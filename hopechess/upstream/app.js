import { createInitialState, getLegalMoves, getTeamLegalMoves, resolveRound, chooseComputerMove, indexToSquare, PIECE_NAMES } from './engine.js';
import { pieceSVG, icons } from './pieces.js';
import { MultiplayerClient, roomCode } from './multiplayer.js';

const $ = id => document.getElementById(id);
const opposite = color => color === 'white' ? 'black' : 'white';
const title = word => word.charAt(0).toUpperCase() + word.slice(1);
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STORAGE = 'hopechess.game.v1';
const MODE_KEY = 'hopechess.mode.v2';
let state = createInitialState();
let mode = 'network';
let playerColor = 'white';
let difficulty = 'balanced';
let orientation = 'white';
let phase = 'planning';
let planner = 'white';
let firstPlanner = 'white';
let selected = null;
let pending = null;
let orders = {};
let botMove = null;
let soundEnabled = false;
let toastTimer;
let revealTimer;
let focusSquare = 56;
let audioContext;
let networkSnapshot = null;
let networkSnapshotAt = 0;
let networkBusy = false;
let returningHome = false;
let networkError = '';
let networkConnection = 'offline';
let autoPassQueued = false;
const PREVIEW_KEY = 'hopechess.preview.v1';
let showMovePreview = true;
try { showMovePreview = localStorage.getItem(PREVIEW_KEY) !== 'off'; } catch {}
let gamesRevision = 0;

const ACCOUNT_KEY = 'hopechess.account.v1';
let accountToken = null;
let account = null;
let accountAction = 'login';
let accountBusy = false;
let resultShownKey = null;
let localGameId = Date.now();
let searchRevision = 0;
let searchOffset = 0;
let searchTimer;
try { accountToken = localStorage.getItem(ACCOUNT_KEY); } catch { /* Optional storage. */ }

const multiplayer = new MultiplayerClient({
  onState: applyNetworkState,
  onIdentity: rememberIdentity,
  onConnection: connection => { networkConnection = connection; if (mode === 'network') render(); },
  onError: message => {
    networkError = message;
    if (!multiplayer.session) { networkSnapshot = null; state = createInitialState(); resultShownKey = null; phase = 'lobby'; selected = null; pending = null; }
    if (mode === 'network') { render(); notify(message); }
  },
});

try {
  const preferredMode = localStorage.getItem(MODE_KEY);
  if (['computer','local'].includes(preferredMode)) mode = preferredMode;
  const saved = JSON.parse(localStorage.getItem(STORAGE));
  if (saved && saved.state?.board?.length === 64 && mode === saved.mode) {
    state = saved.state;
    mode = saved.mode;
    playerColor = saved.playerColor || 'white';
    difficulty = saved.difficulty || 'balanced';
    orientation = saved.orientation || playerColor;
    phase = ['review','planning','handoff','revealing'].includes(saved.phase) ? saved.phase : 'planning';
    planner = saved.planner || playerColor;
    firstPlanner = saved.firstPlanner || 'white';
    orders = saved.orders || {};
    pending = saved.pending || null;
    selected = pending?.from ?? null;
    botMove = saved.botMove ?? null;
    soundEnabled = !!saved.soundEnabled;
  }
} catch { /* Storage is optional; the game still works in private sessions. */ }

function save() {
  if (mode === 'network') return;
  try { localStorage.setItem(STORAGE, JSON.stringify({state,mode,playerColor,difficulty,orientation,phase,planner,firstPlanner,orders,pending,botMove,soundEnabled})); } catch { /* Do not interrupt play if browser storage is full or disabled. */ }
}
function saveMode() { try { localStorage.setItem(MODE_KEY, mode); } catch { /* Optional preference. */ } }
function notify(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3200);
}
function announce(message) { $('announcer').textContent = message; }
function playSound(capture = false) {
  if (!soundEnabled) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume();
    for (const [offset, frequency] of [[0, capture ? 260 : 390], [.085, capture ? 350 : 520]]) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, audioContext.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(.09, audioContext.currentTime + offset + .01);
      gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + offset + .14);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(audioContext.currentTime + offset); oscillator.stop(audioContext.currentTime + offset + .16);
    }
  } catch { /* Audio is an optional enhancement. */ }
}

function updateRoomAddress(code) {
  const url = new URL(location.href);
  url.searchParams.delete('watch');
  url.searchParams.set(multiplayer.session?.spectator ? 'watch' : 'room', code);
  history.replaceState(null, '', url);
}
function clearRoomAddress() {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  url.searchParams.delete('watch');
  history.replaceState(null, '', url);
}
function applyNetworkState(snapshot) {
  const previous = networkSnapshot;
  networkSnapshot = snapshot;
  networkSnapshotAt = performance.now();
  if (mode !== 'network') return;
  const newGame = !previous || previous.gameId !== snapshot.gameId;
  const newRound = previous && snapshot.game.round > previous.game.round;
  state = snapshot.game;
  playerColor = snapshot.you || 'white';
  if (newGame) { orientation = playerColor; focusSquare = playerColor === 'white' ? 56 : 7; $('room-details').open = false; }
  const bothJoined = snapshot.players.white.joined && snapshot.players.black.joined;
  if (newGame || newRound || state.result || ownSubmitted(snapshot) || !bothJoined) {
    pending = null; selected = null;
    if ($('promotion-dialog').open) $('promotion-dialog').close();
  }
  if (state.result) phase = 'review';
  else if (snapshot.spectator) phase = 'watching';
  else if (!bothJoined) phase = 'lobby';
  else if (ownSubmitted(snapshot)) phase = 'waiting';
  else phase = 'planning';
  networkError = '';
  if (newGame) { resultShownKey = null; if ($('result-dialog').open) $('result-dialog').close(); }
  if (phase === 'planning' && selected !== null && !pieceMoves(selected).length) { selected = null; pending = null; if ($('promotion-dialog').open) $('promotion-dialog').close(); }
  const ownAccount = snapshot.members?.find(member => member.seat === snapshot.yourSeat)?.account ?? snapshot.players[playerColor].account;
  if (account && ownAccount?.id === account.id) { account = ownAccount; renderAccount(); }
  render();
  if (newRound) {
    $('board').classList.add('revealing');
    setTimeout(() => $('board').classList.remove('revealing'), 800);
    playSound(state.lastRound?.captures?.length > 0);
    announce(state.result ? resultTitle() : `Round ${state.round - 1} revealed. All moves are in the history.`);
    showBoard();
  } else if (previous && newGame) {
    notify(bothJoined ? 'A new game. All players are ready.' : 'Your friend left. Invite someone to start a new game.');
  } else if (state.result && !previous?.game.result) {
    announce(`${resultTitle()} ${state.result.reason}`);
    playSound(true);
  }
}
async function enterMultiplayer() {
  if (networkBusy) return;
  clearTimeout(revealTimer);
  if (mode !== 'network') save();
  mode = 'network'; saveMode();
  networkError = ''; pending = null; selected = null; orders = {};
  if (multiplayer.snapshot) { networkSnapshot = null; applyNetworkState(multiplayer.snapshot); }
  else { networkSnapshot = null; state = createInitialState(); phase = 'lobby'; render(); }
  const session = multiplayer.savedSession();
  const watchCode = roomCode(new URL(location.href).searchParams.get('watch'));
  if (watchCode && !multiplayer.session) { await watchRoom(watchCode); multiplayer.loadInfo(); return; }
  const queryCode = roomCode(new URL(location.href).searchParams.get('room'));
  if (queryCode) { $('room-code-input').value = queryCode; renderHandoff(); }
  if (!multiplayer.session && session && (!queryCode || queryCode === session.code)) {
    networkBusy = true; render();
    try { await multiplayer.resume(session); updateRoomAddress(session.code); }
    catch (error) { networkError = error.message; }
    finally { networkBusy = false; render(); }
  }
  multiplayer.loadInfo().then(() => { if (mode === 'network') renderNetwork(); });
}
async function openRoom(join = false) {
  if (networkBusy) return;
  const code = roomCode($('room-code-input').value);
  if (join && !/^\d{4}$/.test(code)) { networkError = 'Enter the 4-digit room code your friend shared.'; renderNetwork(); return; }
  networkBusy = true; networkError = ''; render();
  try {
    if (join) await multiplayer.join(code, accountToken, $('join-team').value);
    else await multiplayer.create($('room-color').value, $('room-time-limit').value ? Number($('room-time-limit').value) : null, accountToken, $('room-mode').value, $('room-rated').checked);
    updateRoomAddress(multiplayer.session.code);
    notify(`Room ${multiplayer.session.code}. You’re playing ${playerColor}.`);
    showBoard();
  } catch (error) { networkError = error.message; }
  finally { networkBusy = false; render(); }
}
async function goHome() {
  if (networkBusy || returningHome) return;
  returningHome = true;
  const hadParty = !!multiplayer.session;
  const wasWatching = isSpectator();
  clearTimeout(toastTimer); $('toast').classList.remove('visible');
  clearTimeout(revealTimer);
  if (mode !== 'network') save();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  networkBusy = true; render();
  try {
    const outcome = await multiplayer.leave();
    if (outcome?.player?.id === account?.id) { account = outcome.player; renderAccount(); }
    mode = 'network'; saveMode();
    networkSnapshot = null; networkError = '';
    state = createInitialState(); pending = null; selected = null; orders = {}; botMove = null;
    orientation = 'white'; playerColor = 'white'; phase = 'lobby'; resultShownKey = null;
    clearRoomAddress();
    $('room-code-input').value = '';
    announce('Home. Create or join a multiplayer party.');
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    const rating = outcome?.ratingResult && Object.values(outcome.ratingResult).find(rating => rating.id === outcome.player?.id);
    if (rating) notify(`Left party · ${outcome.mode} Elo ${rating.change > 0 ? '+' : ''}${rating.change} · ${rating.after}`);
    else if (hadParty) notify(wasWatching ? 'Stopped watching' : 'Left party');
    window.scrollTo({top:0,left:0,behavior:'auto'});
  } catch (error) { networkError = error.message; notify(error.message); }
  finally { networkBusy = false; returningHome = false; render(); }
}
async function leaveRoom() { await goHome(); }

