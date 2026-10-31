"""Batched evaluation matches (GPU friendly): nets vs nets / baselines.

    python3 evaluate.py --players a=runs/x/latest.pt b=runs/y/latest.pt:deepen=16 c=computer-hard \
        --pairs a-b,a-c --modes 1v1,2v2 --games 100
Player spec: <checkpoint.pt>[:k1=20][:deepen=16][:temperature=1.0] | computer-hard | computer-normal | random | heur-nash
"""
import argparse, json, os, sys, time
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hcengine as hc
import model
import agents as A
from search import Evaluator, Searcher, WHITE, BLACK
from train import pick, outcome


class NetPlayer:
    def __init__(self, spec, device, rng):
        parts = spec.split(':')
        net, _ = model.load(parts[0], device)
        kw = dict(kv.split('=') for kv in parts[1:])
        self.temperature = float(kw.pop('temperature', 1.0))
        devs = [f'cuda:{i}' for i in range(torch.cuda.device_count())] if str(device).startswith('cuda') else [device]
        self.searcher = Searcher(Evaluator(net, device, devices=devs), rng=rng, **{k: float(v) if k == 'budget' else int(v) for k, v in kw.items()})
        self.spec = spec


def build(spec, device, rng):
    if spec.endswith('.pt') or '.pt:' in spec:
        return NetPlayer(spec, device, rng)
    if spec in ('computer-hard', 'computer-normal'):
        return A.ComputerAgent(spec.endswith('hard'))
    if spec == 'random':
        return A.RandomAgent()
    if spec.startswith('heur-nash'):
        return A.HeuristicNashAgent(scale=10000.0)
    raise ValueError(spec)


def play_match(pa, pb, mode, games, rng, max_rounds=300):
    """Returns list of results from pa's perspective (+1 win, 0 draw, -1 loss)."""
    slots = [dict(g=hc.Game(), players={i % 2: pa, 1 - i % 2: pb}, a_color=i % 2) for i in range(games)]
    active, res = list(slots), []
    while active:
        orders = {id(s): {} for s in active}
        for p in {id(pa): pa, id(pb): pb}.values():
            mine = [(s, c) for s in active for c in (WHITE, BLACK) if s['players'][c] is p]
            if not mine:
                continue
            if isinstance(p, NetPlayer):
                rs = p.searcher.run([(s['g'], mode, None, None) for s, _ in mine])
                for (s, c), r in zip(mine, rs):
                    acts, probs = (r['wa'], r['x']) if c == WHITE else (r['ba'], r['y'])
                    a = pick(acts, probs, rng, p.temperature)
                    orders[id(s)][c] = [a[0]] if mode == 0 else [a[0], a[1]]
            else:
                for s, c in mine:
                    orders[id(s)][c] = p.act(s['g'], c, mode)
        for s in list(active):
            w, b = orders[id(s)][WHITE], orders[id(s)][BLACK]
            s['g'] = s['g'].play(w[0], b[0]) if mode == 0 else s['g'].play2(w[0], w[1], b[0], b[1])
            if s['g'].result or s['g'].round > max_rounds:
                o = outcome(s['g'])
                res.append(o if s['a_color'] == WHITE else -o)
                active.remove(s)
    return np.array(res)


def summary(r):
    w, d, l = int((r > 0).sum()), int((r == 0).sum()), int((r < 0).sum())
    sc = (w + 0.5 * d) / len(r)
    se = np.sqrt(max(sc * (1 - sc), 1e-9) / len(r))
    elo = -400 * np.log10(1 / min(max(sc, 1e-3), 1 - 1e-3) - 1)
    return dict(w=w, d=d, l=l, score=round(sc, 4), se=round(se, 4), elo=round(float(elo)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--players', nargs='+', required=True, help='name=spec')
    ap.add_argument('--pairs', required=True, help='comma list a-b')
    ap.add_argument('--modes', default='1v1,2v2')
    ap.add_argument('--games', type=int, default=100)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    ap.add_argument('--out', default=None)
    ap.add_argument('--seed', type=int, default=0)
    o = ap.parse_args()
    rng = np.random.default_rng(o.seed)
    hc.seed(o.seed)
    specs = dict(p.split('=', 1) for p in o.players)
    players = {k: build(v, o.device, rng) for k, v in specs.items()}
    results = []
    for pair in o.pairs.split(','):
        a, b = pair.split('-')
        for mode in o.modes.split(','):
            t = time.time()
            r = play_match(players[a], players[b], 0 if mode == '1v1' else 1, o.games, rng)
            rec = dict(a=a, b=b, a_spec=specs[a], b_spec=specs[b], mode=mode, games=o.games, secs=round(time.time() - t), **summary(r))
            print(json.dumps(rec), flush=True)
            results.append(rec)
            if o.out:
                with open(o.out, 'a') as f:
                    f.write(json.dumps(rec) + '\n')


if __name__ == '__main__':
    main()
