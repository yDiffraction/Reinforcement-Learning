import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const digest = value => createHash('sha256').update(value).digest('hex');
const modes = ['1v1','2v2'];
const initialRating = () => ({elo:1000,games:0,wins:0,losses:0,draws:0});
const totals = user => Object.fromEntries(['games','wins','losses','draws'].map(key => [key,modes.reduce((sum, mode) => sum + user.ratings[mode][key],0)]));
const publicPlayer = user => ({ id:user.id, username:user.username, guest:!!user.guest, ratings:structuredClone(user.ratings), elo:user.ratings['1v1'].elo, ...totals(user) });

/** Persistent named and guest profiles, with separate ratings for each mode. */
export class AccountStore {
  constructor(filename = null) {
    this.filename = filename;
    this.data = filename && existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : { users: [], sessions: {}, results: {} };
    let migrated = false;
    for (const user of this.data.users) {
      if (!user.ratings) {
        // Retain the previous combined rating and record as the 1v1 legacy record.
        user.ratings = {'1v1':Object.fromEntries(Object.keys(initialRating()).map(key => [key,user[key] ?? initialRating()[key]])), '2v2':initialRating()};
        migrated = true;
      }
    }
    if (migrated) this.save();
  }
  save() {
    if (!this.filename) return;
    mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, this.filename);
  }
  session(user) {
    const token = randomBytes(32).toString('base64url');
    this.data.sessions[digest(token)] = { userId: user.id, expires: Date.now() + 30 * 86400000 };
    for (const [key, value] of Object.entries(this.data.sessions)) if (value.expires < Date.now()) delete this.data.sessions[key];
    this.save();
    return { token, player: publicPlayer(user) };
  }
  createGuest() {
    let username;
    do { username = `Guest_${randomBytes(3).toString('hex')}`; } while (this.data.users.some(user => user.username.toLowerCase() === username.toLowerCase()));
    const user = {id:randomUUID(),username,guest:true,ratings:{'1v1':initialRating(),'2v2':initialRating()}};
    this.data.users.push(user);
    return this.session(user);
  }
  register(username, password, guestToken) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) fail(400, 'Use 3–20 letters, numbers, or underscores for your username.');
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) fail(400, 'Use a password with 6–128 characters.');
    if (this.data.users.some(user => user.username.toLowerCase() === username.toLowerCase())) fail(409, 'That username is already taken.');
    const profile = guestToken ? this.authenticate(guestToken) : null;
    let user = profile?.guest ? this.data.users.find(user => user.id === profile.id) : null;
    if (!user) {
      user = {id:randomUUID(),ratings:{'1v1':initialRating(),'2v2':initialRating()}};
      this.data.users.push(user);
    }
    const salt = randomBytes(16).toString('hex');
    Object.assign(user,{username,guest:false,salt,passwordHash:scryptSync(password,salt,64).toString('hex')});
    return this.session(user);
  }
  login(username, password) {
    const user = typeof username === 'string' && this.data.users.find(user => user.username.toLowerCase() === username.toLowerCase());
    if (!user?.passwordHash || typeof password !== 'string' || password.length > 128 || !timingSafeEqual(Buffer.from(user.passwordHash, 'hex'), scryptSync(password, user.salt, 64))) fail(401, 'Incorrect username or password.');
    return this.session(user);
  }
  authenticate(token, optional = false) {
    if (!token && optional) return null;
    const session = typeof token === 'string' && this.data.sessions[digest(token)];
    const user = session && session.expires > Date.now() && this.data.users.find(user => user.id === session.userId);
    if (!user) fail(401, 'Please sign in again.');
    return publicPlayer(user);
  }
  logout(token) { if (typeof token === 'string') { delete this.data.sessions[digest(token)]; this.save(); } }
  player(id) { const user = this.data.users.find(user => user.id === id); return user ? publicPlayer(user) : null; }
  search(query = '', offset = 0, mode = '1v1') {
    if (!modes.includes(mode)) fail(400,'Choose the 1v1 or 2v2 leaderboard.');
    const found = this.data.users.filter(user => user.username.toLowerCase().includes(query.toLowerCase())).sort((a,b) => b.ratings[mode].elo - a.ratings[mode].elo || a.username.localeCompare(b.username));
    return { players: found.slice(offset, offset + 50).map(publicPlayer), total: found.length, offset, mode };
  }
  rate(gameId, whiteId, blackId, winner) { return this.rateTeams(gameId, {white:[whiteId],black:[blackId]}, winner); }
  rateTeams(gameId, teams, winner) {
    if (this.data.results[gameId]) return this.data.results[gameId];
    const ids = [...teams.white, ...teams.black];
    if (![1,2].includes(teams.white.length) || teams.white.length !== teams.black.length || ids.some(id => !id) || new Set(ids).size !== ids.length) return null;
    const mode = teams.white.length === 2 ? '2v2' : '1v1';
    const players = Object.fromEntries(['white','black'].map(color => [color, teams[color].map(id => this.data.users.find(user => user.id === id))]));
    if ([...players.white,...players.black].some(user => !user) || !['white','black','draw'].includes(winner)) return null;
    const average = color => players[color].reduce((sum, user) => sum + user.ratings[mode].elo, 0) / players[color].length;
    const score = winner === 'draw' ? 0.5 : winner === 'white' ? 1 : 0;
    const delta = Math.round(32 * (score - 1 / (1 + 10 ** ((average('black') - average('white')) / 400))));
    const result = {};
    for (const color of ['white','black']) for (const [index, user] of players[color].entries()) {
      const change = color === 'white' ? delta : -delta;
      const rating = user.ratings[mode];
      const before = rating.elo;
      rating.elo += change;
      rating.games++;
      if (winner === 'draw') rating.draws++;
      else if (winner === color) rating.wins++;
      else rating.losses++;
      Object.assign(user,{elo:user.ratings['1v1'].elo,...totals(user)});
      result[color + (index ? '2' : '')] = { id:user.id, username:user.username, mode, before, after:rating.elo, change };
    }
    this.data.results[gameId] = result;
    this.save();
    return result;
  }
}
