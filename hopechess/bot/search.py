"""Batched depth-1 simultaneous-move matrix search driven by the network.

For each position: the root network pass gives move priors for both sides;
we keep the most promising (plus tactical) candidate actions per side, run
every joint action through the C++ engine, value the successors with the
network (exact values for finished games), and solve the resulting zero-sum
matrix game. The Nash strategies are both the move distribution to play and
the policy training targets.
"""
import os, time
import numpy as np
import torch
import hcengine as hc
import model

THREADS = int(os.environ.get('HC_THREADS', os.cpu_count() or 4))

WHITE, BLACK = 0, 1


class Evaluator:
    """Batched network evaluation. With several CUDA devices the successor
    batches are spread over replicas (call sync() after training)."""
    def __init__(self, net, device='cpu', half=None, chunk=4096, devices=None):
        import copy, time
        self.net = net.to(device).eval()
        self.device = torch.device(device)
        self.half = (self.device.type in ('cuda', 'xpu')) if half is None else half
        self.chunk = chunk
        self.devices = [torch.device(d) for d in (devices or [device])]
        self.replicas = [self.net] + [copy.deepcopy(self.net).to(d).eval() for d in self.devices[1:]]
        self.t_root = self.t_values = 0.0
        self.n_values = 0
        self._time = time.time

    def sync(self):
        sd = self.net.state_dict()
        for r in self.replicas[1:]:
            r.load_state_dict(sd)
            r.eval()

    def _to(self, arr, dev):
        t = torch.from_numpy(np.ascontiguousarray(arr))
        if dev.type == 'cuda':
            t = t.pin_memory().to(dev, non_blocking=True)
        elif dev.type != 'cpu':
            t = t.to(dev)
        return model.expand(t)

    # inputs are compact uint8 encodings [N, 80]
    @torch.no_grad()
    def root(self, comp):
        t = self._time()
        x = self._to(comp, self.device)
        with torch.autocast(self.device.type, dtype=torch.float16, enabled=self.half):
            p, v = self.net(x)
        out = p.float().cpu().numpy(), v.float().cpu().numpy()
        self.t_root += self._time() - t
        return out

    @torch.no_grad()
    def values(self, comp):
        t = self._time()
        outs = []
        nd = len(self.devices)
        for k, i in enumerate(range(0, len(comp), self.chunk)):
            dev, net = self.devices[k % nd], self.replicas[k % nd]
            x = self._to(comp[i:i + self.chunk], dev)
            with torch.autocast(dev.type, dtype=torch.float16, enabled=self.half):
                outs.append(net.value(x).float())
        res = np.concatenate([o.cpu().numpy() for o in outs]) if outs else np.zeros(0, np.float32)
        self.t_values += self._time() - t
        self.n_values += len(comp)
        return res


class HeuristicEvaluator:
    """Stand-in evaluator used to bootstrap: uniform priors, material values."""
    def __init__(self, scale=3000.0):
        self.scale = scale


def softmax_prior(logits, codes, flip=False):
    if not codes or codes == [-1]:
        return {}
    idx = hc.policy_indices(codes, flip)
    z = logits[idx]
    z = np.exp(z - z.max())
    z /= z.sum()
    return dict(zip(codes, z))


def tactical(game, color):
    """Moves that hit the enemy king's square or its flight squares, and all
    own king moves: king hunts and escapes must never be pruned."""
    b = game.board()
    me, them = ('w', 'b') if color == WHITE else ('b', 'w')
    ek = [i for i, p in enumerate(b) if p[0] == them and p[1] == 'k']
    zone = set()
    for k in ek:
        r, c = divmod(k, 8)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if 0 <= r + dr < 8 and 0 <= c + dc < 8:
                    zone.add((r + dr) * 8 + c + dc)
    out = []
    for m in game.legal(color):
        frm, to = m & 63, (m >> 6) & 63
        if to in zone or b[frm][1] == 'k':
            out.append(m)
    return out


