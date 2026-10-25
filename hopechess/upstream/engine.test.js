import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, getPieceMoves, getLegalMoves, resolveRound, resolveTeamRound, getTeamLegalMoves, chooseComputerMove, squareToIndex, indexToSquare, positionKey } from './engine.js';

const at = squareToIndex;
const move = (from, to, promotion) => ({ from: at(from), to: at(to), ...(promotion ? { promotion } : {}) });
function position(pieces) {
  const state = createInitialState();
  state.board.fill(null);
  for (const [square, color, type, resting = false] of pieces) {
    state.board[at(square)] = { id: `${color}-${type}-${square}`, color, type, resting };
  }
  return state;
}
const withKings = pieces => position([['a1', 'white', 'k'], ['h8', 'black', 'k'], ...pieces]);
const destinations = (state, square) => getPieceMoves(state, at(square)).map(order => indexToSquare(order.to));

test('initial board and coordinates match conventional chess', () => {
  const state = createInitialState();
  assert.equal(state.board.filter(Boolean).length, 32);
  assert.equal(state.board[at('e1')].type, 'k');
  assert.equal(state.board[at('d8')].type, 'q');
  assert.equal(getLegalMoves(state, 'white').length, 20);
  assert.equal(getLegalMoves(state, 'black').length, 20);
  for (let index = 0; index < 64; index++) assert.equal(at(indexToSquare(index)), index);
});

test('orders resolve simultaneously and state remains immutable', () => {
  const state = createInitialState();
  const before = JSON.stringify(state);
  const next = resolveRound(state, move('e2', 'e4'), move('e7', 'e5'));
  assert.equal(JSON.stringify(state), before);
  assert.equal(next.board[at('e4')].color, 'white');
  assert.equal(next.board[at('e5')].color, 'black');
  assert.equal(next.round, 2);
  assert.equal(next.history.length, 1);
  assert.equal(next.lastRound.round, 1);
});

test('pawn moving forward defeats a stronger piece at the same destination', () => {
  const state = withKings([['d2', 'white', 'p'], ['f4', 'black', 'n']]);
  const next = resolveRound(state, move('d2', 'd3'), move('f4', 'd3'));
  assert.equal(next.board[at('d3')].type, 'p');
  assert.equal(next.board[at('d3')].resting, true);
  assert.equal(next.captured.black[0].type, 'n');
  assert.equal(next.lastRound.collision, true);
});

test('knight beats bishop in a collision and equal pieces destroy each other', () => {
  let state = withKings([['b1', 'white', 'n'], ['d2', 'black', 'b']]);
  let next = resolveRound(state, move('b1', 'c3'), move('d2', 'c3'));
  assert.equal(next.board[at('c3')].type, 'n');
  assert.equal(next.captured.black[0].type, 'b');
  state = withKings([['a2', 'white', 'r'], ['d5', 'black', 'r']]);
  next = resolveRound(state, move('a2', 'd2'), move('d5', 'd2'));
  assert.equal(next.board[at('d2')], null);
  assert.equal(next.captured.white.length, 1);
  assert.equal(next.captured.black.length, 1);
});

test('a target that moves away evades capture; a diagonal pawn still moves', () => {
  const state = withKings([['d4', 'white', 'p'], ['e5', 'black', 'r']]);
  const next = resolveRound(state, move('d4', 'e5'), move('e5', 'e6'));
  assert.equal(next.board[at('e5')].type, 'p');
  assert.equal(next.board[at('e6')].type, 'r');
  assert.equal(next.board[at('e5')].resting, false);
  assert.equal(next.captured.black.length, 0);
});

test('pieces swapping squares evade each other, including diagonal pawns', () => {
  const state = withKings([['d4', 'white', 'p'], ['e5', 'black', 'p']]);
  const next = resolveRound(state, move('d4', 'e5'), move('e5', 'd4'));
  assert.equal(next.board[at('e5')].color, 'white');
  assert.equal(next.board[at('d4')].color, 'black');
  assert.equal(next.lastRound.collision, false);
  assert.equal(next.captured.white.length + next.captured.black.length, 0);
});