async function requestRematch() {
  if (!networkSnapshot || networkBusy || isSpectator()) return;
  networkBusy = true; networkError = ''; render();
  try { await multiplayer.rematch(); }
  catch (error) { networkError = error.message; }
  finally { networkBusy = false; render(); }
}
async function submitNetworkMove() {
  if (networkBusy || networkConnection !== 'connected' || !networkSnapshot || isSpectator()) return;
  const move = pending ? {...pending} : null;
  networkBusy = true; phase = 'submitting'; networkError = ''; render();
  try { await multiplayer.submit(move); }
  catch (error) {
    networkError = error.message;
    try { await multiplayer.refresh(); } catch { /* The stream will recover when the host is reachable. */ }
    if (phase === 'submitting') phase = ownSubmitted() ? 'waiting' : 'planning';
  } finally { networkBusy = false; render(); }
}
async function copyInvite() {
  const input = $('invite-url');
  try { await navigator.clipboard.writeText(input.value); notify('Invite copied. Send it to your friend.'); }
  catch {
    const details = $('room-details');
    const wasOpen = details.open;
    details.open = true;
    input.focus(); input.select();
    if (document.execCommand('copy')) { details.open = wasOpen; notify('Invite copied. Send it to your friend.'); }
    else notify('Select and copy the invite link shown in your room.');
  }
}
function isSpectator() { return mode === 'network' && !!networkSnapshot?.spectator; }
function ownSubmitted(snapshot = networkSnapshot) { return !!snapshot && !snapshot.spectator && (snapshot.seatSubmitted?.[snapshot.yourSeat] ?? snapshot.submitted[snapshot.you]); }
function allJoined(snapshot = networkSnapshot) { return !!snapshot?.players.white.joined && !!snapshot?.players.black.joined; }
function ownVote() { return networkSnapshot?.seatRematch?.[networkSnapshot.yourSeat] ?? networkSnapshot?.rematch[playerColor]; }
function teammateOrders() { return (networkSnapshot?.teamMoves ?? []).filter(entry => entry.seat !== networkSnapshot.yourSeat && entry.move).map(entry => entry.move); }
function legalMoves(color = activeColor()) {
  if (isSpectator()) return [];
  return mode === 'network' && networkSnapshot?.mode === '2v2' ? getTeamLegalMoves(state,color,teammateOrders()) : getLegalMoves(state,color);
}
function pieceMoves(index) { return legalMoves().filter(move => move.from === index); }
function readyCount() { return networkSnapshot?.members?.filter(member => member.submitted).length ?? 0; }
function renderNetwork() {
  const network = mode === 'network';
  const inRoom = !!networkSnapshot && !!multiplayer.session;
  const watching = isSpectator();
  const teams = networkSnapshot?.mode === '2v2';
  $('network-panel').hidden = !network;
  $('network-lobby').hidden = inRoom;
  $('network-room').hidden = !inRoom;
  $('move-panel').hidden = network && !inRoom;
  const creatingTeams = $('room-mode').value === '2v2';
  $('time-limit-label').textContent = creatingTeams ? 'TIME PER TEAM' : 'TIME PER PLAYER';
  $('team-mode-help').hidden = !creatingTeams;
  $('lobby-clock-help').textContent = creatingTeams ? 'Clocks start when all four players join. Your team clock pauses after both teammates submit.' : 'Clocks start when both players join. Your clock pauses as soon as you move.';
  const ratingMode = $('room-mode').value;
  $('rating-help').textContent = $('room-rated').checked ? account ? `${account.username} · ${ratingMode} Elo ${ratingOf(account,ratingMode).elo}. This party counts toward Elo.` : 'This party counts toward Elo. Your guest rating profile is saved automatically.' : 'Elo is off for this party. Ratings and rated records will stay unchanged.';
  $('create-room').disabled = networkBusy;
  $('join-room').disabled = networkBusy;
  $('watch-code-button').disabled = networkBusy;
  $('network-error').hidden = !networkError;
  $('network-error').textContent = networkError;
  if (!inRoom) return;
  const minutes = networkSnapshot.clock?.limitMinutes;
  $('room-heading-label').textContent = `${watching ? 'WATCHING' : 'YOUR ROOM'} · ${teams ? '2V2' : '1V1'} · ${networkSnapshot.rated ? 'RATED · ' : 'ELO OFF · '}${minutes ? `${minutes} MIN` : 'UNTIMED'}`;
  $('room-clock-help').hidden = !minutes;
  $('room-code-display').textContent = networkSnapshot.code;
  $('invite-url').value = multiplayer.inviteUrl();
  $('network-connection').textContent = networkConnection === 'connected' ? 'LIVE' : networkConnection === 'reconnecting' ? 'RECONNECTING' : 'CONNECTING';
  $('network-connection').classList.toggle('connected', networkConnection === 'connected');
  const members = networkSnapshot.members ?? [];
  const joined = members.filter(member => member.joined).length;
  const everyone = allJoined();
  $('room-player-status').textContent = `${watching ? 'Spectating' : `You’re ${playerColor}${teams ? ' team' : ''}`}. ${joined}/${networkSnapshot?.capacity || 2} players · ${networkSnapshot.spectators || 0} watching${!everyone ? ' · Waiting for players' : ''}`;
  $('team-roster').hidden = !teams && !watching;
  $('team-roster').innerHTML = ['white','black'].map(color => `<div class="roster-team"><strong>${title(color)}${teams ? ' team' : ''}</strong>${members.filter(member => member.color === color).map(member => {
    const own = member.seat === networkSnapshot.yourSeat;
    const order = networkSnapshot.teamMoves?.find(entry => entry.seat === member.seat);
    return `<div class="roster-member${own ? ' is-you' : ''}"><span>${escapeHTML(member.account?.username || (member.joined ? teams ? `Guest ${member.seat.endsWith('2') ? '2' : '1'}` : 'Guest' : 'Open seat'))}${own ? ' (you)' : ''}</span><small>${!member.joined ? 'Waiting' : state.result ? 'Finished' : !everyone ? 'Joined' : member.submitted ? order?.move ? `${indexToSquare(order.move.from)} → ${indexToSquare(order.move.to)}` : 'Submitted' : member.connected ? 'Choosing' : 'Offline'}</small></div>`;
  }).join('')}</div>`).join('');
  $('team-order-help').hidden = !teams || watching;
  $('leave-room').disabled = networkBusy;
  $('leave-room').textContent = watching ? 'Stop watching' : 'Leave party';
  $('leave-effect').textContent = !watching && !state.result && everyone ? teams ? 'Leaving forfeits for your team.' : 'Leaving counts as a loss.' : 'Return to the home screen.';
  $('resign-button').hidden = watching || !!state.result || !everyone;
  $('resign-button').textContent = teams ? 'Resign team' : 'Resign';
  $('resign-button').disabled = networkBusy || networkConnection !== 'connected';
  const voted = ownVote();
  const votes = members.filter(member => member.rematch).length;
  if (votes) $('room-details').open = true;
  $('rematch-button').hidden = watching;
  $('rematch-button').disabled = networkBusy || voted || !everyone || networkConnection !== 'connected' || (networkSnapshot.rated || teams) && !state.result;
  $('rematch-button').textContent = voted ? 'Rematch requested' : votes ? 'Accept rematch' : 'Ask for rematch';
  $('rematch-status').hidden = !votes;
  $('rematch-status').textContent = `${votes}/${networkSnapshot?.capacity || 2} players want a rematch. All players must accept.`;
}