class Searcher:
    def __init__(self, evaluator, k1=24, k_single=12, k_pairs=36, nash_iters=800,
                 noise=0.0, noise_alpha=0.3, rng=None, heuristic=None, deepen=0, budget=0.0, fm_deepen=0):
        self.ev = evaluator
        self.k1, self.k_single, self.k_pairs = k1, k_single, k_pairs
        self.nash_iters = nash_iters
        self.noise, self.noise_alpha = noise, noise_alpha
        self.rng = rng or np.random.default_rng()
        self.heuristic = heuristic  # if set (scale), ignore the net: uniform priors, material values
        self.deepen = deepen        # >0: re-search this many likely joint actions one round deeper
        # >0: seconds per call; deepening repeats in steps of `deepen` cells,
        # re-ranked by the updated strategies, until the time is used up
        self.budget = budget
        self.fm_deepen = fm_deepen  # also deepen the 2v2 first-mover search (no gain measured)

    def _noisy(self, prior):
        if not self.noise or len(prior) < 2:
            return prior
        d = self.rng.dirichlet([self.noise_alpha] * len(prior))
        return {m: (1 - self.noise) * p + self.noise * n for (m, p), n in zip(prior.items(), d)}

    def _singles(self, game, color, prior, k):
        moves = game.legal(color)
        if not moves:
            return [-1]
        if len(moves) <= k:
            return moves
        top = sorted(moves, key=lambda m: -prior.get(m, 0.0))[:k]
        extra = [m for m in tactical(game, color) if m not in top]
        return top + extra

    def _pairs(self, game, color, prior, reserved=None):
        if reserved is not None:
            moves = game.team_legal(color, reserved)
            if not moves:
                return [(reserved, -1)]
            if len(moves) > self.k1:
                top = sorted(moves, key=lambda m: -prior.get(m, 0.0))[:self.k1]
                moves = top + [m for m in tactical(game, color) if m in moves and m not in top]
            return [(reserved, m) for m in moves]
        acts = game.team_actions(color)
        if len(acts) <= self.k_pairs:
            return [tuple(a) for a in acts]
        p = lambda m: prior.get(m, 0.0) if m >= 0 else 0.0
        singles = sorted({m for a in acts for m in a if m >= 0}, key=lambda m: -p(m))
        keep = set(singles[:self.k_single])
        tact = [m for m in tactical(game, color) if m not in keep]
        pool = [tuple(a) for a in acts if a[0] in keep and (a[1] in keep or a[1] < 0)]
        score = lambda a: (p(a[0]) + 1e-4) * ((p(a[1]) + 1e-4) if a[1] >= 0 else 1e-4)
        pool.sort(key=lambda a: -score(a))
        chosen = pool[:self.k_pairs]
        have = {m for a in chosen for m in a}
        # make sure each tactical move appears, paired with its best partner
        for t in tact[:12]:
            if t in have:
                continue
            partners = [a for a in acts if t in a]
            if partners:
                best = max(partners, key=score)
                chosen.append(tuple(best))
                have.update(best)
        return chosen or [tuple(a) for a in acts[:self.k_pairs]]

    def run(self, items):
        """items: list of (game, mode, reserved_color, reserved_code). Returns a
        list of dicts with wa, ba, x, y, v, root_v, pw, pb (priors)."""
        t0 = time.time()
        n = len(items)
        if self.heuristic is None:
            feats = np.stack([hc.compact(g, mode) for g, mode, _, _ in items])
            logits, root_v = self.ev.root(feats)
        else:
            logits, root_v = None, np.zeros(n, np.float32)
        plans = []
        for i, (g, mode, rc, rcode) in enumerate(items):
            wl, bl = g.legal(WHITE), g.legal(BLACK)
            if logits is None:
                pw = {m: 1.0 / len(wl) for m in wl}
                pb = {m: 1.0 / len(bl) for m in bl}
            else:
                pw = softmax_prior(logits[i, 0], wl)
                pb = softmax_prior(logits[i, 1], bl)
            spw, spb = self._noisy(pw), self._noisy(pb)
            if mode == 0:
                wa = [(m, -1) for m in self._singles(g, WHITE, spw, self.k1)]
                ba = [(m, -1) for m in self._singles(g, BLACK, spb, self.k1)]
            else:
                wa = self._pairs(g, WHITE, spw, rcode if rc == WHITE else None)
                ba = self._pairs(g, BLACK, spb, rcode if rc == BLACK else None)
            plans.append((wa, ba, pw, pb))
        # successor values
        if self.heuristic is None:
            comp, res = hc.successors_batch([it[0] for it in items], [it[1] for it in items],
                                            [p[0] for p in plans], [p[1] for p in plans], THREADS)
            vals = np.zeros(len(res), np.float32)
            live = np.nonzero(res == 0)[0]
            if len(live):
                vals[live] = self.ev.values(comp[live])
            vals[res == 1], vals[res == 2], vals[res == 3] = 1.0, -1.0, 0.0
        else:
            vals = np.concatenate([hc.heuristic_values(g, mode, wa, ba, self.heuristic) for (g, mode, _, _), (wa, ba, _, _) in zip(items, plans)])
        if self.heuristic is not None:
            res = np.zeros(len(vals), np.int8)
        shapes = [(len(p[0]), len(p[1])) for p in plans]
        sols = hc.nash_batch(vals, shapes, self.nash_iters, THREADS)
        offs = np.cumsum([0] + [a * b for a, b in shapes])
        out = []
        for i, ((wa, ba, pw, pb), (x, y, v)) in enumerate(zip(plans, sols)):
            M = vals[offs[i]:offs[i + 1]].reshape(len(wa), len(ba))
            R = res[offs[i]:offs[i + 1]].reshape(len(wa), len(ba))
            out.append(dict(wa=wa, ba=ba, x=x, y=y, v=v, root_v=float(root_v[i]), pw=pw, pb=pb, M=M, R=R))
        if self.deepen and self.heuristic is None:
            jobs = [_NashJob(g, mode, r, self.nash_iters) for (g, mode, _, _), r in zip(items, out)]
            self._deepen(jobs, t0)
            for jb, r in zip(jobs, out):
                r.update(M=jb.M, x=jb.x, y=jb.y, v=jb.v)
        return out

    def run_first_mover(self, game, color, k_mine=10, k_mate=10, beta=0.0):
        """2v2 seat that submits before an unknown teammate (human, other bot).
        Each own move a is valued by the expectation over the teammate's reply
        b ~ policy prior (restricted to moves compatible with a), against the
        opponent team's candidate pairs; the reduced matrix (own single moves x
        opponent pairs) is solved for a Nash strategy over single moves."""
        t0 = time.time()
        mode = 1
        logits, _ = self.ev.root(hc.compact(game, mode)[None])
        opp = 1 - color
        mine_l, opp_l = game.legal(color), game.legal(opp)
        if not mine_l:
            return dict(moves=[-1], probs=np.ones(1))
        pm = softmax_prior(logits[0, color], mine_l)
        po = softmax_prior(logits[0, opp], opp_l)
        ranked = sorted(mine_l, key=lambda m: -pm.get(m, 0.0))
        singles = ranked[:k_mine] + [m for m in tactical(game, color) if m not in ranked[:k_mine]][:6]
        mates = ranked[:k_mate]
        pairs, owner, weight = [], [], []
        for a in singles:
            allowed = set(game.team_legal(color, a))
            bs = [b for b in mates if b in allowed]
            if not bs and allowed:
                bs = [max(allowed, key=lambda b: pm.get(b, 0.0))]
            if not bs:
                bs = [-1]
            w = np.array([pm.get(b, 0.0) + 1e-6 for b in bs])
            w /= w.sum()
            for b, wb in zip(bs, w):
                pairs.append((a, b)); owner.append(a); weight.append(wb)
        oacts = self._pairs(game, opp, po)
        wa, ba = (pairs, oacts) if color == WHITE else (oacts, pairs)
        comp, res = hc.successors_batch([game], [mode], [wa], [ba], THREADS)
        vals = np.zeros(len(res), np.float32)
        live = np.nonzero(res == 0)[0]
        if len(live):
            vals[live] = self.ev.values(comp[live])
        vals[res == 1], vals[res == 2], vals[res == 3] = 1.0, -1.0, 0.0
        jb = _FirstMoverJob(game, mode, wa, ba, vals.reshape(len(wa), len(ba)), res.reshape(len(wa), len(ba)),
                            color, singles, owner, weight, beta, self.nash_iters)
        if self.deepen and self.fm_deepen:
            self._deepen([jb], t0)
        return dict(moves=singles, probs=jb.x, value=jb.v, R=jb.Rm, opp=oacts, opp_probs=jb.y)

    def _deepen(self, jobs, t0):
        """Selective depth 2: replace the values of the most relevant joint
        actions (likely under both Nash strategies, plus best responses to the
        main candidates) by a depth-1 search from the child position. Without
        a budget this is one step of `deepen` cells per job; with one, steps
        repeat until the time since t0 is used up."""
        sub = Searcher(self.ev, self.k1, self.k_single, self.k_pairs, self.nash_iters, rng=self.rng)
        per_child = None
        while True:
            picks = [(jb, a, b) for jb in jobs for a, b in jb.cells(self.deepen)]
            if self.budget:
                # a small first step measures the cost per child; later steps
                # stop short of overrunning the budget (slowest step so far, +20%)
                n = 8 if per_child is None else int((self.budget - (time.time() - t0)) / (1.2 * per_child))
                picks = picks[:max(0, n)]
            if not picks:
                return
            t = time.time()
            kids = [(jb.child(a, b), jb.mode, None, None) for jb, a, b in picks]
            res = []
            for j in range(0, len(kids), 64):
                res += sub.run(kids[j:j + 64])
            per_child = max(per_child or 0.0, (time.time() - t) / len(kids))
            touched = {}
            for (jb, a, b), cr in zip(picks, res):
                jb.M[a, b] = cr['v']
                jb.done[a, b] = True
                touched[id(jb)] = jb
            for jb in touched.values():
                jb.solve()
            if not self.budget:
                return


