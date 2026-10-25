"""Self-play reinforcement learning for hopechess (1v1 and 2v2).

Loop: play P games in lockstep with the batched matrix search, store
(position, Nash policies of both sides, search value, final result), train
the network on a replay buffer, checkpoint, periodically evaluate against
the upstream engine.js computer. Runs on CPU (tiny smoke tests) or GPU.

    python3 train.py --out runs/x --hours 0.1 --parallel 16 --blocks 2 --channels 32
"""
import argparse, json, math, os, sys, time
import numpy as np
import torch
import torch.nn.functional as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hcengine as hc
import model
import agents as A
from search import Evaluator, Searcher, marginal, WHITE, BLACK

K = 64  # sparse policy target slots per side


class Replay:
    def __init__(self, cap):
        self.cap, self.n, self.i = cap, 0, 0
        self.f = np.zeros((cap, hc.NCOMPACT), np.uint8)
        self.pi = np.zeros((cap, 2, K), np.int16)
        self.pp = np.zeros((cap, 2, K), np.float16)
        self.z = np.zeros(cap, np.float32)
        self.v = np.zeros(cap, np.float32)
        self.mode = np.zeros(cap, np.int8)

    def add(self, f, pi, pp, z, v, mode):
        j = self.i
        self.f[j], self.pi[j], self.pp[j], self.z[j], self.v[j], self.mode[j] = f, pi, pp, z, v, mode
        self.i = (j + 1) % self.cap
        self.n = min(self.n + 1, self.cap)

    def sample(self, b, rng):
        return rng.integers(0, self.n, b)


def sparse_target(dist):
    items = sorted(dist.items(), key=lambda kv: -kv[1])[:K]
    idx = np.zeros(K, np.int16); p = np.zeros(K, np.float16)
    if not items:
        return idx, p
    codes = [c for c, _ in items]
    ps = np.array([q for _, q in items], np.float64)
    ps = ps / ps.sum() if ps.sum() > 0 else ps
    idx[:len(codes)] = hc.policy_indices(codes, False)
    p[:len(codes)] = ps
    return idx, p


class GameSlot:
    def __init__(self, mode, players=None, net_color=None):
        self.g = hc.Game()
        self.mode = mode
        self.samples = []        # (feats, pi, pp, v)
        self.players = players   # None = self-play, else {color: agent or 'net'}
        self.net_color = net_color


def pick(acts, probs, rng, temperature=1.0, eps=0.0):
    probs = np.maximum(np.asarray(probs, np.float64), 0)
    if eps and rng.random() < eps:
        return acts[rng.integers(len(acts))]
    if temperature <= 0:
        return acts[int(np.argmax(probs))]
    p = probs ** (1.0 / temperature)
    s = p.sum()
    p = p / s if s > 0 else np.full(len(p), 1.0 / len(p))
    return acts[rng.choice(len(acts), p=p)]


def step_games(slots, searcher, rng, record=True, eps=0.0, temperature=1.0):
    """Advance every slot by one round. Returns slots that finished."""
    need = [s for s in slots if s.players is None or 'net' in s.players.values()]
    results = searcher.run([(s.g, s.mode, None, None) for s in need]) if need else []
    rmap = {id(s): r for s, r in zip(need, results)}
    done = []
    for s in slots:
        r = rmap.get(id(s))
        orders = {}
        for color in (WHITE, BLACK):
            who = 'net' if s.players is None else s.players[color]
            if who == 'net':
                acts, probs = (r['wa'], r['x']) if color == WHITE else (r['ba'], r['y'])
                a = pick(acts, probs, rng, temperature, eps)
                orders[color] = [a[0]] if s.mode == 0 else [a[0], a[1]]
            else:
                orders[color] = who.act(s.g, color, s.mode)
        if record and r is not None:
            if s.mode == 0:
                dw = {a[0]: p for a, p in zip(r['wa'], r['x']) if a[0] >= 0}
                db = {a[0]: p for a, p in zip(r['ba'], r['y']) if a[0] >= 0}
            else:
                dw, db = marginal(r['wa'], r['x']), marginal(r['ba'], r['y'])
            iw, pw = sparse_target(dw)
            ib, pb = sparse_target(db)
            s.samples.append((hc.compact(s.g, s.mode), np.stack([iw, ib]), np.stack([pw, pb]), r['v']))
        w, b = orders[WHITE], orders[BLACK]
        s.g = s.g.play(w[0], b[0]) if s.mode == 0 else s.g.play2(w[0], w[1], b[0], b[1])
        if s.g.result or s.g.round > 300:
            done.append(s)
    return done


