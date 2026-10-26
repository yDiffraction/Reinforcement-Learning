"""Play on a hopechess multiplayer server (upstream server.mjs) as a bot seat.

    # create a 2v2 room and take a White seat
    python3 client.py --server http://localhost:4173 --create --mode 2v2 --color white
    # join an existing room (any open seat, or a team)
    python3 client.py --server http://localhost:4173 --room 0421 --color black
Agent: --agent models/best.pt[:deepen=N] (default models/best.pt:deepen=16) | computer-hard | heur-nash | random

The bot rebuilds the exact engine state by replaying the room's round
history, so repetition counts and rest flags match the server. In 2v2 it
reads its teammate's pending order (shared within a team) and plays the best
complementary move. With a human teammate (default) it first waits --wait
seconds for that order; if none comes it moves first with a move that is
robust to the teammate's likely replies. With --teammate bot (two bot
clients on one team) the primary seat moves at once and
the second seat complements it.
"""
import argparse, json, os, sys, threading, time, urllib.error, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hcengine as hc
from arena import make_agent

PROMO = {'q': 1, 'r': 2, 'b': 3, 'n': 4}
PROMO_NAME = {1: 'q', 2: 'r', 3: 'b', 4: 'n'}


def code_of(m):
    if not m or m.get('pass'):
        return -1
    return m['from'] | (m['to'] << 6) | (PROMO.get(m.get('promotion'), 0) << 12)


def move_json(code):
    if code < 0:
        return None
    m = {'from': code & 63, 'to': (code >> 6) & 63}
    if code >> 12:
        m['promotion'] = PROMO_NAME[code >> 12]
    return m


def rebuild(game_json, mode):
    """Replay the server's round history with the C++ engine."""
    g = hc.Game()
    for rnd in game_json.get('history', []):
        codes = [code_of(m) for m in rnd['moves']]
        g = g.play(*codes) if mode == 0 else g.play2(*codes)
    want = [f"{p['color'][0]}{p['type']}{1 if p.get('resting') else 0}" if p else '.' for p in game_json['board']]
    if g.board() != want or g.round != game_json['round']:
        raise RuntimeError('replayed state does not match the server board')
    return g