def _closeness(gap, scale=0.05):
    return np.exp(-np.maximum(gap, 0.0) / scale)


def _ranked(pri, done, br, n):
    """br cells first, then the n highest-priority other cells; skips done cells."""
    pri = pri.copy()
    pri[done] = -1
    out = [c for c in br if not done[c]]
    for k in np.argsort(-pri, axis=None):
        c = divmod(int(k), pri.shape[1])
        if pri[c] < 0 or len(out) >= len(br) + n:
            break
        if c not in br:
            out.append(c)
    return out


class _NashJob:
    """A root matrix (rows wa, cols ba, White's values) whose cells can be deepened."""
    def __init__(self, game, mode, r, iters):
        self.game, self.mode, self.wa, self.ba, self.iters = game, mode, r['wa'], r['ba'], iters
        self.M = r['M'].copy()
        self.done = r['R'] != 0
        self.x, self.y, self.v = r['x'], r['y'], r['v']

    def child(self, a, b):
        wa, ba = self.wa[a], self.ba[b]
        return self.game.play(wa[0], ba[0]) if self.mode == 0 else self.game.play2(wa[0], wa[1], ba[0], ba[1])

    def solve(self):
        self.x, self.y, self.v = hc.solve_nash(self.M.astype(np.float64), self.iters)

    def cells(self, n):
        """Best responses to the top-4 candidates of each side, then the n most
        likely joint actions (near-equilibrium rows and columns break ties)."""
        x, y, M = self.x, self.y, self.M
        br = {(int(a), int(np.argmin(M[a]))) for a in np.argsort(-x)[:4]}
        br |= {(int(np.argmax(M[:, b])), int(b)) for b in np.argsort(-y)[:4]}
        sx = x + 1e-3 * _closeness(self.v - M @ y)
        sy = y + 1e-3 * _closeness(x @ M - self.v)
        return _ranked(np.outer(sx, sy), self.done, br, n)


