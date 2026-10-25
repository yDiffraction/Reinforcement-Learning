"""Agents for hopechess. Every agent implements

    act(game, color, mode, reserved=None) -> list of move codes

mode 0 = 1v1 (returns [move]), mode 1 = 2v2 (returns [move_a, move_b] for the
whole team; with `reserved` set to a teammate's already-submitted order it
returns [own_move]). A code of -1 is a pass.
"""
import numpy as np
import hcengine as hc

WHITE, BLACK = 0, 1


def sign(color):
    return 1.0 if color == WHITE else -1.0


class RandomAgent:
    name = 'random'

    def __init__(self, seed=None):
        self.rng = np.random.default_rng(seed)

    def act(self, game, color, mode, reserved=None):
        if mode == 0:
            moves = game.legal(color)
            return [int(self.rng.choice(moves)) if moves else -1]
        if reserved is not None:
            moves = game.team_legal(color, reserved)
            return [int(self.rng.choice(moves)) if moves else -1]
        acts = game.team_actions(color)
        return list(acts[self.rng.integers(len(acts))])


class ComputerAgent:
    """The upstream engine.js computer ('normal' or 'hard'). For 2v2 the two
    teammates choose one after the other, the second respecting reservations."""

    def __init__(self, hard=True):
        self.hard = hard
        self.name = 'computer-hard' if hard else 'computer-normal'

    def _one(self, game, color, allowed=None):
        if allowed is not None and not allowed:
            return -1
        return hc.computer_move(game, color, self.hard, allowed or [])

    def act(self, game, color, mode, reserved=None):
        if mode == 0:
            return [self._one(game, color)]
        if reserved is not None:
            return [self._one(game, color, game.team_legal(color, reserved))]
        a = self._one(game, color)
        b = self._one(game, color, game.team_legal(color, a)) if a >= 0 else -1
        return [a, b]


# ---------------------------------------------------------------- matrix search
class MatrixSearchAgent:
    """Depth-1 simultaneous-move search: build the payoff matrix of candidate
    joint actions using a value function on successor states, solve the
    zero-sum matrix game and sample from our Nash strategy.

    Subclasses provide:
      values(game, mode, wa, ba) -> np.ndarray [len(wa), len(ba)] white-view value
      priors(game, mode) -> (white_prior: dict code->p, black_prior) or None
    """
    name = 'matrix'

    def __init__(self, k1=48, k_single=12, k_pairs=40, nash_iters=1000, temperature=1.0, seed=None):
        self.k1, self.k_single, self.k_pairs = k1, k_single, k_pairs
        self.nash_iters = nash_iters
        self.temperature = temperature
        self.rng = np.random.default_rng(seed)
        self.last = None

    # --- candidate generation
    def single_candidates(self, game, color, prior, k):
        moves = game.legal(color)
        if not moves:
            return [-1]
        if prior is None or len(moves) <= k:
            return moves
        return sorted(moves, key=lambda m: -prior.get(m, 0.0))[:k]

    def team_candidates(self, game, color, prior, reserved=None):
        if reserved is not None:
            moves = game.team_legal(color, reserved)
            return [(reserved, m) for m in moves] or [(reserved, -1)]
        acts = game.team_actions(color)
        if len(acts) <= self.k_pairs or prior is None:
            return [tuple(a) for a in acts]
        p = lambda m: prior.get(m, 0.0) if m >= 0 else 0.0
        singles = set(sorted({m for a in acts for m in a if m >= 0}, key=lambda m: -p(m))[:self.k_single])
        pool = [a for a in acts if (a[0] in singles or a[0] < 0) and (a[1] in singles or a[1] < 0)]
        if len(pool) < 4:
            pool = acts
        pool = sorted(pool, key=lambda a: -(p(a[0]) + 1e-3) * (p(a[1]) + 1e-3) if a[1] >= 0 else -(p(a[0]) + 1e-3) * 1e-3)
        return [tuple(a) for a in pool[:self.k_pairs]]

    def priors(self, game, mode):
        return None

    def values(self, game, mode, wa, ba):
        raise NotImplementedError

    def search(self, game, mode, reserved_color=None, reserved=None):
        pri = self.priors(game, mode)
        pw, pb = (pri if pri else (None, None))
        if mode == 0:
            wa = [(m, -1) for m in self.single_candidates(game, WHITE, pw, self.k1)]
            ba = [(m, -1) for m in self.single_candidates(game, BLACK, pb, self.k1)]
        else:
            wa = self.team_candidates(game, WHITE, pw, reserved if reserved_color == WHITE else None)
            ba = self.team_candidates(game, BLACK, pb, reserved if reserved_color == BLACK else None)
        M = self.values(game, mode, wa, ba)
        x, y, v = hc.solve_nash(M.astype(np.float64), self.nash_iters)
        self.last = dict(wa=wa, ba=ba, x=x, y=y, v=v, M=M, priors=pri)
        return wa, ba, x, y, v

    def pick(self, acts, probs):
        probs = np.maximum(np.asarray(probs, dtype=np.float64), 0)
        if self.temperature <= 0:
            return acts[int(np.argmax(probs))]
        p = probs ** (1.0 / self.temperature)
        p /= p.sum()
        return acts[self.rng.choice(len(acts), p=p)]

    def act(self, game, color, mode, reserved=None):
        wa, ba, x, y, v = self.search(game, mode, color if reserved is not None else None, reserved)
        acts, probs = (wa, x) if color == WHITE else (ba, y)
        a = self.pick(acts, probs)
        if mode == 0:
            return [a[0]]
        if reserved is not None:
            return [a[1]]
        return [a[0], a[1]]


class HeuristicNashAgent(MatrixSearchAgent):
    """Matrix search with the upstream material/position evaluation squashed
    by tanh. Team candidates come from a 1v1-style single-move matrix."""
    name = 'heur-nash'

    def __init__(self, scale=400.0, **kw):
        super().__init__(**kw)
        self.scale = scale

    def values(self, game, mode, wa, ba):
        return hc.heuristic_values(game, mode, wa, ba, self.scale).reshape(len(wa), len(ba))

    def priors(self, game, mode):
        if mode == 0:
            return None
        # single-move matrix (as if each team moved one piece) for move ranking
        wm, bm = game.legal(WHITE), game.legal(BLACK)
        if not wm or not bm:
            return None
        wa, ba = [(m, -1) for m in wm], [(m, -1) for m in bm]
        M = hc.heuristic_values(game, 1, wa, ba, self.scale).reshape(len(wa), len(ba))
        x, y, _ = hc.solve_nash(M.astype(np.float64), 300)
        # rank by Nash weight plus mean payoff (keeps strong but unmixed moves)
        sw = x + 0.05 * (M.mean(1) - M.mean(1).min())
        sb = y + 0.05 * (-(M.mean(0)) + M.mean(0).max())
        return dict(zip(wm, sw)), dict(zip(bm, sb))
