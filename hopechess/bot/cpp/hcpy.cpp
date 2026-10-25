// Python bindings: game state wrapper, feature encoding, batched successor
// generation for matrix-game search, Nash solver and heuristic baselines.
#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>
#include <cmath>
#include <random>
#include <sstream>
#include <algorithm>
#include "engine.hpp"

namespace py = pybind11;
using namespace hc;

static const int NPLANES = 24;
static const int NPOLICY = 64 * 73;

static bool findMove(const std::vector<Move>& legal, int code, Move& out) {
  if (code < 0) return false;
  int from = code & 63, to = (code >> 6) & 63;
  int8_t promo = promoType(code >> 12);
  for (const Move& m : legal) if (m.from == from && m.to == to && m.promo == promo) { out = m; return true; }
  // engine.js defaults a missing promotion to a queen
  if (promo == NOTYPE) for (const Move& m : legal) if (m.from == from && m.to == to && m.promo == Q) { out = m; return true; }
  throw std::runtime_error("illegal move code " + std::to_string(code));
}

struct Game {
  State s;
  Game() : s(initialState()) {}
  explicit Game(const State& st) : s(st) {}

  std::vector<int> legal(int color) const {
    std::vector<Move> mv; legalMoves(s, color, mv);
    std::vector<int> out; out.reserve(mv.size());
    for (auto& m : mv) out.push_back(m.code());
    return out;
  }
  std::vector<std::pair<int,int>> teamActionsPy(int color) const {
    std::vector<Move> mv; legalMoves(s, color, mv);
    std::vector<TeamAction> ta; teamActions(mv, ta);
    std::vector<std::pair<int,int>> out; out.reserve(ta.size());
    for (auto& t : ta) out.emplace_back(t.hasA ? t.a.code() : -1, t.hasB ? t.b.code() : -1);
    return out;
  }
  // Moves for one teammate given the other teammate's reserved order.
  std::vector<int> teamLegal(int color, int reserved) const {
    std::vector<Move> mv; legalMoves(s, color, mv);
    Move r; bool has = false;
    if (reserved >= 0) has = findMove(mv, reserved, r);
    std::vector<int> out;
    for (auto& m : mv) if (!has || !teamConflict(m, r)) out.push_back(m.code());
    return out;
  }
  Game play(int w, int b) const {
    std::vector<Move> wl, bl; legalMoves(s, WHITE, wl); legalMoves(s, BLACK, bl);
    Move wm, bm;
    bool hw = findMove(wl, w, wm), hb = findMove(bl, b, bm);
    if (!hw && !wl.empty()) throw std::runtime_error("white must move");
    if (!hb && !bl.empty()) throw std::runtime_error("black must move");
    return Game(resolve1v1(s, hw ? &wm : nullptr, hb ? &bm : nullptr));
  }
  Game play2(int w1, int w2, int b1, int b2) const {
    std::vector<Move> wl, bl; legalMoves(s, WHITE, wl); legalMoves(s, BLACK, bl);
    Move m[4]; bool h[4];
    h[0] = findMove(wl, w1, m[0]); h[1] = findMove(wl, w2, m[1]);
    h[2] = findMove(bl, b1, m[2]); h[3] = findMove(bl, b2, m[3]);
    if (h[0] && h[1] && teamConflict(m[0], m[1])) throw std::runtime_error("white team conflict");
    if (h[2] && h[3] && teamConflict(m[2], m[3])) throw std::runtime_error("black team conflict");
    const Move* o[4];
    for (int i = 0; i < 4; i++) o[i] = h[i] ? &m[i] : nullptr;
    return Game(resolve2v2(s, o[0], o[1], o[2], o[3]));
  }
  int result() const { return s.result; }
  int reason() const { return s.reason; }
  int round() const { return s.round; }
  int noProgress() const { return s.noProgress; }
  int repetitions() const { return s.repetitions(); }
  uint64_t key() const { return s.key(); }
  // Board as list of 64 strings like "wp0" (color,type,resting) or "."
  std::vector<std::string> boardStr() const {
    std::vector<std::string> out;
    const char* t = "pnbrqk";
    for (int i = 0; i < 64; i++) {
      const Piece& p = s.board[i];
      if (p.empty()) out.push_back(".");
      else out.push_back(std::string(1, p.color == WHITE ? 'w' : 'b') + t[p.type] + (p.resting ? "1" : "0"));
    }
    return out;
  }
  std::vector<std::tuple<int,int,int,int>> epRights() const {
    std::vector<std::tuple<int,int,int,int>> out;
    for (int i = 0; i < s.nEp; i++) out.emplace_back(s.ep[i].color, s.ep[i].pawnId, s.ep[i].square, s.ep[i].to);
    return out;
  }
  std::vector<int> hasMoved() const { std::vector<int> o(64, 0); for (int i = 0; i < 64; i++) o[i] = s.board[i].hasMoved; return o; }
  std::vector<int> ids() const { std::vector<int> o(64, -1); for (int i = 0; i < 64; i++) o[i] = s.board[i].empty() ? -1 : s.board[i].id; return o; }
};

