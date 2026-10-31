"""Remote API contract test: does a hopechess server still speak the API of
the upstream snapshot (upstream/server.mjs) that client.py and play.py use?

    python tests/apitest.py                                   # local upstream vs the live site
    python tests/apitest.py --remote https://example.org/hopechess --no-bot
    python tests/apitest.py --remote none                     # local upstream only

The same scenarios run against a local copy of upstream/server.mjs (the
reference) and against the remote server: room list, create/join, snapshot
and watch, the SSE event stream, 1v1 and 2v2 rounds with legal and illegal
moves, private team orders, resign, rematch, leave and room deletion. Every
round the client's history replay (client.rebuild) must reproduce the server
board exactly. Response shapes (keys and types) and status codes from the
remote server are compared with the reference; extra keys are reported but
allowed, missing keys or different status codes fail. Finally client.Bot
plays a few rounds on each server (--no-bot skips this). All rooms are
unrated and every seat leaves at the end, which deletes the room.
"""
import argparse, json, os, random, shutil, socket, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import hcengine as hc
import client

UPSTREAM = os.path.join(HERE, '..', '..', 'upstream')
LIVE = 'https://keksimperium.com/hopechess'
TRACE = bool(os.environ.get('APITEST_TRACE'))


class Api:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.opened = []   # (code, token) of every seat taken, for cleanup

    def call(self, path, body=None):
        """Returns (status, json)."""
        t = time.time()
        try:
            return self._call(path, body)
        finally:
            if TRACE:
                print(f'    {time.time() - t:5.2f}s {"POST" if body is not None else "GET "} {path}', flush=True)

    def _call(self, path, body):
        try:
            with client.request(self.base + path, body, timeout=20) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read())
            except ValueError:
                return e.code, None

    def ok(self, path, body=None, status=(200, 201)):
        s, j = self.call(path, body)
        if s not in status:
            raise AssertionError(f'{path}: HTTP {s} {j}')
        return j

    def seat(self, reply):
        self.opened.append((reply['code'], reply['token']))
        return reply

    def first_state(self, code, query, timeout=15):
        """Open the event stream and return the first state event."""
        url = f'{self.base}/api/rooms/{code}/events?{query}'
        with client.request(url, timeout=timeout) as resp:
            ctype = resp.headers.get('Content-Type', '')
            event, data = None, []
            for raw in resp:
                line = raw.decode().rstrip('\r\n')
                if line.startswith('event:'):
                    event = line[6:].strip()
                elif line.startswith('data:'):
                    data.append(line[5:].strip())
                elif line == '' and event == 'state':
                    return ctype, json.loads('\n'.join(data))
        raise AssertionError('event stream closed before a state event')

    def cleanup(self):
        for code, token in reversed(self.opened):
            self.call(f'/api/rooms/{code}/leave', {'token': token})
        self.opened.clear()


def shape(v):
    if isinstance(v, dict):
        return {k: shape(x) for k, x in v.items()}
    if isinstance(v, list):
        return [shape(v[0])] if v else []
    if v is None:
        return None
    return type(v).__name__


def compare(ref, got, path, out):
    """Report keys the remote lacks (breaking) and keys it adds (fine)."""
    if ref is None or got is None:
        return   # null is compatible with any type (results, clocks, accounts)
    if isinstance(ref, dict):
        if not isinstance(got, dict):
            out['broken'].append(f'{path}: expected object, got {got}')
            return
        for k in ref:
            if k in got:
                compare(ref[k], got[k], f'{path}.{k}', out)
            else:
                out['broken'].append(f'{path}.{k}: missing')
        for k in got:
            if k not in ref:
                out['added'].append(f'{path}.{k}')
    elif isinstance(ref, list):
        if not isinstance(got, list):
            out['broken'].append(f'{path}: expected list, got {got}')
        elif ref and got:
            compare(ref[0], got[0], f'{path}[]', out)
    elif ref != got and not {ref, got} <= {'int', 'float'}:
        out['broken'].append(f'{path}: {ref} -> {got}')


def random_move(g, color, rng, reserved=-1):
    moves = g.team_legal(color, reserved) if reserved >= 0 else g.legal(color)
    return rng.choice(moves) if moves else -1


def check_board(api, code, token, mode, log):
    snap = api.ok(f'/api/rooms/{code}?token={urllib.parse.quote(token)}')
    g = client.rebuild(snap['game'], mode)   # raises on any mismatch
    log.append(('snapshot', shape(snap)))
    return snap, g


