"""Network-guided matrix-search agent (see search.py)."""
import numpy as np
import torch
import model
from search import Evaluator, Searcher, WHITE


class NetAgent:
    def __init__(self, net, device='cpu', temperature=1.0, seed=None, solo=0, beta=0.0, solo_temperature=0.0, **search_kw):
        self.rng = np.random.default_rng(seed)
        self.searcher = Searcher(Evaluator(net, device), rng=self.rng, **search_kw)
        self.temperature = temperature
        self.name = 'net'
        # solo=1: when moving first in 2v2, assume an independent teammate
        # (value own moves by expectation over the teammate's likely replies)
        self.solo = solo
        self.beta = beta
        # A lone first mover should not randomize: the Nash mix is meant for a
        # jointly randomized team pair (see FINDINGS.md section 6).
        self.solo_temperature = solo_temperature
        self.last = None

    def pick(self, acts, probs, temperature=None):
        t = self.temperature if temperature is None else temperature
        probs = np.maximum(np.asarray(probs, np.float64), 0)
        if t <= 0:
            return acts[int(np.argmax(probs))]
        p = probs ** (1.0 / t)
        p /= p.sum()
        return acts[self.rng.choice(len(acts), p=p)]

    def act(self, game, color, mode, reserved=None):
        if mode == 1 and reserved is None and self.solo:
            r = self.searcher.run_first_mover(game, color, beta=self.beta)
            self.last = r
            m = self.pick([(m,) for m in r['moves']], r['probs'], self.solo_temperature)[0]
            allowed = game.team_legal(color, m) if m >= 0 else []
            # second element only matters if the caller controls both seats
            b = max(allowed, key=lambda c: 0) if allowed else -1
            return [m, b]
        r = self.searcher.run([(game, mode, color if reserved is not None else None, reserved)])[0]
        self.last = r
        acts, probs = (r['wa'], r['x']) if color == WHITE else (r['ba'], r['y'])
        a = self.pick(acts, probs)
        if mode == 0:
            return [a[0]]
        if reserved is not None:
            return [a[1]]
        return [a[0], a[1]]


def pick_device(name='auto'):
    """'auto' prefers CUDA, then Intel XPU (torch.xpu, e.g. an iGPU), then CPU."""
    if name != 'auto':
        return name
    if torch.cuda.is_available():
        return 'cuda'
    if hasattr(torch, 'xpu') and torch.xpu.is_available():
        return 'xpu'
    return 'cpu'


def from_spec(spec, seed=None, threads=1, device='cpu'):
    """'path.pt[:k1=24][:deepen=8][:temperature=0.5][:device=xpu]...'"""
    parts = spec.split(':')
    # Windows paths: re-join a drive letter split off by the ':' separator
    if len(parts) > 1 and len(parts[0]) == 1 and parts[1][:1] in ('\\', '/'):
        parts = [parts[0] + ':' + parts[1]] + parts[2:]
    torch.set_num_threads(threads)
    kw = {}
    for kv in parts[1:]:
        k, v = kv.split('=')
        if k == 'device':
            device = v
        else:
            kw[k] = float(v) if k in ('temperature', 'noise', 'beta', 'solo_temperature', 'budget') else int(v)
    device = pick_device(device)
    net, _ = model.load(parts[0], device)
    return NetAgent(model.fuse(net), device=device, seed=seed, **kw)