def outcome(g):
    return {1: 1.0, 2: -1.0}.get(g.result, 0.0)


def train_steps(net, opt, buf, steps, batch, device, rng, lam, sched=None):
    net.train()
    flip_t = torch.from_numpy(model.POLICY_FLIP).to(device)
    tot = np.zeros(3)
    for _ in range(steps):
        idx = buf.sample(batch, rng)
        f = model.expand(torch.from_numpy(buf.f[idx]).to(device))
        pi = torch.from_numpy(buf.pi[idx].astype(np.int64)).to(device)
        pp = torch.from_numpy(buf.pp[idx].astype(np.float32)).to(device)
        z = torch.from_numpy(lam * buf.z[idx] + (1 - lam) * buf.v[idx]).to(device)
        # color-flip augmentation on half the batch
        fl = torch.from_numpy(rng.random(batch) < 0.5).to(device)
        f = torch.where(fl[:, None, None, None], model.flip_features(f), f)
        pi_f = flip_t[pi].flip(1)
        pp_f = pp.flip(1)
        pi = torch.where(fl[:, None, None], pi_f, pi)
        pp = torch.where(fl[:, None, None], pp_f, pp)
        z = torch.where(fl, -z, z)
        logits, v = net(f)
        logp = F.log_softmax(logits.float(), -1)
        lp = -(logp.gather(2, pi) * pp).sum(-1).mean()
        lv = F.mse_loss(v.float(), z)
        loss = lp + 2.0 * lv
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
        opt.step()
        if sched:
            sched.step()
        tot += [loss.item(), lp.item(), lv.item()]
    net.eval()
    return tot / max(steps, 1)