function activeColor() { return mode === 'local' ? planner : playerColor; }
function showBoard() {
  if (!window.matchMedia('(max-width:800px)').matches) return;
  const bounds = $('board').getBoundingClientRect();
  const reserve = mode === 'local' ? 84 : 12;
  if (bounds.top < 0 || bounds.bottom > window.innerHeight - reserve) document.querySelector('.opponent').scrollIntoView({behavior:'smooth',block:'start'});
}
function prepareBot() {
  if (mode === 'computer' && !state.result) botMove = chooseComputerMove(state, opposite(playerColor), difficulty);
}
function beginRound() {
  phase = 'planning'; selected = null; pending = null; orders = {};
  if (mode === 'network') { render(); showBoard(); announce(`Round ${state.round}. Choose your move.`); return; }
  firstPlanner = state.round % 2 ? 'white' : 'black';
  planner = firstPlanner;
  if (mode === 'local') { phase = 'handoff'; orientation = planner; }
  prepareBot(); save(); render();
  showBoard();
  if (phase === 'planning') announce(`Round ${state.round}. Choose your move.`);
}
async function newGame(nextMode = null) {
  if (networkBusy) return;
  clearTimeout(revealTimer);
  if (multiplayer.session) {
    networkBusy = true; render();
    try { await multiplayer.leave(); }
    catch (error) { networkBusy = false; networkError = error.message; render(); notify(error.message); return; }
    networkBusy = false;
  }
  networkSnapshot = null;
  clearRoomAddress();
  state = createInitialState();
  mode = nextMode || $('game-mode').value;
  localGameId = Date.now(); resultShownKey = null;
  if ($('result-dialog').open) $('result-dialog').close();
  saveMode();
  const color = $('play-color').value;
  playerColor = color === 'random' ? (Math.random() < .5 ? 'white' : 'black') : color;
  difficulty = $('difficulty').value;
  orientation = mode === 'computer' ? playerColor : 'white';
  focusSquare = orientation === 'white' ? 56 : 7;
  beginRound();
  $('new-game-dialog').close();
  showBoard();
  notify(mode === 'computer' ? `A new game. You’re playing ${playerColor}.` : 'A new game. Keep your moves secret.');
}
function openSettings(nextMode = mode) {
  if (networkBusy) return;
  if (nextMode === 'network') nextMode = 'computer';
  $('game-mode').value = nextMode;
  $('play-color').value = playerColor;
  $('difficulty').value = difficulty;
  $('computer-options').hidden = nextMode === 'local';
  $('new-game-dialog').showModal();
}

function boardClick(index) {
  if (phase !== 'planning' || state.result) return;
  if (mode === 'network' && (networkBusy || networkConnection !== 'connected')) { notify('Reconnecting to your room. Your board will be ready shortly.'); return; }
  focusSquare = index;
  const color = activeColor();
  const piece = state.board[index];
  if (selected !== null) {
    const options = pieceMoves(selected).filter(move => move.to === index);
    if (options.length) {
      if (options.some(move => move.promotion)) { showPromotion(options); return; }
      chooseMove(options[0]); return;
    }
  }
  if (piece?.color === color) {
    if (teammateOrders().some(move => move.from === index || move.castle?.from === index) && mode === 'network') { notify('Your teammate has already reserved that piece for this round.'); return; }
    if (piece.resting) { notify(`That ${PIECE_NAMES[piece.type]} captured last round. It must rest this round.`); return; }
    if (!pieceMoves(index).length) { notify(`That ${PIECE_NAMES[piece.type]} has no available moves.`); return; }
    if (selected === index && !pending) selected = null;
    else selected = index;
    pending = null; render(); save();
  } else if (selected !== null) {
    notify('Choose a highlighted square, or select another piece.');
  } else {
    notify(`Choose one of the ${color} pieces to see its moves.`);
  }
}
function chooseMove(move) {
  pending = move;
  if (mode === 'local') {
    save(); render(); announce(`Move selected: ${indexToSquare(move.from)} to ${indexToSquare(move.to)}. Lock in when ready.`);
  } else lockMove();
}
function showPromotion(options) {
  $('promotion-options').innerHTML = options.map(move => `<button data-promotion="${move.promotion}">${pieceSVG(move.promotion, activeColor())}${title(PIECE_NAMES[move.promotion])}</button>`).join('');
  for (const button of $('promotion-options').querySelectorAll('button')) button.addEventListener('click', () => {
    const move = options.find(move => move.promotion === button.dataset.promotion);
    $('promotion-dialog').close(); chooseMove(move);
  });
  $('promotion-dialog').showModal();
}
function lockMove() {
  if (state.result) { if (mode === 'network') requestRematch(); else openSettings(); return; }
  if (phase === 'review') { beginRound(); return; }
  if (phase !== 'planning') return;
  const color = activeColor();
  if (!pending && legalMoves(color).length) return;
  if (mode === 'network') { submitNetworkMove(); return; }
  orders[color] = pending ? { ...pending } : null;
  if (mode === 'computer') {
    orders[opposite(playerColor)] = botMove;
    reveal();
  } else if (!Object.hasOwn(orders, opposite(color))) {
    planner = opposite(color); pending = null; selected = null; phase = 'handoff'; orientation = planner;
    save(); render(); showBoard(); announce(`Move locked. Pass the screen to ${planner}.`);
  } else reveal();
}
function reveal() {
  phase = 'revealing'; pending = null; selected = null; save(); render(); showBoard();
  // Both orders already exist. This pause gives their shared reveal a clear beat.
  revealTimer = setTimeout(() => {
    try {
      state = resolveRound(state, orders.white ?? null, orders.black ?? null);
      phase = state.result || mode === 'local' ? 'review' : 'planning'; orders = {};
      if (mode === 'computer' && !state.result) prepareBot();
      save(); render();
      $('board').classList.add('revealing');
      setTimeout(() => $('board').classList.remove('revealing'), 800);
      playSound(state.lastRound?.captures?.length > 0);
      announce(state.result ? resultTitle() : `Round ${state.round - 1} revealed. ${state.lastRound?.events.join(' ')}`);
    } catch (error) {
      phase = 'planning'; orders = {}; prepareBot(); save(); render(); notify(`The round couldn’t resolve: ${error.message}`);
    }
  }, 550);
}
function resultTitle() {
  if (!state.result) return '';
  if (state.result.winner === 'draw') return 'Draw';
  if (mode === 'local' || isSpectator()) return `${title(state.result.winner)}${networkSnapshot?.mode === '2v2' && mode === 'network' ? ' team' : ''} wins`;
  return state.result.winner === playerColor ? networkSnapshot?.mode === '2v2' && mode === 'network' ? 'Your team won!' : 'You won!' : networkSnapshot?.mode === '2v2' && mode === 'network' ? 'Your team lost' : 'You lost';
}
function scheduleForcedPass() {
  if (autoPassQueued || mode === 'local' || state.result || phase !== 'planning') return;
  if (mode === 'network' && (networkBusy || networkConnection !== 'connected')) return;
  if (legalMoves().length) return;
  autoPassQueued = true;
  queueMicrotask(() => {
    autoPassQueued = false;
    if (mode === 'local' || state.result || phase !== 'planning' || legalMoves().length) return;
    if (mode === 'network' && (networkBusy || networkConnection !== 'connected')) return;
    pending = null;
    lockMove();
  });
}

