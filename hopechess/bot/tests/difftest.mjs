// Replays games recorded by difftest.py through the upstream engine.js and
// prints per-round snapshots so the C++ port can be compared exactly.
import { readFileSync } from 'node:fs';
import { createInitialState, getLegalMoves, getTeamLegalMoves, resolveRound, resolveTeamRound } from '../../upstream/engine.js';

const PROMO = { q: 1, r: 2, b: 3, n: 4 };
const code = m => m.from | (m.to << 6) | ((m.promotion ? PROMO[m.promotion] : 0) << 12);
const decode = c => c < 0 ? null : { from: c & 63, to: (c >> 6) & 63, ...((c >> 12) ? { promotion: ['', 'q', 'r', 'b', 'n'][c >> 12] } : {}) };
const snap = s => ({
  board: s.board.map(p => p ? `${p.color[0]}${p.type}${p.resting ? 1 : 0}` : '.'),
  moved: s.board.map(p => p ? (p.hasMoved ? 1 : 0) : 0),
  winner: s.result?.winner ?? null,
  reason: s.result?.reason ?? null,
  noProgress: s.noProgressRounds,
  ep: (s.enPassant ?? []).map(e => [e.color === 'white' ? 0 : 1, e.square, e.to]),
  white: getLegalMoves(s, 'white').map(code).sort((a, b) => a - b),
  black: getLegalMoves(s, 'black').map(code).sort((a, b) => a - b),
});

const games = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const g of games) {
  let s = createInitialState();
  const snaps = [snap(s)];
  for (const r of g.rounds) {
    if (g.mode === '1v1') s = resolveRound(s, decode(r[0]), decode(r[1]));
    else s = resolveTeamRound(s, [decode(r[0]), decode(r[1])], [decode(r[2]), decode(r[3])]);
    snaps.push(snap(s));
  }
  out.push(snaps);
}
process.stdout.write(JSON.stringify(out));
