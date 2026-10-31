"""Compare 2v2 search settings at play-time budgets, one round at a time.

Full games at ~10 s per move are far too slow on one GPU, so this scores a
single round from fixed positions instead. Each team plays as two bot seats
do on the server: the first seat plays the argmax of the robust first-mover
search, and the second seat plays the Nash complement to that move (an
expectation over its mixed strategy). The resulting joint actions are scored
by a depth-1 search from the child position (exact for finished games), and
the expected value is turned into a score:
0.5 + (value with V as White - value with V as Black) / 4.

    python searcheval.py --variants base=deepen=16 new=deepen=16:budget=7.5 --time 280

The first variant is the reference opponent. Searches and reference values
are cached in --cache, so repeated runs add positions until --positions.
"""
import argparse, json, os, pickle, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hcengine as hc
import model
from search import Evaluator, Searcher, softmax_prior, WHITE, BLACK
from netagent import pick_device
from train import outcome


def gen_positions(ev, n, seed, lo=4, hi=36):
    """Positions from policy-sampled 2v2 games (first move ~ prior, partner ~
    prior among compatible moves), stopped at a random round. Returns move lists."""
    rng = np.random.default_rng(seed)
    out = []
    while len(out) < n:
        k = n - len(out)
        games, hist = [hc.Game() for _ in range(k)], [[] for _ in range(k)]
        stop = rng.integers(lo, hi + 1, k)
        for r in range(hi):
            live = [i for i in range(k) if not games[i].result and len(hist[i]) < stop[i]]
            if not live:
                break
            logits, _ = ev.root(np.stack([hc.compact(games[i], 1) for i in live]))
            for j, i in enumerate(live):
                g, acts = games[i], []
                for c in (WHITE, BLACK):
                    pr = softmax_prior(logits[j, c], g.legal(c))
                    if not pr:
                        acts += [-1, -1]
                        continue
                    ms = list(pr)
                    m1 = ms[rng.choice(len(ms), p=np.array([pr[m] for m in ms]) / sum(pr.values()))]
                    ok = [m for m in g.team_legal(c, m1) if m in pr]
                    m2 = ok[rng.choice(len(ok), p=np.array([pr[m] for m in ok]) / sum(pr[m] for m in ok))] if ok else -1
                    acts += [m1, m2]
                games[i] = g.play2(*acts)
                hist[i].append(acts)
        out += [h for g, h, s in zip(games, hist, stop) if not g.result and len(h) == s]
    return out[:n]


def replay(hist):
    g = hc.Game()
    for a in hist:
        g = g.play2(*a)
    return g


