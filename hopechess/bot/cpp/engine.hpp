// Fast C++ port of hopechess engine.js (1v1 and 2v2 rules).
// Board index = row*8+col, row 0 is Black's home rank (same as engine.js).
#pragma once
#include <cstdint>
#include <cstring>
#include <vector>
#include <array>

namespace hc {

enum Color : int8_t { WHITE = 0, BLACK = 1, NOCOLOR = -1 };
enum Type : int8_t { P = 0, N = 1, B = 2, R = 3, Q = 4, K = 5, NOTYPE = -1 };
// Strength p<n<b<r<q<k equals type index ordering.

struct Piece {
  int8_t color = NOCOLOR;
  int8_t type = NOTYPE;
  int8_t id = -1;
  bool resting = false;
  bool hasMoved = false;
  bool empty() const { return color == NOCOLOR; }
};

// A move is packed as an int: from | to<<6 | promo<<12 where promo is
// 0 none, 1 q, 2 r, 3 b, 4 n. Castling/en passant are implied by from/to.
struct Move {
  int8_t from = -1, to = -1;
  int8_t promo = NOTYPE;          // piece type after promotion or NOTYPE
  int8_t castleFrom = -1, castleTo = -1;
  int8_t epSquare = -1, epPawnId = -1;
  int code() const;
};

int promoCode(int8_t type);
int8_t promoType(int code);

struct EpRight { int8_t color, pawnId, square, to; };

enum Result : int8_t { ONGOING = 0, WHITE_WINS = 1, BLACK_WINS = 2, DRAW = 3 };

struct State {
  Piece board[64];
  int round = 1;
  int noProgress = 0;
  int8_t result = ONGOING;
  int8_t reason = 0;  // 1 both kings, 2 king captured, 3 no moves, 4 repetition, 5 100 rounds
  int8_t nEp = 0;
  EpRight ep[4];
  // Position keys since the last irreversible round (pawn move or capture),
  // including the current position as the last element.
  std::vector<uint64_t> keys;

  uint64_t key() const;
  int repetitions() const;  // occurrences of the current key in keys
};

State initialState();
void pieceMoves(const State& s, int from, std::vector<Move>& out);
void legalMoves(const State& s, int color, std::vector<Move>& out);
bool teamConflict(const Move& a, const Move& b);
// Apply one order per entry; orders[i] may be nullptr (pass). colors[i] is its side.
State applyOrders(const State& s, const Move* const* orders, const int* colors, int n);
// Convenience wrappers.
State resolve1v1(const State& s, const Move* w, const Move* b);
State resolve2v2(const State& s, const Move* w1, const Move* w2, const Move* b1, const Move* b2);

// Joint team actions for 2v2: all unordered compatible pairs; a single move
// only when no compatible partner exists; an empty action when no moves.
struct TeamAction { Move a, b; bool hasA = false, hasB = false; };
void teamActions(const std::vector<Move>& legal, std::vector<TeamAction>& out);

}  // namespace hc