// Build a Game from an engine.js-like description (used by the live client).
// board: 64 entries of (color 0/1/-1, type 0..5, resting, hasMoved, id)
static Game fromDesc(const std::vector<std::tuple<int,int,int,int,int>>& board, int round, int noProgress,
                     const std::vector<std::tuple<int,int,int,int>>& ep, const std::vector<uint64_t>& priorKeys) {
  State s;
  for (int i = 0; i < 64; i++) {
    auto [c, t, r, hm, id] = board[i];
    if (c < 0) { s.board[i] = Piece{}; continue; }
    s.board[i] = Piece{(int8_t)c, (int8_t)t, (int8_t)id, (bool)r, (bool)hm};
  }
  s.round = round; s.noProgress = noProgress;
  s.nEp = 0;
  for (auto& [c, pid, sq, to] : ep) if (s.nEp < 4) s.ep[s.nEp++] = EpRight{(int8_t)c, (int8_t)pid, (int8_t)sq, (int8_t)to};
  s.keys = priorKeys;
  s.keys.push_back(s.key());
  return Game(s);
}

// ---------------------------------------------------------------- features
static void encode(const State& s, int mode2v2, float* f) {
  std::fill(f, f + NPLANES * 64, 0.f);
  for (int i = 0; i < 64; i++) {
    const Piece& p = s.board[i];
    if (p.empty()) continue;
    f[(p.color * 6 + p.type) * 64 + i] = 1.f;
    if (p.resting) f[(12 + p.color) * 64 + i] = 1.f;
  }
  for (int color = 0; color < 2; color++) {
    int home = color == WHITE ? 56 : 0;
    const Piece& k = s.board[home + 4];
    for (int fl = 0; fl < 2; fl++) {
      const Piece& r = s.board[home + (fl ? 0 : 7)];
      bool right = k.color == color && k.type == K && !k.hasMoved && r.color == color && r.type == R && !r.hasMoved;
      if (right) std::fill(f + (14 + color * 2 + fl) * 64, f + (15 + color * 2 + fl) * 64, 1.f);
    }
  }
  for (int i = 0; i < s.nEp; i++) f[(18 + s.ep[i].color) * 64 + s.ep[i].to] = 1.f;
  std::fill(f + 20 * 64, f + 21 * 64, s.noProgress / 100.f);
  std::fill(f + 21 * 64, f + 22 * 64, std::max(0, s.repetitions() - 1) / 2.f);
  std::fill(f + 22 * 64, f + 23 * 64, (float)mode2v2);
  std::fill(f + 23 * 64, f + 24 * 64, 1.f);
}

static py::array_t<float> features(const Game& g, int mode) {
  py::array_t<float> a({NPLANES, 8, 8});
  encode(g.s, mode, a.mutable_data());
  return a;
}