function renderBoard() {
  const focused = $('board').contains(document.activeElement);
  const indices = Array.from({length:64}, (_, i) => orientation === 'white' ? i : 63 - i);
  const legal = new Set(phase === 'planning' && selected !== null ? pieceMoves(selected).map(move => move.to) : []);
  const lastMoves = [...(state.lastRound?.moves ?? []), ...(state.lastRound?.secondaryMoves ?? [])].filter(move => !move.pass);
  const queued = showMovePreview && !state.result && mode === 'network' && !isSpectator()
    ? [...(networkSnapshot?.teamMoves ?? []).map(entry => entry.move).filter(Boolean)] : [];
  if (showMovePreview && phase === 'submitting' && pending && !queued.some(move => move.from === pending.from)) queued.push(pending);
  const queuedMoves = queued.flatMap(move => [move, ...(move.castle ? [move.castle] : [])]);
  const reserved = mode === 'network' && !isSpectator() ? teammateOrders().flatMap(move => [move.from, ...(move.castle ? [move.castle.from] : [])]) : [];
  const movable = phase === 'planning' ? new Set(legalMoves().map(move => move.from)) : new Set();
  $('board').innerHTML = indices.map((index, display) => {
    const piece = state.board[index];
    const row = Math.floor(index / 8), col = index % 8;
    const classes = ['square', (row + col) % 2 ? 'dark' : 'light'];
    if (piece) classes.push('has-piece');
    if (reserved.includes(index)) classes.push('team-reserved');
    if (movable.has(index)) classes.push('movable');
    if (queuedMoves.some(move => move.from === index)) classes.push('queued-from');
    const ghostMove = queuedMoves.find(move => move.to === index);
    const ghostPiece = ghostMove && state.board[ghostMove.from] ? {...state.board[ghostMove.from],type:ghostMove.promotion ?? state.board[ghostMove.from].type} : null;
    if (ghostPiece) classes.push('queued-to');
    if (lastMoves.some(move => move.from === index)) classes.push('last-from');
    if (lastMoves.some(move => move.to === index)) classes.push('last-to');
    if (phase === 'planning' && index === selected) classes.push('selected');
    if (phase === 'planning' && index === pending?.to) classes.push('pending-to');
    if (legal.has(index)) classes.push('legal');
    const label = `${indexToSquare(index)}${piece ? `, ${piece.color} ${PIECE_NAMES[piece.type]}${piece.resting ? ', resting this round' : ''}` : ', empty'}${legal.has(index) ? ', available destination' : movable.has(index) ? ', can move' : ''}${ghostPiece ? ', submitted team destination' : ''}${reserved.includes(index) ? ', reserved by teammate' : ''}`;
    return `<button class="${classes.join(' ')}" role="gridcell" data-square="${index}" tabindex="${index === focusSquare ? '0' : '-1'}" aria-label="${label}"${selected === index && phase === 'planning' ? ' aria-selected="true"' : ''} title="${label}">${display % 8 === 0 ? `<span class="coord rank-coord">${8-row}</span>` : ''}${display >= 56 ? `<span class="coord file-coord">${'abcdefgh'[col]}</span>` : ''}${piece ? pieceSVG(piece.type,piece.color) : ''}${ghostPiece ? `<span class="move-ghost" aria-hidden="true">${pieceSVG(ghostPiece.type,ghostPiece.color)}</span>` : ''}${piece?.resting ? '<span class="rest-marker" aria-hidden="true">Ⅱ</span>' : ''}</button>`;
  }).join('');
  if (focused) $('board').querySelector(`[data-square="${focusSquare}"]`)?.focus({preventScroll:true});
}
function renderPlayers() {
  const bottom = orientation, top = opposite(bottom);
  const name = color => mode === 'network' && networkSnapshot?.mode === '2v2' ? `${title(color)} team` : mode === 'network' ? networkSnapshot?.players[color].account ? `${escapeHTML(networkSnapshot.players[color].account.username)} <span class="player-elo">${ratingOf(networkSnapshot.players[color].account,networkSnapshot.mode).elo}</span>` : color === playerColor && !isSpectator() ? 'You (guest)' : 'Guest' : mode === 'computer' ? color === playerColor ? 'You' : 'The computer' : `${title(color)} player`;
  $('opponent-avatar').innerHTML = pieceSVG('n', top);
  $('you-avatar').innerHTML = pieceSVG('k', bottom);
  $('opponent-name').innerHTML = `${name(top)} <span class="mini-tag">${mode === 'computer' && top !== playerColor ? 'BOT' : top.toUpperCase()}</span>`;
  $('you-name').innerHTML = `${name(bottom)} <span class="mini-tag you-tag">${bottom.toUpperCase()}</span>`;
  $('opponent-subtitle').textContent = state.result ? resultTitle() : phase === 'review' ? `Playing ${top} · Move revealed` : `Playing ${top} · Planning in secret`;
  $('you-subtitle').textContent = isSpectator() ? 'Watching this game' : state.result ? state.result.reason : phase === 'review' ? 'Both moves revealed' : phase === 'waiting' ? 'Your move is submitted' : 'Choose a piece to see its moves';
  let status = state.result ? 'Game complete' : phase === 'review' ? 'Round revealed' : phase === 'revealing' ? 'Revealing moves' : mode === 'local' && Object.hasOwn(orders, top) ? 'Move locked' : 'Choosing a move';
  if (mode === 'network') {
    const friend = networkSnapshot?.players[opposite(playerColor)];
    status = isSpectator() ? 'Watching live' : state.result ? 'Game complete' : !networkSnapshot || !friend?.joined ? 'Waiting for a friend' : networkConnection !== 'connected' ? 'Reconnecting…' : !friend.connected ? 'Friend disconnected' : networkSnapshot.submitted[opposite(playerColor)] ? 'Friend has moved' : phase === 'review' ? 'Round revealed' : 'Planning together';
  }
  $('opponent-status').innerHTML = `<span class="status-dot"></span> ${status}`;
  $('captured-pieces').innerHTML = (state.captured?.[top] || []).map(piece => pieceSVG(piece.type, piece.color)).join('');
  $('captured-pieces').title = `${(state.captured?.[top] || []).length} ${top} pieces captured`;
}
function renderClocks() {
  const clock = mode === 'network' ? networkSnapshot?.clock : null;
  const elapsed = Math.max(0, performance.now() - networkSnapshotAt);
  const remaining = color => clock.remainingMs[color] === null ? null : Math.max(0, clock.remainingMs[color] - (clock.running[color] ? elapsed : 0));
  const display = ms => {
    if (ms === null) return '∞';
    const seconds = Math.ceil(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}`;
  };
  document.body.classList.toggle('has-network-clock', !!clock);
  for (const [id,color] of [['opponent-clock',opposite(orientation)],['you-clock',orientation]]) {
    const element = $(id);
    element.hidden = !clock;
    if (!clock) continue;
    const ms = remaining(color);
    element.textContent = display(ms);
    element.classList.toggle('running', clock.running[color]);
    element.classList.toggle('low-time', ms !== null && ms <= 30000 && !state.result);
    element.setAttribute('aria-label', `${title(color)}${networkSnapshot?.mode === '2v2' ? ' team' : ''}: ${ms === null ? 'no time limit' : `${display(ms)} remaining, ${state.result ? 'finished' : clock.running[color] ? 'running' : 'paused'}`}`);
  }
  $('mobile-time').hidden = !clock || clock.limitMinutes === null;
  if (clock && clock.limitMinutes !== null) {
    $('mobile-time').textContent = `${display(remaining(playerColor))} ${state.result ? 'remaining' : clock.running[playerColor] ? '· clock running' : '· clock paused'}`;
    $('mobile-time').classList.toggle('low-time', remaining(playerColor) <= 30000 && !state.result);
  }
}
function renderControls() {
  const color = activeColor();
  const noMoves = !isSpectator() && phase === 'planning' && !legalMoves(color).length;
  $('round-label').textContent = `ROUND ${String(phase === 'review' && !state.result?.reasonCode ? Math.max(1,state.round-1) : state.round).padStart(2,'0')}`;
  const phaseText = state.result ? 'COMPLETE' : phase === 'review' ? 'REVEALED' : phase === 'revealing' ? 'REVEALING' : phase === 'handoff' ? 'IN SECRET' : phase === 'waiting' ? 'WAITING' : phase === 'submitting' ? 'SENDING' : phase === 'lobby' ? 'WAITING' : phase === 'watching' ? 'WATCHING' : 'PLANNING';
  $('phase-label').innerHTML = `<span class="status-dot"></span> ${phaseText}`;
  let heading, description;
  if (state.result) { heading = resultTitle(); description = state.result.reason; }
  else if (isSpectator()) { heading = 'Spectating'; description = `${readyCount()}/${networkSnapshot.capacity} moves submitted. The board updates when every player is ready. You cannot play moves while watching.`; }
  else if (mode === 'network' && phase === 'lobby') { heading = 'Waiting for players'; description = `Share your room code. The game starts when all ${networkSnapshot?.capacity || 2} players join.`; }
  else if (mode === 'network' && phase === 'waiting') { heading = 'Move submitted'; description = `${readyCount()}/${networkSnapshot?.capacity || 2} moves submitted. Waiting for the remaining players.`; }
  else if (mode === 'network' && phase === 'submitting') { heading = 'Sending move…'; description = 'Your move stays hidden from the other team until everyone has submitted.'; }
  else if (phase === 'review') { heading = 'Round complete'; description = mode === 'network' && networkSnapshot?.clock?.limitMinutes ? 'Both moves are revealed. Your clock is running—continue to the next round and lock your next move.' : 'Both moves are revealed. Take in the new board, then plan your next move.'; }
  else if (phase === 'revealing') { heading = 'Revealing moves…'; description = 'Resolving both moves together.'; }
  else if (phase === 'handoff') { heading = `Pass to ${planner}`; description = `Pass the screen to ${planner}. The board will appear when they’re ready.`; }
  else if (noMoves) { heading = 'No legal moves'; description = mode === 'local' ? `No legal moves for ${color}. Lock in a pass to let the other side move and resting pieces recover.` : `No legal moves for ${color}. Passing automatically this round.`; }
  else { heading = mode === 'network' ? 'Your next move.' : mode === 'local' ? `${title(color)}, <br>make your move.` : 'Choose your move'; description = mode === 'local' ? 'Choose a piece and a destination, then lock in your secret move.' : selected !== null ? 'Tap a highlighted square to make your move.' : 'Tap a piece, then a destination. Your move is sent immediately.'; }
  $('turn-copy').innerHTML = `<h2>${heading}</h2><p class="turn-description">${escapeHTML(description)}</p>`;
  const chosen = pending && state.board[pending.from];
  if (phase === 'planning' && chosen) {
    $('move-selection').className = 'move-selection has-move';
    $('move-selection').innerHTML = `${pieceSVG(chosen.type,color)}<span class="selection-label"><strong>${title(PIECE_NAMES[chosen.type])} · ${indexToSquare(pending.from)} → ${indexToSquare(pending.to)}</strong>${pending.promotion ? `Promote to ${PIECE_NAMES[pending.promotion]}` : 'Ready when you are'}</span><button class="clear-move" aria-label="Clear selected move">×</button>`;
    $('move-selection').querySelector('button').addEventListener('click', () => {pending=null;selected=null;save();render();});
  } else {
    $('move-selection').className = 'move-selection';
    const label = state.result ? 'Game over' : phase === 'waiting' ? 'Move locked · waiting for your friend' : phase === 'submitting' ? 'Locking your move…' : phase === 'lobby' ? 'Waiting for a player' : phase === 'review' ? 'Both moves revealed' : phase === 'revealing' ? 'Resolving moves…' : phase === 'handoff' ? 'Pass the screen to the other player' : noMoves ? 'Forced pass · no available moves' : selected !== null ? 'Now choose a highlighted square' : 'Your move is a secret';
    $('move-selection').innerHTML = `<span class="selection-symbol" aria-hidden="true">${state.result ? '✳' : phase === 'review' ? '↗' : '◇'}</span><span class="selection-label">${label}</span>`;
  }
  let enabled = state.result || phase === 'review' || phase === 'planning' && (pending || noMoves);
  if (mode === 'network') {
    enabled = !isSpectator() && !networkBusy && !!networkSnapshot && (phase === 'review' && !state.result || networkConnection === 'connected' && (state.result ? !ownVote() && allJoined() : phase === 'planning' && (pending || noMoves)));
  }
  $('lock-button').disabled = !enabled;
  $('lock-button').hidden = isSpectator() || mode !== 'local' && !state.result;
  $('move-selection').hidden = mode !== 'local';
  $('lock-note').hidden = mode !== 'local';
  $('lock-button').innerHTML = `${state.result ? mode === 'network' ? ownVote() ? 'Rematch requested' : 'Play again together' : 'Play again' : phase === 'waiting' ? 'Waiting for your friend' : phase === 'submitting' ? 'Locking move…' : phase === 'review' ? 'Next round' : phase === 'revealing' ? 'Revealing moves…' : noMoves ? 'Lock in pass' : 'Lock in move'} <span aria-hidden="true">${state.result ? '↗' : '→'}</span>`;
  $('lock-note').innerHTML = `<span aria-hidden="true">◇</span> ${state.result ? 'Game over.' : phase === 'review' ? 'Capturing pieces rest for the next round.' : 'Your move stays hidden until both are ready.'}`;
  $('mobile-action').hidden = mode !== 'local' || phase === 'handoff' || phase === 'lobby';
  $('mobile-round').textContent = $('round-label').textContent;
  $('mobile-move').textContent = state.result ? state.result.winner === 'draw' ? 'Game drawn' : `${title(state.result.winner)} wins` : phase === 'waiting' ? 'Your move is locked' : phase === 'submitting' ? 'Sending your move…' : phase === 'review' ? 'Both moves revealed' : phase === 'revealing' ? 'Revealing…' : pending ? `${indexToSquare(pending.from)} → ${indexToSquare(pending.to)}${pending.promotion ? ` = ${pending.promotion.toUpperCase()}` : ''}` : noMoves ? 'No moves · pass this round' : `Choose ${mode === 'local' ? color + '’s' : 'your'} move`;
  $('mobile-lock').innerHTML = $('lock-button').innerHTML;
  $('mobile-lock').disabled = !enabled;
  for (const [id,value] of [['multiplayer-mode','network'],['computer-mode','computer'],['local-mode','local']]) {
    $(id).classList.toggle('active',mode===value); $(id).setAttribute('aria-selected',String(mode===value));
    $(id).disabled = networkBusy;
  }
}
function roundMarkup(round) {
  const moves = round.moves.map(move => {
    const color = move.color;
    if (!move || move.pass) return `<div class="round-move">${pieceSVG('p',color)}<div><span class="move-color">${color}${move.seat?.endsWith('2') ? ' · 2' : ''}</span><span class="move-route">Passed</span></div></div>`;
    return `<div class="round-move">${pieceSVG(move.piece?.type || 'p',color)}<div><span class="move-color">${color}${move.seat?.endsWith('2') ? ' · 2' : ''}</span><span class="move-route">${indexToSquare(move.from)} → ${indexToSquare(move.to)}${move.promotion ? ` = ${move.promotion.toUpperCase()}` : ''}${move.bounced ? ' · returned' : move.castle ? ' · castle' : move.enPassant ? ' · e.p.' : ''}</span></div></div>`;
  }).join('');
  const events = round.events?.length ? round.events.join(' ') : 'No captures this round.';
  return `<div class="round-moves">${moves}</div><p class="round-events">${escapeHTML(events)}</p>`;
}
function renderHistory() {
  $('last-round').innerHTML = state.lastRound ? roundMarkup(state.lastRound) : `<div class="empty-round"><span class="empty-symbol" aria-hidden="true">↗</span><p><strong>No moves yet.</strong>Completed rounds will appear here.</p></div>`;
  $('history-list').innerHTML = state.history.length ? [...state.history].reverse().map(round => `<article class="history-round"><h3>ROUND ${String(round.round).padStart(2,'0')}</h3>${roundMarkup(round)}</article>`).join('') : '<p class="history-empty">No completed rounds yet.</p>';
}
function renderHandoff() {
  const overlay = $('handoff-overlay');
  const networkLobby = mode === 'network' && phase === 'lobby' && !isSpectator();
  const covered = phase === 'handoff' || networkLobby;
  overlay.hidden = !covered;
  $('board').inert = covered;
  $('board').setAttribute('aria-hidden',String(covered));
  if (networkLobby) {
    const code = roomCode($('room-code-input').value);
    const join = !networkSnapshot && /^\d{4}$/.test(code);
    overlay.innerHTML = `<span class="handoff-symbol" aria-hidden="true">↗ ↙</span><p class="eyebrow">MULTIPLAYER</p><h2>${networkSnapshot ? 'Room ready' : join ? 'Join your friend' : 'Play a friend'}</h2><p>${networkSnapshot ? `Room ${networkSnapshot.code} is ready. Send your friend the invite link to start playing.` : 'Create a room or enter your friend’s 4-digit code. Both players choose a move on their own device.'}</p><button id="board-room-button"${networkBusy ? ' disabled' : ''}>${networkBusy ? 'Connecting…' : networkSnapshot ? 'Copy invite link ↗' : join ? `Join room ${code} →` : 'Create a room ↗'}</button>`;
    $('board-room-button').addEventListener('click', () => networkSnapshot ? copyInvite() : openRoom(join));
    return;
  }
  if (phase !== 'handoff') return;
  const first = !Object.keys(orders).length;
  overlay.innerHTML = `<span class="handoff-symbol" aria-hidden="true">↗ ↙</span><p class="eyebrow">${first ? 'NEW ROUND' : 'FIRST MOVE SUBMITTED'}</p><h2>Over to ${planner}.</h2><p>${first ? `${title(planner)} plans first this round.` : 'The first move is hidden.'} Pass the screen, then reveal the board when you’re ready.</p><button id="ready-button">I’m ${planner}. Let’s play <span aria-hidden="true">→</span></button>`;
  $('ready-button').addEventListener('click', () => {phase='planning';save();render();announce(`${title(planner)} to choose a move.`);});
}
function render() {
  document.body.dataset.mode = mode;
  document.body.dataset.phase = phase;
  document.body.classList.toggle('in-game', mode !== 'network' || !!networkSnapshot);
  renderBoard(); renderPlayers(); renderControls(); renderHistory(); renderNetwork(); renderHandoff(); renderClocks();
  document.querySelector('.game-sidebar').classList.toggle('network-sidebar', mode === 'network');
  $('new-game-button').innerHTML = `${mode === 'network' ? networkSnapshot ? isSpectator() ? 'Stop watching' : 'Leave party' : 'Create room' : 'New game'} <span aria-hidden="true">↗</span>`;
  $('new-game-button').disabled = networkBusy || returningHome;
  renderBoardStatus(); renderResult();
  scheduleForcedPass();
}

function renderBoardStatus() {
  const status = $('board-status');
  let text;
  $('preview-toggle').hidden = mode !== 'network' || !networkSnapshot || isSpectator();
  $('preview-toggle').textContent = `Preview ${showMovePreview ? 'on' : 'off'}`;
  $('preview-toggle').setAttribute('aria-pressed', String(showMovePreview));
  if (state.result) text = resultTitle();
  else if (isSpectator()) text = `Watching ${networkSnapshot.mode} · Round ${state.round} · ${readyCount()}/${networkSnapshot.capacity} submitted`;
  else if (phase === 'waiting' || phase === 'submitting') {
    const move = networkSnapshot?.yourMove ?? pending;
    text = `${move ? `${indexToSquare(move.from)} → ${indexToSquare(move.to)} submitted` : 'Pass submitted'} · ${readyCount()}/${networkSnapshot?.capacity || 2} ready`;
  } else if (phase === 'lobby') text = `Waiting for players · ${networkSnapshot?.members?.filter(member => member.joined).length || 0}/${networkSnapshot?.capacity || 2}`;
  else if (phase === 'handoff') text = `Pass the screen to ${planner}`;
  else if (phase === 'review') text = 'Both moves revealed · Continue to the next round';
  else if (phase === 'revealing') text = 'Revealing both moves…';
  else if (mode === 'network' && networkConnection !== 'connected') text = 'Reconnecting to the host…';
  else if (mode === 'local' && pending) text = `${indexToSquare(pending.from)} → ${indexToSquare(pending.to)} selected · Lock in your move`;
  else if (selected !== null) text = 'Choose a highlighted square';
  else text = `${mode === 'local' ? title(planner) + ' to move' : 'You can move'} · Select a piece`;
  status.textContent = text;
  status.classList.toggle('ready', phase === 'planning' && !state.result && (mode !== 'network' || networkConnection === 'connected'));
  status.classList.toggle('waiting', ['waiting','submitting'].includes(phase));
  status.classList.toggle('finished', !!state.result);
}
function renderResult() {
  if (!state.result || returningHome) return;
  const key = mode === 'network' ? networkSnapshot?.gameId : `${mode}-${localGameId}`;
  if (resultShownKey === key) return;
  resultShownKey = key;
  const draw = state.result.winner === 'draw';
  const won = !draw && (mode === 'local' || isSpectator() || state.result.winner === playerColor);
  const dialog = $('result-dialog');
  dialog.dataset.result = draw ? 'draw' : won ? 'win' : 'loss';
  $('result-symbol').textContent = draw ? '=' : won ? '♔' : '♚';
  $('result-title').textContent = resultTitle();
  $('result-reason').textContent = state.result.reason;
  const ratings = mode === 'network' ? networkSnapshot?.ratingResult : null;
  $('result-rating').innerHTML = ratings ? `<p class="result-rating-mode">${networkSnapshot.mode} Elo</p>` + Object.entries(ratings).map(([seat,rating]) => {
    const own = !isSpectator() && seat === (networkSnapshot.yourSeat || playerColor);
    return `<div class="rating-result-row${own ? ' own-rating' : ''}"><span>${escapeHTML(rating.username)}${own ? ' (you)' : ''}</span><strong>${rating.before} → ${rating.after} <span class="elo-change ${rating.change < 0 ? 'negative' : 'positive'}">${rating.change > 0 ? '+' : ''}${rating.change}</span></strong></div>`;
  }).join('') : `<p class="account-note">${mode === 'network' ? 'Unrated game · no Elo change' : 'Local game · no Elo change'}</p>`;
  $('result-rematch').hidden = isSpectator() || mode === 'network' && !allJoined();
  $('result-rematch').textContent = mode === 'network' ? 'Request rematch' : 'Play again';
  for (const other of document.querySelectorAll('dialog[open]')) if (other !== dialog) other.close();
  dialog.showModal();
}
function ratingOf(player, ratingMode = '1v1') {
  return player?.ratings?.[ratingMode] ?? {elo:player?.elo ?? 1000,games:player?.games ?? 0,wins:player?.wins ?? 0,losses:player?.losses ?? 0,draws:player?.draws ?? 0};
}
function rememberIdentity(identity) {
  accountToken = identity.token; account = identity.player;
  try { localStorage.setItem(ACCOUNT_KEY,accountToken); } catch {}
  if (account.guest) accountAction = 'register';
  renderAccount();
}
function renderAccount() {
  const currentMode = mode === 'network' ? networkSnapshot?.mode || $('room-mode').value : '1v1';
  $('account-button').textContent = account ? `${account.username} · ${currentMode} ${ratingOf(account,currentMode).elo}` : 'Sign in';
  $('account-title').textContent = account?.guest ? 'Your guest profile' : account ? 'Your account' : accountAction === 'register' ? 'Create account' : 'Sign in';
  $('account-signed-in').hidden = !account;
  $('account-signed-out').hidden = !!account && !account.guest;
  $('logout-button').hidden = !!account?.guest;
  $('login-tab').classList.toggle('active', accountAction === 'login');
  $('register-tab').classList.toggle('active', accountAction === 'register');
  $('account-password').autocomplete = accountAction === 'register' ? 'new-password' : 'current-password';
  $('account-submit').textContent = accountBusy ? 'Please wait…' : accountAction === 'register' ? account?.guest ? 'Save guest as an account' : 'Create account' : 'Sign in';
  $('account-submit').disabled = accountBusy;
  if (account) $('account-profile').innerHTML = `<h3>${escapeHTML(account.username)}</h3><div class="profile-ratings">${['1v1','2v2'].map(ratingMode => {
    const rating = ratingOf(account,ratingMode);
    return `<section><h4>${ratingMode} Elo</h4><strong>${rating.elo}</strong><p>${rating.games} ${rating.games === 1 ? 'game' : 'games'}<br>${rating.wins}W · ${rating.losses}L · ${rating.draws}D</p></section>`;
  }).join('')}</div>`;
  if (mode === 'network') renderNetwork();
}

async function restoreAccount() {
  if (!accountToken) return;
  try { account = (await multiplayer.request('/api/accounts/me', undefined, accountToken)).player; }
  catch (error) { if (error.status === 401) { accountToken = null; try { localStorage.removeItem(ACCOUNT_KEY); } catch {} } }
  if (account?.guest) accountAction = 'register';
  renderAccount();
}
async function authenticateAccount(event) {
  event.preventDefault();
  if (accountBusy) return;
  accountBusy = true; $('account-error').hidden = true; renderAccount();
  try {
    const reply = await multiplayer.request(`/api/accounts/${accountAction}`, { username: $('account-username').value.trim(), password: $('account-password').value }, account?.guest && accountAction === 'register' ? accountToken : undefined);
    accountToken = reply.token; account = reply.player;
    try { localStorage.setItem(ACCOUNT_KEY, accountToken); } catch { /* This sign-in lasts until the page closes. */ }
    $('account-password').value = '';
    notify(`Signed in as ${account.username}`);
  } catch (error) { $('account-error').textContent = error.message; $('account-error').hidden = false; }
  finally { accountBusy = false; renderAccount(); }
}
async function loadPlayers(more = false) {
  const revision = ++searchRevision;
  const offset = more ? searchOffset : 0;
  if (!more) { $('players-list').innerHTML = ''; $('players-count').textContent = 'Loading players…'; }
  $('players-more').hidden = true;
  try {
    const reply = await multiplayer.request(`/api/players?q=${encodeURIComponent($('player-search').value.trim())}&offset=${offset}&mode=${$('leaderboard-mode').value}`);
    if (revision !== searchRevision) return;
    searchOffset = offset + reply.players.length;
    const markup = reply.players.map(player => {
      const rating = ratingOf(player,$('leaderboard-mode').value);
      return `<article class="public-player"><div><strong>${escapeHTML(player.username)}</strong><span>${rating.games} ${rating.games === 1 ? 'game' : 'games'} · ${rating.wins}W / ${rating.losses}L / ${rating.draws}D</span><span>1v1: ${ratingOf(player,'1v1').elo} · 2v2: ${ratingOf(player,'2v2').elo}</span></div><div class="public-elo">${rating.elo}<small>${$('leaderboard-mode').value} Elo</small></div></article>`;
    }).join('');
    $('players-list').insertAdjacentHTML('beforeend', markup);
    $('players-count').textContent = reply.total ? `${reply.total} player${reply.total === 1 ? '' : 's'} · highest ${$('leaderboard-mode').value} Elo first` : 'No players found.';
    $('players-more').hidden = searchOffset >= reply.total;
  } catch (error) { if (revision === searchRevision) $('players-count').textContent = error.message; }
}
$('account-button').addEventListener('click', () => { renderAccount(); $('account-dialog').showModal(); });
$('account-form').addEventListener('submit', authenticateAccount);
for (const action of ['login','register']) $(`${action}-tab`).addEventListener('click', () => { accountAction = action; $('account-error').hidden = true; renderAccount(); });
$('logout-button').addEventListener('click', async () => {
  try { await multiplayer.request('/api/accounts/logout', {}, accountToken); }
  catch (error) { notify(error.message); return; }
  account = null; accountToken = null; try { localStorage.removeItem(ACCOUNT_KEY); } catch {}
  renderAccount();
});
$('players-button').addEventListener('click', () => { if (networkSnapshot?.mode) $('leaderboard-mode').value = networkSnapshot.mode; $('players-dialog').showModal(); loadPlayers(); });
$('leaderboard-mode').addEventListener('change', () => { searchRevision++; loadPlayers(); });
$('player-search').addEventListener('input', () => { searchRevision++; clearTimeout(searchTimer); searchTimer = setTimeout(() => loadPlayers(), 180); });
$('players-more').addEventListener('click', () => loadPlayers(true));
$('result-rematch').addEventListener('click', () => {
  $('result-dialog').close();
  if (mode === 'network') requestRematch();
  else if (mode === 'local') newGame('local');
  else openSettings();
});
$('resign-button').addEventListener('click', async () => {
  if (networkBusy || isSpectator()) return;
  networkBusy = true; render();
  try { await multiplayer.resign(); }
  catch (error) { notify(error.message); }
  finally { networkBusy = false; render(); }
});
window.addEventListener('storage', event => { if (event.key === ACCOUNT_KEY) { accountToken = event.newValue; account = null; renderAccount(); restoreAccount(); } });

async function watchRoom(code = $('room-code-input').value) {
  if (networkBusy) return;
  code = roomCode(code);
  if (!/^\d{4}$/.test(code)) { networkError = 'Enter a 4-digit party code to watch.'; renderNetwork(); return; }
  if (multiplayer.session && !multiplayer.session.spectator) { openGames(); return; }
  clearTimeout(revealTimer);
  if (mode !== 'network') save();
  mode = 'network'; saveMode(); phase = 'watching';
  networkBusy = true; networkError = ''; render();
  try { await multiplayer.watch(code); updateRoomAddress(code); showBoard(); }
  catch (error) { networkError = error.message; if (!networkSnapshot) phase = 'lobby'; }
  finally { networkBusy = false; render(); }
}
async function loadGames() {
  const revision = ++gamesRevision;
  $('games-count').textContent = 'Loading games…';
  try {
    const reply = await multiplayer.request('/api/rooms');
    if (revision !== gamesRevision) return;
    $('games-count').textContent = reply.rooms.length ? `${reply.rooms.length} current room${reply.rooms.length === 1 ? '' : 's'}` : 'No multiplayer games yet.';
    $('games-list').innerHTML = reply.rooms.map(room => `<article class="watch-game"><div><strong>${room.code} <span>${room.mode}</span></strong><p>${escapeHTML(room.teams.white.join(' + '))} vs ${escapeHTML(room.teams.black.join(' + '))}</p><small>${room.status === 'playing' ? `Round ${room.round}` : room.status === 'waiting' ? `${room.joined}/${room.capacity} players · Waiting` : room.result?.winner === 'draw' ? 'Draw' : `${title(room.result?.winner || 'white')} wins`} · ${room.spectators} watching</small></div><a class="secondary-button watch-link" href="?watch=${room.code}" target="_blank" rel="noopener">Watch ↗</a></article>`).join('');
  } catch (error) { if (revision === gamesRevision) $('games-count').textContent = error.message; }
}
function openGames() { if (!$('games-dialog').open) $('games-dialog').showModal(); loadGames(); }
$('watch-games-button').addEventListener('click', openGames);
$('browse-games-button').addEventListener('click', openGames);
$('refresh-games').addEventListener('click', loadGames);
$('watch-code-button').addEventListener('click', () => watchRoom());
$('watch-code-form').addEventListener('submit', event => {
  event.preventDefault();
  const code = roomCode($('watch-code-input').value);
  if (/^\d{4}$/.test(code)) window.open(`?watch=${code}`, '_blank', 'noopener');
});
$('room-mode').addEventListener('change', renderAccount);
$('room-rated').addEventListener('change', renderNetwork);
$('preview-toggle').addEventListener('click', () => {
  showMovePreview = !showMovePreview;
  try { localStorage.setItem(PREVIEW_KEY, showMovePreview ? 'on' : 'off'); } catch {}
  renderBoard(); renderBoardStatus();
});
window.addEventListener('storage', event => { if (event.key === PREVIEW_KEY) { showMovePreview = event.newValue !== 'off'; renderBoard(); renderBoardStatus(); } });
setInterval(() => { if ($('games-dialog').open && !document.hidden) loadGames(); }, 10000);

$('board').addEventListener('click', event => {const square=event.target.closest('[data-square]');if(square)boardClick(Number(square.dataset.square));});
$('board').addEventListener('keydown', event => {
  const square=event.target.closest('[data-square]');if(!square)return;
  const offsets = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-8,ArrowDown:8};
  if (!(event.key in offsets)) return;
  event.preventDefault();
  const display = orientation === 'white' ? Number(square.dataset.square) : 63-Number(square.dataset.square);
  const next = display + offsets[event.key];
  if (next < 0 || next > 63 || event.key === 'ArrowLeft' && display%8===0 || event.key==='ArrowRight' && display%8===7) return;
  focusSquare = orientation === 'white' ? next : 63-next;
  for(const button of $('board').querySelectorAll('button'))button.tabIndex=Number(button.dataset.square)===focusSquare?0:-1;
  $('board').querySelector(`[data-square="${focusSquare}"]`).focus();
});
$('lock-button').addEventListener('click',lockMove);
$('mobile-lock').addEventListener('click',lockMove);
$('rules-button').addEventListener('click',()=>$('rules-dialog').showModal());
$('collision-rules-button').addEventListener('click',()=>$('rules-dialog').showModal());
$('history-button').addEventListener('click',()=>$('history-dialog').showModal());
$('new-game-button').addEventListener('click',()=>mode === 'network' ? networkSnapshot ? goHome() : openRoom() : mode === 'local' ? newGame('local') : openSettings());
$('home-link').addEventListener('click', event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); goHome(); } });
$('multiplayer-mode').addEventListener('click',()=>{if(mode!=='network')enterMultiplayer();});
$('computer-mode').addEventListener('click',()=>{if(mode!=='computer')openSettings('computer');});
$('local-mode').addEventListener('click',()=>{if(mode!=='local')newGame('local');});
$('game-mode').addEventListener('change',()=>$('computer-options').hidden=$('game-mode').value==='local');
$('new-game-form').addEventListener('submit',event=>{event.preventDefault();newGame();});
$('create-room').addEventListener('click',()=>openRoom());
$('join-room-form').addEventListener('submit',event=>{event.preventDefault();openRoom(true);});
$('room-code-input').addEventListener('input',()=>renderHandoff());
$('copy-invite').addEventListener('click',copyInvite);
$('invite-url').addEventListener('click',event=>event.target.select());
$('leave-room').addEventListener('click',leaveRoom);
$('rematch-button').addEventListener('click',requestRematch);
$('flip-button').innerHTML=icons.flip;
$('flip-button').addEventListener('click',()=>{orientation=opposite(orientation);save();render();});
function renderSound() { $('sound-button').innerHTML = icons[soundEnabled?'sound':'mute']; $('sound-button').setAttribute('aria-label',`Turn sound ${soundEnabled?'off':'on'}`); $('sound-button').title=`Turn sound ${soundEnabled?'off':'on'}`; }
$('sound-button').addEventListener('click',()=>{soundEnabled=!soundEnabled;save();renderSound();if(soundEnabled)playSound();});
for(const button of document.querySelectorAll('.close-dialog'))button.addEventListener('click',()=>button.closest('dialog').close());
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
$('strength-order').innerHTML=['p','n','b','r','q','k'].map(type=>pieceSVG(type,'black')).join('');
if (mode !== 'network' && phase === 'revealing') {
  try { state = resolveRound(state, orders.white ?? null, orders.black ?? null); phase = state.result || mode === 'local' ? 'review' : 'planning'; }
  catch { phase = 'planning'; }
  orders = {}; pending = null; selected = null; save();
}
if (mode === 'computer' && phase === 'review' && !state.result) { phase = 'planning'; botMove = null; }
if(mode==='computer' && !botMove && phase==='planning')prepareBot();
renderSound(); renderAccount(); restoreAccount();
setInterval(() => { if (mode === 'network' && networkSnapshot?.clock && Object.values(networkSnapshot.clock.running).some(Boolean)) renderClocks(); }, 200);
document.addEventListener('visibilitychange', renderClocks);
if (mode === 'network' || (new URL(location.href).searchParams.has('room') || new URL(location.href).searchParams.has('watch'))) enterMultiplayer();
else render();
