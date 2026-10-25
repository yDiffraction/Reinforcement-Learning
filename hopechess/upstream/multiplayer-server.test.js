import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHopechessServer } from './server.mjs';
import { createInitialState, resolveRound, squareToIndex } from './engine.js';

const move = (from, to, promotion) => ({ from: squareToIndex(from), to: squareToIndex(to), ...(promotion ? { promotion } : {}) });

async function host(t, options) {
  const server = createHopechessServer(options);
  const controllers = [];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const request = async (pathname, body, expected = 200) => {
    const response = await fetch(base + pathname, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (expected >= 400) assert.equal(typeof value.error, 'string');
    return value;
  };
  const create = (color = 'white', timeLimitMinutes = null, rated = true) => request('/api/rooms', { color, timeLimitMinutes, rated }, 201);
  const join = code => request(`/api/rooms/${code}/join`, {});
  const snapshot = player => request(`/api/rooms/${player.code}?token=${player.token}`);
  const order = (player, game, chosenMove, expected = 200) => request(`/api/rooms/${player.code}/move`, {
    token: player.token, round: game.game.round, gameId: game.gameId, move: chosenMove,
  }, expected);
  const events = async player => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/api/rooms/${player.code}/events?${player.spectator ? 'watch=1' : `token=${player.token}`}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextState = async () => {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!message.includes('event: state\n')) continue;
          return JSON.parse(message.split('\n').find(line => line.startsWith('data: ')).slice(6));
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Event stream ended before a state arrived.');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    return {
      close: () => controller.abort(),
      next: async () => {
        let timer;
        try {
          return await Promise.race([nextState(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No state event within two seconds.')), 2000); })]);
        } finally { clearTimeout(timer); }
      },
    };
  };
  return { base, request, create, join, snapshot, order, events };
}

test('two seats share a game, with random colors, private tokens, and room capacity', async t => {
  const api = await host(t);
  const black = await api.create('black');
  assert.equal(black.color, 'black');
  assert.match(black.code, /^\d{4}$/);
  const white = await api.join(black.code.toLowerCase());
  assert.equal(white.color, 'white');
  assert.notEqual(white.token, black.token);
  const [whiteState, blackState] = await Promise.all([api.snapshot(white), api.snapshot(black)]);
  assert.deepEqual(whiteState.game, createInitialState());
  assert.deepEqual(whiteState.game, blackState.game);
  assert.equal(whiteState.gameId, blackState.gameId);
  for (const color of ['white','black']) {
    assert.equal(whiteState.players[color].joined,true);
    assert.equal(whiteState.players[color].connected,false);
    assert.equal(whiteState.players[color].account.guest,true);
    assert.equal(whiteState.players[color].account.ratings['1v1'].elo,1000);
  }
  assert.equal(whiteState.you, 'white');
  assert.equal(blackState.you, 'black');
  assert.ok(!JSON.stringify(whiteState).includes(black.token));
  assert.ok(!JSON.stringify(blackState).includes(white.token));
  await api.request(`/api/rooms/${black.code}/join`, {}, 409);
  const random = await api.create('random');
  assert.ok(['white', 'black'].includes(random.color));
});

test('host info lists local and LAN addresses using the actual listening port without caching', async t => {
  const api = await host(t);
  const info = await api.request('/api/info');
  const port = new URL(api.base).port;
  assert.equal(info.localUrl, `http://localhost:${port}`);
  assert.ok(Array.isArray(info.lanUrls));
  assert.equal(new Set(info.lanUrls).size, info.lanUrls.length);
  for (const address of info.lanUrls) {
    const url = new URL(address);
    assert.equal(url.protocol, 'http:');
    assert.equal(url.port, port);
    assert.match(url.hostname, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.notEqual(url.hostname, '127.0.0.1');
  }
});

test('room codes contain exactly four digits, stay unique, and reject old alphanumeric codes', async t => {
  const api = await host(t);
  const codes = new Set();
  for (let i = 0; i < 30; i++) {
    const player = await api.create();
    assert.match(player.code, /^\d{4}$/);
    assert.equal(codes.has(player.code), false);
    codes.add(player.code);
    const other = await api.join(player.code);
    assert.equal(other.code, player.code);
  }
  for (const code of ['ABCDEF','123456','123','12AB']) await api.request(`/api/rooms/${code}/join`, {}, 404);
});

test('first move stays secret; both moves resolve together using the rules engine', async t => {
  const api = await host(t);
  const white = await api.create();
  const black = await api.join(white.code);
  const initial = await api.snapshot(white);
  const whiteMove = move('e2', 'e4');
  const blackMove = move('d7', 'd5');
  const first = await api.order(white, initial, whiteMove);
  assert.deepEqual(first.game, initial.game);
  assert.deepEqual(first.submitted, { white: true, black: false });
  assert.deepEqual(first.yourMove, whiteMove);
  const blackWaiting = await api.snapshot(black);
  assert.deepEqual(blackWaiting.game, initial.game);
  assert.ok(!Object.hasOwn(blackWaiting, 'orders'));
  assert.ok(!JSON.stringify(blackWaiting).includes('"from"'));
  await api.order(white, initial, move('d2', 'd4'), 409);
  const resolved = await api.order(black, initial, blackMove);
  assert.deepEqual(resolved.game, resolveRound(initial.game, whiteMove, blackMove));
  assert.deepEqual(resolved.submitted, { white: false, black: false });
  assert.equal(resolved.game.round, 2);
  assert.deepEqual((await api.snapshot(white)).game, resolved.game);
  await api.order(white, initial, whiteMove, 409);
  const whiteDiagonal = move('e4', 'd5');
  const escapingPawn = move('d5', 'd4');
  await api.order(white, resolved, whiteDiagonal);
  const evasion = await api.order(black, resolved, escapingPawn);
  assert.deepEqual(evasion.game, resolveRound(resolved.game, whiteDiagonal, escapingPawn));
  assert.equal(evasion.game.board[squareToIndex('d5')].color, 'white');
  assert.equal(evasion.game.board[squareToIndex('d4')].color, 'black');
  assert.equal(evasion.game.board[squareToIndex('d5')].resting, false);
});

test('illegal moves, opponent pieces, voluntary passes, missing fields, and invalid sessions fail before accepting an order', async t => {
  const api = await host(t);
  const white = await api.create();
  const initial = white.snapshot;
  await api.order(white, initial, move('e2', 'e4'), 409);
  await api.join(white.code);
  await api.order(white, initial, move('e2', 'e5'), 400);
  await api.order(white, initial, move('e7', 'e5'), 400);
  await api.order(white, initial, null, 400);
  await api.order(white, initial, { from: 52.5, to: 36 }, 400);
  await api.order(white, initial, { ...move('e2', 'e4'), promotion: 'q' }, 400);
  await api.request(`/api/rooms/${white.code}/move`, { token: white.token, gameId: initial.gameId, round: 1 }, 400);
  await api.request(`/api/rooms/${white.code}/move`, { token: white.token, round: 1, move: move('e2', 'e4') }, 400);
  await api.request(`/api/rooms/${white.code}?token=wrong`, undefined, 401);
  await api.request(`/api/rooms/${white.code}/move`, { token: 'wrong', gameId: initial.gameId, round: 1, move: move('e2', 'e4') }, 401);
  assert.deepEqual((await api.snapshot(white)).submitted, { white: false, black: false });
});

test('event streams reveal connection state and simultaneous results, and reconnect preserves the seat and locked move', async t => {
  const api = await host(t);
  const white = await api.create();
  const black = await api.join(white.code);
  const whiteEvents = await api.events(white);
  const whiteConnected = await whiteEvents.next();
  assert.equal(whiteConnected.players.white.connected, true);
  assert.equal(whiteConnected.players.black.connected, false);
  const blackEvents = await api.events(black);
  const [joinedWhite, joinedBlack] = await Promise.all([whiteEvents.next(), blackEvents.next()]);
  assert.deepEqual(joinedWhite.players, joinedBlack.players);
  assert.equal(joinedWhite.players.black.connected, true);
  await api.order(white, joinedWhite, move('e2', 'e4'));
  const [whiteLocked, blackWaiting] = await Promise.all([whiteEvents.next(), blackEvents.next()]);
  assert.deepEqual(blackWaiting.submitted, { white: true, black: false });
  assert.deepEqual(blackWaiting.game, createInitialState());
  assert.ok(whiteLocked.revision > joinedWhite.revision);
  whiteEvents.close();
  const disconnected = await blackEvents.next();
  assert.equal(disconnected.players.white.joined, true);
  assert.equal(disconnected.players.white.connected, false);
  const reconnectedEvents = await api.events(white);
  const [reconnected, blackReconnected] = await Promise.all([reconnectedEvents.next(), blackEvents.next()]);
  assert.equal(reconnected.you, 'white');
  assert.equal(reconnected.submitted.white, true);
  assert.equal(blackReconnected.players.white.connected, true);
  await api.order(black, reconnected, move('e7', 'e5'));
  const [whiteRound, blackRound] = await Promise.all([reconnectedEvents.next(), blackEvents.next()]);
  assert.equal(whiteRound.game.round, 2);
  assert.deepEqual(whiteRound.game, blackRound.game);
  assert.deepEqual(whiteRound.submitted, { white: false, black: false });
});

test('two rematch votes preserve seats, start a fresh game, and reject old-game requests even at round one', async t => {
  const api = await host(t);
  const white = await api.create('white',null,false);
  const black = await api.join(white.code);
  const initial = await api.snapshot(white);
  await api.order(white, initial, move('e2', 'e4'));
  const voted = await api.request(`/api/rooms/${white.code}/rematch`, { token: white.token, gameId: initial.gameId });
  assert.deepEqual(voted.rematch, { white: true, black: false });
  assert.equal(voted.gameId, initial.gameId);
  const fresh = await api.request(`/api/rooms/${black.code}/rematch`, { token: black.token, gameId: initial.gameId });
  assert.notEqual(fresh.gameId, initial.gameId);
  assert.deepEqual(fresh.game, createInitialState());
  assert.deepEqual(fresh.submitted, { white: false, black: false });
  assert.deepEqual(fresh.rematch, { white: false, black: false });
  assert.equal((await api.snapshot(white)).you, 'white');
  assert.equal((await api.snapshot(black)).you, 'black');
  await api.order(white, initial, move('e2', 'e4'), 409);
  await api.request(`/api/rooms/${black.code}/rematch`, { token: black.token, gameId: initial.gameId }, 409);
  await api.order(white, fresh, move('e2', 'e4'));
});

test('explicit leave releases a seat, invalidates its token, and clears old orders before a friend replaces it', async t => {
  const api = await host(t);
  const white = await api.create();
  const black = await api.join(white.code);
  const initial = await api.snapshot(white);
  await api.order(white, initial, move('e2', 'e4'));
  await api.request(`/api/rooms/${black.code}/leave`, { token: black.token });
  const waiting = await api.snapshot(white);
  assert.equal(waiting.players.black.joined, false);
  assert.equal(waiting.game.result.winner, 'white');
  assert.equal(waiting.game.result.reasonCode, 'resigned');
  assert.equal(waiting.gameId, initial.gameId);
  await api.request(`/api/rooms/${black.code}?token=${black.token}`, undefined, 401);
  const replacement = await api.join(white.code);
  assert.equal(replacement.color, 'black');
  assert.notEqual(replacement.token, black.token);
  await api.order(white, initial, move('e2', 'e4'), 409);
  await api.order(white, replacement.snapshot, move('e2', 'e4'));
  await api.request(`/api/rooms/${white.code}/leave`, { token: white.token });
  await api.request(`/api/rooms/${replacement.code}/leave`, { token: replacement.token });
  await api.request(`/api/rooms/${white.code}?token=${white.token}`, undefined, 404);
});

test('static serving uses an asset allowlist and JSON input is bounded', async t => {
  const api = await host(t);
  const page = await fetch(api.base + '/?room=0123');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hopechess/);
  const engine = await fetch(api.base + '/engine.js', { method: 'HEAD' });
  assert.equal(engine.status, 200);
  assert.match(engine.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await engine.text(), '');
  for (const file of ['server.mjs', 'package.json', 'README.md', 'engine.test.js', 'multiplayer-server.test.js']) {
    assert.equal((await fetch(api.base + '/' + file)).status, 404);
  }
  await api.request('/api/rooms', { color: 'purple' }, 400);
  await api.request('/api/rooms', { color: 'white', excessive: 'x'.repeat(9000) }, 413);
  const invalidJson = await fetch(api.base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(invalidJson.status, 400);
  assert.equal(typeof (await invalidJson.json()).error, 'string');
});

test('rooms offer 1, 3, 5, 10 minutes per player or an untimed game', async t => {
  const api = await host(t);
  for (const minutes of [null,1,3,5,10]) {
    const room = await api.create('white', minutes);
    assert.equal(room.snapshot.clock.limitMinutes, minutes);
    assert.deepEqual(room.snapshot.clock.remainingMs, {white:minutes === null ? null : minutes*60000,black:minutes === null ? null : minutes*60000});
    assert.deepEqual(room.snapshot.clock.running, {white:false,black:false});
  }
  for (const invalid of [0,2,-1,60,'3',true]) await api.request('/api/rooms', {timeLimitMinutes:invalid}, 400);
});

test('clocks wait for a friend, pause individually on lock, and keep a total budget across rounds and review', async t => {
  let at = 0;
  const api = await host(t, {now:()=>at});
  const white = await api.create('white', 3);
  at = 500000;
  assert.deepEqual((await api.snapshot(white)).clock.remainingMs, {white:180000,black:180000});
  const black = await api.join(white.code);
  const initial = black.snapshot;
  assert.deepEqual(initial.clock.running, {white:true,black:true});
  at += 10000;
  const locked = await api.order(white, initial, move('e2','e4'));
  assert.deepEqual(locked.clock.remainingMs, {white:170000,black:170000});
  assert.deepEqual(locked.clock.running, {white:false,black:true});
  at += 5000;
  const waiting = await api.snapshot(white);
  assert.deepEqual(waiting.clock.remainingMs, {white:170000,black:165000});
  const round = await api.order(black, initial, move('e7','e5'));
  assert.equal(round.game.round, 2);
  assert.deepEqual(round.clock.remainingMs, {white:170000,black:165000});
  assert.deepEqual(round.clock.running, {white:true,black:true});
  at += 6000;
  assert.deepEqual((await api.snapshot(black)).clock.remainingMs, {white:164000,black:159000});
});

test('a player who runs out of time loses without revealing a locked opponent order; rematches reset clocks', async t => {
  let at = 0;
  const api = await host(t, {now:()=>at});
  const white = await api.create('white', 1);
  const black = await api.join(white.code);
  const initial = black.snapshot;
  at = 10000;
  await api.order(white, initial, move('e2','e4'));
  at = 60000;
  const flagged = await api.snapshot(white);
  assert.equal(flagged.game.result.winner, 'white');
  assert.equal(flagged.game.result.reasonCode, 'timeout');
  assert.match(flagged.game.result.reason, /Black ran out/);
  assert.equal(flagged.game.board[squareToIndex('e2')].type, 'p');
  assert.equal(flagged.game.board[squareToIndex('e4')], null);
  assert.equal(flagged.game.history.length, 0);
  assert.deepEqual(flagged.clock.remainingMs, {white:50000,black:0});
  assert.deepEqual(flagged.clock.running, {white:false,black:false});
  await api.order(black, initial, move('e7','e5'), 409);
  await api.request(`/api/rooms/${white.code}/rematch`, {token:white.token,gameId:initial.gameId});
  const fresh = await api.request(`/api/rooms/${black.code}/rematch`, {token:black.token,gameId:initial.gameId});
  assert.equal(fresh.clock.limitMinutes, 1);
  assert.deepEqual(fresh.clock.remainingMs, {white:60000,black:60000});
  assert.deepEqual(fresh.clock.running, {white:true,black:true});
});

test('equal clock deadlines draw, and a delayed timeout check still awards the win by the first deadline', async t => {
  let at = 0;
  const api = await host(t, {now:()=>at});
  const white = await api.create('white', 1);
  const black = await api.join(white.code);
  at = 60000;
  const simultaneous = await api.snapshot(white);
  assert.equal(simultaneous.game.result.winner, 'draw');
  assert.deepEqual(simultaneous.clock.remainingMs, {white:0,black:0});
  await api.request(`/api/rooms/${white.code}/rematch`, {token:white.token,gameId:simultaneous.gameId});
  const fresh = await api.request(`/api/rooms/${black.code}/rematch`, {token:black.token,gameId:simultaneous.gameId});
  at += 10000;
  await api.order(white, fresh, move('e2','e4'));
  at += 10000;
  await api.order(black, fresh, move('e7','e5'));
  at += 100000;
  const overdue = await api.snapshot(black);
  assert.equal(overdue.game.result.winner, 'white');
  assert.deepEqual(overdue.clock.remainingMs, {white:10000,black:0});
});

test('leaving resets the room clock and an untimed game never flags', async t => {
  let at = 0;
  const api = await host(t, {now:()=>at});
  const white = await api.create('white', 5, false);
  const black = await api.join(white.code);
  at = 12345;
  await api.request(`/api/rooms/${black.code}/leave`, {token:black.token});
  at += 900000;
  const waiting = await api.snapshot(white);
  assert.equal(waiting.game.result, null);
  assert.deepEqual(waiting.clock.remainingMs, {white:300000,black:300000});
  assert.deepEqual(waiting.clock.running, {white:false,black:false});
  const untimed = await api.create();
  await api.join(untimed.code);
  at += 1e9;
  const ongoing = await api.snapshot(untimed);
  assert.equal(ongoing.game.result, null);
  assert.deepEqual(ongoing.clock.remainingMs, {white:null,black:null});
  assert.deepEqual(ongoing.clock.running, {white:false,black:false});
});


test('signed-in players are public and a rated resignation updates Elo exactly once', async t => {
  const api = await host(t);
  const alice = await api.request('/api/accounts/register', {username:'Alice',password:'passphrase'},201);
  const bob = await api.request('/api/accounts/register', {username:'Bobby',password:'passphrase'},201);
  await api.request('/api/accounts/login', {username:'Alice',password:'wrong'},401);
  const signedIn = await api.request('/api/accounts/login', {username:'alice',password:'passphrase'});
  const me = await fetch(api.base + '/api/accounts/me', {headers:{Authorization:`Bearer ${signedIn.token}`}});
  assert.equal((await me.json()).player.id,alice.player.id);
  const white = await api.request('/api/rooms',{color:'white',accountToken:alice.token},201);
  const black = await api.request(`/api/rooms/${white.code}/join`,{accountToken:bob.token});
  assert.equal(black.snapshot.rated,true);
  assert.equal(black.snapshot.players.white.account.username,'Alice');
  assert.ok(!JSON.stringify(black.snapshot).includes(alice.token));
  await api.request(`/api/rooms/${white.code}/rematch`,{token:white.token,gameId:white.snapshot.gameId},409);
  const result = await api.request(`/api/rooms/${black.code}/resign`,{token:black.token,gameId:black.snapshot.gameId});
  assert.equal(result.game.result.winner,'white');
  assert.equal(result.ratingResult.white.change,16);
  assert.equal(result.ratingResult.black.change,-16);
  await api.request(`/api/rooms/${black.code}/resign`,{token:black.token,gameId:black.snapshot.gameId});
  await api.snapshot(white);
  const players = await api.request('/api/players');
  assert.equal(players.total,2);
  assert.equal(players.players[0].elo,1016);
  assert.equal(players.players[1].elo,984);
  assert.equal(players.players[1].games,1);
  const filtered = await api.request('/api/players?q=BOB');
  assert.equal(filtered.total,1);
  assert.equal(filtered.players[0].losses,1);
  for (const field of ['passwordHash','salt','token']) assert.ok(!JSON.stringify(players).includes(field));
  await api.request(`/api/rooms/${white.code}/rematch`,{token:white.token,gameId:result.gameId});
  const fresh = await api.request(`/api/rooms/${black.code}/rematch`,{token:black.token,gameId:result.gameId});
  assert.equal(fresh.ratingResult,null);
  assert.equal(fresh.rated,true);
  assert.notEqual(fresh.gameId,result.gameId);
});

test('timeouts and leaving an active rated game award results; guests count too', async t => {
  let at = 0;
  const api = await host(t,{now:()=>at});
  const a = await api.request('/api/accounts/register',{username:'Alice',password:'passphrase'},201);
  const b = await api.request('/api/accounts/register',{username:'Bobby',password:'passphrase'},201);
  const white = await api.request('/api/rooms',{color:'white',accountToken:a.token,timeLimitMinutes:1},201);
  const black = await api.request(`/api/rooms/${white.code}/join`,{accountToken:b.token});
  at = 10000;
  await api.order(white,black.snapshot,move('e2','e4'));
  at = 60000;
  const timeout = await api.snapshot(black);
  assert.equal(timeout.ratingResult.black.change,-16);
  await api.request(`/api/rooms/${white.code}/rematch`,{token:white.token,gameId:timeout.gameId});
  const fresh = await api.request(`/api/rooms/${black.code}/rematch`,{token:black.token,gameId:timeout.gameId});
  await api.order(white,fresh,move('d2','d4'));
  await api.request(`/api/rooms/${white.code}/leave`,{token:white.token});
  const forfeited = await api.snapshot(black);
  assert.equal(forfeited.game.result.winner,'black');
  assert.ok(forfeited.ratingResult.black.change > 0);
  assert.equal(forfeited.players.black.account.games,2);
  const guest = await api.create();
  await api.join(guest.code);
  const unrated = await api.request(`/api/rooms/${guest.code}/resign`,{token:guest.token,gameId:guest.snapshot.gameId});
  assert.equal(unrated.rated,true);
  assert.equal(unrated.ratingResult.white.change,-16);
  assert.equal(unrated.players.white.account.ratings['1v1'].losses,1);
  await api.request('/api/rooms',{accountToken:'invalid'},401);
});

test('king capture rates a completed game and a rated player cannot leave round one to avoid a loss', async t => {
  const api = await host(t);
  const a = await api.request('/api/accounts/register',{username:'Alice',password:'passphrase'},201);
  const b = await api.request('/api/accounts/register',{username:'Bobby',password:'passphrase'},201);
  const white = await api.request('/api/rooms',{color:'white',accountToken:a.token},201);
  const black = await api.request(`/api/rooms/${white.code}/join`,{accountToken:b.token});
  let state = black.snapshot;
  for (const [w,b] of [[move('f2','f3'),move('e7','e5')],[move('g2','g4'),move('d8','h4')],[move('a2','a3'),move('h4','e1')]]) {
    await api.order(white,state,w);
    state = await api.order(black,state,b);
  }
  assert.equal(state.game.result.winner,'black');
  assert.equal(state.ratingResult.white.change,-16);
  assert.equal(state.ratingResult.black.change,16);
  await api.request(`/api/rooms/${white.code}/rematch`,{token:white.token,gameId:state.gameId});
  const fresh = await api.request(`/api/rooms/${black.code}/rematch`,{token:black.token,gameId:state.gameId});
  assert.equal(fresh.game.round,1);
  await api.request(`/api/rooms/${white.code}/leave`,{token:white.token});
  const left = await api.snapshot(black);
  assert.equal(left.game.result.winner,'black');
  assert.equal(left.players.black.account.wins,2);
});

async function teamRoom(api, minutes = null, tokens = []) {
  const w1 = await api.request('/api/rooms',{color:'white',mode:'2v2',timeLimitMinutes:minutes,accountToken:tokens[0]},201);
  const w2 = await api.request(`/api/rooms/${w1.code}/join`,{color:'white',accountToken:tokens[1]});
  const b1 = await api.request(`/api/rooms/${w1.code}/join`,{color:'black',accountToken:tokens[2]});
  const b2 = await api.request(`/api/rooms/${w1.code}/join`,{color:'black',accountToken:tokens[3]});
  return {w1,w2,b1,b2};
}

test('2v2 holds four distinct seats, keeps team reservations private, and resolves only after four orders', async t => {
  const api = await host(t);
  const {w1,w2,b1,b2} = await teamRoom(api);
  assert.equal(w2.color,'white');
  assert.equal(w2.seat,'white2');
  assert.equal(b2.seat,'black2');
  const initial = b2.snapshot;
  assert.equal(initial.capacity,4);
  assert.equal(initial.members.filter(member => member.joined).length,4);
  await api.request(`/api/rooms/${w1.code}/join`,{},409);
  const first = await api.order(w1,initial,move('e2','e4'));
  assert.equal(first.submitted.white,false);
  assert.equal(first.seatSubmitted.white,true);
  assert.equal((await api.snapshot(w2)).teamMoves[0].move.to,squareToIndex('e4'));
  assert.equal(JSON.stringify(await api.snapshot(b1)).includes('"from"'),false);
  const watching = await api.request(`/api/rooms/${w1.code}/watch`);
  assert.equal(watching.spectator,true);
  assert.equal(watching.yourSeat,null);
  assert.deepEqual(watching.teamMoves,[]);
  assert.equal(watching.yourMove,null);
  assert.equal(JSON.stringify(watching).includes('"from"'),false);
  await api.order(w2,initial,move('e2','e3'),400);
  await api.order(w2,initial,move('g1','f3'));
  const third = await api.order(b1,initial,move('e7','e5'));
  assert.equal(third.game.round,1);
  const next = await api.order(b2,initial,move('g8','f6'));
  assert.equal(next.game.round,2);
  assert.equal(next.game.lastRound.moves.length,4);
  assert.equal((await api.request(`/api/rooms/${w1.code}/watch`)).game.round,2);
  const round2 = await api.order(w1,next,move('f1','d3'));
  await api.order(w2,next,move('d2','d3'),400);
  await api.order(w2,next,move('b1','c3'));
  assert.deepEqual(round2.seatSubmitted,{white:true,black:false,white2:false,black2:false});
});

test('2v2 clocks start at four players and pause only when both teammates are ready', async t => {
  let at = 0;
  const api = await host(t,{now:()=>at});
  const w1 = await api.request('/api/rooms',{color:'white',mode:'2v2',timeLimitMinutes:1},201);
  await api.request(`/api/rooms/${w1.code}/join`,{color:'black'});
  const w2 = await api.request(`/api/rooms/${w1.code}/join`,{color:'white'});
  at = 30000;
  assert.deepEqual((await api.snapshot(w1)).clock.remainingMs,{white:60000,black:60000});
  assert.deepEqual((await api.snapshot(w1)).clock.running,{white:false,black:false});
  const b2 = await api.request(`/api/rooms/${w1.code}/join`,{color:'black'});
  at += 5000;
  const first = await api.order(w1,b2.snapshot,move('e2','e4'));
  assert.deepEqual(first.clock.running,{white:true,black:true});
  at += 5000;
  const teamReady = await api.order(w2,b2.snapshot,move('d2','d4'));
  assert.deepEqual(teamReady.clock.running,{white:false,black:true});
  assert.equal(teamReady.clock.remainingMs.white,50000);
  at += 50000;
  const ended = await api.snapshot(w1);
  assert.equal(ended.game.result.winner,'white');
  assert.equal(ended.game.result.reasonCode,'timeout');
  assert.equal(ended.game.round,1);
  assert.equal((await api.request(`/api/rooms/${w1.code}/watch`)).teamMoves.length,0);
});

test('spectator streams reveal completed rounds without consuming a seat or exposing submitted moves', async t => {
  const api = await host(t);
  const white = await api.create();
  const viewer = {code:white.code,spectator:true};
  const stream = await api.events(viewer);
  const watching = await stream.next();
  assert.equal(watching.spectators,1);
  assert.equal(watching.players.black.joined,false);
  const black = await api.join(white.code);
  await stream.next();
  const initial = black.snapshot;
  await api.order(white,initial,move('e2','e4'));
  const secret = await stream.next();
  assert.equal(secret.spectator,true);
  assert.deepEqual(secret.teamMoves,[]);
  assert.equal(secret.game.round,1);
  assert.ok(!JSON.stringify(secret).includes('"from"'));
  await api.order(black,initial,move('e7','e5'));
  const revealed = await stream.next();
  assert.equal(revealed.game.round,2);
  assert.equal(revealed.game.lastRound.moves[0].from,squareToIndex('e2'));
  await api.request(`/api/rooms/${white.code}/move`,{gameId:initial.gameId,round:2,move:move('e4','e5')},401);
  for (const action of ['resign','rematch','leave']) await api.request(`/api/rooms/${white.code}/${action}`,{gameId:initial.gameId},401);
});

test('game browsing lists party codes, both modes and public names without tokens or pending orders', async t => {
  const api = await host(t);
  const one = await api.create();
  const two = await teamRoom(api);
  await api.order(two.w1,two.b2.snapshot,move('e2','e4'));
  const list = await api.request('/api/rooms');
  assert.equal(list.rooms.length,2);
  const team = list.rooms.find(room => room.code === two.w1.code);
  assert.equal(team.mode,'2v2');
  assert.equal(team.capacity,4);
  assert.equal(team.status,'playing');
  assert.equal(list.rooms.find(room => room.code === one.code).status,'waiting');
  const text = JSON.stringify(list);
  for (const secret of [two.w1.token,two.w2.token,'"from"','"orders"']) assert.ok(!text.includes(secret));
  await api.request('/api/rooms',{mode:'3v3'},400);
  await api.request(`/api/rooms/${one.code}/watch`,{},405);
});

test('2v2 rated results update all four accounts once and rematches need all four votes', async t => {
  const api = await host(t);
  const tokens = [];
  for (const name of ['WhiteOne','WhiteTwo','BlackOne','BlackTwo']) tokens.push((await api.request('/api/accounts/register',{username:name,password:'passphrase'},201)).token);
  const {w1,w2,b1,b2} = await teamRoom(api,null,tokens);
  const initial = b2.snapshot;
  assert.equal(initial.rated,true);
  const result = await api.request(`/api/rooms/${w1.code}/resign`,{token:w2.token,gameId:initial.gameId});
  assert.equal(result.game.result.winner,'black');
  assert.deepEqual(Object.values(result.ratingResult).map(rating => rating.change),[-16,-16,16,16]);
  const players = await api.request('/api/players');
  for (const player of players.players) assert.equal(player.games,1);
  for (const seat of [w1,w2,b1]) {
    const vote = await api.request(`/api/rooms/${seat.code}/rematch`,{token:seat.token,gameId:initial.gameId});
    assert.equal(vote.gameId,initial.gameId);
  }
  const fresh = await api.request(`/api/rooms/${b2.code}/rematch`,{token:b2.token,gameId:initial.gameId});
  assert.notEqual(fresh.gameId,initial.gameId);
  assert.equal(fresh.game.round,1);
  assert.equal(fresh.capacity,4);
  assert.equal(fresh.ratingResult,null);
  assert.deepEqual(fresh.seatRematch,{white:false,black:false,white2:false,black2:false});
  const viewer = await api.request(`/api/rooms/${b2.code}/watch`);
  assert.equal(viewer.gameId,fresh.gameId);
  await api.order(w1,fresh,move('e2','e4'));
  await api.request(`/api/rooms/${w2.code}/leave`,{token:w2.token});
  const left = await api.snapshot(b1);
  assert.equal(left.game.result.winner,'black');
  assert.equal(left.players.black.account.games,2);
});

test('guest games are rated by default and the same guest profile is reusable across parties', async t => {
  const api = await host(t);
  const white = await api.create();
  const black = await api.join(white.code);
  assert.equal(white.snapshot.rated,true);
  assert.equal(white.identity.player.guest,true);
  assert.equal(black.identity.player.guest,true);
  const result = await api.request(`/api/rooms/${white.code}/resign`,{token:black.token,gameId:black.snapshot.gameId});
  assert.equal(result.ratingResult.white.mode,'1v1');
  assert.equal(result.players.white.account.ratings['1v1'].elo,1016);
  assert.equal(result.players.white.account.ratings['2v2'].elo,1000);
  assert.ok(!JSON.stringify(await api.request(`/api/rooms/${white.code}/watch`)).includes(white.identity.token));
  const next = await api.request('/api/rooms',{accountToken:white.identity.token,color:'white'},201);
  assert.equal(next.snapshot.players.white.account.id,white.identity.player.id);
  assert.equal(next.snapshot.players.white.account.ratings['1v1'].elo,1016);
  await api.request(`/api/rooms/${next.code}/join`,{accountToken:white.identity.token},409);
  for (const value of [null,'false',0]) await api.request('/api/rooms',{rated:value},400);
});

test('turning Elo off is explicit, persists through rematches, and leaves both rating records unchanged', async t => {
  const api = await host(t);
  const white = await api.create('white',null,false);
  const black = await api.join(white.code);
  const end = await api.request(`/api/rooms/${white.code}/resign`,{token:white.token,gameId:white.snapshot.gameId});
  assert.equal(end.rated,false);
  assert.equal(end.ratingResult,null);
  for (const color of ['white','black']) {
    const ratings = end.players[color].account.ratings;
    assert.equal(ratings['1v1'].games,0);
    assert.equal(ratings['2v2'].games,0);
  }
  await api.request(`/api/rooms/${white.code}/rematch`,{token:white.token,gameId:end.gameId});
  const fresh = await api.request(`/api/rooms/${black.code}/rematch`,{token:black.token,gameId:end.gameId});
  assert.equal(fresh.rated,false);
  assert.equal(fresh.ratingResult,null);
  assert.equal((await api.request('/api/rooms')).rooms[0].rated,false);
});

test('one profile has independent ratings for 1v1 and 2v2, and leaving returns the updated result', async t => {
  const api = await host(t);
  const a = await api.request('/api/accounts/guest',{},201);
  const duel = await api.request('/api/rooms',{color:'white',accountToken:a.token},201);
  const opponent = await api.join(duel.code);
  await api.request(`/api/rooms/${duel.code}/resign`,{token:opponent.token,gameId:opponent.snapshot.gameId});
  const team = await api.request('/api/rooms',{mode:'2v2',color:'white',accountToken:a.token},201);
  await api.request(`/api/rooms/${team.code}/join`,{color:'white'});
  await api.request(`/api/rooms/${team.code}/join`,{color:'black'});
  const last = await api.request(`/api/rooms/${team.code}/join`,{color:'black'});
  const left = await api.request(`/api/rooms/${team.code}/leave`,{token:team.token});
  assert.equal(left.mode,'2v2');
  assert.equal(left.ratingResult.white.mode,'2v2');
  assert.equal(left.ratingResult.white.before,1000);
  assert.equal(left.ratingResult.white.after,984);
  assert.equal(left.player.ratings['1v1'].elo,1016);
  assert.equal(left.player.ratings['2v2'].elo,984);
  assert.equal(left.player.ratings['2v2'].games,1);
  const me = await fetch(api.base+'/api/accounts/me',{headers:{Authorization:`Bearer ${a.token}`}});
  assert.equal((await me.json()).player.ratings['2v2'].elo,984);
  const list = await api.request('/api/players?mode=2v2');
  assert.equal(list.mode,'2v2');
  assert.equal(list.players[0].ratings['2v2'].elo,1016);
  assert.equal(list.players[0].ratings['1v1'].elo,1000);
  const black = await api.snapshot(last);
  assert.equal(black.game.result.winner,'black');
});
