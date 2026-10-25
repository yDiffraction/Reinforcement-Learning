const SESSION_KEY = 'hopechess.room.v1';

export function roomCode(value) {
  let code = String(value || '').trim();
  try { code = new URL(code).searchParams.get('room') || new URL(code).searchParams.get('watch') || code; } catch { /* A plain room code is expected too. */ }
  return code.replace(/\s/g, '').toUpperCase();
}

/** HTTP orders and a live state stream. Teammates share reservations; opponents and spectators never receive unrevealed orders. */
export class MultiplayerClient {
  constructor({ onState, onConnection, onError, onIdentity = () => {} }) {
    this.onState = onState;
    this.onIdentity = onIdentity;
    this.onConnection = onConnection;
    this.onError = onError;
    this.session = null;
    this.snapshot = null;
    this.stream = null;
    this.epoch = 0;
    this.connection = 'offline';
    this.leaving = false;
    this.info = { lanUrls: [] };
  }

  savedSession() {
    try {
      const session = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      return session?.code && (session?.token || session?.spectator) ? session : null;
    } catch { return null; }
  }

  remember() {
    try {
      if (this.session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* Rooms still work if browser storage is unavailable. */ }
  }

  async request(endpoint, body, accountToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(endpoint, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(accountToken ? { Authorization: `Bearer ${accountToken}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('Multiplayer needs the Hopechess server. Open the address printed by npm start.'); }
      if (!response.ok) {
        const error = new Error(data.error || 'The room could not be reached.');
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Cannot reach the game host. Check your Wi-Fi and keep the host running.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async loadInfo() {
    try { this.info = await this.request('/api/info'); } catch { /* Creating a room will show an actionable error if no host exists. */ }
    return this.info;
  }

  setConnection(value) { this.connection = value; this.onConnection(value); }

  accept(snapshot) {
    if (!this.session || snapshot.code !== this.session.code) return;
    if (this.snapshot && snapshot.revision <= this.snapshot.revision) return;
    this.snapshot = snapshot;
    this.onState(snapshot);
  }

  attach(reply) {
    if (reply.identity) this.onIdentity(reply.identity);
    this.disconnect();
    this.session = { code: reply.code, token: reply.token, color: reply.color, seat: reply.seat, spectator: !!reply.spectator };
    this.snapshot = null;
    this.remember();
    this.setConnection('connecting');
    this.accept(reply.snapshot);
    this.listen();
    return reply.snapshot;
  }

  async create(color = 'white', timeLimitMinutes = null, accountToken, mode = '1v1', rated = true) { return this.attach(await this.request('/api/rooms', {color,timeLimitMinutes,accountToken,mode,rated})); }
  async join(code, accountToken, color = 'random') { return this.attach(await this.request(`/api/rooms/${encodeURIComponent(roomCode(code))}/join`, {accountToken,color})); }

  async watch(code) {
    const normalized = roomCode(code);
    const snapshot = await this.request(`/api/rooms/${encodeURIComponent(normalized)}/watch`);
    return this.attach({code:normalized,spectator:true,snapshot});
  }
  stateUrl(session = this.session) {
    return `/api/rooms/${session.code}${session.spectator ? '/watch' : `?token=${encodeURIComponent(session.token)}`}`;
  }
  requirePlayer() { if (!this.session || this.session.spectator) throw new Error('Spectators cannot play moves or change the game.'); }

  async resume(session) {
    this.disconnect();
    this.session = session;
    this.snapshot = null;
    this.setConnection('connecting');
    try {
      this.accept(await this.request(this.stateUrl(session)));
      this.listen();
    } catch (error) {
      if (error.status === 401 || error.status === 404) { this.session = null; this.remember(); }
      this.setConnection('offline');
      throw error;
    }
  }

  listen() {
    const epoch = ++this.epoch;
    const { code, token, spectator } = this.session;
    const stream = new EventSource(`/api/rooms/${code}/events?${spectator ? 'watch=1' : `token=${encodeURIComponent(token)}`}`);
    this.stream = stream;
    stream.onopen = () => { if (epoch === this.epoch) this.setConnection('connected'); };
    stream.addEventListener('state', event => {
      if (epoch !== this.epoch) return;
      try { this.accept(JSON.parse(event.data)); } catch { this.onError('The host sent an unreadable update. Reconnecting…'); }
    });
    stream.onerror = async () => {
      if (epoch !== this.epoch || this.leaving) return;
      this.setConnection('reconnecting');
      try {
        const snapshot = await this.request(this.stateUrl());
        if (epoch === this.epoch) this.accept(snapshot);
      } catch (error) {
        if (epoch === this.epoch && [401,404].includes(error.status)) {
          this.disconnect(); this.session = null; this.snapshot = null; this.remember();
          this.onError(error.message);
        }
      }
    };
  }

  async refresh() {
    if (!this.session) return;
    const {code,token} = this.session;
    this.accept(await this.request(this.stateUrl()));
  }

  async submit(move) {
    this.requirePlayer();
    const {code,token} = this.session;
    const {gameId,game} = this.snapshot;
    const snapshot = await this.request(`/api/rooms/${code}/move`, {token,gameId,round:game.round,move});
    this.accept(snapshot);
  }

  async rematch() {
    this.requirePlayer();
    const {code,token} = this.session;
    const snapshot = await this.request(`/api/rooms/${code}/rematch`, {token,gameId:this.snapshot.gameId});
    this.accept(snapshot);
  }

  async resign() {
    this.requirePlayer();
    const {code,token} = this.session;
    this.accept(await this.request(`/api/rooms/${code}/resign`, {token,gameId:this.snapshot.gameId}));
  }

  disconnect() { this.epoch++; this.stream?.close(); this.stream = null; this.setConnection('offline'); }

  async leave() {
    const session = this.session;
    if (!session) return;
    if (session.spectator) { this.disconnect(); this.session = null; this.snapshot = null; this.remember(); return; }
    this.leaving = true;
    let outcome;
    try { outcome = await this.request(`/api/rooms/${session.code}/leave`, {token:session.token}); }
    catch (error) { if (![401,404].includes(error.status)) throw error; }
    finally { this.leaving = false; }
    this.disconnect(); this.session = null; this.snapshot = null; this.remember();
    return outcome;
  }

  inviteUrl() {
    const local = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
    const base = local && this.info.lanUrls?.length ? this.info.lanUrls[0] : location.origin;
    const url = new URL('/', base);
    url.searchParams.set(this.session.spectator ? 'watch' : 'room', this.session.code);
    return url.href;
  }
}