class Bot:
    def __init__(self, server, agent, verbose=True, rematch=True, think_delay=0.0, teammate='human', wait=6.0):
        self.server = server.rstrip('/')
        self.agent = agent
        self.verbose = verbose
        self.rematch = rematch
        self.think_delay = think_delay
        self.session = None
        self.done_for = set()
        self.rematched = set()
        self.lock = threading.Lock()
        self.max_deepen = None
        self.teammate, self.wait = teammate, wait
        self.seen, self.timers, self.latest = {}, {}, None

    def req(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        r = urllib.request.Request(self.server + path, data=data, method='GET' if body is None else 'POST',
                                   headers={'Content-Type': 'application/json'} if body is not None else {})
        try:
            with urllib.request.urlopen(r, timeout=15) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors='replace')
            raise RuntimeError(f'{e.code}: {msg}')

    def create(self, mode, color, minutes, rated):
        reply = self.req('/api/rooms', {'mode': mode, 'color': color, 'timeLimitMinutes': minutes, 'rated': rated})
        self.session = reply
        print(f"room {reply['code']} created ({mode}); bot seat {reply['seat']}", flush=True)
        return reply

    def join(self, code, color):
        reply = self.req(f'/api/rooms/{code}/join', {'color': color})
        self.session = reply
        print(f"joined room {reply['code']} as {reply['seat']}", flush=True)
        return reply

    def on_state(self, snap):
        with self.lock:
            game = snap['game']
            mode = 1 if snap['mode'] == '2v2' else 0
            seat, color = snap['yourSeat'], 0 if snap['you'] == 'white' else 1
            if not all(m['joined'] for m in snap['members']):
                return
            if game.get('result'):
                gid = snap['gameId']
                if gid not in self.rematched:
                    self.rematched.add(gid)
                    print('game over:', game['result'].get('reason'), flush=True)
                    if self.rematch:
                        try:
                            self.req(f"/api/rooms/{snap['code']}/rematch", {'token': self.session['token'], 'gameId': gid})
                        except RuntimeError as e:
                            print('rematch:', e, flush=True)
                return
            key = (snap['gameId'], game['round'])
            if snap['seatSubmitted'].get(seat) or key in self.done_for:
                return
            g = rebuild(game, mode)
            reserved = None
            if mode == 1:
                mates = [t for t in snap.get('teamMoves', []) if t['seat'] != seat]
                if mates:
                    reserved = code_of(mates[0]['move'])
                    if reserved < 0:
                        reserved = None
            self.latest = snap
            solo = False
            if mode == 1 and reserved is None:
                # Wait a little for the teammate's order (it reaches us as a
                # reservation), unless we are the primary seat of a bot team.
                primary = seat in ('white', 'black')
                wait = 0.0 if (self.teammate == 'bot' and primary) else self.wait
                first_seen = self.seen.setdefault(key, time.time())
                left = wait - (time.time() - first_seen)
                if left > 0:
                    if key not in self.timers:
                        self.timers[key] = threading.Timer(left + 0.05, lambda: self.on_state(self.latest))
                        self.timers[key].daemon = True
                        self.timers[key].start()
                    return
                # moving first: robust deterministic move (FINDINGS.md section 6)
                solo = True
            if self.think_delay:
                time.sleep(self.think_delay)
            t = time.time()
            self.budget(snap)
            if mode == 0:
                move = self.agent.act(g, color, 0)[0]
            elif reserved is not None:
                move = self.agent.act(g, color, 1, reserved)[0]
            else:
                if hasattr(self.agent, 'solo'):
                    self.agent.solo = int(solo)
                move = self.agent.act(g, color, 1)[0]
            self.done_for.add(key)
            try:
                self.req(f"/api/rooms/{snap['code']}/move", {'token': self.session['token'], 'gameId': snap['gameId'],
                                                             'round': game['round'], 'move': move_json(move)})
                if self.verbose:
                    print(f"round {game['round']}: {seat} plays {move_json(move)} ({time.time() - t:.2f}s)", flush=True)
            except RuntimeError as e:
                print('move rejected:', e, flush=True)
                self.done_for.discard(key)

    def budget(self, snap):
        """Use the selective depth-2 search only when the clock allows it."""
        searcher = getattr(self.agent, 'searcher', None)
        if searcher is None:
            return
        if self.max_deepen is None:
            self.max_deepen = searcher.deepen
        clock = snap.get('clock') or {}
        left = (clock.get('remainingMs') or {}).get(snap['you'])
        if clock.get('limitMinutes') is None or left is None:
            searcher.deepen = self.max_deepen
            return
        per_move = left / 1000.0 / 60.0   # assume ~60 more rounds
        searcher.deepen = (self.max_deepen if per_move > 15 else min(self.max_deepen, 8) if per_move > 8
                           else min(self.max_deepen, 4) if per_move > 3 else 0)

    def run(self):
        s = self.session
        url = f"{self.server}/api/rooms/{s['code']}/events?token={urllib.parse.quote(s['token'])}"
        self.on_state(s['snapshot'])
        while True:
            try:
                with urllib.request.urlopen(url, timeout=60) as resp:
                    event, data = None, []
                    for raw in resp:
                        line = raw.decode().rstrip('\n')
                        if line.startswith('event:'):
                            event = line[6:].strip()
                        elif line.startswith('data:'):
                            data.append(line[5:].strip())
                        elif line == '':
                            if event == 'state' and data:
                                self.on_state(json.loads('\n'.join(data)))
                            event, data = None, []
            except Exception as e:  # reconnect on stream errors / keepalive timeouts
                if self.verbose:
                    print('stream:', e, flush=True)
                time.sleep(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--server', default='http://localhost:4173')
    ap.add_argument('--room', default=None)
    ap.add_argument('--create', action='store_true')
    ap.add_argument('--mode', default='2v2')
    ap.add_argument('--color', default='random')
    ap.add_argument('--minutes', type=int, default=None)
    ap.add_argument('--unrated', action='store_true')
    ap.add_argument('--agent', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'best.pt') + ':deepen=16')
    ap.add_argument('--no-rematch', action='store_true')
    ap.add_argument('--teammate', choices=['human', 'bot'], default='human',
                    help='2v2: human = wait for the teammate, else move robustly first; '
                         'bot = primary seat moves at once, the other seat complements it')
    ap.add_argument('--wait', type=float, default=6.0, help='2v2: seconds to wait for the teammate before moving')
    ap.add_argument('--quiet', action='store_true')
    o = ap.parse_args()
    spec = 'net:' + o.agent if ('.pt' in o.agent and not o.agent.startswith('net:')) else o.agent
    bot = Bot(o.server, make_agent(spec, threads=os.cpu_count() or 4), verbose=not o.quiet, rematch=not o.no_rematch,
              teammate=o.teammate, wait=o.wait)
    if o.create:
        bot.create(o.mode, o.color if o.color != 'random' else 'white', o.minutes, not o.unrated)
    else:
        bot.join(o.room, o.color)
    bot.run()


if __name__ == '__main__':
    main()
