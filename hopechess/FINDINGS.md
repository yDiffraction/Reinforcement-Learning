# Hopechess bot: findings log

Game: [Tom1736/hopechess](https://github.com/Tom1736/hopechess) (snapshot in `upstream/`).
Both sides submit orders simultaneously; in 2v2 each team submits two
non-conflicting orders per round. See `upstream/README.md` for the rules.

## 1. Engine port

* `bot/cpp/engine.cpp` is a line-by-line C++ port of `upstream/engine.js`:
  move generation, simultaneous resolution (collisions, weaker-wins, king
  bounce, returning-king capture in 2v2, rest, promotion-before-combat,
  castling, en passant), forced passes, and repetition / 100-round draws.
* Exactness was checked by a differential test (`bot/tests/difftest.py`): 3,000
  random, heuristic and "quiet-move" games (175k rounds, 1v1 and 2v2) replayed
  through engine.js, comparing board, rest flags, hasMoved, en passant rights,
  counters, legal move sets and result every round. 0 mismatches. The test games
  covered 82 castles, 89 en passant captures, 521 promotions (277
  underpromotions) and 89 king meetings.
* Speed: about 0.25 µs per successor state without features. All joint actions
  of a 1v1 position (~900) take about 0.2 ms.
* Repetition detection keeps only the position hashes since the last
  irreversible round (a pawn move or capture). This matches engine.js's
  `positionCounts`, because no earlier position can recur after such a round.

## 2. Baselines (1v1, 100–200 games, colors alternate)

| match | result |
|---|---|
| upstream computer "hard" vs random | 100% |
| upstream "hard" vs "normal" | 50.5%; 96% draws, mostly threefold repetition: two deterministic bots shuffle |
| 1-ply Nash with tanh(material/scale) vs "hard" | 16–21% for every scale tried |

Takeaways:
* A **1-ply Nash** search with a bounded material eval is badly beaten by the
  upstream bot. The upstream bot scores king capture as ±1e6 and blends 35%
  worst case into its score, so it never leaves its king en prise. The bounded
  eval treats "king hunted by a queen" as only a little worse than losing
  material. Games are lost in king-vs-queen guessing chases (the Nash mix
  correctly randomizes, but the position is already lost).
  ⇒ The value function must understand king danger. This is what the learned
  value net is for.

## 3. Learning setup

* Network (`bot/model.py`): SE-ResNet trunk on 24 input planes (pieces, rest
  flags per color, castling rights, en passant targets, no-progress counter,
  repetition count, **2v2 flag**, ones). One network serves both modes. Heads:
  value (tanh, White's view) and policy for **both** colors (AlphaZero 73-plane
  move encoding, 2×4672 logits).
* Search (`bot/search.py`): depth-1 simultaneous-move matrix game. Candidates
  per side come from the policy prior (1v1: top-24 moves; 2v2: top-12 single
  moves → compatible pairs ranked by prior product, top-36), always adding
  "tactical" moves (king moves, moves into the enemy king's zone). Every joint
  action is resolved by the C++ engine and successors are valued by the net
  (exact values for finished games). The zero-sum matrix is solved with regret
  matching+ (800 iterations). We play by sampling our Nash strategy.
* A single search yields training targets for **both** sides: the Nash marginal
  of each side over single moves. Value target = 0.5·game result + 0.5·search
  value. Color-flip augmentation (mirror ranks and swap colors, negate value,
  swap and mirror policies).
* Inputs travel as an 80-byte compact encoding and are expanded to planes on
  the accelerator. This cut CPU time per searched round from 5.3 ms to 0.45 ms
  (1v1) and from 18.9 ms to 1.2 ms (2v2), and makes the replay buffer ~40×
  smaller.
