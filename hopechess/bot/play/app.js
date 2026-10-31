// Bot table: create a room on a hopechess server, fill seats with local bots,
// and play your seat here. All server calls go through play.py's /remote proxy.
import { getLegalMoves, getTeamLegalMoves } from '/lib/engine.js';
import { pieceSVG } from '/lib/pieces.js';

const $ = id => document.getElementById(id);
const store = (kind, key, value) => {
  try {
    if (value === undefined) return JSON.parse(kind.getItem(key) || 'null');
    if (value === null) kind.removeItem(key); else kind.setItem(key, JSON.stringify(value));
  } catch { return null; }
};
const FILES = 'abcdefgh';
const squareName = i => FILES[i % 8] + (8 - Math.floor(i / 8));
const teamOf = seat => seat?.startsWith('white') ? 'white' : 'black';
const other = color => color === 'white' ? 'black' : 'white';
const title = s => s[0].toUpperCase() + s.slice(1);

let config = null;
let session = store(sessionStorage, 'hc-session');   // {code, token, seat, server}
let account = store(localStorage, 'hc-account');     // {token, username}
let snap = null, receivedAt = 0, selected = null, events = null, botInfo = [], streamErrors = 0;

async function call(url, body, headers = {}) {
  const res = await fetch(url, body === undefined ? { headers } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}
const api = (path, body, headers) => call('/remote' + path, body, headers);
const local = (path, body) => call('/local' + path, body);

// ---------- setup form ----------
function params() {
  return {
    engine: $('engine').value, device: $('device').value, deepen: +$('deepen').value, think: +$('think').value, k1: +$('k1').value,
    temperature: +$('temperature').value, budget: $('budget').checked, wait: +$('wait').value, rematch: true,
  };
}

function syncForm() {
  const team = $('mode').value === '2v2';
  document.querySelectorAll('.team-only').forEach(el => { el.hidden = !team; });
  const net = $('engine').value.endsWith('.pt');
  document.querySelectorAll('.net-only').forEach(el => { el.hidden = !net; });
  $('deepen-out').textContent = $('deepen').value;
  $('think-out').textContent = `${$('think').value}s`;
  $('k1-out').textContent = $('k1').value;
  $('temp-out').textContent = (+$('temperature').value).toFixed(1);
  $('wait-out').textContent = `${$('wait').value}s`;
  $('account-name').textContent = account ? `· ${account.username}` : '· guest';
  $('signed-in').hidden = !account;
  $('signed-out').hidden = !!account;
  const saved = {};
  for (const id of ['mode', 'color', 'minutes', 'mate', 'opps', 'engine', 'device', 'deepen', 'think', 'k1', 'temperature', 'wait']) saved[id] = $(id).value;
  for (const id of ['rated', 'budget']) saved[id] = $(id).checked;
  store(localStorage, 'hc-form', saved);
}

function restoreForm() {
  const saved = store(localStorage, 'hc-form') || {};
  for (const [id, value] of Object.entries(saved)) {
    const el = $(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = value;
    else if ([...(el.options || [])].some(o => o.value === value) || el.tagName === 'INPUT') el.value = value;
  }
}

function showError(message) {
  $('setup-error').textContent = message;
  $('setup-error').hidden = !message;
}

async function setServer() {
  const server = $('server').value.trim().replace(/\/+$/, '');
  if (server !== config.server) config.server = (await local('/server', { server })).server;
  $('server-label').textContent = config.server;
}

async function startGame(event) {
  event.preventDefault();
  showError('');
  $('start').disabled = true;
  $('start').textContent = 'Starting…';
  let reply = null;
  try {
    await setServer();
    const mode = $('mode').value;
    const color = $('color').value === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : $('color').value;
    const minutes = $('minutes').value ? +$('minutes').value : null;
    reply = await api('/api/rooms', { mode, color, timeLimitMinutes: minutes, rated: $('rated').checked, accountToken: account?.token });
    const seats = [];
    if (mode === '1v1') seats.push({ color: other(color) });
    else {
      if ($('mate').value === 'bot') seats.push({ color });
      for (let i = 0; i < +$('opps').value; i++) seats.push({ color: other(color) });
    }
    $('start').textContent = 'Loading bots…';
    if (seats.length) await local('/bots', { code: reply.code, seats, params: params() });
    session = { code: reply.code, token: reply.token, seat: reply.seat, server: config.server };
    store(sessionStorage, 'hc-session', session);
    enterGame(reply.snapshot);
  } catch (error) {
    if (reply) {
      await local('/bots/stop', { code: reply.code }).catch(() => {});
      await api(`/api/rooms/${reply.code}/leave`, { token: reply.token }).catch(() => {});
    }
    showError(error.message);
  } finally {
    $('start').disabled = false;
    $('start').textContent = 'Start game';
  }
}

async function sendBot() {
  showError('');
  const code = $('join-code').value.trim();
  if (!/^\d{4}$/.test(code)) return showError('Enter the four-digit room code.');
  try {
    await setServer();
    $('join-bot').disabled = true;
    await local('/bots', { code, seats: [{ color: $('join-team').value }], params: params() });
    refreshBots();
  } catch (error) { showError(error.message); } finally { $('join-bot').disabled = false; }
}

async function login() {
  showError('');
  try {
    await setServer();
    const reply = await api('/api/accounts/login', { username: $('username').value, password: $('password').value });
    account = { token: reply.token, username: reply.player.username };
    store(localStorage, 'hc-account', account);
    $('password').value = '';
  } catch (error) { showError(error.message); }
  syncForm();
}

async function logout() {
  if (account) await api('/api/accounts/logout', {}, { Authorization: `Bearer ${account.token}` }).catch(() => {});
  account = null;
  store(localStorage, 'hc-account', null);
  syncForm();
}

// ---------- game ----------
function enterGame(initial) {
  $('setup').hidden = true;
  $('game').hidden = false;
  $('room-code').textContent = session.code;
  $('watch-link').href = `${session.server}/?watch=${session.code}`;
  $('invite-link').href = `${session.server}/?room=${session.code}`;
  snap = null;
  if (initial) accept(initial);
  connect();
}

function connect() {
  events?.close();
  streamErrors = 0;
  events = new EventSource(`/remote/api/rooms/${session.code}/events?token=${encodeURIComponent(session.token)}`);
  events.addEventListener('state', e => { streamErrors = 0; $('conn').textContent = 'live'; $('conn').className = 'conn live'; accept(JSON.parse(e.data)); });
  events.onerror = async () => {
    $('conn').textContent = 'reconnecting';
    $('conn').className = 'conn';
    if (++streamErrors < 3) return;
    try { accept(await api(`/api/rooms/${session.code}?token=${encodeURIComponent(session.token)}`)); }
    catch (error) {
      if (error.status === 401 || error.status === 404) { setStatus('This seat or room no longer exists.'); exitGame(false); }
    }
  };
}

function exitGame(leave = true) {
  events?.close();
  events = null;
  const old = session;
  session = null;
  snap = null;
  store(sessionStorage, 'hc-session', null);
  if (old) {
    local('/bots/stop', { code: old.code }).catch(() => {});
    if (leave) api(`/api/rooms/${old.code}/leave`, { token: old.token }).catch(() => {});
  }
  $('setup').hidden = false;
  $('game').hidden = true;
  selected = null;
  render();
}

function accept(next) {
  if (!session || next.code !== session.code) return;
  if (snap && next.revision < snap.revision) return;   // late HTTP reply after a newer event
  if (snap?.gameId !== next.gameId || snap?.game.round !== next.game.round) selected = null;
  snap = next;
  receivedAt = performance.now();
  render();
  autoPass();
}

const allJoined = () => snap.members.every(m => m.joined);
const myColor = () => teamOf(session?.seat);

function myMoves() {
  if (!snap || !session || snap.game.result || !allJoined() || snap.seatSubmitted[session.seat]) return [];
  if (snap.mode !== '2v2') return getLegalMoves(snap.game, myColor());
  const reserved = snap.teamMoves.filter(t => t.seat !== session.seat).map(t => t.move).filter(Boolean);
  return getTeamLegalMoves(snap.game, myColor(), reserved);
}

let passing = false;
async function autoPass() {
  // 1v1 with no legal move: the client must submit the pass (2v2 passes are server-side)
  if (passing || snap.mode === '2v2' || snap.game.result || !allJoined() || snap.seatSubmitted[session.seat] || myMoves().length) return;
  if (getLegalMoves(snap.game, myColor()).length) return;
  passing = true;
  try { await submit(null); } finally { passing = false; }
}

async function submit(move) {
  const { gameId, game } = snap;
  selected = null;
  try {
    accept(await api(`/api/rooms/${session.code}/move`, { token: session.token, gameId, round: game.round, move }));
  } catch (error) { setStatus(error.message, true); render(); }
}

function clickSquare(index) {
  const moves = myMoves();
  if (selected !== null) {
    const options = moves.filter(m => m.from === selected && m.to === index);
    if (options.length > 1) return choosePromotion(options);
    if (options.length === 1) return submit(strip(options[0]));
  }
  selected = moves.some(m => m.from === index) && selected !== index ? index : null;
  render();
}

const strip = m => ({ from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) });

function choosePromotion(options) {
  const dialog = $('promo');
  $('promo-options').innerHTML = '';
  for (const option of options) {
    const button = document.createElement('button');
    button.innerHTML = pieceSVG(option.promotion, myColor());
    button.title = option.promotion;
    button.onclick = () => { dialog.close(); submit(strip(option)); };
    $('promo-options').append(button);
  }
  dialog.showModal();
}

// ---------- rendering ----------
let statusOverride = null;
function setStatus(text, error = false) {
  statusOverride = { text, error, until: performance.now() + 4000 };
  renderStatus();
}

function render() {
  renderBoard();
  renderStrips();
  renderStatus();
  renderSidebar();
}

function renderBoard() {
  const board = $('board');
  const game = snap?.game;
  const flip = session && myColor() === 'black';
  const moves = myMoves();
  const dests = new Map(moves.filter(m => m.from === selected).map(m => [m.to, m]));
  const movable = new Set(moves.map(m => m.from));
  const last = new Set((game?.lastRound?.moves || []).flatMap(m => m && m.from !== undefined ? [m.from, m.to] : []));
  const pending = new Map();
  for (const t of snap?.teamMoves || []) if (t.move) {
    const kind = t.seat === session.seat ? 'mine' : 'mate';
    pending.set(t.move.from, kind);
    pending.set(t.move.to, kind);
  }
  const cells = [];
  for (let k = 0; k < 64; k++) {
    const i = flip ? 63 - k : k;
    const row = Math.floor(i / 8), col = i % 8;
    const piece = game ? game.board[i] : null;
    const cls = ['sq', (row + col) % 2 ? 'dark' : 'light'];
    if (last.has(i)) cls.push('last');
    if (i === selected) cls.push('selected');
    if (movable.has(i)) cls.push('movable');
    if (dests.has(i)) cls.push(piece ? 'capture' : 'dest');
    if (pending.has(i)) cls.push(`pending-${pending.get(i)}`);
    const coords = (k % 8 === 0 ? `<span class="rank">${8 - row}</span>` : '') + (k >= 56 ? `<span class="file">${FILES[col]}</span>` : '');
    const art = piece ? pieceSVG(piece.type, piece.color) + (piece.resting ? '<span class="rest" title="Resting">Ⅱ</span>' : '') : '';
    cells.push(`<button class="${cls.join(' ')}" data-i="${i}" aria-label="${squareName(i)}${piece ? ` ${piece.color} ${piece.type}` : ''}">${coords}${art}</button>`);
  }
  board.innerHTML = cells.join('');
  const overlay = $('board-overlay');
  overlay.hidden = !!snap;
  overlay.textContent = 'Choose your settings and start a game.';
}

function memberName(m) {
  if (!m.joined) return 'Open seat';
  const name = m.account?.username || 'Guest';
  return name;
}

function seatTags(m) {
  const tags = [];
  if (m.seat === session?.seat) tags.push('<span class="tag you">YOU</span>');
  if (botInfo.some(b => b.seat === m.seat)) tags.push('<span class="tag bot">BOT</span>');
  return tags.join('');
}

function clockText(color) {
  const clock = snap?.clock;
  if (!clock || clock.limitMinutes == null) return '';
  let ms = clock.remainingMs[color];
  if (clock.running[color]) ms -= performance.now() - receivedAt;
  ms = Math.max(0, ms);
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderStrips() {
  const mine = session ? myColor() : 'white';
  for (const [id, color] of [['bottom-strip', mine], ['top-strip', other(mine)]]) {
    const el = $(id);
    if (!snap) { el.innerHTML = ''; continue; }
    const members = snap.members.filter(m => m.color === color);
    const people = members.map(m => `<span class="person ${m.submitted ? 'ready' : ''}">${memberName(m)}${seatTags(m)}<i>${m.submitted ? '✓ moved' : m.joined ? '' : '…'}</i></span>`).join('');
    const clock = clockText(color);
    const running = snap.clock?.running?.[color];
    el.innerHTML = `<span class="side ${color}">${title(color)}</span><span class="people">${people}</span>${clock ? `<span class="clock ${running ? 'running' : ''}" data-color="${color}">${clock}</span>` : ''}`;
  }
}

function tickClocks() {
  document.querySelectorAll('.clock[data-color]').forEach(el => { el.textContent = clockText(el.dataset.color); });
}

function renderStatus() {
  const el = $('status');
  if (statusOverride && performance.now() < statusOverride.until) {
    el.textContent = statusOverride.text;
    el.className = `status ${statusOverride.error ? 'error' : ''}`;
    return;
  }
  el.className = 'status';
  if (!snap) { el.textContent = ''; return; }
  const game = snap.game;
  if (game.result) {
    const w = game.result.winner;
    const verdict = w === 'draw' ? 'Draw.' : w === myColor() ? 'You win!' : 'You lose.';
    const rating = snap.ratingResult ? ' Ratings updated.' : '';
    el.textContent = `${verdict} ${game.result.reason}${rating}`;
    el.className = `status result ${w === 'draw' ? '' : w === myColor() ? 'win' : 'loss'}`;
    return;
  }
  if (!allJoined()) {
    const joined = snap.members.filter(m => m.joined).length;
    el.textContent = `Round ${game.round} · waiting for players (${joined}/${snap.capacity}). Share the invite link for open seats.`;
    return;
  }
  if (snap.seatSubmitted[session.seat]) {
    const waiting = snap.members.filter(m => !m.submitted).map(m => m.seat === session.seat ? 'you' : memberName(m) + (botInfo.some(b => b.seat === m.seat) ? ' (bot thinking)' : ''));
    el.textContent = `Round ${game.round} · move locked. Waiting for ${waiting.join(', ')}.`;
    return;
  }
  const mate = snap.teamMoves.find(t => t.seat !== session.seat);
  const hint = snap.mode === '2v2' ? (mate ? ' Your teammate has moved (grey): pick a different piece and square.' : ' Your bot teammate is waiting for your move.') : '';
  el.textContent = `Round ${game.round} · your move.${selected !== null ? ` ${squareName(selected)} selected.` : ''}${hint}`;
}

function renderSidebar() {
  if (!snap) return;
  $('roster').innerHTML = snap.members.map(m => {
    const state = !m.joined ? 'open' : m.submitted ? 'moved' : !m.connected && !botInfo.some(b => b.seat === m.seat) ? 'offline' : 'thinking';
    return `<div class="seat"><span class="seat-id ${m.color}">${m.seat}</span><span>${memberName(m)} ${seatTags(m)}</span><span class="seat-state ${state}">${state}</span></div>`;
  }).join('');
  const lr = snap.game.lastRound;
  $('last-round').innerHTML = lr
    ? `<h3>Round ${lr.round}</h3>${(lr.events?.length ? lr.events : ['No captures.']).map(e => `<p>${e}</p>`).join('')}`
    : '<h3>Last round</h3><p>No rounds played yet.</p>';
  $('resign').disabled = !!snap.game.result || !allJoined();
  const askedRematch = snap.seatRematch?.[session.seat];
  $('rematch').disabled = !snap.game.result || askedRematch;
  $('rematch').textContent = askedRematch ? 'Rematch asked' : 'Rematch';
}

async function refreshBots() {
  try {
    const all = (await local('/bots')).bots;
    botInfo = session ? all.filter(b => b.code === session.code) : [];
    const others = all.filter(b => b.code !== session?.code);
    $('bot-log').innerHTML = botInfo.length
      ? botInfo.map(b => `<div class="bot"><strong>${b.seat}</strong> · ${b.label} · ${b.device}${b.running ? '' : ' · stopped'}${b.log.slice(-6).map(l => `<code>${l}</code>`).join('')}</div>`).join('')
      : '<p>No bots in this room.</p>';
    $('bot-only').hidden = !others.length;
    $('other-bots').innerHTML = others.map(b => `<div class="bot"><strong>room ${b.code} · ${b.seat}</strong> · ${b.label}${b.running ? '' : ' · stopped'}${b.log.slice(-3).map(l => `<code>${l}</code>`).join('')}</div>`).join('');
    if (snap) { renderStrips(); renderSidebar(); }
  } catch { /* play.py restarting */ }
}

// ---------- wiring ----------
async function init() {
  config = await local('/config');
  $('engine').innerHTML = config.models.map(m => `<option value="${m}">${m}${m === 'best.pt' ? ' (strongest)' : ''}</option>`).join('')
    + Object.entries(config.engines).map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
  $('device').innerHTML = config.devices.map(d => `<option value="${d.id}">${d.label}</option>`).join('');
  restoreForm();
  $('server').value = session?.server || config.server;
  $('server-label').textContent = config.server;
  syncForm();
  $('setup').addEventListener('input', syncForm);
  $('setup').addEventListener('change', syncForm);
  $('setup').addEventListener('submit', startGame);
  $('join-bot').onclick = sendBot;
  $('login').onclick = login;
  $('logout').onclick = logout;
  $('board').addEventListener('click', e => {
    const sq = e.target.closest('.sq');
    if (sq && snap) clickSquare(+sq.dataset.i);
  });
  $('resign').onclick = async () => {
    if (!confirm('Resign this game?')) return;
    try { accept(await api(`/api/rooms/${session.code}/resign`, { token: session.token, gameId: snap.gameId })); } catch (e) { setStatus(e.message, true); }
  };
  $('rematch').onclick = async () => {
    try { accept(await api(`/api/rooms/${session.code}/rematch`, { token: session.token, gameId: snap.gameId })); } catch (e) { setStatus(e.message, true); }
  };
  $('leave').onclick = () => {
    if (snap && !snap.game.result && allJoined() && !confirm('Leave the game? An active game counts as a loss.')) return;
    exitGame(true);
  };
  $('stop-others').onclick = async () => {
    const all = (await local('/bots')).bots;
    for (const code of new Set(all.filter(b => b.code !== session?.code).map(b => b.code))) await local('/bots/stop', { code });
    refreshBots();
  };
  if (session) {
    if (session.server !== config.server) await local('/server', { server: session.server }).then(r => { config.server = r.server; }).catch(() => {});
    $('server-label').textContent = config.server;
    enterGame(null);
  }
  render();
  refreshBots();
  setInterval(refreshBots, 1500);
  setInterval(() => { tickClocks(); if (statusOverride && performance.now() > statusOverride.until) { statusOverride = null; renderStatus(); } }, 250);
}

init().catch(error => showError(`Could not load: ${error.message}`));
