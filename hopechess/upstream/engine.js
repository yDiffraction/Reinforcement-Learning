/**
 * Hopechess rules engine. This module is pure JavaScript and has no UI dependencies.
 *
 * A board is a 64-entry array, indexed row * 8 + column. Row zero is Black's
 * home rank. Pieces are { id, color, type, resting }; types use p/n/b/r/q/k.
 * State.round is the round about to be played. resolveRound returns a new state
 * and never changes its input. Orders are { from, to, promotion? }; null is a
 * forced pass and is accepted only when that color has no legal order.
 *
 * Both orders are legal against the original board. Moving pieces evade attacks
 * on their old squares, including when two pieces swap squares. Only a shared
 * destination creates a duel: the weaker piece captures the stronger, or equal
 * types destroy each other (two active kings instead return to their origins).
 * Kings can target an enemy king only while that king is resting.
 * Promotion takes effect before destination combat. Capturing survivors
 * must rest for one round. Resting pieces can still be captured. Three identical
 * positions (including rest) or 100 rounds without a pawn move or capture draw.
 */

export const PIECE_NAMES = Object.freeze({ p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' });
export const PIECE_STRENGTH = Object.freeze({ p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 });
export const COLORS = Object.freeze(['white', 'black']);

const PROMOTIONS = ['q', 'r', 'b', 'n'];
const MATERIAL = { p: 100, n: 315, b: 330, r: 500, q: 900, k: 100000 };
const KNIGHT_STEPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const STRAIGHTS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const ALL_DIRECTIONS = [...DIAGONALS, ...STRAIGHTS];
const otherColor = color => color === 'white' ? 'black' : 'white';
const inside = (row, col) => row >= 0 && row < 8 && col >= 0 && col < 8;
const title = value => value[0].toUpperCase() + value.slice(1);
const describe = piece => `${title(piece.color)} ${PIECE_NAMES[piece.type]}`;

export function indexToSquare(index) {
  if (!Number.isInteger(index) || index < 0 || index > 63) return null;
  return `${'abcdefgh'[index % 8]}${8 - Math.floor(index / 8)}`;
}

export function squareToIndex(square) {
  if (typeof square !== 'string' || !/^[a-h][1-8]$/i.test(square)) return -1;
  return (8 - Number(square[1])) * 8 + 'abcdefgh'.indexOf(square[0].toLowerCase());
}

/** Identity-free position key: include rest, castling rights, and en passant rights. */
export function positionKey(state) {
  const rights = ['white', 'black'].map(color => {
    const home = color === 'white' ? 56 : 0;
    const king = state.board[home + 4];
    return [0, 7].map(file => {
      const rook = state.board[home + file];
      return king?.color === color && king.type === 'k' && !king.hasMoved && rook?.color === color && rook.type === 'r' && !rook.hasMoved ? '1' : '0';
    }).join('');
  }).join('');
  return state.board.map(piece => piece ? `${piece.color[0]}${piece.type}${piece.resting ? '1' : '0'}` : '.').join('') + rights + JSON.stringify((state.enPassant ?? []).map(({color, square, to}) => ({color, square, to})));
}

export function createInitialState() {
  const board = Array(64).fill(null);
  const backRank = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (const color of COLORS) {
    const home = color === 'white' ? 7 : 0;
    const pawns = color === 'white' ? 6 : 1;
    for (let col = 0; col < 8; col++) {
      board[home * 8 + col] = { id: `${color}-${backRank[col]}-${col}`, color, type: backRank[col], resting: false, hasMoved: false };
      board[pawns * 8 + col] = { id: `${color}-p-${col}`, color, type: 'p', resting: false, hasMoved: false };
    }
  }
  const state = { board, round: 1, result: null, history: [], captured: { white: [], black: [] }, lastRound: null, noProgressRounds: 0, enPassant: [] };
  state.positionCounts = { [positionKey(state)]: 1 };
  return state;
}

/** Return orders for a board piece, piece id, or numeric board index. */
export function getPieceMoves(state, pieceOrId) {
  if (state.result) return [];
  const from = typeof pieceOrId === 'number'
    ? pieceOrId
    : state.board.findIndex(piece => piece && piece.id === (typeof pieceOrId === 'string' ? pieceOrId : pieceOrId?.id));
  const piece = state.board[from];
  if (!piece || piece.resting) return [];
  const row = Math.floor(from / 8);
  const col = from % 8;
  const moves = [];
  const add = (nextRow, nextCol) => {
    if (!inside(nextRow, nextCol)) return false;
    const to = nextRow * 8 + nextCol;
    const occupant = state.board[to];
    if (occupant?.color === piece.color) return false;
    if (piece.type === 'k' && occupant?.type === 'k' && !occupant.resting) return false;
    if (piece.type === 'p' && (nextRow === 0 || nextRow === 7)) {
      for (const promotion of PROMOTIONS) moves.push({ from, to, promotion });
    } else {
      moves.push({ from, to });
    }
    return !occupant;
  };

  if (piece.type === 'p') {
    const direction = piece.color === 'white' ? -1 : 1;
    const homeRow = piece.color === 'white' ? 6 : 1;
    const nextRow = row + direction;
    if (inside(nextRow, col) && !state.board[nextRow * 8 + col]) {
      add(nextRow, col);
      if (row === homeRow && !state.board[(row + direction * 2) * 8 + col]) add(row + direction * 2, col);
    }
    for (const offset of [-1, 1]) {
      if (!inside(nextRow, col + offset)) continue;
      const target = state.board[nextRow * 8 + col + offset];
      if (target && target.color !== piece.color) add(nextRow, col + offset);
      if (!target) {
        const ep = (state.enPassant ?? []).find(right => right.to === nextRow * 8 + col + offset && right.color !== piece.color
          && right.square === row * 8 + col + offset && state.board[right.square]?.id === right.pawnId);
        if (ep) moves.push({ from, to: ep.to, enPassant: { square: ep.square, pawnId: ep.pawnId } });
      }
    }
  } else if (piece.type === 'n') {
    for (const [dr, dc] of KNIGHT_STEPS) add(row + dr, col + dc);
  } else if (piece.type === 'k') {
    for (const [dr, dc] of ALL_DIRECTIONS) add(row + dr, col + dc);
    const home = piece.color === 'white' ? 56 : 0;
    if (from === home + 4 && !piece.hasMoved) {
      for (const [rookFile, toFile, rookToFile, between] of [[7, 6, 5, [5, 6]], [0, 2, 3, [1, 2, 3]]]) {
        const rook = state.board[home + rookFile];
        if (rook?.color === piece.color && rook.type === 'r' && !rook.hasMoved && !rook.resting && between.every(file => !state.board[home + file])) {
          moves.push({ from, to: home + toFile, castle: { from: home + rookFile, to: home + rookToFile } });
        }
      }
    }
  } else {
    const directions = piece.type === 'b' ? DIAGONALS : piece.type === 'r' ? STRAIGHTS : ALL_DIRECTIONS;
    for (const [dr, dc] of directions) {
      for (let distance = 1; distance < 8; distance++) {
        if (!add(row + dr * distance, col + dc * distance)) break;
      }
    }
  }
  return moves;
}

export function getLegalMoves(state, color) {
  if (!COLORS.includes(color) || state.result) return [];
  return state.board.flatMap((piece, index) => piece?.color === color ? getPieceMoves(state, index) : []);
}

/** Teammates reserve every piece and destination used by their accepted order. */
export function teamOrdersConflict(a, b) {
  if (!a || !b) return false;
  const origins = order => [order.from, ...(order.castle ? [order.castle.from] : [])];
  const targets = order => [order.to, ...(order.castle ? [order.castle.to] : [])];
  return origins(a).some(square => origins(b).includes(square)) || targets(a).some(square => targets(b).includes(square));
}

export function getTeamLegalMoves(state, color, reserved = []) {
  return getLegalMoves(state, color).filter(move => reserved.every(order => !teamOrdersConflict(move, order)));
}

/** Each teammate supplies one order; forced passes are allowed after reservations. */
export function resolveTeamRound(state, whiteOrders, blackOrders) {
  if (state.result) throw new Error('The game has already finished.');
  const normalized = [];
  for (const [color, team] of [['white',whiteOrders], ['black',blackOrders]]) {
    if (!Array.isArray(team) || team.length !== 2) throw new Error('Each team needs two orders.');
    const legal = getLegalMoves(state, color);
    const orders = team.map(order => order == null ? null : normalizeOrder(state, color, order, legal));
    if (teamOrdersConflict(...orders)) throw new Error('Teammates must use different pieces and destinations.');
    if (orders.includes(null) && getTeamLegalMoves(state, color, orders.filter(Boolean)).length) throw new Error(`${title(color)} still has an available team move.`);
    normalized.push(...orders);
  }
  const next = applyOrders(state, normalized, true, ['white','white','black','black']);
  next.lastRound.moves.forEach((move, index) => { move.seat = ['white','white2','black','black2'][index]; });
  return next;
}

function normalizeOrder(state, color, order, legalMoves) {
  if (order == null) {
    if (legalMoves.length) throw new Error(`${title(color)} must choose a move.`);
    return null;
  }
  const piece = state.board[order.from];
  if (!piece || piece.color !== color) throw new Error(`${title(color)} does not own that piece.`);
  const promotes = piece.type === 'p' && [0, 7].includes(Math.floor(order.to / 8));
  const promotion = promotes ? (order.promotion ?? 'q') : undefined;
  const match = legalMoves.find(move => move.from === order.from && move.to === order.to && move.promotion === promotion);
  if (!match || (!promotes && order.promotion != null)) throw new Error(`Illegal ${color} order.`);
  return { ...match };
}

/** Validate and resolve one pair of secret orders against the same starting board. */
export function resolveRound(state, whiteMove, blackMove) {
  if (state.result) throw new Error('The game has already finished.');
  const whiteLegal = getLegalMoves(state, 'white');
  const blackLegal = getLegalMoves(state, 'black');
  const orders = [
    normalizeOrder(state, 'white', whiteMove, whiteLegal),
    normalizeOrder(state, 'black', blackMove, blackLegal),
  ];
  return applyOrders(state, orders, true);
}

function applyOrders(state, orders, record, orderColors = COLORS) {
  const board = state.board.map(piece => piece ? { ...piece, resting: false } : null);
  const captured = { white: [...(state.captured?.white ?? [])], black: [...(state.captured?.black ?? [])] };
  const events = [];
  const captures = [];
  const moves = orders.map((order, index) => {
    const color = orderColors[index];
    return order ? { ...order, color, originalType: state.board[order.from].type, piece: { ...state.board[order.from], type: order.promotion ?? state.board[order.from].type }, captured: false, survived: true } : { color, pass: true };
  });
  // A castle contributes two independent movers. Both depart before any capture.
  const secondaryMoves = moves.filter(move => move.castle).map(move => ({
    ...move.castle, color: move.color, piece: { ...state.board[move.castle.from] }, captured: false, survived: true, auxiliary: true,
  }));
  const movers = [...moves.filter(move => !move.pass), ...secondaryMoves];
  for (const move of movers) board[move.from] = null;
  const take = (victim, victor, square) => {
    captured[victim.color].push({ ...victim });
    captures.push({ piece: { ...victim }, by: victor.id, color: victor.color, square });
  };
  const destinations = new Map();
  for (const move of movers) {
    if (!destinations.has(move.to)) destinations.set(move.to, []);
    destinations.get(move.to).push(move);
  }
  let collision = false;
  const bouncedKings = [];
  // Teammates reserve distinct destinations, so each square has at most two arrivals.
  for (const [square, arrivals] of destinations) {
    let survivor = arrivals[0];
    if (arrivals.length === 2) {
      collision = true;
      const [a, b] = arrivals;
      if (a.piece.type === 'k' && b.piece.type === 'k') {
        a.bounced = b.bounced = true;
        bouncedKings.push(a,b);
        events.push(`The kings met on ${indexToSquare(square)} and returned to their starting squares; neither can capture an active king.`);
        continue;
      }
      const aRank = PIECE_STRENGTH[a.piece.type], bRank = PIECE_STRENGTH[b.piece.type];
      if (aRank === bRank) {
        a.survived = b.survived = false;
        take(a.piece, b.piece, square);
        take(b.piece, a.piece, square);
        events.push(`${describe(a.piece)} and ${describe(b.piece).toLowerCase()} collided on ${indexToSquare(square)}; both were captured.`);
        continue;
      }
      survivor = aRank < bRank ? a : b;
      const victim = survivor === a ? b : a;
      survivor.captured = true;
      victim.survived = false;
      take(victim.piece, survivor.piece, square);
      events.push(`${describe(survivor.piece)} won the collision on ${indexToSquare(square)} and captured ${describe(victim.piece).toLowerCase()}.`);
    } else if (board[square]) {
      const victim = board[square];
      take(victim, survivor.piece, square);
      survivor.captured = true;
      events.push(`${describe(survivor.piece)} captured ${describe(victim).toLowerCase()} on ${indexToSquare(square)}.`);
    }
    board[square] = { ...survivor.piece, resting: survivor.captured, hasMoved: true };
  }
  // Returning kings remain vulnerable to a different enemy piece arriving at
  // their starting square in 2v2. The king protection only applies to kings.
  for (const move of bouncedKings) {
    const attacker = board[move.from];
    if (attacker) {
      take(move.piece,attacker,move.from);
      move.survived = false;
      board[move.from].resting = true;
      const attackingMove = movers.find(candidate => candidate.piece.id === attacker.id);
      attackingMove.captured = true;
      events.push(`${describe(attacker)} captured the returning ${describe(move.piece).toLowerCase()} on ${indexToSquare(move.from)}.`);
    } else board[move.from] = {...move.piece,resting:false,hasMoved:true};
  }
  for (const move of moves) {
    if (move.pass) events.push(`${title(move.color)} had no legal move and passed.`);
    if (move.castle) events.push(`${title(move.color)} castled ${move.to % 8 === 6 ? 'kingside' : 'queenside'}.`);
    // As with ordinary captures, an en passant target can escape by moving.
    if (!move.enPassant || !move.survived) continue;
    const victim = board[move.enPassant.square];
    if (victim?.id === move.enPassant.pawnId) {
      take(victim, move.piece, move.enPassant.square);
      board[move.enPassant.square] = null;
      move.captured = true;
      board[move.to].resting = true;
      events.push(`${describe(move.piece)} captured en passant on ${indexToSquare(move.to)}.`);
    }
  }

  for (const move of moves) {
    if (move.pass || !move.promotion) continue;
    const promotion = move.promotion ?? 'q';
    events.unshift(`${title(move.color)} promoted to ${PIECE_NAMES[promotion]} on ${indexToSquare(move.to)} before captures resolved.`);
  }
  const pawnMoved = moves.some(move => !move.pass && move.originalType === 'p');
  const next = {
    ...state, board, round: state.round + 1, captured, result: null,
    enPassant: moves.filter(move => !move.pass && move.piece.type === 'p' && Math.abs(move.from - move.to) === 16 && move.survived && board[move.to]?.id === move.piece.id)
      .map(move => ({ color: move.color, pawnId: move.piece.id, square: move.to, to: (move.from + move.to) / 2 })),
    noProgressRounds: captures.length || pawnMoved ? 0 : (state.noProgressRounds ?? 0) + 1,
    positionCounts: { ...(state.positionCounts ?? {}) },
  };
  const beforeKey = positionKey(state);
  if (!next.positionCounts[beforeKey]) next.positionCounts[beforeKey] = 1;
  const afterKey = positionKey(next);
  next.positionCounts[afterKey] = (next.positionCounts[afterKey] ?? 0) + 1;
  const whiteKing = board.some(piece => piece?.color === 'white' && piece.type === 'k');
  const blackKing = board.some(piece => piece?.color === 'black' && piece.type === 'k');
  if (!whiteKing && !blackKing) next.result = { winner: 'draw', reason: 'Both kings were captured in the same round.' };
  else if (!whiteKing) next.result = { winner: 'black', reason: 'White’s king was captured.' };
  else if (!blackKing) next.result = { winner: 'white', reason: 'Black’s king was captured.' };
  else if (orders.every(order => order === null) && !getLegalMoves(next, 'white').length && !getLegalMoves(next, 'black').length) {
    next.result = { winner: 'draw', reason: 'Neither player has a legal move.' };
  }
  else if (next.positionCounts[afterKey] >= 3) next.result = { winner: 'draw', reason: 'The same position occurred three times.' };
  else if (next.noProgressRounds >= 100) next.result = { winner: 'draw', reason: '100 rounds passed without a pawn move or capture.' };
  if (record) {
    const lastRound = { round: state.round, moves, secondaryMoves, events, captures, collision, result: next.result };
    next.lastRound = lastRound;
    next.history = [...(state.history ?? []), lastRound];
  }
  return next;
}

function evaluateBoard(state, color) {
  if (state.result) return state.result.winner === 'draw' ? 0 : state.result.winner === color ? 1000000 : -1000000;
  let score = 0;
  for (let index = 0; index < 64; index++) {
    const piece = state.board[index];
    if (!piece) continue;
    const row = Math.floor(index / 8);
    const col = index % 8;
    const center = 7 - Math.abs(3.5 - row) - Math.abs(3.5 - col);
    const advancement = piece.color === 'white' ? 6 - row : row - 1;
    const positional = piece.type === 'p' ? advancement * 8 + center * 2 : piece.type === 'n' || piece.type === 'b' ? center * 5 : piece.type === 'k' ? -center * 2 : center * 2;
    score += (piece.color === color ? 1 : -1) * (MATERIAL[piece.type] + positional - (piece.resting ? MATERIAL[piece.type] * 0.08 : 0));
  }
  return score;
}

function orderPriority(state, move) {
  if (!move) return 0;
  const piece = state.board[move.from];
  const target = state.board[move.to];
  const row = Math.floor(move.to / 8);
  const col = move.to % 8;
  const center = 7 - Math.abs(3.5 - row) - Math.abs(3.5 - col);
  let score = center * 4 + (target ? Math.min(MATERIAL[target.type], 3000) : 0);
  if (move.promotion) score += MATERIAL[move.promotion] - MATERIAL.p;
  // Escaping a currently threatened square is a useful prior for simultaneous play.
  if (piece.type === 'k') score += 3;
  return score;
}

/**
 * Choose an order without seeing the opponent's submitted order. Normal and hard
 * compare simultaneous replies; easy uses a random legal order. All modes return
 * a legal {from,to,promotion?} or null if the player cannot move.
 */
export function chooseComputerMove(state, color, difficulty = 'normal') {
  if (difficulty === 'casual') difficulty = 'easy';
  if (difficulty === 'balanced') difficulty = 'normal';
  const legal = getLegalMoves(state, color);
  if (!legal.length) return null;
  if (difficulty === 'easy') return { ...legal[Math.floor(Math.random() * legal.length)] };
  const enemy = otherColor(color);
  const enemyLegal = getLegalMoves(state, enemy);
  const opponentOrders = enemyLegal.length ? enemyLegal : [null];
  const rankedReplies = opponentOrders.map(move => ({ move, priority: orderPriority(state, move) })).sort((a, b) => b.priority - a.priority);
  // Keep all tactical replies, plus a spread of quieter orders to model evasion.
  const limit = difficulty === 'hard' ? 36 : 20;
  const selected = rankedReplies.slice(0, Math.ceil(limit * 0.7));
  const remaining = rankedReplies.slice(selected.length);
  const slots = limit - selected.length;
  for (let i = 0; i < slots && remaining.length; i++) selected.push(remaining[Math.floor(i * remaining.length / slots)]);
  // Always include every reply that can meet our king at its current or next
  // square. Rare king captures must not disappear from the reply sample.
  const kingSquare = state.board.findIndex(piece => piece?.color === color && piece.type === 'k');
  const kingSquares = new Set([kingSquare, ...getPieceMoves(state, kingSquare).map(move => move.to)]);
  for (const reply of rankedReplies) {
    if (reply.move && kingSquares.has(reply.move.to) && !selected.includes(reply)) selected.push(reply);
  }
  const replies = selected.length ? selected : rankedReplies;
  const baseline = evaluateBoard(state, color);
  let best = legal[0];
  let bestScore = -Infinity;
  for (const move of legal) {
    let weighted = 0;
    let totalWeight = 0;
    let worst = Infinity;
    for (const reply of replies) {
      const orders = color === 'white' ? [move, reply.move] : [reply.move, move];
      const next = applyOrders(state, orders, false);
      const score = evaluateBoard(next, color) - baseline;
      const weight = 1 + Math.min(4, Math.max(0, reply.priority) / 180);
      weighted += score * weight;
      totalWeight += weight;
      worst = Math.min(worst, score);
    }
    const caution = difficulty === 'hard' ? 0.35 : 0.2;
    const score = (weighted / totalWeight) * (1 - caution) + worst * caution + Math.random() * 3;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return { ...best };
}