test('ordinary capture ignores strength and forces exactly one round of rest', () => {
  const state = withKings([['d2', 'white', 'q'], ['d4', 'black', 'p']]);
  let next = resolveRound(state, move('d2', 'd4'), move('h8', 'h7'));
  assert.equal(next.board[at('d4')].type, 'q');
  assert.equal(next.board[at('d4')].resting, true);
  assert.deepEqual(getPieceMoves(next, at('d4')), []);
  next = resolveRound(next, move('a1', 'a2'), move('h7', 'h6'));
  assert.equal(next.board[at('d4')].resting, false);
  assert.ok(getPieceMoves(next, at('d4')).length > 0);
});

test('resting pieces can be captured and cannot submit orders', () => {
  const state = withKings([['d4', 'white', 'q', true], ['d7', 'black', 'r']]);
  assert.throws(() => resolveRound(state, move('d4', 'd5'), move('d7', 'd4')), /Illegal/);
  const next = resolveRound(state, move('a1', 'a2'), move('d7', 'd4'));
  assert.equal(next.board[at('d4')].color, 'black');
  assert.equal(next.captured.white[0].type, 'q');
});

test('pawn and sliding legality use the starting board, including blockers', () => {
  const state = withKings([['d2', 'white', 'p'], ['e3', 'black', 'p'], ['d3', 'black', 'n'], ['c2', 'white', 'r'], ['c4', 'black', 'b']]);
  assert.deepEqual(destinations(state, 'd2'), ['e3']);
  assert.ok(!destinations(state, 'c2').includes('c5'));
  assert.ok(destinations(state, 'c2').includes('c4'));
  assert.throws(() => resolveRound(state, move('c2', 'c5'), move('c4', 'e6')), /Illegal/);
});

test('promotion strength applies before collisions, including underpromotion and equal types', () => {
  const state = withKings([['b7', 'white', 'p'], ['c6', 'black', 'n']]);
  const before = JSON.stringify(state);
  const queen = resolveRound(state, move('b7', 'b8', 'q'), move('c6', 'b8'));
  assert.equal(queen.board[at('b8')].color, 'black');
  assert.equal(queen.board[at('b8')].type, 'n');
  assert.equal(queen.board[at('b8')].resting, true);
  assert.equal(queen.captured.white[0].type, 'q');
  const equal = resolveRound(state, move('b7', 'b8', 'n'), move('c6', 'b8'));
  assert.equal(equal.board[at('b8')],null);
  assert.equal(equal.captured.white[0].type,'n');
  const rook = withKings([['b7','white','p'],['d8','black','r']]);
  const knight = resolveRound(rook,move('b7','b8','n'),move('d8','b8'));
  assert.equal(knight.board[at('b8')].color,'white');
  assert.equal(knight.board[at('b8')].type,'n');
  assert.ok(knight.board[at('b8')].resting);
  assert.equal(JSON.stringify(state),before);
  assert.ok(queen.lastRound.events[0].includes('promoted'));
});

test('promotion defaults to queen and rejects invalid promotion types', () => {
  const state = withKings([['b7', 'white', 'p']]);
  const next = resolveRound(state, move('b7', 'b8'), move('h8', 'h7'));
  assert.equal(next.board[at('b8')].type, 'q');
  assert.throws(() => resolveRound(state, move('b7', 'b8', 'k'), move('h8', 'h7')), /Illegal/);
});

test('capturing a king wins and attacked kings may move without check restrictions', () => {
  const state = position([['a1', 'white', 'k'], ['h8', 'black', 'k'], ['h1', 'white', 'r'], ['a8', 'black', 'r']]);
  const next = resolveRound(state, move('h1', 'h8'), move('a8', 'b8'));
  assert.equal(next.result.winner, 'white');
  assert.equal(next.captured.black[0].type, 'k');
  assert.throws(() => resolveRound(next, null, null), /already finished/);
  const adjacent = position([['e4', 'white', 'k'], ['e6', 'black', 'k']]);
  assert.ok(destinations(adjacent, 'e4').includes('e5'));
});

test('both kings captured by other pieces draw; active kings colliding return without capturing', () => {
  const state = position([['a1', 'white', 'k'], ['h8', 'black', 'k'], ['h1', 'white', 'r'], ['a8', 'black', 'r']]);
  assert.equal(resolveRound(state, move('h1', 'h8'), move('a8', 'a1')).result.winner, 'draw');
  const kings = position([['d4', 'white', 'k'], ['f4', 'black', 'k']]);
  const bounced = resolveRound(kings, move('d4', 'e4'), move('f4', 'e4'));
  assert.equal(bounced.result,null);
  assert.equal(bounced.board[at('d4')].type,'k');
  assert.equal(bounced.board[at('f4')].type,'k');
  assert.equal(bounced.board[at('e4')],null);
  assert.equal(bounced.captured.white.length + bounced.captured.black.length,0);
  assert.ok(bounced.lastRound.moves.every(move => move.bounced));
});

