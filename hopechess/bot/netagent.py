"""Network-guided matrix-search agent (see search.py)."""
import numpy as np
import torch
import model
from search import Evaluator, Searcher, WHITE


class NetAgent:
    def __init__(self, net, device='cpu', temperature=1.0, seed=None, **search_kw):
        self.rng = np.random.default_rng(seed)
        self.searcher = Searcher(Evaluator(net, device), rng=self.rng, **search_kw)
        self.temperature = temperature
        self.name = 'net'
        self.last = None

    def pick(self, acts, probs):
        probs = np.maximum(np.asarray(probs, np.float64), 0)
        if self.temperature <= 0:
            return acts[int(np.argmax(probs))]
        p = probs ** (1.0 / self.temperature)
        p /= p.sum()
        return acts[self.rng.choice(len(acts), p=p)]

    def act(self, game, color, mode, reserved=None):
        r = self.searcher.run([(game, mode, color if reserved is not None else None, reserved)])[0]
        self.last = r
        acts, probs = (r['wa'], r['x']) if color == WHITE else (r['ba'], r['y'])
        a = self.pick(acts, probs)
        if mode == 0:
            return [a[0]]
        if reserved is not None:
            return [a[1]]
        return [a[0], a[1]]


def from_spec(spec, seed=None, threads=1):
    """'path.pt[:k1=24][:deepen=8][:temperature=0.5]...'"""
    parts = spec.split(':')
    torch.set_num_threads(threads)
    net, _ = model.load(parts[0])
    kw = {}
    for kv in parts[1:]:
        k, v = kv.split('=')
        kw[k] = float(v) if k in ('temperature', 'noise') else int(v)
    return NetAgent(net, seed=seed, **kw)