// policy index of a move in absolute geometry; flip mirrors rows
static int policyIndex(int code, bool flip) {
  int from = code & 63, to = (code >> 6) & 63, pc = code >> 12;
  int fr = from / 8, fc = from % 8, tr = to / 8, tc = to % 8;
  if (flip) { fr = 7 - fr; tr = 7 - tr; }
  int dr = tr - fr, dc = tc - fc;
  int f2 = fr * 8 + fc;
  if (pc >= 2) {  // r b n underpromotions
    int pi = pc == 4 ? 0 : pc == 3 ? 1 : 2;
    return f2 * 73 + 64 + (dc + 1) * 3 + pi;
  }
  int adr = std::abs(dr), adc = std::abs(dc);
  if ((adr == 1 && adc == 2) || (adr == 2 && adc == 1)) {
    static const int KN[8][2] = {{-2,-1},{-2,1},{-1,-2},{-1,2},{1,-2},{1,2},{2,-1},{2,1}};
    for (int k = 0; k < 8; k++) if (KN[k][0] == dr && KN[k][1] == dc) return f2 * 73 + 56 + k;
  }
  static const int DIRS[8][2] = {{-1,0},{-1,1},{0,1},{1,1},{1,0},{1,-1},{0,-1},{-1,-1}};
  int sr = (dr > 0) - (dr < 0), sc = (dc > 0) - (dc < 0);
  int dist = std::max(adr, adc);
  for (int d = 0; d < 8; d++) if (DIRS[d][0] == sr && DIRS[d][1] == sc) return f2 * 73 + d * 7 + dist - 1;
  throw std::runtime_error("bad move geometry");
}

static std::vector<int> policyIndices(const std::vector<int>& codes, bool flip) {
  std::vector<int> o; o.reserve(codes.size());
  for (int c : codes) o.push_back(c < 0 ? -1 : policyIndex(c, flip));
  return o;
}

// All successor states of a joint action matrix. Actions for 1v1 are move
// codes; for 2v2 pairs of codes. Returns (features[nW*nB,...], result[nW*nB]).
static py::tuple successors(const Game& g, int mode,
                            const std::vector<std::pair<int,int>>& wa,
                            const std::vector<std::pair<int,int>>& ba,
                            bool wantFeatures) {
  std::vector<Move> wl, bl; legalMoves(g.s, WHITE, wl); legalMoves(g.s, BLACK, bl);
  auto dec = [](const std::vector<Move>& l, std::pair<int,int> p, Move* m, bool* h) {
    h[0] = p.first >= 0 && findMove(l, p.first, m[0]);
    h[1] = p.second >= 0 && findMove(l, p.second, m[1]);
  };
  size_t nW = wa.size(), nB = ba.size(), n = nW * nB;
  std::vector<std::array<Move,2>> wm(nW), bm(nB);
  std::vector<std::array<bool,2>> wh(nW), bh(nB);
  for (size_t i = 0; i < nW; i++) { bool h[2]; dec(wl, wa[i], wm[i].data(), h); wh[i] = {h[0], h[1]}; }
  for (size_t j = 0; j < nB; j++) { bool h[2]; dec(bl, ba[j], bm[j].data(), h); bh[j] = {h[0], h[1]}; }
  py::array_t<float> feats(wantFeatures ? std::vector<py::ssize_t>{(py::ssize_t)n, NPLANES, 8, 8} : std::vector<py::ssize_t>{0});
  py::array_t<int8_t> res((py::ssize_t)n);
  float* fp = wantFeatures ? feats.mutable_data() : nullptr;
  int8_t* rp = res.mutable_data();
  {
    py::gil_scoped_release nogil;
    for (size_t i = 0; i < nW; i++) for (size_t j = 0; j < nB; j++) {
      State nx;
      if (mode == 0) nx = resolve1v1(g.s, wh[i][0] ? &wm[i][0] : nullptr, bh[j][0] ? &bm[j][0] : nullptr);
      else nx = resolve2v2(g.s, wh[i][0] ? &wm[i][0] : nullptr, wh[i][1] ? &wm[i][1] : nullptr,
                           bh[j][0] ? &bm[j][0] : nullptr, bh[j][1] ? &bm[j][1] : nullptr);
      size_t k = i * nB + j;
      rp[k] = nx.result;
      if (fp) encode(nx, mode, fp + k * NPLANES * 64);
    }
  }
  return py::make_tuple(feats, res);
}