test('forced passes clear rest; a temporary double lock does not end the game', () => {
  const state = position([['a1', 'white', 'k', true], ['h8', 'black', 'k', true]]);
  assert.equal(getLegalMoves(state, 'white').length, 0);
  const next = resolveRound(state, null, null);
  assert.equal(next.result, null);
  assert.equal(next.board[at('a1')].resting, false);
  assert.ok(getLegalMoves(next, 'white').length);
  assert.throws(() => resolveRound(next, null, null), /must choose/);
});

test('one side may pass while its opponent moves', () => {
  const state = position([['a1', 'white', 'k', true], ['h8', 'black', 'k']]);
  const next = resolveRound(state, null, move('h8', 'h7'));
  assert.equal(next.board[at('h7')].color, 'black');
  assert.equal(next.board[at('a1')].resting, false);
});

test('permanent lack of moves draws after forced passes', () => {
  const pieces = [['a1', 'white', 'k'], ['h8', 'black', 'k']];
  for (let rank = 1; rank <= 8; rank++) {
    for (const file of ['a', 'b']) if (`${file}${rank}` !== 'a1') pieces.push([`${file}${rank}`, 'white', 'p']);
    for (const file of ['g', 'h']) if (`${file}${rank}` !== 'h8') pieces.push([`${file}${rank}`, 'black', 'p']);
  }
  const state = position(pieces);
  assert.equal(getLegalMoves(state, 'white').length + getLegalMoves(state, 'black').length, 0);
  const next = resolveRound(state, null, null);
  assert.equal(next.result.winner, 'draw');
  assert.match(next.result.reason, /Neither player/);
});

test('third identical position draws, including piece rest in position identity', () => {
  let state = position([['a1', 'white', 'k'], ['h8', 'black', 'k']]);
  const resting = structuredClone(state);
  resting.board[at('a1')].resting = true;
  assert.notEqual(positionKey(state), positionKey(resting));
  for (let round = 0; round < 4; round++) {
    state = round % 2 === 0
      ? resolveRound(state, move('a1', 'a2'), move('h8', 'h7'))
      : resolveRound(state, move('a2', 'a1'), move('h7', 'h8'));
    assert.equal(state.result?.winner ?? null, round === 3 ? 'draw' : null);
  }
  assert.match(state.result.reason, /three times/);
});

test('100 quiet rounds draw, while pawn moves and captures reset the count', () => {
  const state = position([['a1', 'white', 'k'], ['h8', 'black', 'k']]);
  state.noProgressRounds = 99;
  const next = resolveRound(state, move('a1', 'a2'), move('h8', 'h7'));
  assert.equal(next.result.winner, 'draw');
  assert.equal(next.noProgressRounds, 100);
  const pawns = withKings([['d2', 'white', 'p']]);
  pawns.noProgressRounds = 99;
  assert.equal(resolveRound(pawns, move('d2', 'd3'), move('h8', 'h7')).noProgressRounds, 0);
  const capture = withKings([['d2', 'white', 'r'], ['d3', 'black', 'n']]);
  capture.noProgressRounds = 99;
  assert.equal(resolveRound(capture, move('d2', 'd3'), move('h8', 'h7')).noProgressRounds, 0);
});

test('invalid orders are rejected and en passant requires a previous double step', () => {
  const state = createInitialState();
  assert.throws(() => resolveRound(state, move('e7', 'e5'), move('e7', 'e5')), /does not own/);
  assert.throws(() => resolveRound(state, move('e2', 'e5'), move('e7', 'e5')), /Illegal/);
  const clear = withKings([['e1', 'white', 'k'], ['h1', 'white', 'r'], ['d5', 'white', 'p'], ['e5', 'black', 'p']]);
  assert.ok(destinations(clear, 'e1').includes('g1'));
  assert.ok(!destinations(clear, 'd5').includes('e6'));
});

