import http from 'node:http';
import { AccountStore } from './accounts.mjs';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState, getTeamLegalMoves, resolveRound, resolveTeamRound } from './engine.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicFiles = new Set(['index.html', 'styles.css', 'app.js', 'multiplayer.js', 'pieces.js', 'engine.js']);
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const colors = ['white', 'black'];
const other = color => color === 'white' ? 'black' : 'white';
const teamOf = seat => seat?.startsWith('white') ? 'white' : 'black';
const seatIds = room => room.mode === '2v2' ? ['white','black','white2','black2'] : colors;
const teamSeats = (room, color) => seatIds(room).filter(seat => teamOf(seat) === color);
const full = room => seatIds(room).every(seat => room.seats[seat]);
const ready = (room, color) => teamSeats(room, color).every(seat => Object.hasOwn(room.orders, seat));
const rated = room => room.rated !== false;

function hostUrls(port) {
  const addresses = Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
    .filter(address => !address.internal && address.family === 'IPv4')
    .map(address => {
      const privateAddress = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address);
      const tunnel = /^(utun|tun|tap|tailscale|wg|ppp|ipsec|zt)/i.test(name);
      return { address: address.address, priority: (tunnel ? 2 : 0) + (privateAddress ? 0 : 1) };
    }))
    .sort((a, b) => a.priority - b.priority || a.address.localeCompare(b.address));
  return {
    localUrl: `http://localhost:${port}`,
    lanUrls: [...new Set(addresses.map(({ address }) => `http://${address}:${port}`))],
  };
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let contents = '';
    let bytes = 0;
    let tooLarge = false;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8192) {
        if (!tooLarge) reject(new RequestError(413, 'That request is too large.'));
        tooLarge = true;
      } else if (!tooLarge) contents += chunk.toString('utf8');
    });
    request.on('end', () => {
      if (tooLarge) return;
      try {
        const value = JSON.parse(contents || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(new RequestError(400, 'Send a valid JSON object.')); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new RequestError(400, 'The request was interrupted.')));
  });
}

function createSeat(account = null) {
  return { token: randomBytes(24).toString('base64url'), streams: new Set(), accountId: account?.id ?? null };
}

