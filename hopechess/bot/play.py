"""Play the bot in your browser on a hopechess server (default: the live site).

    python play.py                       # opens http://localhost:8765
    python play.py --server http://localhost:4173 --port 8765 --no-browser

The page talks to the game server through this process (the server sends no
CORS headers), so your seat is a normal player on that server: the room shows
up in its Watch list and friends can take open seats on the website. Bot
seats run here with client.Bot, on the device you pick (auto prefers CUDA,
then Intel XPU through torch.xpu, then CPU).
"""
import argparse, glob, json, os, sys, threading, time, urllib.error, urllib.parse, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import torch
import client
from arena import make_agent

UI = os.path.join(HERE, 'play')
UPSTREAM = os.path.join(HERE, '..', 'upstream')
STATIC = {'/': (UI, 'index.html'), '/app.js': (UI, 'app.js'), '/style.css': (UI, 'style.css'),
          '/lib/engine.js': (UPSTREAM, 'engine.js'), '/lib/pieces.js': (UPSTREAM, 'pieces.js')}
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'}
ENGINES = {'computer-hard': 'Upstream computer (hard)', 'heur-nash': 'Heuristic Nash', 'random': 'Random moves'}


def devices():
    out = [{'id': 'auto', 'label': 'Auto'}]
    if torch.cuda.is_available():
        out.append({'id': 'cuda', 'label': f'CUDA · {torch.cuda.get_device_name(0)}'})
    if hasattr(torch, 'xpu') and torch.xpu.is_available():
        out.append({'id': 'xpu', 'label': f'XPU · {torch.xpu.get_device_name(0)}'})
    out.append({'id': 'cpu', 'label': f'CPU · {os.cpu_count()} threads'})
    return out


def agent_spec(p):
    engine = p.get('engine', 'best.pt')
    if engine in ENGINES:
        return engine
    path = os.path.join(HERE, 'models', os.path.basename(engine))
    if not os.path.exists(path):
        raise ValueError(f'no model {engine}')
    spec = f"net:{path}:deepen={int(p.get('deepen', 16))}:k1={int(p.get('k1', 24))}:budget={float(p.get('think', 7.5))}"
    spec += f":temperature={float(p.get('temperature', 1.0))}:device={p.get('device', 'auto')}"
    return spec


class BotSeat:
    def __init__(self, server, code, color, params, teammate):
        self.logs, self.code = [], code
        spec = agent_spec(params)
        self.label = ENGINES.get(spec, os.path.basename(params.get('engine', '')))
        agent = make_agent(spec, threads=os.cpu_count() or 4, device=params.get('device', 'auto'))
        self.device = str(getattr(getattr(agent, 'searcher', None), 'ev', None) and agent.searcher.ev.device or 'cpu')
        self.bot = client.Bot(server, agent, rematch=bool(params.get('rematch', True)), teammate=teammate,
                              wait=float(params.get('wait', 6)), log=self.log, budget=bool(params.get('budget', True)))
        self.seat = self.bot.join(code, color)['seat']
        self.thread = threading.Thread(target=self.bot.run, daemon=True)
        self.thread.start()

    def log(self, msg):
        self.logs = (self.logs + [f"{time.strftime('%H:%M:%S')} {msg}"])[-60:]

    def info(self):
        return {'seat': self.seat, 'code': self.code, 'label': self.label, 'device': self.device,
                'running': self.thread.is_alive(), 'log': self.logs[-20:]}


class App:
    def __init__(self, server):
        self.server = server.rstrip('/')
        self.bots = []
        self.lock = threading.Lock()

    def add_bots(self, body):
        code, seats, params = str(body['code']), body['seats'], body.get('params', {})
        # seats join in order, so each lands on the first open seat of its team
        with self.lock:
            added = []
            team_bots = {c: sum(1 for s in seats if s['color'] == c) for c in ('white', 'black')}
            for s in seats:
                # two bots on one team coordinate (primary moves, the other complements);
                # a bot next to a human waits for the human's order first
                teammate = 'bot' if team_bots[s['color']] == 2 else 'human'
                b = BotSeat(self.server, code, s['color'], params, teammate)
                self.bots.append(b)
                added.append(b.info())
            return {'bots': added}

    def stop_bots(self, code=None):
        with self.lock:
            keep = []
            for b in self.bots:
                if code is None or b.code == code:
                    b.bot.stop(leave=True)
                else:
                    keep.append(b)
            self.bots = keep
        return {'ok': True}

    def status(self, code=None):
        return {'bots': [b.info() for b in self.bots if code is None or b.code == code]}


class Handler(BaseHTTPRequestHandler):
    app = None
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def send(self, status, body, ctype='application/json; charset=utf-8'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}') if n else {}

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path in STATIC:
            folder, name = STATIC[url.path]
            with open(os.path.join(folder, name), 'rb') as f:
                return self.send(200, f.read(), TYPES[os.path.splitext(name)[1]])
        if url.path == '/local/config':
            models = sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, 'models', '*.pt')))
            return self.send(200, {'server': self.app.server, 'models': models, 'engines': ENGINES, 'devices': devices()})
        if url.path == '/local/bots':
            return self.send(200, self.app.status(urllib.parse.parse_qs(url.query).get('code', [None])[0]))
        if url.path.startswith('/remote/'):
            return self.proxy(url)
        self.send(404, {'error': 'Not found.'})

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        try:
            if url.path == '/local/server':
                server = self.body().get('server', '').strip().rstrip('/')
                if not server.startswith(('http://', 'https://')):
                    return self.send(400, {'error': 'The server address must start with http:// or https://.'})
                self.app.server = server
                return self.send(200, {'server': server})
            if url.path == '/local/bots':
                return self.send(200, self.app.add_bots(self.body()))
            if url.path == '/local/bots/stop':
                return self.send(200, self.app.stop_bots(self.body().get('code')))
        except (RuntimeError, ValueError, KeyError) as e:
            return self.send(400, {'error': str(e)})
        if url.path.startswith('/remote/'):
            return self.proxy(url, self.body())
        self.send(404, {'error': 'Not found.'})

    def proxy(self, url, body=None):
        target = self.app.server + url.path[len('/remote'):] + (f'?{url.query}' if url.query else '')
        stream = url.path.endswith('/events')
        try:
            auth = self.headers.get('Authorization')
            resp = client.request(target, body, timeout=60 if stream else 20, headers={'Authorization': auth} if auth else None)
        except urllib.error.HTTPError as e:
            return self.send(e.code, e.read(), e.headers.get('Content-Type', 'application/json'))
        except OSError as e:
            return self.send(502, {'error': f'Could not reach {self.app.server}: {e}'})
        with resp:
            if not stream:
                return self.send(resp.status, resp.read(), resp.headers.get('Content-Type', 'application/json'))
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache, no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            try:
                while True:
                    chunk = resp.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (OSError, ValueError):
                pass   # browser closed the stream, or the upstream read timed out (EventSource reconnects)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--server', default='https://keksimperium.com/hopechess')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-browser', action='store_true')
    o = ap.parse_args()
    Handler.app = App(o.server)
    httpd = ThreadingHTTPServer(('127.0.0.1', o.port), Handler)
    httpd.daemon_threads = True
    url = f'http://localhost:{o.port}'
    print(f'Hopechess bot UI at {url} (game server {o.server}). Ctrl+C stops it and the bots leave their seats.', flush=True)
    if not o.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        Handler.app.stop_bots()
        httpd.server_close()


if __name__ == '__main__':
    main()