test('all computer levels choose legal orders without mutating the state', () => {
  const state = createInitialState();
  const before = JSON.stringify(state);
  const legal = getLegalMoves(state, 'black');
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const chosen = chooseComputerMove(state, 'black', difficulty);
    assert.ok(legal.some(order => JSON.stringify(order) === JSON.stringify(chosen)));
  }
  assert.equal(JSON.stringify(state), before);
  const resting = position([['a1', 'white', 'k', true], ['h8', 'black', 'k']]);
  assert.equal(chooseComputerMove(resting, 'white'), null);
});

test('computer moves an exposed king when every stationary order permits its capture', () => {
  const state = position([['e1', 'white', 'k'], ['a8', 'black', 'k'], ['e8', 'black', 'r'], ['b1', 'white', 'q']]);
  for (const difficulty of ['normal', 'hard']) {
    const chosen = chooseComputerMove(state, 'white', difficulty);
    assert.equal(chosen.from, at('e1'));
    assert.notEqual(chosen.to % 8, 4);
  }
});


test('both sides can castle through attacked squares, with independent rook movement', () => {
  const state = position([['e1','white','k'],['a1','white','r'],['h1','white','r'],['e8','black','k'],['h8','black','r'],['f3','black','r'],['e3','black','r'],['g3','black','r']]);
  assert.ok(destinations(state, 'e1').includes('c1'));
  const before = JSON.stringify(state);
  const next = resolveRound(state, move('e1','g1'), move('e8','g8'));
  assert.equal(JSON.stringify(state), before);
  for (const [square,type,color] of [['g1','k','white'],['f1','r','white'],['g8','k','black'],['f8','r','black']]) {
    assert.equal(next.board[at(square)].type,type);
    assert.equal(next.board[at(square)].color,color);
    assert.equal(next.board[at(square)].hasMoved,true);
  }
  assert.equal(next.lastRound.secondaryMoves.length,2);
});

test('castling needs unmoved, non-resting king and rook and a clear whole path', () => {
  const state = position([['e1','white','k'],['a1','white','r'],['h1','white','r'],['e8','black','k']]);
  for (const [square, property] of [['e1','hasMoved'],['h1','hasMoved'],['h1','resting'],['e1','resting']]) {
    const blocked = structuredClone(state);
    blocked.board[at(square)][property] = true;
    assert.ok(!destinations(blocked, 'e1').includes('g1'));
  }
  state.board[at('b1')] = { id:'block',color:'white',type:'n' };
  assert.ok(!destinations(state,'e1').includes('c1'));
  let next = resolveRound(state,move('e1','f1'),move('e8','e7'));
  next = resolveRound(next,move('f1','e1'),move('e7','e8'));
  assert.ok(!destinations(next,'e1').includes('g1'));
  assert.notEqual(positionKey(state),positionKey(next));
});

test('castling rook can collide and rest while the king completes its move', () => {
  const state = position([['e1','white','k'],['h1','white','r'],['a8','black','k'],['f8','black','q']]);
  const next = resolveRound(state,move('e1','g1'),move('f8','f1'));
  assert.equal(next.board[at('g1')].type,'k');
  assert.equal(next.board[at('g1')].resting,false);
  assert.equal(next.board[at('f1')].type,'r');
  assert.equal(next.board[at('f1')].resting,true);
  assert.equal(next.captured.black[0].type,'q');
});

test('a castling king can be captured at its destination and the rook still moves', () => {
  const state = position([['e1','white','k'],['h1','white','r'],['a8','black','k'],['e2','black','n']]);
  const next = resolveRound(state,move('e1','g1'),move('e2','g1'));
  assert.equal(next.result.winner,'black');
  assert.equal(next.board[at('f1')].type,'r');
});

test('en passant lasts one round and capturing pawn rests; the target can evade', () => {
  const state = withKings([['d5','white','p'],['e7','black','p']]);
  const next = resolveRound(state,move('a1','a2'),move('e7','e5'));
  assert.ok(destinations(next,'d5').includes('e6'));
  const capture = resolveRound(next,move('d5','e6'),move('h8','h7'));
  assert.equal(capture.board[at('e5')],null);
  assert.equal(capture.board[at('e6')].resting,true);
  assert.equal(capture.captured.black[0].type,'p');
  const evade = resolveRound(next,move('d5','e6'),move('e5','e4'));
  assert.equal(evade.board[at('e4')].color,'black');
  assert.equal(evade.board[at('e6')].resting,false);
  assert.equal(evade.captured.black.length,0);
  const expired = resolveRound(next,move('a2','a3'),move('h8','h7'));
  assert.ok(!destinations(expired,'d5').includes('e6'));
});