def evaluate(searcher, opponent, mode, games, rng):
    slots = []
    for i in range(games):
        c = i % 2
        slots.append(GameSlot(mode, {c: 'net', 1 - c: opponent}, c))
    active, score, res = list(slots), 0.0, []
    while active:
        done = step_games(active, searcher, rng, record=False)
        for s in done:
            o = outcome(s.g)
            res.append(o if s.net_color == WHITE else -o)
            active.remove(s)
    res = np.array(res)
    return float(((res > 0) + 0.5 * (res == 0)).mean()), int((res > 0).sum()), int((res == 0).sum()), int((res < 0).sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--init', default=None)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    ap.add_argument('--blocks', type=int, default=6)
    ap.add_argument('--channels', type=int, default=64)
    ap.add_argument('--hours', type=float, default=1.0)
    ap.add_argument('--parallel', type=int, default=128)
    ap.add_argument('--p2v2', type=float, default=0.0, help='fraction of 2v2 self-play games')
    ap.add_argument('--p2v2-final', type=float, default=None, help='linearly move p2v2 to this by the end')
    ap.add_argument('--bootstrap-games', type=int, default=0, help='first games use heuristic values')
    ap.add_argument('--iter-samples', type=int, default=20000)
    ap.add_argument('--reuse', type=float, default=4.0)
    ap.add_argument('--batch', type=int, default=512)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--buffer', type=int, default=600000)
    ap.add_argument('--lam', type=float, default=0.5, help='value target = lam*z + (1-lam)*search value')
    ap.add_argument('--k1', type=int, default=24)
    ap.add_argument('--k-single', type=int, default=12)
    ap.add_argument('--k-pairs', type=int, default=36)
    ap.add_argument('--noise', type=float, default=0.25)
    ap.add_argument('--eps', type=float, default=0.03)
    ap.add_argument('--eval-every', type=int, default=3)
    ap.add_argument('--eval-games', type=int, default=40)
    ap.add_argument('--seed', type=int, default=0)
    o = ap.parse_args()
    os.makedirs(o.out, exist_ok=True)
    rng = np.random.default_rng(o.seed)
    hc.seed(o.seed)
    torch.manual_seed(o.seed)
    dev = torch.device(o.device)
    if o.device == 'cpu':
        torch.set_num_threads(max(1, os.cpu_count()))
    if o.init:
        net, ck = model.load(o.init, dev)
        print('init from', o.init, ck.get('meta'))
    else:
        net = model.Net(o.blocks, o.channels).to(dev)
    net.eval()
    opt = torch.optim.AdamW(net.parameters(), lr=o.lr, weight_decay=1e-4)
    buf = Replay(o.buffer)
    ev = Evaluator(net, o.device)
    kw = dict(k1=o.k1, k_single=o.k_single, k_pairs=o.k_pairs)
    sp_search = Searcher(ev, noise=o.noise, rng=rng, **kw)
    boot_search = Searcher(ev, rng=rng, heuristic=3000.0, **kw)
    eval_search = Searcher(ev, rng=rng, **kw)
    log = open(os.path.join(o.out, 'log.jsonl'), 'a')
    t0 = time.time()
    games_done, it, total_samples = 0, 0, 0
    stats = dict(len=[], res=[])
    p_final = o.p2v2 if o.p2v2_final is None else o.p2v2_final

    def p2v2_now():
        frac = min(1.0, (time.time() - t0) / (o.hours * 3600))
        return o.p2v2 + (p_final - o.p2v2) * frac

    def new_slot():
        return GameSlot(1 if rng.random() < p2v2_now() else 0)

    slots = [new_slot() for _ in range(o.parallel)]
    boot_slots = [GameSlot(0) for _ in range(min(o.parallel, 64))] if o.bootstrap_games else []
    boot_left = o.bootstrap_games
    while time.time() - t0 < o.hours * 3600:
        it += 1
        new = 0
        ts = time.time()
        while new < o.iter_samples:
            if boot_left > 0:
                done = step_games(boot_slots, boot_search, rng, eps=0.1)
                pool = boot_slots
            else:
                done = step_games(slots, sp_search, rng, eps=o.eps)
                pool = slots
            for s in done:
                z = outcome(s.g)
                for f, pi, pp, v in s.samples:
                    buf.add(f, pi, pp, z, v, s.mode)
                new += len(s.samples)
                stats['len'].append((s.mode, s.g.round))
                stats['res'].append((s.mode, s.g.result, s.g.reason))
                games_done += 1
                pool[pool.index(s)] = GameSlot(0) if pool is boot_slots else new_slot()
                if pool is boot_slots:
                    boot_left -= 1
        total_samples += new
        t_play = time.time() - ts
        ts = time.time()
        steps = int(math.ceil(new * o.reuse / o.batch))
        if buf.n >= 4 * o.batch:
            losses = train_steps(net, opt, buf, steps, o.batch, dev, rng, o.lam)
        else:
            losses = np.zeros(3)
        t_train = time.time() - ts
        lens = {m: float(np.mean([l for mm, l in stats['len'][-400:] if mm == m] or [0])) for m in (0, 1)}
        rec = dict(it=it, t=round(time.time() - t0), games=games_done, samples=total_samples, buf=buf.n,
                   loss=losses.round(4).tolist(), len1v1=lens[0], len2v2=lens[1], p2v2=round(p2v2_now(), 3),
                   play_s=round(t_play), train_s=round(t_train), steps=steps, boot_left=max(boot_left, 0))
        if o.eval_every and it % o.eval_every == 0:
            ts = time.time()
            for mode in (0, 1):
                sc = evaluate(eval_search, A.ComputerAgent(True), mode, o.eval_games, rng)
                rec[f'eval_{"1v1" if mode == 0 else "2v2"}_vs_hard'] = sc
            rec['eval_s'] = round(time.time() - ts)
        print(json.dumps(rec), flush=True)
        log.write(json.dumps(rec) + '\n'); log.flush()
        model.save(net, os.path.join(o.out, 'latest.pt'), meta=rec)
        if it % 10 == 0:
            model.save(net, os.path.join(o.out, f'it{it:04d}.pt'), meta=rec)
    model.save(net, os.path.join(o.out, 'final.pt'), meta=dict(games=games_done, samples=total_samples))
    print('done', games_done, 'games', total_samples, 'samples')


if __name__ == '__main__':
    main()