def team_dist(searcher, g, color, mass=0.95, top=6):
    """The team's round under the two-seat protocol: (first move, [(pair, prob)]), secs."""
    t = time.time()
    r = searcher.run_first_mover(g, color)
    t1 = time.time() - t
    a = int(r['moves'][int(np.argmax(r['probs']))])
    if a < 0 or not g.team_legal(color, a):
        return dict(pairs=[((a, -1), 1.0)], t1=t1, t2=0.0)
    t = time.time()
    r2 = searcher.run([(g, 1, color, a)])[0]
    t2 = time.time() - t
    acts, x = (r2['wa'], r2['x']) if color == WHITE else (r2['ba'], r2['y'])
    order = np.argsort(-np.asarray(x))
    keep, tot = [], 0.0
    for i in order[:top]:
        keep.append((tuple(int(m) for m in acts[i]), float(x[i])))
        tot += x[i]
        if tot >= mass:
            break
    return dict(pairs=[(p, w / tot) for p, w in keep], t1=t1, t2=t2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'best.pt'))
    ap.add_argument('--variants', nargs='+', required=True, help='name=k=v:k=v (Searcher options); first = opponent')
    ap.add_argument('--positions', type=int, default=64)
    ap.add_argument('--time', type=float, default=280, help='stop adding positions after this many seconds')
    ap.add_argument('--cache', default='searcheval.pkl')
    ap.add_argument('--device', default='auto')
    ap.add_argument('--seed', type=int, default=0)
    o = ap.parse_args()
    t_start = time.time()
    hc.seed(o.seed)
    device = pick_device(o.device)
    net, _ = model.load(o.model, device)
    ev = Evaluator(model.fuse(net), device)
    cache = pickle.load(open(o.cache, 'rb')) if os.path.exists(o.cache) else {}
    if cache.get('seed') != o.seed or len(cache.get('positions', [])) < o.positions:
        cache = dict(seed=o.seed, positions=gen_positions(ev, o.positions, o.seed), dist={}, ref={})
    specs = dict(v.split('=', 1) for v in o.variants)
    searchers = {}
    for name, spec in specs.items():
        kw = dict(kv.split('=') for kv in spec.split(':') if kv)
        searchers[name] = Searcher(ev, rng=np.random.default_rng(o.seed),
                                   **{k: float(v) if k == 'budget' else int(v) for k, v in kw.items()})
    base = list(specs)[0]
    # 1. team distributions, position by position, until the time is up
    done = 0
    for i, hist in enumerate(cache['positions']):
        g = replay(hist)
        for name in specs:
            for c in (WHITE, BLACK):
                key = (i, c, specs[name])
                if key not in cache['dist']:
                    if time.time() - t_start > o.time:
                        break
                    cache['dist'][key] = team_dist(searchers[name], g, c)
        if all((i, c, specs[n]) in cache['dist'] for n in specs for c in (WHITE, BLACK)):
            done = i + 1
        else:
            break
    # 2. reference values of all joint cells that matter
    need = {}
    for i in range(done):
        for name in specs:
            for vw, vb in ((name, base), (base, name)):
                dw, db = cache['dist'][(i, WHITE, specs[vw])], cache['dist'][(i, BLACK, specs[vb])]
                for pw, _ in dw['pairs']:
                    for pb, _ in db['pairs']:
                        if (i, pw, pb) not in cache['ref']:
                            need[(i, pw, pb)] = None
    if need:
        keys, kids = [], []
        for k in need:
            i, pw, pb = k
            child = replay(cache['positions'][i]).play2(pw[0], pw[1], pb[0], pb[1])
            if child.result:
                cache['ref'][k] = outcome(child)
            else:
                keys.append(k); kids.append((child, 1, None, None))
        ref = Searcher(ev, rng=np.random.default_rng(o.seed))
        for j in range(0, len(kids), 64):
            for k, r in zip(keys[j:j + 64], ref.run(kids[j:j + 64])):
                cache['ref'][k] = float(r['v'])
    pickle.dump(cache, open(o.cache, 'wb'))

    def value(i, vw, vb):
        dw, db = cache['dist'][(i, WHITE, specs[vw])], cache['dist'][(i, BLACK, specs[vb])]
        return sum(ww * wb * cache['ref'][(i, pw, pb)] for pw, ww in dw['pairs'] for pb, wb in db['pairs'])

    print(f'{done} positions ({time.time() - t_start:.0f}s); opponent {base} = {specs[base]}')
    for name in specs:
        d = np.array([(value(i, name, base) - value(i, base, name)) / 4 for i in range(done)])
        t1 = [cache['dist'][(i, c, specs[name])]['t1'] for i in range(done) for c in (WHITE, BLACK)]
        t2 = [cache['dist'][(i, c, specs[name])]['t2'] for i in range(done) for c in (WHITE, BLACK)]
        same = np.mean([cache['dist'][(i, c, specs[name])]['pairs'][0][0][0] == cache['dist'][(i, c, specs[base])]['pairs'][0][0][0]
                        for i in range(done) for c in (WHITE, BLACK)]) if done else 0
        se = d.std(ddof=1) / np.sqrt(len(d)) if len(d) > 1 else 0
        print(json.dumps(dict(variant=name, spec=specs[name], n=done, score=round(0.5 + float(d.mean()), 4) if done else None,
                              se=round(float(se), 4), same_first=round(float(same), 2),
                              first_s=[round(float(np.mean(t1)), 2), round(float(np.max(t1)), 2)] if t1 else None,
                              second_s=[round(float(np.mean(t2)), 2), round(float(np.max(t2)), 2)] if t2 else None)), flush=True)


if __name__ == '__main__':
    main()
