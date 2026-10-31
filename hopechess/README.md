# Hopechess bot

A self-play-trained bot for [Hopechess](https://github.com/Tom1736/hopechess), a
chess variant where both sides submit their moves simultaneously. It plays 1v1
and 2v2; the main target is 2v2. Results and experiments are in
[FINDINGS.md](FINDINGS.md).

```
hopechess/
  upstream/        snapshot of Tom1736/hopechess (rules, server, engine.js)
  bot/
    cpp/           C++ port of engine.js + Python bindings (hcengine)
    model.py       policy/value network (one net for 1v1 and 2v2)
    search.py      batched simultaneous-move matrix search (Nash), time-budgeted depth 2, first-mover search
    searcheval.py  compares 2v2 search settings at play-time budgets (one round from fixed positions)
    agents.py      baselines: random, upstream computer, heuristic Nash
    netagent.py    network agent
    client.py      plays on a hopechess server (1v1 or a 2v2 seat)
    play.py, play/ browser UI: play the bot on a hopechess server (default: the live site)
    arena.py       local matches (multiprocess, CPU), incl. mixed 2v2 teams
    evaluate.py    batched matches on GPU
    train.py       self-play reinforcement learning
    kaggle/        builds self-contained Kaggle notebooks for training/eval
    models/        trained checkpoints (best.pt = strongest)
    logs/          training and evaluation logs
    tests/         differential test of the C++ engine against engine.js; remote API contract test
```

## Setup

Requirements: Python 3.10+, a C++17 compiler, `pip install numpy torch pybind11`.
For the server and the engine tests, Node.js is also needed.

```sh
cd hopechess/bot
./build.sh                      # builds hcengine*.so
python build.py                 # same, any platform (Windows: uses Visual Studio Build Tools)
python3 tests/difftest.py 300   # optional: C++ engine == engine.js
HC_ENGINE_JS=/path/to/engine.js python3 tests/difftest.py 300   # ... or another copy, e.g. a live site's
```

The network runs on `--device auto` by default: CUDA, then Intel XPU
(`torch.xpu`, e.g. an Arc iGPU with the `+xpu` PyTorch build), then CPU. An
Arc 140T iGPU evaluates ~16k positions/s (a fixed `deepen=16` 2v2 move takes
about 3.5 s there, versus 17 s on the CPU); the default search thinks for 7.5 s
per move (at most ~9 s).

## Play the bot in the browser

```sh
python play.py                  # opens http://localhost:8765, game server https://keksimperium.com/hopechess
python play.py --server http://localhost:4173
```

The page creates a room on the game server, fills the other seats with bots
running locally, and you play your seat on its board. You choose the mode
(1v1, or 2v2 with a bot or human teammate and bot or open opponent seats),
color, clock, rated or not, and the bot: model, device, depth-2 search width,
candidate moves, temperature, clock-aware search, and how long a bot teammate
waits for your move. Open seats can be taken by friends on the website, and
the room appears in its Watch list. "Add a bot to an existing room" sends a bot
into a room you created on the website, so you can play it there instead.

## Play against people

Start the hopechess server (`cd hopechess/upstream && npm start`), then:

```sh
# create a 2v2 room; the bot takes a White seat and prints the room code
python3 client.py --server http://localhost:4173 --create --mode 2v2 --color white
# join an existing room (as any open seat, or a team)
python3 client.py --server http://localhost:4173 --room 0421 --color black
# 1v1
python3 client.py --server http://localhost:4173 --create --mode 1v1
```

Options:
* `--agent models/best.pt:deepen=16:budget=7.5` (default) selects the model
  and the search: selective depth 2 in steps of 16 joint moves, repeated until
  7.5 s are used (`budget=0`: one step only). Fast time controls shorten the
  thinking time automatically. `fm_deepen=1` also deepens the 2v2 seat that
  moves first (no gain measured, FINDINGS.md section 9).
  Other agents: `computer-hard`, `heur-nash`, `random`.
* `--teammate human|bot` and `--wait 6`: in 2v2 the bot waits for a human
  teammate's order and complements it. If none comes, it moves first with a
  robust move. For two bot clients on one team, pass `--teammate bot` to both.
* Games are rated by default on the server; create with `--unrated` to opt out.
* `--device auto|cuda|xpu|cpu` picks where the network runs.

## Check a server's API

```sh
python tests/apitest.py                         # upstream/server.mjs (local) vs https://keksimperium.com/hopechess
python tests/apitest.py --remote <url> --no-bot
```

It plays the same scripted 1v1 and 2v2 games on a local copy of the upstream
server and on the remote one, checks status codes, response shapes, private
team orders, rematch and leave, and that the bot's history replay matches the
server board every round; then `client.Bot` plays a few rounds on each. Rooms
are unrated and deleted at the end. Requests send `User-Agent: hopechess-bot/1.0`,
because the live site's Cloudflare front rejects Python's default agent.

## Evaluate

```sh
python searcheval.py --variants base=deepen=16 new=deepen=16:budget=7.5   # 2v2 search settings, one round per position
python3 arena.py --mode 2v2 --a net:models/best.pt --b computer-hard --games 100
python3 arena.py --mode 2v2 --a "net:models/best.pt+computer-hard" --b computer-hard   # mixed team
python3 evaluate.py --players a=models/best.pt b=models/r1_curriculum.pt --pairs a-b --games 200  # GPU
```

## Train (Kaggle)

```sh
python3 kaggle/make_notebook.py --slug my-run --args "--hours 6 --parallel 192 --p2v2 0.85" \
    [--source <user>/<previous-run> --init-file final.pt]
kaggle kernels push -p kaggle/build/my-run --accelerator NvidiaTeslaT4
kaggle kernels output <user>/my-run -p runs/my-run
```
