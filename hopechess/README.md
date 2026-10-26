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
    search.py      batched simultaneous-move matrix search (Nash), depth 2, first-mover search
    agents.py      baselines: random, upstream computer, heuristic Nash
    netagent.py    network agent
    client.py      plays on a hopechess server (1v1 or a 2v2 seat)
    arena.py       local matches (multiprocess, CPU), incl. mixed 2v2 teams
    evaluate.py    batched matches on GPU
    train.py       self-play reinforcement learning
    kaggle/        builds self-contained Kaggle notebooks for training/eval
    models/        trained checkpoints (best.pt = strongest)
    logs/          training and evaluation logs
    tests/         differential test of the C++ engine against engine.js
```

## Setup

Requirements: Python 3.10+, a C++17 compiler, `pip install numpy torch pybind11`.
For the server and the engine tests, Node.js is also needed.

```sh
cd hopechess/bot
./build.sh                      # builds hcengine*.so
python3 tests/difftest.py 300   # optional: C++ engine == engine.js
```

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
* `--agent models/best.pt:deepen=16` (default) selects the model and the
  selective depth-2 search width. Fast time controls reduce it automatically.
  Other agents: `computer-hard`, `heur-nash`, `random`.
* `--teammate human|bot` and `--wait 6`: in 2v2 the bot waits for a human
  teammate's order and complements it. If none comes, it moves first with a
  robust move. For two bot clients on one team, pass `--teammate bot` to both.
* Games are rated by default on the server; create with `--unrated` to opt out.

## Evaluate

```sh
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