// ---------------------------------------------------------------- Nash
// Zero-sum matrix game, row player maximizes. Regret matching+ with
// alternating updates and linear averaging. Returns (x, y, value).
static py::tuple solveNash(py::array_t<double, py::array::c_style | py::array::forcecast> M, int iters) {
  auto buf = M.unchecked<2>();
  int m = buf.shape(0), n = buf.shape(1);
  std::vector<double> A(m * n);
  for (int i = 0; i < m; i++) for (int j = 0; j < n; j++) A[i * n + j] = buf(i, j);
  std::vector<double> rx(m, 0), ry(n, 0), x(m, 1.0 / m), y(n, 1.0 / n), sx(m, 0), sy(n, 0), u(std::max(m, n));
  auto norm = [](std::vector<double>& r, std::vector<double>& p) {
    double s = 0; for (double v : r) s += v;
    if (s <= 0) { for (auto& v : p) v = 1.0 / p.size(); return; }
    for (size_t i = 0; i < p.size(); i++) p[i] = r[i] / s;
  };
  {
    py::gil_scoped_release nogil;
    for (int t = 1; t <= iters; t++) {
      // row update vs y
      double ev = 0;
      for (int i = 0; i < m; i++) { double s = 0; for (int j = 0; j < n; j++) s += A[i * n + j] * y[j]; u[i] = s; ev += s * x[i]; }
      for (int i = 0; i < m; i++) rx[i] = std::max(0.0, rx[i] + u[i] - ev);
      norm(rx, x);
      for (int i = 0; i < m; i++) sx[i] += t * x[i];
      // column update vs x (column minimizes)
      ev = 0;
      for (int j = 0; j < n; j++) { double s = 0; for (int i = 0; i < m; i++) s += A[i * n + j] * x[i]; u[j] = -s; ev += -s * y[j]; }
      for (int j = 0; j < n; j++) ry[j] = std::max(0.0, ry[j] + u[j] - ev);
      norm(ry, y);
      for (int j = 0; j < n; j++) sy[j] += t * y[j];
    }
  }
  double tx = 0, ty = 0; for (double v : sx) tx += v; for (double v : sy) ty += v;
  py::array_t<double> X(m), Y(n);
  double val = 0;
  for (int i = 0; i < m; i++) X.mutable_data()[i] = sx[i] / tx;
  for (int j = 0; j < n; j++) Y.mutable_data()[j] = sy[j] / ty;
  for (int i = 0; i < m; i++) for (int j = 0; j < n; j++) val += X.data()[i] * A[i * n + j] * Y.data()[j];
  return py::make_tuple(X, Y, val);
}

// ---------------------------------------------------------------- heuristics
static const int MATERIAL[6] = {100, 315, 330, 500, 900, 100000};

// engine.js evaluateBoard (white perspective, not including result)
static double evaluateBoard(const State& s, int color) {
  if (s.result) return s.result == DRAW ? 0 : ((s.result == WHITE_WINS) == (color == WHITE) ? 1e6 : -1e6);
  double score = 0;
  for (int i = 0; i < 64; i++) {
    const Piece& p = s.board[i];
    if (p.empty()) continue;
    int row = i / 8, col = i % 8;
    double center = 7 - std::abs(3.5 - row) - std::abs(3.5 - col);
    int adv = p.color == WHITE ? 6 - row : row - 1;
    double pos = p.type == P ? adv * 8 + center * 2 : (p.type == N || p.type == B) ? center * 5 : p.type == K ? -center * 2 : center * 2;
    score += (p.color == color ? 1 : -1) * (MATERIAL[p.type] + pos - (p.resting ? MATERIAL[p.type] * 0.08 : 0));
  }
  return score;
}