def scenario(base, rounds, rng):
    """Runs all scenarios; returns (record, checks) where record maps a step
    name to (status, shape) for comparison and checks lists passed checks."""
    api = Api(base)
    rec, checks = {}, []

    def step(name, path, body=None, expect=None):
        s, j = api.call(path, body)
        rec[name] = (s, shape(j) if s < 300 else None)
        if expect is not None and s != expect:
            raise AssertionError(f'{name}: expected HTTP {expect}, got {s} {j}')
        return s, j

    def check(name, cond, detail=''):
        if not cond:
            raise AssertionError(f'{name} failed {detail}')
        checks.append(name)

    try:
        _, rooms = step('list rooms', '/api/rooms', expect=200)
        check('room list', isinstance(rooms.get('rooms'), list))
        taken = {r['code'] for r in rooms['rooms']}

        # ---------- validation errors ----------
        step('create: bad time limit', '/api/rooms', {'mode': '1v1', 'timeLimitMinutes': 2, 'rated': False}, expect=400)
        step('create: bad color', '/api/rooms', {'color': 'green', 'rated': False}, expect=400)
        step('create: bad rated', '/api/rooms', {'rated': 'yes'}, expect=400)
        missing = next(c for c in (f'{i:04d}' for i in rng.sample(range(10000), 200)) if c not in taken)
        step('unknown room', f'/api/rooms/{missing}/watch', expect=404)
        step('unknown endpoint', '/api/nothing-here', expect=404)

        # ---------- 1v1 ----------
        s, a = step('create 1v1', '/api/rooms', {'mode': '1v1', 'color': 'white', 'timeLimitMinutes': 10, 'rated': False}, expect=201)
        api.seat(a)
        code = a['code']
        check('create returns seat', a['seat'] == 'white' and a['color'] == 'white' and len(code) == 4 and a['token'])
        check('guest identity issued', 'identity' in a)
        check('waiting snapshot', a['snapshot']['game']['round'] == 1 and not a['snapshot']['members'][1]['joined'])
        step('move before opponent joins', f'/api/rooms/{code}/move',
             {'token': a['token'], 'gameId': a['snapshot']['gameId'], 'round': 1, 'move': {'from': 52, 'to': 36}}, expect=409)
        step('bad token', f'/api/rooms/{code}?token=nope', expect=401)
        _, b = step('join 1v1', f'/api/rooms/{code}/join', {'color': 'random'}, expect=200)
        api.seat(b)
        check('join takes open seat', b['seat'] == 'black')
        step('join full room', f'/api/rooms/{code}/join', {'color': 'random'}, expect=409)
        _, w = step('watch', f'/api/rooms/{code}/watch', expect=200)
        check('spectator snapshot', w['spectator'] is True and w['yourSeat'] is None and w['yourMove'] is None)
        ctype, ev = api.first_state(code, f'token={urllib.parse.quote(a["token"])}')
        rec['event stream state'] = (200, shape(ev))
        check('SSE content type', ctype.startswith('text/event-stream'), ctype)
        check('SSE state is a player snapshot', ev['yourSeat'] == 'white' and ev['code'] == code)
        ctype, ev = api.first_state(code, 'watch=1')
        check('SSE spectator stream', ev['spectator'] is True)
        check('clock configured', ev['clock']['limitMinutes'] == 10)

        tok = {'white': a['token'], 'black': b['token']}
        gid = b['snapshot']['gameId']
        snap, g = check_board(api, code, tok['white'], 0, [])
        step('illegal move', f'/api/rooms/{code}/move', {'token': tok['white'], 'gameId': gid, 'round': 1, 'move': {'from': 52, 'to': 20}}, expect=400)
        step('wrong round', f'/api/rooms/{code}/move', {'token': tok['white'], 'gameId': gid, 'round': 7, 'move': {'from': 52, 'to': 36}}, expect=409)
        step('wrong game id', f'/api/rooms/{code}/move', {'token': tok['white'], 'gameId': 'x', 'round': 1, 'move': {'from': 52, 'to': 36}}, expect=409)
        step('pass with legal moves', f'/api/rooms/{code}/move', {'token': tok['white'], 'gameId': gid, 'round': 1, 'move': None}, expect=400)
        played = 0
        for _ in range(rounds):
            if g.result:
                break
            r = g.round
            mw, mb = random_move(g, 0, rng), random_move(g, 1, rng)
            _, sw = step('move', f'/api/rooms/{code}/move', {'token': tok['white'], 'gameId': gid, 'round': r, 'move': client.move_json(mw)}, expect=200)
            check('own pending move visible', sw['yourMove'] is not None and sw['submitted']['white'] and not sw['submitted']['black'])
            _, other = step('snapshot', f'/api/rooms/{code}?token={urllib.parse.quote(tok["black"])}', expect=200)
            check('opponent order hidden', other['yourMove'] is None and other['teamMoves'] == [] and other['seatSubmitted']['white'])
            step('double move', f'/api/rooms/{code}/move', {'token': tok['white'], 'gameId': gid, 'round': r, 'move': client.move_json(mw)}, expect=409)
            step('move', f'/api/rooms/{code}/move', {'token': tok['black'], 'gameId': gid, 'round': r, 'move': client.move_json(mb)}, expect=200)
            snap, g = check_board(api, code, tok['white'], 0, [])
            check('round resolved', snap['game']['round'] == r + 1 or snap['game']['result'])
            played += 1
        check(f'1v1 replay matches server board ({played} rounds)', True)
        if not g.result:
            _, rs = step('resign', f'/api/rooms/{code}/resign', {'token': tok['black'], 'gameId': gid}, expect=200)
            check('resign ends game', rs['game']['result']['winner'] == 'white' and rs['game']['result']['reasonCode'] == 'resigned')
        step('rematch', f'/api/rooms/{code}/rematch', {'token': tok['white'], 'gameId': gid}, expect=200)
        _, rm = step('rematch', f'/api/rooms/{code}/rematch', {'token': tok['black'], 'gameId': gid}, expect=200)
        check('rematch starts a fresh game', rm['gameId'] != gid and rm['game']['round'] == 1 and not rm['game']['result'])
        _, lv = step('leave', f'/api/rooms/{code}/leave', {'token': tok['black']}, expect=200)
        check('leave reply', lv['ok'] is True)
        step('leave', f'/api/rooms/{code}/leave', {'token': tok['white']}, expect=200)
        api.opened.clear()
        step('room deleted after everyone leaves', f'/api/rooms/{code}/watch', expect=404)

        # ---------- 2v2 ----------
        _, a = step('create 2v2', '/api/rooms', {'mode': '2v2', 'color': 'white', 'rated': False}, expect=201)
        api.seat(a)
        code = a['code']
        seats = {'white': a}
        for team in ('black', 'white', 'black'):
            _, j = step('join 2v2', f'/api/rooms/{code}/join', {'color': team}, expect=200)
            seats[api.seat(j)['seat']] = j
        check('2v2 seat ids', sorted(seats) == ['black', 'black2', 'white', 'white2'])
        tok = {k: v['token'] for k, v in seats.items()}
        snap, g = check_board(api, code, tok['white'], 1, [])
        gid = snap['gameId']
        played = 0
        for _ in range(rounds):
            if g.result:
                break
            r = g.round
            w1 = random_move(g, 0, rng)
            w2 = random_move(g, 0, rng, w1)
            b1 = random_move(g, 1, rng)
            b2 = random_move(g, 1, rng, b1)
            step('move 2v2', f'/api/rooms/{code}/move', {'token': tok['white'], 'gameId': gid, 'round': r, 'move': client.move_json(w1)}, expect=200)
            _, mate = step('snapshot 2v2', f'/api/rooms/{code}?token={urllib.parse.quote(tok["white2"])}', expect=200)
            check('teammate sees pending order', [t['seat'] for t in mate['teamMoves']] == ['white'] and client.code_of(mate['teamMoves'][0]['move']) == w1)
            _, opp = step('snapshot 2v2', f'/api/rooms/{code}?token={urllib.parse.quote(tok["black"])}', expect=200)
            check('opponents do not see team orders', opp['teamMoves'] == [] and opp['seatSubmitted']['white'])
            if w1 >= 0 and w2 >= 0:
                s, _ = api.call(f'/api/rooms/{code}/move', {'token': tok['white2'], 'gameId': gid, 'round': r, 'move': client.move_json(w1)})
                check('reserved piece rejected', s == 400)
            for seat, m in (('white2', w2), ('black', b1), ('black2', b2)):
                s, j = api.call(f'/api/rooms/{code}/move', {'token': tok[seat], 'gameId': gid, 'round': r, 'move': client.move_json(m)})
                # a forced pass is submitted by the server itself
                if s == 409 and m < 0:
                    continue
                if s != 200:
                    raise AssertionError(f'2v2 move {seat}: HTTP {s} {j}')
            snap, g = check_board(api, code, tok['white2'], 1, [])
            check('2v2 round resolved', snap['game']['round'] == r + 1 or snap['game']['result'])
            played += 1
        check(f'2v2 replay matches server board ({played} rounds)', True)
        if not g.result:
            _, rs = step('resign 2v2', f'/api/rooms/{code}/resign', {'token': tok['black2'], 'gameId': gid}, expect=200)
            check('2v2 resign forfeits for the team', rs['game']['result']['winner'] == 'white')
        api.cleanup()
        step('2v2 room deleted', f'/api/rooms/{code}/watch', expect=404)
    finally:
        api.cleanup()
    return rec, checks