test('en passant supports black and collision rules still apply at the landing square', () => {
  const state = withKings([['d4','black','p'],['e2','white','p'],['c5','white','n']]);
  const next = resolveRound(state,move('e2','e4'),move('h8','h7'));
  assert.ok(destinations(next,'d4').includes('e3'));
  const result = resolveRound(next,move('a1','a2'),move('d4','e3'));
  assert.equal(result.board[at('e4')],null);
  assert.equal(result.board[at('e3')].type,'p');
  assert.equal(result.board[at('e3')].resting,true);
  // A white knight can instead meet the capturing pawn on its landing square.
  const collisionState = withKings([['d5','white','p'],['e7','black','p'],['c7','black','n']]);
  const prepared = resolveRound(collisionState,move('a1','a2'),move('e7','e5'));
  const collided = resolveRound(prepared,move('d5','e6'),move('c7','e6'));
  assert.equal(collided.board[at('e6')].type,'p');
  assert.equal(collided.board[at('e5')],null);
  assert.equal(collided.captured.black.length,2);
});


test('a double-stepping pawn that wins a collision can still be captured en passant while resting', () => {
  const state = withKings([['d5','white','p'],['e7','black','p'],['c6','white','n']]);
  const next = resolveRound(state,move('c6','e5'),move('e7','e5'));
  assert.equal(next.board[at('e5')].resting,true);
  assert.ok(destinations(next,'d5').includes('e6'));
  const captured = resolveRound(next,move('d5','e6'),move('h8','h7'));
  assert.equal(captured.board[at('e5')],null);
  assert.equal(captured.board[at('e6')].resting,true);
  assert.equal(captured.captured.white[0].type,'n');
  assert.equal(captured.captured.black[0].type,'p');
});

test('2v2 resolves four orders from the same board and records both teammates', () => {
  const state = createInitialState();
  const before = JSON.stringify(state);
  const next = resolveTeamRound(state,[move('e2','e4'),move('d2','d4')],[move('e7','e5'),move('d7','d5')]);
  assert.equal(JSON.stringify(state),before);
  for (const square of ['e4','d4','e5','d5']) assert.ok(next.board[at(square)]);
  assert.deepEqual(next.lastRound.moves.map(move => move.seat),['white','white2','black','black2']);
  assert.equal(next.round,2);
});

test('2v2 forbids sharing a piece, destination, or the rook used by a castle', () => {
  const state = createInitialState();
  const black = [move('e7','e5'),move('d7','d5')];
  assert.throws(() => resolveTeamRound(state,[move('e2','e4'),move('e2','e3')],black),/different pieces/);
  const sameTarget = withKings([['b1','white','n'],['c1','white','b'],['g7','black','p'],['h7','black','p']]);
  assert.throws(() => resolveTeamRound(sameTarget,[move('b1','d2'),move('c1','d2')],[move('g7','g6'),move('h7','h6')]),/destinations/);
  const castle = position([['e1','white','k'],['h1','white','r'],['g2','white','b'],['e8','black','k'],['g7','black','p'],['h7','black','p']]);
  for (const other of [move('h1','h2'),move('g2','f1')]) assert.throws(() => resolveTeamRound(castle,[move('e1','g1'),other],[move('g7','g6'),move('h7','h6')]),/different pieces/);
  const available = getTeamLegalMoves(castle,'white',getPieceMoves(castle,at('e1')).filter(move => move.castle && move.to === at('g1')));
  assert.ok(!available.some(move => move.from === at('h1') || move.from === at('e1') || move.to === at('f1') || move.to === at('g1')));
});

test('2v2 permits a forced second pass only when no distinct legal move remains', () => {
  const state = withKings([['a2','white','p'],['g7','black','p'],['h7','black','p']]);
  state.board[at('a1')].resting = true;
  const black = [move('g7','g6'),move('h7','h6')];
  const next = resolveTeamRound(state,[move('a2','a3'),null],black);
  assert.equal(next.lastRound.moves[1].pass,true);
  assert.equal(next.board[at('a1')].resting,false);
  state.board[at('a1')].resting = false;
  assert.throws(() => resolveTeamRound(state,[move('a2','a3'),null],black),/available team move/);
  assert.throws(() => resolveTeamRound(state,[null,null],black),/available team move/);
});