class _FirstMoverJob(_NashJob):
    """run_first_mover's pair matrix: rows are (own move, teammate reply)
    pairs, reduced to own single moves by the teammate-reply weights."""
    def __init__(self, game, mode, wa, ba, M, R, color, singles, owner, weight, beta, iters):
        self.game, self.mode, self.wa, self.ba, self.iters = game, mode, wa, ba, iters
        self.M, self.done = M, R != 0
        self.color, self.beta = color, beta
        idx = {a: i for i, a in enumerate(singles)}
        self.own = np.array([idx[a] for a in owner])
        self.w0 = np.array(weight)
        self.solve()

    def mine(self):
        return self.M if self.color == WHITE else -self.M.T     # rows: my pairs, my point of view

    def solve(self):
        Mm = self.mine()
        w = self.w0
        if self.beta:
            # quantal-response teammate: prefers replies that work well with a
            # (against the opponent's Nash strategy of the full pair game)
            _, yo, _ = hc.solve_nash(Mm.astype(np.float64), self.iters // 2)
            q = Mm @ yo
            w = w.copy()
            for a in np.unique(self.own):
                rows = self.own == a
                z = np.log(w[rows]) + self.beta * (q[rows] - q[rows].max())
                z = np.exp(z - z.max())
                w[rows] = z / z.sum()
        W = np.zeros((self.own.max() + 1, len(w)))
        W[self.own, np.arange(len(w))] = w
        self.W, self.Rm = W, W @ Mm
        self.x, self.y, self.v = hc.solve_nash(self.Rm, self.iters)

    def cells(self, n):
        """As _NashJob.cells, on the single-move game: the opponent's best
        replies to my top-4 moves and my best move against its top-4 pairs
        (each via the move's two likeliest teammate replies), then likely
        cells, a single move's weight spread over its pairs."""
        x, y, R, W = self.x, self.y, self.Rm, self.W
        top = lambda s: [r for r in np.argsort(-W[s])[:2] if W[s, r] > 0]
        br = {(int(r), int(np.argmin(R[s]))) for s in np.argsort(-x)[:4] for r in top(s)}
        br |= {(int(r), int(j)) for j in np.argsort(-y)[:4] for r in top(int(np.argmax(R[:, j])))}
        sx = W.T @ (x + 1e-3 * _closeness(self.v - R @ y))
        sy = y + 1e-3 * _closeness(x @ R - self.v)
        mine = _ranked(np.outer(sx, sy), self.done if self.color == WHITE else self.done.T, br, n)
        return mine if self.color == WHITE else [(j, r) for r, j in mine]


def marginal(acts, probs):
    """Per-move marginal of a (team) mixed strategy; sums to 1."""
    d = {}
    for (a, b), p in zip(acts, probs):
        mv = [m for m in (a, b) if m >= 0]
        for m in mv:
            d[m] = d.get(m, 0.0) + p / len(mv)
    return d
