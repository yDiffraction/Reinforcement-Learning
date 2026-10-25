#include "engine.hpp"
#include <algorithm>
#include <cstdlib>

namespace hc {

static const int KNIGHT[8][2] = {{-2,-1},{-2,1},{-1,-2},{-1,2},{1,-2},{1,2},{2,-1},{2,1}};
static const int DIAG[4][2] = {{-1,-1},{-1,1},{1,-1},{1,1}};
static const int STRAIGHT[4][2] = {{-1,0},{1,0},{0,-1},{0,1}};
static const int ALLDIR[8][2] = {{-1,-1},{-1,1},{1,-1},{1,1},{-1,0},{1,0},{0,-1},{0,1}};
static inline bool inside(int r, int c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

int promoCode(int8_t t) {
  switch (t) { case Q: return 1; case R: return 2; case B: return 3; case N: return 4; default: return 0; }
}
int8_t promoType(int c) {
  switch (c) { case 1: return Q; case 2: return R; case 3: return B; case 4: return N; default: return NOTYPE; }
}
int Move::code() const { return int(from) | (int(to) << 6) | (promoCode(promo) << 12); }

// ---------------------------------------------------------------- hashing
struct Zobrist {
  uint64_t sq[64][2][6][2];
  uint64_t rights[4];
  uint64_t ep[4][2][64];
  Zobrist() {
    uint64_t x = 0x9E3779B97F4A7C15ULL;
    auto next = [&]() { x += 0x9E3779B97F4A7C15ULL; uint64_t z = x; z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL; z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL; return z ^ (z >> 31); };
    for (auto& a : sq) for (auto& b : a) for (auto& c : b) for (auto& d : c) d = next();
    for (auto& r : rights) r = next();
    for (auto& a : ep) for (auto& b : a) for (auto& c : b) c = next();
  }
};
static const Zobrist Z;

uint64_t State::key() const {
  uint64_t h = 0;
  for (int i = 0; i < 64; i++) {
    const Piece& p = board[i];
    if (!p.empty()) h ^= Z.sq[i][p.color][p.type][p.resting ? 1 : 0];
  }
  for (int color = 0; color < 2; color++) {
    int home = color == WHITE ? 56 : 0;
    const Piece& k = board[home + 4];
    for (int f = 0; f < 2; f++) {
      const Piece& r = board[home + (f ? 7 : 0)];
      if (k.color == color && k.type == K && !k.hasMoved && r.color == color && r.type == R && !r.hasMoved) h ^= Z.rights[color * 2 + f];
    }
  }
  for (int i = 0; i < nEp; i++) h ^= Z.ep[i][ep[i].color][ep[i].square];
  return h;
}

int State::repetitions() const {
  if (keys.empty()) return 0;
  uint64_t k = keys.back();
  int c = 0;
  for (uint64_t x : keys) c += x == k;
  return c;
}

State initialState() {
  State s;
  const int8_t back[8] = {R, N, B, Q, K, B, N, R};
  int id = 0;
  for (int color = 0; color < 2; color++) {
    int home = color == WHITE ? 7 : 0, pawns = color == WHITE ? 6 : 1;
    for (int c = 0; c < 8; c++) {
      s.board[home * 8 + c] = Piece{(int8_t)color, back[c], (int8_t)id++, false, false};
      s.board[pawns * 8 + c] = Piece{(int8_t)color, P, (int8_t)id++, false, false};
    }
  }
  s.keys.push_back(s.key());
  return s;
}

// ---------------------------------------------------------------- moves
void pieceMoves(const State& s, int from, std::vector<Move>& out) {
  if (s.result) return;
  const Piece& piece = s.board[from];
  if (piece.empty() || piece.resting) return;
  int row = from / 8, col = from % 8;
  auto add = [&](int nr, int nc) -> bool {
    if (!inside(nr, nc)) return false;
    int to = nr * 8 + nc;
    const Piece& occ = s.board[to];
    if (occ.color == piece.color) return false;
    if (piece.type == K && occ.type == K && !occ.empty() && !occ.resting) return false;
    if (piece.type == P && (nr == 0 || nr == 7)) {
      for (int8_t pr : {Q, R, B, N}) { Move m; m.from = from; m.to = to; m.promo = pr; out.push_back(m); }
    } else {
      Move m; m.from = from; m.to = to; out.push_back(m);
    }
    return occ.empty();
  };
  if (piece.type == P) {
    int dir = piece.color == WHITE ? -1 : 1;
    int homeRow = piece.color == WHITE ? 6 : 1;
    int nr = row + dir;
    if (inside(nr, col) && s.board[nr * 8 + col].empty()) {
      add(nr, col);
      if (row == homeRow && s.board[(row + dir * 2) * 8 + col].empty()) add(row + dir * 2, col);
    }
    for (int off : {-1, 1}) {
      if (!inside(nr, col + off)) continue;
      const Piece& t = s.board[nr * 8 + col + off];
      if (!t.empty() && t.color != piece.color) add(nr, col + off);
      if (t.empty()) {
        int dest = nr * 8 + col + off, side = row * 8 + col + off;
        for (int i = 0; i < s.nEp; i++) {
          const EpRight& e = s.ep[i];
          if (e.to == dest && e.color != piece.color && e.square == side && s.board[e.square].id == e.pawnId && !s.board[e.square].empty()) {
            Move m; m.from = from; m.to = dest; m.epSquare = e.square; m.epPawnId = e.pawnId; out.push_back(m);
            break;
          }
        }
      }
    }
  } else if (piece.type == N) {
    for (auto& d : KNIGHT) add(row + d[0], col + d[1]);
  } else if (piece.type == K) {
    for (auto& d : ALLDIR) add(row + d[0], col + d[1]);
    int home = piece.color == WHITE ? 56 : 0;
    if (from == home + 4 && !piece.hasMoved) {
      // [rookFile, toFile, rookToFile, between...]
      struct C { int rookFile, toFile, rookToFile; int between[3]; int nb; };
      const C cs[2] = {{7, 6, 5, {5, 6, 0}, 2}, {0, 2, 3, {1, 2, 3}, 3}};
      for (const C& c : cs) {
        const Piece& rook = s.board[home + c.rookFile];
        bool ok = rook.color == piece.color && rook.type == R && !rook.hasMoved && !rook.resting;
        for (int i = 0; ok && i < c.nb; i++) ok = s.board[home + c.between[i]].empty();
        if (ok) { Move m; m.from = from; m.to = home + c.toFile; m.castleFrom = home + c.rookFile; m.castleTo = home + c.rookToFile; out.push_back(m); }
      }
    }
  } else {
    const int (*dirs)[2] = piece.type == B ? DIAG : piece.type == R ? STRAIGHT : ALLDIR;
    int nd = piece.type == Q ? 8 : 4;
    for (int d = 0; d < nd; d++)
      for (int dist = 1; dist < 8; dist++)
        if (!add(row + dirs[d][0] * dist, col + dirs[d][1] * dist)) break;
  }
}

void legalMoves(const State& s, int color, std::vector<Move>& out) {
  out.clear();
  if (s.result) return;
  for (int i = 0; i < 64; i++) if (s.board[i].color == color) pieceMoves(s, i, out);
}

bool teamConflict(const Move& a, const Move& b) {
  int oa[2] = {a.from, a.castleFrom}, ob[2] = {b.from, b.castleFrom};
  int ta[2] = {a.to, a.castleTo}, tb[2] = {b.to, b.castleTo};
  for (int x : oa) for (int y : ob) if (x >= 0 && x == y) return true;
  for (int x : ta) for (int y : tb) if (x >= 0 && x == y) return true;
  return false;
}

void teamActions(const std::vector<Move>& legal, std::vector<TeamAction>& out) {
  out.clear();
  int n = legal.size();
  if (!n) { out.push_back(TeamAction{}); return; }
  std::vector<char> partner(n, 0);
  for (int i = 0; i < n; i++)
    for (int j = i + 1; j < n; j++)
      if (!teamConflict(legal[i], legal[j])) {
        TeamAction t; t.a = legal[i]; t.b = legal[j]; t.hasA = t.hasB = true; out.push_back(t);
        partner[i] = partner[j] = 1;
      }
  for (int i = 0; i < n; i++) if (!partner[i]) { TeamAction t; t.a = legal[i]; t.hasA = true; out.push_back(t); }
}

// ---------------------------------------------------------------- resolution
namespace {
struct Mover {
  Move m;
  int color;
  Piece piece;
  int8_t origType;
  bool pass = false, captured = false, survived = true, bounced = false;
};
}

State applyOrders(const State& s, const Move* const* orders, const int* colors, int n) {
  State nx;
  for (int i = 0; i < 64; i++) { nx.board[i] = s.board[i]; nx.board[i].resting = false; }
  Piece* board = nx.board;
  int captures = 0;
  Mover moves[4];
  Mover secondary[4];
  int nSec = 0;
  bool allNull = true;
  for (int i = 0; i < n; i++) {
    Mover& mv = moves[i];
    mv.color = colors[i];
    if (!orders[i]) { mv.pass = true; continue; }
    allNull = false;
    mv.m = *orders[i];
    mv.piece = s.board[mv.m.from];
    mv.origType = mv.piece.type;
    if (mv.m.promo != NOTYPE) mv.piece.type = mv.m.promo;
    if (mv.m.castleFrom >= 0) {
      Mover& sm = secondary[nSec++];
      sm.color = colors[i];
      sm.m.from = mv.m.castleFrom; sm.m.to = mv.m.castleTo;
      sm.piece = s.board[mv.m.castleFrom];
      sm.origType = sm.piece.type;
    }
  }
  Mover* movers[8];
  int nm = 0;
  for (int i = 0; i < n; i++) if (!moves[i].pass) movers[nm++] = &moves[i];
  for (int i = 0; i < nSec; i++) movers[nm++] = &secondary[i];
  for (int i = 0; i < nm; i++) board[movers[i]->m.from] = Piece{};

  // Destinations in insertion order.
  int dsq[8], dcount[8], dlist[8][4], nd = 0;
  for (int i = 0; i < nm; i++) {
    int to = movers[i]->m.to, k = 0;
    while (k < nd && dsq[k] != to) k++;
    if (k == nd) { dsq[nd] = to; dcount[nd] = 0; nd++; }
    dlist[k][dcount[k]++] = i;
  }
  Mover* bounced[8];
  int nb = 0;
  for (int k = 0; k < nd; k++) {
    int square = dsq[k];
    Mover* survivor = movers[dlist[k][0]];
    if (dcount[k] >= 2) {
      Mover* a = movers[dlist[k][0]];
      Mover* b = movers[dlist[k][1]];
      if (a->piece.type == K && b->piece.type == K) {
        a->bounced = b->bounced = true;
        bounced[nb++] = a; bounced[nb++] = b;
        continue;
      }
      int ar = a->piece.type, br = b->piece.type;
      if (ar == br) {
        a->survived = b->survived = false;
        captures += 2;
        continue;
      }
      survivor = ar < br ? a : b;
      Mover* victim = survivor == a ? b : a;
      survivor->captured = true;
      victim->survived = false;
      captures++;
    } else if (!board[square].empty()) {
      captures++;
      survivor->captured = true;
    }
    Piece placed = survivor->piece;
    placed.resting = survivor->captured;
    placed.hasMoved = true;
    board[square] = placed;
  }
  for (int i = 0; i < nb; i++) {
    Mover* mv = bounced[i];
    Piece& att = board[mv->m.from];
    if (!att.empty()) {
      captures++;
      mv->survived = false;
      att.resting = true;
      for (int j = 0; j < nm; j++) if (movers[j]->piece.id == att.id) { movers[j]->captured = true; break; }
    } else {
      Piece king = mv->piece;
      king.resting = false;
      king.hasMoved = true;
      board[mv->m.from] = king;
    }
  }
  for (int i = 0; i < n; i++) {
    Mover& mv = moves[i];
    if (mv.pass || mv.m.epSquare < 0 || !mv.survived) continue;
    Piece& victim = board[mv.m.epSquare];
    if (!victim.empty() && victim.id == mv.m.epPawnId) {
      captures++;
      victim = Piece{};
      mv.captured = true;
      board[mv.m.to].resting = true;
    }
  }
  bool pawnMoved = false;
  for (int i = 0; i < n; i++) if (!moves[i].pass && moves[i].origType == P) pawnMoved = true;
  nx.nEp = 0;
  for (int i = 0; i < n; i++) {
    Mover& mv = moves[i];
    if (mv.pass || mv.piece.type != P || std::abs(mv.m.from - mv.m.to) != 16 || !mv.survived) continue;
    const Piece& at = board[mv.m.to];
    if (at.empty() || at.id != mv.piece.id) continue;
    nx.ep[nx.nEp++] = EpRight{(int8_t)mv.color, mv.piece.id, mv.m.to, (int8_t)((mv.m.from + mv.m.to) / 2)};
  }
  nx.round = s.round + 1;
  nx.noProgress = (captures || pawnMoved) ? 0 : s.noProgress + 1;
  uint64_t k = nx.key();
  if (nx.noProgress == 0) nx.keys.assign(1, k);
  else { nx.keys = s.keys; nx.keys.push_back(k); }

  bool wk = false, bk = false;
  for (int i = 0; i < 64; i++) if (board[i].type == K && !board[i].empty()) (board[i].color == WHITE ? wk : bk) = true;
  if (!wk && !bk) { nx.result = DRAW; nx.reason = 1; }
  else if (!wk) { nx.result = BLACK_WINS; nx.reason = 2; }
  else if (!bk) { nx.result = WHITE_WINS; nx.reason = 2; }
  else {
    bool noMoves = false;
    if (allNull) {
      std::vector<Move> tmp;
      legalMoves(nx, WHITE, tmp);
      if (tmp.empty()) { legalMoves(nx, BLACK, tmp); noMoves = tmp.empty(); }
    }
    if (noMoves) { nx.result = DRAW; nx.reason = 3; }
    else if (nx.repetitions() >= 3) { nx.result = DRAW; nx.reason = 4; }
    else if (nx.noProgress >= 100) { nx.result = DRAW; nx.reason = 5; }
  }
  return nx;
}

State resolve1v1(const State& s, const Move* w, const Move* b) {
  const Move* o[2] = {w, b};
  const int c[2] = {WHITE, BLACK};
  return applyOrders(s, o, c, 2);
}

State resolve2v2(const State& s, const Move* w1, const Move* w2, const Move* b1, const Move* b2) {
  const Move* o[4] = {w1, w2, b1, b2};
  const int c[4] = {WHITE, WHITE, BLACK, BLACK};
  return applyOrders(s, o, c, 4);
}

}  // namespace hc
