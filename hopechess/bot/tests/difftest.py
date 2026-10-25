"""Differential test: random/heuristic games played with the C++ engine are
replayed through upstream engine.js; every round's board, rest flags,
hasMoved, en passant rights, counters, result and legal move sets must match.

usage: python3 tests/difftest.py [games_per_mode] [seed]
"""
import json, os, random, subprocess, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import hcengine as hc

REASONS = {1: 'Both kings', 2: 'king was captured', 3: 'Neither player', 4: 'three times', 5: '100 rounds'}


def is_quiet(g, code):
    b = g.board()
    frm, to = code & 63, (code >> 6) & 63
    return b[frm][1] != 'p' and b[to] == '.'


def pick(g, color, style, rng, allowed=None):
    moves = allowed if allowed is not None else g.legal(color)
    if not moves:
        return -1
    if style == 'heur' and allowed is None and rng.random() < 0.7:
        return hc.computer_move(g, color, rng.random() < 0.5)
    if style == 'quiet':
        q = [m for m in moves if is_quiet(g, m)]
        if q and rng.random() < 0.95:
            return rng.choice(q)
    return rng.choice(moves)


def snap(g):
    return dict(board=g.board(), moved=[m if p != '.' else 0 for m, p in zip(g.has_moved(), g.board())],
                result=g.result, reason=g.reason, noProgress=g.no_progress,
                ep=[[c, sq, to] for c, _, sq, to in g.ep_rights()],
                white=sorted(g.legal(0)), black=sorted(g.legal(1)))


def play(mode, rng, max_rounds=250):
    g = hc.Game()
    style = rng.choice(['rand', 'heur', 'quiet'])
    rounds, snaps = [], [snap(g)]
    while not g.result and len(rounds) < max_rounds:
        if mode == '1v1':
            o = [pick(g, 0, style, rng), pick(g, 1, style, rng)]
            g = g.play(*o)
        else:
            o = []
            for color in (0, 1):
                a = pick(g, color, style, rng)
                b = pick(g, color, style, rng, g.team_legal(color, a)) if a >= 0 else -1
                o += [a, b]
            g = g.play2(*o)
        rounds.append(o)
        snaps.append(snap(g))
    return dict(mode=mode, rounds=rounds), snaps


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    hc.seed(rng.randrange(1 << 30))
    games, ours = [], []
    for mode in ('1v1', '2v2'):
        for _ in range(n):
            gm, sn = play(mode, rng)
            games.append(gm); ours.append(sn)
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(games, f)
    js = json.loads(subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'difftest.mjs'), f.name],
                                   capture_output=True, text=True, check=True).stdout)
    os.unlink(f.name)
    bad = 0
    reasons = {}
    for gi, (a, b) in enumerate(zip(ours, js)):
        for ri, (x, y) in enumerate(zip(a, b)):
            winner = {0: None, 1: 'white', 2: 'black', 3: 'draw'}[x['result']]
            diffs = [k for k in ('board', 'moved', 'noProgress', 'ep', 'white', 'black') if x[k] != y[k]]
            if winner != y['winner'] or (winner and REASONS[x['reason']] not in y['reason']):
                diffs.append('result')
            if diffs:
                bad += 1
                print(f'game {gi} ({games[gi]["mode"]}) round {ri}: mismatch {diffs}')
                for k in diffs[:2]:
                    print('  cpp', x.get(k, x['result']), '\n  js ', y.get(k, y['winner']))
                break
        r = a[-1]['reason']
        reasons[(games[gi]['mode'], r)] = reasons.get((games[gi]['mode'], r), 0) + 1
    rounds = sum(len(g['rounds']) for g in games)
    print(f'{len(games)} games, {rounds} rounds, mismatching games: {bad}')
    print('end reasons (mode, code):', dict(sorted(reasons.items())))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