test('2v2 resolves two enemy collisions independently and rests only the capturing pieces', () => {
  const state = withKings([['d2','white','p'],['b1','white','n'],['f4','black','n'],['d4','black','b']]);
  const next = resolveTeamRound(state,[move('d2','d3'),move('b1','c3')],[move('f4','d3'),move('d4','c3')]);
  assert.equal(next.board[at('d3')].type,'p');
  assert.equal(next.board[at('c3')].type,'n');
  assert.equal(next.board[at('d3')].resting,true);
  assert.equal(next.board[at('c3')].resting,true);
  assert.equal(next.captured.black.length,2);
});

test('2v2 simultaneous king captures draw and two en passant rights can coexist', () => {
  const kings = withKings([['a8','white','r'],['h1','black','r'],['e2','white','p'],['e7','black','p']]);
  assert.equal(resolveTeamRound(kings,[move('a8','h8'),move('e2','e3')],[move('h1','a1'),move('e7','e6')]).result.winner,'draw');
  const pawns = withKings([['b5','white','p'],['d5','white','p'],['g1','white','n'],['c7','black','p'],['e7','black','p'],['b8','black','n']]);
  const next = resolveTeamRound(pawns,[move('a1','a2'),move('g1','f3')],[move('c7','c5'),move('e7','e5')]);
  assert.equal(next.enPassant.length,2);
  const captured = resolveTeamRound(next,[move('b5','c6'),move('d5','e6')],[move('h8','h7'),move('b8','a6')]);
  assert.equal(captured.board[at('c5')],null);
  assert.equal(captured.board[at('e5')],null);
  assert.equal(captured.captured.black.length,2);
  assert.ok(captured.board[at('c6')].resting && captured.board[at('e6')].resting);
});


test('a king cannot target an unpaused king but can capture one resting after a capture', () => {
  const adjacent = position([['e4','white','k'],['e5','black','k']]);
  assert.ok(!destinations(adjacent,'e4').includes('e5'));
  assert.ok(!destinations(adjacent,'e5').includes('e4'));
  assert.ok(destinations(adjacent,'e4').includes('d5'));
  assert.throws(() => resolveRound(adjacent,move('e4','e5'),move('e5','f5')),/Illegal/);
  for (const difficulty of ['easy','normal','hard']) assert.notEqual(chooseComputerMove(adjacent,'white',difficulty).to,at('e5'));
  const state = position([['e4','white','k'],['e6','black','k'],['e5','white','p'],['h7','black','p']]);
  const captured = resolveRound(state,move('e4','d4'),move('e6','e5'));
  assert.equal(captured.board[at('e5')].resting,true);
  assert.ok(destinations(captured,'d4').includes('e5'));
  assert.equal(resolveRound(captured,move('d4','e5'),move('h7','h6')).result.winner,'white');
});

test('promotions still reset pawn progress and 2v2 uses promoted collision strength', () => {
  const state = withKings([['b7','white','p']]);
  state.noProgressRounds = 99;
  const next = resolveRound(state,move('b7','b8','r'),move('h8','h7'));
  assert.equal(next.noProgressRounds,0);
  assert.equal(next.result,null);
  const teams = withKings([['b7','white','p'],['d2','white','p'],['c6','black','n'],['e7','black','p']]);
  const round = resolveTeamRound(teams,[move('b7','b8','q'),move('d2','d3')],[move('c6','b8'),move('e7','e6')]);
  assert.equal(round.board[at('b8')].color,'black');
  assert.equal(round.captured.white[0].type,'q');
});


test('bouncing kings in 2v2 remain vulnerable to another enemy piece at their starting square', () => {
  const state = position([['d4','white','k'],['f4','black','k'],['a2','white','p'],['d8','black','r']]);
  const next = resolveTeamRound(state,[move('d4','e4'),move('a2','a3')],[move('f4','e4'),move('d8','d4')]);
  assert.equal(next.result.winner,'black');
  assert.equal(next.board[at('d4')].type,'r');
  assert.equal(next.board[at('d4')].resting,true);
  assert.equal(next.board[at('f4')].type,'k');
  assert.equal(next.captured.white[0].type,'k');
});