/** A dependency-free game host. Each server instance owns its in-memory rooms. */
export function createHopechessServer({ roomTtlMs = 24 * 60 * 60 * 1000, pingIntervalMs = 25000, now = () => performance.now(), accounts = new AccountStore() } = {}) {
  const rooms = new Map();

  function finalize(room) {
    if (!room.game.result || room.ratingResult || !rated(room)) return;
    room.ratingResult = accounts.rateTeams(room.gameId, Object.fromEntries(colors.map(color => [color, teamSeats(room,color).map(seat => room.seats[seat]?.accountId)])), room.game.result.winner);
  }

  // Both clocks run at once. Locking an order pauses only that player's clock.
  function settleClock(room) {
    const clock = room.clock;
    const at = now();
    const elapsed = Math.max(0, at - clock.updatedAt);
    const running = colors.filter(color => clock.running[color]);
    const firstFlag = Math.min(...running.map(color => clock.remainingMs[color]));
    const spent = Math.min(elapsed, firstFlag);
    const expired = running.filter(color => elapsed >= firstFlag && Math.abs(clock.remainingMs[color] - firstFlag) < 0.000001);
    for (const color of running) clock.remainingMs[color] = Math.max(0, clock.remainingMs[color] - spent);
    clock.updatedAt = at;
    if (!expired.length) return false;
    room.game = {
      ...room.game,
      result: expired.length === 2
        ? { winner: 'draw', reason: `Both ${room.mode === '2v2' ? 'teams' : 'players'} ran out of time together.`, reasonCode: 'timeout' }
        : { winner: other(expired[0]), reason: `${expired[0] === 'white' ? 'White' : 'Black'} ran out of time.`, reasonCode: 'timeout' },
    };
    clock.running = { white: false, black: false };
    finalize(room);
    return true;
  }

  function updateRunning(room) {
    settleClock(room);
    const active = room.timeLimitMinutes !== null && !room.game.result && full(room);
    room.clock.running = Object.fromEntries(colors.map(color => [color, !!active && !ready(room, color)]));
  }

  function scheduleClock(room) {
    clearTimeout(room.clockTimer);
    const remaining = colors.filter(color => room.clock.running[color]).map(color => room.clock.remainingMs[color]);
    if (!remaining.length) return;
    room.clockTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room) return;
      if (settleClock(room)) changed(room);
      else scheduleClock(room);
    }, Math.max(1, Math.ceil(Math.min(...remaining))));
    room.clockTimer.unref();
  }

  function snapshot(room, seatId = null) {
    const color = seatId ? teamOf(seatId) : null;
    const member = seat => ({ seat, color: teamOf(seat), joined: !!room.seats[seat], connected: !!room.seats[seat]?.streams.size, account: accounts.player(room.seats[seat]?.accountId), submitted: Object.hasOwn(room.orders,seat), rematch: !!room.rematch[seat] });
    return {
      code: room.code, mode: room.mode, capacity: seatIds(room).length,
      you: color, yourSeat: seatId, spectator: !seatId, spectators: room.spectators.size,
      members: seatIds(room).map(member),
      gameId: room.gameId, game: room.game,
      yourMove: seatId ? room.orders[seatId] ?? null : null,
      teamMoves: seatId ? teamSeats(room,color).filter(seat => Object.hasOwn(room.orders,seat)).map(seat => ({seat,move:room.orders[seat]})) : [],
      rated: rated(room), ratingResult: room.ratingResult,
      submitted: Object.fromEntries(colors.map(side => [side, ready(room,side)])),
      seatSubmitted: Object.fromEntries(seatIds(room).map(seat => [seat, Object.hasOwn(room.orders,seat)])),
      players: Object.fromEntries(colors.map(side => [side, {
        joined: teamSeats(room,side).every(seat => room.seats[seat]),
        connected: teamSeats(room,side).every(seat => room.seats[seat]?.streams.size),
        account: accounts.player(room.seats[side]?.accountId),
      }])),
      rematch: room.mode === '2v2' ? Object.fromEntries(colors.map(side => [side, teamSeats(room,side).every(seat => room.rematch[seat])])) : { ...room.rematch },
      seatRematch: { ...room.rematch }, revision: room.revision,
      clock: { limitMinutes: room.timeLimitMinutes, remainingMs: { ...room.clock.remainingMs }, running: { ...room.clock.running } },
    };
  }

  function available(room, seat) {
    return getTeamLegalMoves(room.game, teamOf(seat), teamSeats(room,teamOf(seat)).filter(id => id !== seat).map(id => room.orders[id]).filter(Boolean));
  }

  function finishOrders(room) {
    // Reservations can leave the second teammate with no legal distinct move.
    // Passing then is mandatory; a team never has to move one piece twice.
    if (room.mode === '2v2') for (const seat of seatIds(room)) {
      if (!Object.hasOwn(room.orders,seat) && !available(room,seat).length) room.orders[seat] = null;
    }
    if (!seatIds(room).every(seat => Object.hasOwn(room.orders,seat))) return;
    room.game = room.mode === '2v2'
      ? resolveTeamRound(room.game, teamSeats(room,'white').map(seat => room.orders[seat]), teamSeats(room,'black').map(seat => room.orders[seat]))
      : resolveRound(room.game, room.orders.white, room.orders.black);
    room.orders = {};
  }

  function sendState(response, room, color) {
    response.write(`id: ${room.revision}\nevent: state\ndata: ${JSON.stringify(snapshot(room, color))}\n\n`);
  }

  function broadcast(room) {
    for (const seat of seatIds(room)) for (const stream of room.seats[seat]?.streams ?? []) sendState(stream, room, seat);
    for (const stream of room.spectators) sendState(stream, room, null);
  }

  function changed(room) {
    settleClock(room);
    finalize(room);
    room.revision++;
    room.touched = Date.now();
    broadcast(room);
    scheduleClock(room);
  }

  function freshGame(room) {
    clearTimeout(room.clockTimer);
    room.game = createInitialState();
    room.ratingResult = null;
    room.gameId = randomUUID();
    room.orders = {};
    room.rematch = Object.fromEntries(seatIds(room).map(seat => [seat,false]));
    const initialMs = room.timeLimitMinutes === null ? null : room.timeLimitMinutes * 60000;
    room.clock = { remainingMs: { white: initialMs, black: initialMs }, running: { white: false, black: false }, updatedAt: now() };
    updateRunning(room);
  }

  function authenticate(room, token) {
    const color = seatIds(room).find(side => typeof token === 'string' && room.seats[side]?.token === token);
    if (!color) throw new RequestError(401, 'Your player session is no longer available. Join the room again.');
    room.touched = Date.now();
    return color;
  }

  function identityForSeat(room, token) {
    const player = accounts.authenticate(token, true);
    if (player) {
      if (rated(room) && seatIds(room).some(seat => room.seats[seat]?.accountId === player.id)) throw new RequestError(409, 'That profile already has a seat in this rated party. Use a different account, or create a party with Elo switched off.');
      return {player};
    }
    const identity = accounts.createGuest();
    return {player:identity.player,identity};
  }

  function currentGame(room, gameId) {
    if (typeof gameId !== 'string') throw new RequestError(400, 'Include the current game ID.');
    if (gameId !== room.gameId) throw new RequestError(409, 'A new game has started. Refresh your board and choose again.');
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { throw new RequestError(400, 'That address is invalid.'); }

      if (pathname === '/api/info' && request.method === 'GET') {
        json(response, 200, hostUrls(server.address().port));
        return;
      }

      if (pathname === '/api/players' && request.method === 'GET') {
        const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        json(response, 200, accounts.search((url.searchParams.get('q') || '').slice(0, 40), offset, url.searchParams.get('mode') || '1v1'));
        return;
      }
      if (pathname.startsWith('/api/accounts/')) {
        const action = pathname.slice('/api/accounts/'.length);
        const token = request.headers.authorization?.replace(/^Bearer /, '');
        if (action === 'me' && request.method === 'GET') {
          json(response, 200, { player: accounts.authenticate(token) }); return;
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          if (action === 'register') { json(response, 201, accounts.register(body.username, body.password, token)); return; }
          if (action === 'guest') { json(response, 201, accounts.createGuest()); return; }
          if (action === 'login') { json(response, 200, accounts.login(body.username, body.password)); return; }
          if (action === 'logout') { accounts.logout(token); json(response, 200, { ok: true }); return; }
        }
        throw new RequestError(404, 'Account endpoint not found.');
      }

      if (pathname === '/api/rooms' && request.method === 'GET') {
        for (const room of rooms.values()) if (settleClock(room)) changed(room);
        json(response, 200, { rooms: [...rooms.values()].sort((a,b) => b.touched - a.touched).map(room => ({
          code: room.code, mode: room.mode, rated: rated(room), capacity: seatIds(room).length, joined: seatIds(room).filter(seat => room.seats[seat]).length,
          round: room.game.round, status: room.game.result ? 'finished' : full(room) ? 'playing' : 'waiting',
          result: room.game.result, spectators: room.spectators.size, timeLimitMinutes: room.timeLimitMinutes,
          teams: Object.fromEntries(colors.map(color => [color, teamSeats(room,color).map(seat => accounts.player(room.seats[seat]?.accountId)?.username || (room.seats[seat] ? 'Guest' : 'Open seat'))])),
        })) });
        return;
      }

      if (pathname === '/api/rooms' && request.method === 'POST') {
        const body = await readJson(request);
        if (!['white', 'black', 'random', undefined].includes(body.color)) throw new RequestError(400, 'Choose White, Black, or random.');
        if (body.rated !== undefined && typeof body.rated !== 'boolean') throw new RequestError(400, 'Elo must be on or off.');
        if (!['1v1','2v2',undefined].includes(body.mode)) throw new RequestError(400, 'Choose 1v1 or 2v2.');
        const timeLimitMinutes = body.timeLimitMinutes ?? null;
        if (![null, 1, 3, 5, 10].includes(timeLimitMinutes)) throw new RequestError(400, 'Choose 1, 3, 5, 10 minutes, or no time limit.');
        const color = body.color === 'white' || body.color === 'black' ? body.color : colors[randomInt(2)];
        if (rooms.size >= 10000) throw new RequestError(503, 'All rooms are busy. Please try again later.');
        let code = String(randomInt(10000)).padStart(4, '0');
        while (rooms.has(code)) code = String((Number(code) + 1) % 10000).padStart(4, '0');
        const room = { code, mode: body.mode ?? '1v1', rated: body.rated !== false, seats: { white: null, black: null, ...(body.mode === '2v2' ? { white2: null, black2: null } : {}) }, spectators: new Set(), timeLimitMinutes, revision: 1, touched: Date.now() };
        freshGame(room);
        const {player,identity} = identityForSeat(room,body.accountToken);
        room.seats[color] = createSeat(player);
        rooms.set(code, room);
        json(response, 201, { code, ...(identity ? {identity} : {}), token: room.seats[color].token, color: teamOf(color), seat: color, snapshot: snapshot(room, color) });
        return;
      }

      const match = pathname.match(/^\/api\/rooms\/(\d{4})(?:\/(join|events|watch|move|rematch|leave|resign))?\/?$/);
      if (match) {
        const room = rooms.get(match[1]);
        if (!room) throw new RequestError(404, 'Room not found. Check the room code or create a new room.');
        if (settleClock(room)) changed(room);
        const action = match[2];
        if (action === 'join' && request.method === 'POST') {
          const body = await readJson(request);
          if (!['white','black','random',undefined].includes(body.color)) throw new RequestError(400, 'Choose White, Black, or any team.');
          const color = seatIds(room).find(seat => !room.seats[seat] && (!body.color || body.color === 'random' || teamOf(seat) === body.color));
          if (!color) throw new RequestError(409, 'No open seat on that team. Choose another team or room.');
          const {player,identity} = identityForSeat(room,body.accountToken);
          if (room.game.round > 1 || room.game.result || Object.keys(room.orders).length) freshGame(room);
          room.seats[color] = createSeat(player);
          updateRunning(room);
          changed(room);
          json(response, 200, { code: room.code, ...(identity ? {identity} : {}), token: room.seats[color].token, color: teamOf(color), seat: color, snapshot: snapshot(room, color) });
          return;
        }

        if ((!action || action === 'events' || action === 'watch') && request.method === 'GET') {
          const watching = action === 'watch' || action === 'events' && url.searchParams.get('watch') === '1';
          const color = watching ? null : authenticate(room, url.searchParams.get('token'));
          if (!action || action === 'watch') { json(response, 200, snapshot(room, color)); return; }
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store',
            'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
          });
          response.flushHeaders();
          response.write('retry: 1500\n\n');
          const seat = watching ? null : room.seats[color];
          const streams = watching ? room.spectators : seat.streams;
          const wasConnected = streams.size > 0;
          streams.add(response);
          if (wasConnected && !watching) sendState(response, room, color);
          else changed(room);
          response.on('close', () => {
            streams.delete(response);
            if (rooms.get(room.code) === room && (watching || !streams.size && room.seats[color] === seat)) changed(room);
          });
          return;
        }

        if (request.method === 'POST' && ['move', 'rematch', 'leave', 'resign'].includes(action)) {
          const body = await readJson(request);
          const seatId = authenticate(room, body.token);
          const color = teamOf(seatId);

          if (action === 'leave') {
            const seat = room.seats[seatId];
            if (!room.game.result && full(room) && (room.game.round > 1 || Object.keys(room.orders).length || rated(room))) {
              room.game = { ...room.game, result: { winner: other(color), reason: `${color === 'white' ? 'White' : 'Black'}${room.mode === '2v2' ? ' team' : ''} left the game.`, reasonCode: 'resigned' } };
              room.clock.running = { white: false, black: false };
              changed(room);
            }
            const outcome = {ok:true,mode:room.mode,result:room.game.result,ratingResult:room.ratingResult,player:accounts.player(seat.accountId)};
            room.seats[seatId] = null;
            clearTimeout(room.clockTimer);
            if (!room.game.result) freshGame(room);
            for (const stream of seat.streams) stream.end();
            seat.streams.clear();
            if (!seatIds(room).some(seat => room.seats[seat])) { rooms.delete(room.code); for (const stream of room.spectators) stream.end(); room.spectators.clear(); }
            else changed(room);
            json(response, 200, outcome);
            return;
          }

          currentGame(room, body.gameId);
          if (!full(room)) throw new RequestError(409, 'Wait for all players to join the room first.');

          if (action === 'resign') {
            if (!room.game.result) {
              room.game = { ...room.game, result: { winner: other(color), reason: `${color === 'white' ? 'White' : 'Black'}${room.mode === '2v2' ? ' team' : ''} resigned.`, reasonCode: 'resigned' } };
              room.clock.running = { white: false, black: false };
              changed(room);
            }
            json(response, 200, snapshot(room, seatId)); return;
          }

          if (action === 'rematch') {
            if (!room.game.result && (rated(room) || room.mode === '2v2')) throw new RequestError(409, 'Finish or resign the rated game before requesting a rematch.');
            room.rematch[seatId] = true;
            if (seatIds(room).every(seat => room.rematch[seat])) freshGame(room);
            changed(room);
            json(response, 200, snapshot(room, seatId));
            return;
          }

          if (!Number.isInteger(body.round)) throw new RequestError(400, 'Include the round number shown on your board.');
          if (body.round !== room.game.round) throw new RequestError(409, 'That round has already changed. Refresh your board and choose again.');
          if (room.game.result) throw new RequestError(409, 'This game has finished. Request a rematch to play again.');
          if (Object.hasOwn(room.orders, seatId)) throw new RequestError(409, 'Your move is already locked for this round.');
          if (!Object.hasOwn(body, 'move')) throw new RequestError(400, 'Choose a move before locking it in.');
          const legal = available(room, seatId);
          let order;
          if (body.move === null) {
            if (legal.length) throw new RequestError(400, 'You have a legal move and cannot pass this round.');
            order = null;
          } else {
            const move = body.move;
            if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to) || move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63) {
              throw new RequestError(400, 'Choose a valid move on the board.');
            }
            order = legal.find(candidate => candidate.from === move.from && candidate.to === move.to && candidate.promotion === (move.promotion ?? (candidate.promotion ? 'q' : undefined)));
            if (!order) throw new RequestError(400, 'That move is unavailable. Your teammate may have reserved that piece or destination.');
            order = { ...order };
          }
          if (settleClock(room)) {
            changed(room);
            throw new RequestError(409, 'This game has finished on time. Request a rematch to play again.');
          }
          room.orders[seatId] = order;
          finishOrders(room);
          updateRunning(room);
          changed(room);
          json(response, 200, snapshot(room, seatId));
          return;
        }
        throw new RequestError(405, 'That request method is not supported.');
      }

      if (pathname.startsWith('/api/')) throw new RequestError(404, 'That game endpoint does not exist.');
      if (!['GET', 'HEAD'].includes(request.method)) throw new RequestError(405, 'Use GET to load the game.');
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!publicFiles.has(filename)) throw new RequestError(404, 'Not found.');
      let contents;
      try { contents = await readFile(path.join(root, filename)); }
      catch { throw new RequestError(404, 'Not found.'); }
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filename)], 'Content-Length': contents.length, 'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
      else response.end();
      if (!error.status) console.error(error);
    }
  });

  const ping = setInterval(() => {
    for (const room of rooms.values()) {
      for (const seat of seatIds(room)) for (const stream of room.seats[seat]?.streams ?? []) stream.write(': ping\n\n');
      for (const stream of room.spectators) stream.write(': ping\n\n');
    }
  }, pingIntervalMs);
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - roomTtlMs;
    for (const [code, room] of rooms) {
      if (room.touched < cutoff && !seatIds(room).some(seat => room.seats[seat]?.streams.size) && !room.spectators.size) { clearTimeout(room.clockTimer); rooms.delete(code); }
    }
  }, Math.min(roomTtlMs, 60000));
  ping.unref();
  cleanup.unref();
  server.on('close', () => { clearInterval(ping); clearInterval(cleanup); for (const room of rooms.values()) clearTimeout(room.clockTimer); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST ?? '0.0.0.0';
  const accounts = new AccountStore(path.join(process.env.DATA_DIR || path.join(root, 'data'), 'accounts.json'));
  const server = createHopechessServer({ accounts });
  server.on('error', error => {
    console.error(`Could not start Hopechess: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const actualPort = server.address().port;
    const urls = hostUrls(actualPort);
    console.log(`Hopechess is ready at ${urls.localUrl}`);
    if (host === '0.0.0.0' || host === '::') {
      for (const url of urls.lanUrls) console.log(`Same Wi-Fi: ${url}`);
    } else if (!['127.0.0.1', '::1', 'localhost'].includes(host)) console.log(`Game address: http://${host}:${actualPort}`);
    console.log('Keep this terminal open while you play.');
  });
}
