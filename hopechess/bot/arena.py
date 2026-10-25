"""Play matches between agents (colors alternate) and report results.

    python3 arena.py --mode 1v1 --a heur-nash --b computer-hard --games 100
Agent specs: random | computer-normal | computer-hard | heur-nash | net:<path>[:opts]
"""
import argparse, multiprocessing as mp, os, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hcengine as hc
import agents as A


def make_agent(spec, seed=None):
    if spec == 'random':
        return A.RandomAgent(seed)
    if spec in ('computer-normal', 'computer-hard'):
        return A.ComputerAgent(spec.endswith('hard'))
    if spec.startswith('heur-nash'):
        kw = dict(kv.split('=') for kv in spec.split(':')[1:])
        return A.HeuristicNashAgent(seed=seed, **{k: float(v) if k in ('scale', 'temperature') else int(v) for k, v in kw.items()})
    if spec.startswith('net:'):
        import netagent
        return netagent.from_spec(spec[4:], seed=seed)
    raise ValueError(spec)


def play_game(a, b, mode, a_color, max_rounds=400):
    """Returns +1 if agent a wins, -1 if b wins, 0 draw; plus rounds."""
    g = hc.Game()
    players = {a_color: a, 1 - a_color: b}
    while not g.result and g.round <= max_rounds:
        w = players[0].act(g, 0, mode)
        bl = players[1].act(g, 1, mode)
        g = g.play(w[0], bl[0]) if mode == 0 else g.play2(w[0], w[1], bl[0], bl[1])
    if g.result in (0, 3):
        return 0, g.round, g.reason
    winner = 0 if g.result == 1 else 1
    return (1 if winner == a_color else -1), g.round, g.reason


def _worker(args):
    spec_a, spec_b, mode, idxs, seed = args
    hc.seed(seed)
    a, b = make_agent(spec_a, seed), make_agent(spec_b, seed + 1)
    return [(i,) + play_game(a, b, mode, i % 2) for i in idxs]


def match(spec_a, spec_b, mode, games, procs=4, seed=0):
    chunks = [list(range(i, games, procs)) for i in range(procs)]
    with mp.get_context('fork').Pool(procs) as pool:
        res = [r for part in pool.map(_worker, [(spec_a, spec_b, mode, c, seed + 1000 * k) for k, c in enumerate(chunks)]) for r in part]
    s = np.array([r[1] for r in res])
    w, d, l = int((s > 0).sum()), int((s == 0).sum()), int((s < 0).sum())
    score = (w + 0.5 * d) / len(s)
    se = np.sqrt(max(score * (1 - score), 1e-9) / len(s))
    elo = -400 * np.log10(1 / min(max(score, 1e-3), 1 - 1e-3) - 1)
    return dict(w=w, d=d, l=l, score=score, se=se, elo=elo, rounds=float(np.mean([r[2] for r in res])))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', default='1v1')
    ap.add_argument('--a', required=True)
    ap.add_argument('--b', required=True)
    ap.add_argument('--games', type=int, default=100)
    ap.add_argument('--procs', type=int, default=4)
    ap.add_argument('--seed', type=int, default=0)
    o = ap.parse_args()
    t = time.time()
    r = match(o.a, o.b, 0 if o.mode == '1v1' else 1, o.games, o.procs, o.seed)
    print(f"{o.mode} {o.a} vs {o.b}: +{r['w']} ={r['d']} -{r['l']} score {r['score']:.3f}±{r['se']:.3f} "
          f"elo {r['elo']:+.0f} avg rounds {r['rounds']:.1f} ({time.time() - t:.0f}s)")