def bot_scenario(base, rounds, agent_spec, device):
    """client.Bot (the real bot client) plays `rounds` rounds against a scripted opponent."""
    from arena import make_agent
    api = Api(base)
    rng = random.Random(5)
    agent = make_agent(agent_spec, seed=0, threads=os.cpu_count() or 4, device=device)
    bot = None
    try:
        human = api.seat(api.ok('/api/rooms', {'mode': '1v1', 'color': 'white', 'rated': False}))
        code = human['code']
        bot = client.Bot(base, agent, verbose=False, rematch=False, log=lambda msg: None)
        api.seat(bot.join(code, 'black'))
        threading.Thread(target=bot.run, daemon=True).start()
        gid, moved = human['snapshot']['gameId'], 0
        deadline = time.time() + 60 + rounds * 30
        while moved < rounds and time.time() < deadline:
            snap = api.ok(f'/api/rooms/{code}?token={urllib.parse.quote(human["token"])}')
            g = client.rebuild(snap['game'], 0)
            if g.result:
                break
            if not snap['seatSubmitted']['white']:
                api.ok(f'/api/rooms/{code}/move', {'token': human['token'], 'gameId': gid, 'round': g.round,
                                                   'move': client.move_json(random_move(g, 0, rng))})
            elif not snap['seatSubmitted']['black']:
                time.sleep(0.3)
                continue
            moved = snap['game']['round'] - 1
            time.sleep(0.1)
        snap = api.ok(f'/api/rooms/{code}?token={urllib.parse.quote(human["token"])}')
        bot_moves = sum(1 for r in snap['game']['history'] if r['moves'][1])
        if bot_moves < min(rounds, len(snap['game']['history'])) or not snap['game']['history']:
            raise AssertionError(f'bot made {bot_moves} moves in {len(snap["game"]["history"])} rounds')
        return f'client.Bot played {bot_moves} rounds ({agent_spec.split(":")[0] if "/" not in agent_spec else "net"}, {device})'
    finally:
        if bot:
            bot.stop(leave=False)
        api.cleanup()


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def start_upstream():
    port = free_port()
    data = tempfile.mkdtemp(prefix='hc-apitest-')
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', DATA_DIR=data)
    proc = subprocess.Popen(['node', 'server.mjs'], cwd=UPSTREAM, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/rooms', timeout=1)
            return proc, f'http://127.0.0.1:{port}', data
        except Exception:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError('upstream server did not start')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--remote', default=LIVE, help="server to check against the upstream snapshot ('none' to skip)")
    ap.add_argument('--rounds', type=int, default=12)
    ap.add_argument('--no-bot', action='store_true', help='skip the client.Bot rounds')
    ap.add_argument('--agent', default='net:' + os.path.join(HERE, '..', 'models', 'best.pt') + ':deepen=4')
    ap.add_argument('--device', default='auto')
    o = ap.parse_args()

    proc, local, data = start_upstream()
    failed = False
    try:
        print(f'reference: upstream/server.mjs at {local}')
        ref, checks = scenario(local, o.rounds, random.Random(1))
        print(f'  {len(set(checks))} distinct checks passed, {len(ref)} endpoints recorded')
        if not o.no_bot:
            print(' ', bot_scenario(local, 3, o.agent, o.device))
        if o.remote != 'none':
            print(f'remote: {o.remote}')
            try:
                got, checks = scenario(o.remote, o.rounds, random.Random(1))
                print(f'  {len(set(checks))} distinct checks passed')
            except AssertionError as e:
                print('  FAIL:', e)
                failed = True
                got = {}
            out = {'broken': [], 'added': []}
            for name, (status, sh) in ref.items():
                if name not in got:
                    continue
                if got[name][0] != status:
                    out['broken'].append(f'{name}: HTTP {status} upstream, {got[name][0]} remote')
                elif sh is not None:
                    compare(sh, got[name][1], name, out)
            for line in sorted(set(out['added'])):
                print('  + remote adds', line)
            for line in sorted(set(out['broken'])):
                print('  ! INCOMPATIBLE', line)
            failed |= bool(out['broken'])
            if not o.no_bot and not failed:
                print(' ', bot_scenario(o.remote, 3, o.agent, o.device))
    except AssertionError as e:
        print('FAIL:', e)
        failed = True
    finally:
        proc.kill()
        shutil.rmtree(data, ignore_errors=True)
    print('RESULT:', 'FAIL' if failed else 'OK, the remote API matches the upstream snapshot')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