static double orderPriority(const State& s, const Move* m) {
  if (!m) return 0;
  const Piece& piece = s.board[m->from];
  const Piece& target = s.board[m->to];
  int row = m->to / 8, col = m->to % 8;
  double center = 7 - std::abs(3.5 - row) - std::abs(3.5 - col);
  double score = center * 4 + (target.empty() ? 0 : std::min(MATERIAL[target.type], 3000));
  if (m->promo != NOTYPE) score += MATERIAL[m->promo] - MATERIAL[P];
  if (piece.type == K) score += 3;
  return score;
}

static std::mt19937_64 rng(12345);

// Port of engine.js chooseComputerMove ('normal' or 'hard'); returns code or -1.
static int computerMove(const Game& g, int color, bool hard, const std::vector<int>& allowedCodes) {
  const State& s = g.s;
  std::vector<Move> legal; legalMoves(s, color, legal);
  if (!allowedCodes.empty()) {
    std::vector<Move> f;
    for (auto& m : legal) if (std::find(allowedCodes.begin(), allowedCodes.end(), m.code()) != allowedCodes.end()) f.push_back(m);
    legal = f;
  }
  if (legal.empty()) return -1;
  int enemy = 1 - color;
  std::vector<Move> el; legalMoves(s, enemy, el);
  struct Rep { const Move* m; double pr; };
  std::vector<Rep> ranked;
  if (el.empty()) ranked.push_back({nullptr, 0});
  for (auto& m : el) ranked.push_back({&m, orderPriority(s, &m)});
  std::stable_sort(ranked.begin(), ranked.end(), [](const Rep& a, const Rep& b) { return a.pr > b.pr; });
  int limit = hard ? 36 : 20;
  size_t take = std::min(ranked.size(), (size_t)std::ceil(limit * 0.7));
  std::vector<int> sel;
  for (size_t i = 0; i < take; i++) sel.push_back(i);
  size_t remN = ranked.size() - take;
  int slots = limit - (int)sel.size();
  for (int i = 0; i < slots && remN; i++) {
    size_t idx = take + (size_t)std::floor((double)i * remN / slots);
    sel.push_back(idx);
  }
  int kingSq = -1;
  for (int i = 0; i < 64; i++) if (s.board[i].color == color && s.board[i].type == K) kingSq = i;
  std::vector<int> kingSquares;
  if (kingSq >= 0) { kingSquares.push_back(kingSq); std::vector<Move> km; pieceMoves(s, kingSq, km); for (auto& m : km) kingSquares.push_back(m.to); }
  for (size_t r = 0; r < ranked.size(); r++) {
    if (!ranked[r].m) continue;
    if (std::find(kingSquares.begin(), kingSquares.end(), ranked[r].m->to) != kingSquares.end()
        && std::find(sel.begin(), sel.end(), (int)r) == sel.end()) sel.push_back(r);
  }
  double baseline = evaluateBoard(s, color);
  std::uniform_real_distribution<double> U(0, 1);
  int best = 0; double bestScore = -INFINITY;
  for (size_t i = 0; i < legal.size(); i++) {
    double weighted = 0, total = 0, worst = INFINITY;
    for (int r : sel) {
      const Move* rep = ranked[r].m;
      State nx = color == WHITE ? resolve1v1(s, &legal[i], rep) : resolve1v1(s, rep, &legal[i]);
      double score = evaluateBoard(nx, color) - baseline;
      double w = 1 + std::min(4.0, std::max(0.0, ranked[r].pr) / 180);
      weighted += score * w; total += w; worst = std::min(worst, score);
    }
    double caution = hard ? 0.35 : 0.2;
    double sc = (weighted / total) * (1 - caution) + worst * caution + U(rng) * 3;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return legal[best].code();
}

// Material+position heuristic value in [-1,1] from white's view for a batch
// of successors (used by the heuristic Nash baseline).
static py::array_t<float> heuristicValues(const Game& g, int mode,
                                          const std::vector<std::pair<int,int>>& wa,
                                          const std::vector<std::pair<int,int>>& ba, double scale) {
  std::vector<Move> wl, bl; legalMoves(g.s, WHITE, wl); legalMoves(g.s, BLACK, bl);
  size_t nW = wa.size(), nB = ba.size();
  py::array_t<float> out((py::ssize_t)(nW * nB));
  float* o = out.mutable_data();
  for (size_t i = 0; i < nW; i++) {
    Move w[2]; bool hw[2];
    hw[0] = wa[i].first >= 0 && findMove(wl, wa[i].first, w[0]);
    hw[1] = wa[i].second >= 0 && findMove(wl, wa[i].second, w[1]);
    for (size_t j = 0; j < nB; j++) {
      Move b[2]; bool hb[2];
      hb[0] = ba[j].first >= 0 && findMove(bl, ba[j].first, b[0]);
      hb[1] = ba[j].second >= 0 && findMove(bl, ba[j].second, b[1]);
      State nx = mode == 0 ? resolve1v1(g.s, hw[0] ? &w[0] : nullptr, hb[0] ? &b[0] : nullptr)
                           : resolve2v2(g.s, hw[0] ? &w[0] : nullptr, hw[1] ? &w[1] : nullptr, hb[0] ? &b[0] : nullptr, hb[1] ? &b[1] : nullptr);
      double v;
      if (nx.result == WHITE_WINS) v = 1; else if (nx.result == BLACK_WINS) v = -1; else if (nx.result == DRAW) v = 0;
      else v = std::tanh(evaluateBoard(nx, WHITE) / scale);
      o[i * nB + j] = (float)v;
    }
  }
  return out;
}

static void seed(uint64_t s) { rng.seed(s); }

PYBIND11_MODULE(hcengine, m) {
  m.attr("NPLANES") = NPLANES;
  m.attr("NPOLICY") = NPOLICY;
  py::class_<Game>(m, "Game")
      .def(py::init<>())
      .def("legal", &Game::legal)
      .def("team_actions", &Game::teamActionsPy)
      .def("team_legal", &Game::teamLegal)
      .def("play", &Game::play)
      .def("play2", &Game::play2)
      .def_property_readonly("result", &Game::result)
      .def_property_readonly("reason", &Game::reason)
      .def_property_readonly("round", &Game::round)
      .def_property_readonly("no_progress", &Game::noProgress)
      .def_property_readonly("repetitions", &Game::repetitions)
      .def_property_readonly("key", &Game::key)
      .def("board", &Game::boardStr)
      .def("ep_rights", &Game::epRights)
      .def("has_moved", &Game::hasMoved)
      .def("ids", &Game::ids)
      .def("keys", [](const Game& g) { return g.s.keys; })
      .def("copy", [](const Game& g) { return Game(g.s); });
  m.def("from_desc", &fromDesc);
  m.def("features", &features);
  m.def("policy_index", &policyIndex);
  m.def("policy_indices", &policyIndices);
  m.def("successors", &successors, py::arg("game"), py::arg("mode"), py::arg("white"), py::arg("black"), py::arg("features") = true);
  m.def("solve_nash", &solveNash, py::arg("M"), py::arg("iters") = 1000);
  m.def("computer_move", &computerMove, py::arg("game"), py::arg("color"), py::arg("hard") = false, py::arg("allowed") = std::vector<int>{});
  m.def("heuristic_values", &heuristicValues);
  m.def("evaluate_board", [](const Game& g, int color) { return evaluateBoard(g.s, color); });
  m.def("seed", &seed);
}
