import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountStore } from './accounts.mjs';

test('accounts validate usernames, store password hashes, sign in case-insensitively and revoke sessions', () => {
  const store = new AccountStore();
  const alice = store.register('Alice_1', 'passphrase');
  assert.equal(alice.player.elo, 1000);
  assert.equal(store.authenticate(alice.token).username, 'Alice_1');
  assert.equal(store.login('alice_1', 'passphrase').player.id, alice.player.id);
  assert.throws(() => store.register('ALICE_1', 'anotherpass'), {status:409});
  for (const name of ['a', 'bad name', '<script>', 'x'.repeat(21)]) assert.throws(() => store.register(name, 'passphrase'), {status:400});
  assert.throws(() => store.register('Bob', 'short'), {status:400});
  assert.throws(() => store.login('Alice_1', 'wrong'), {status:401});
  assert.throws(() => store.authenticate('bogus'), {status:401});
  assert.equal(store.authenticate(null, true), null);
  const publicData = JSON.stringify(store.search());
  for (const secret of ['password', 'salt', 'token', 'sessions']) assert.ok(!publicData.includes(secret));
  store.logout(alice.token);
  assert.throws(() => store.authenticate(alice.token), {status:401});
});

test('Elo is zero-sum, uses opponent strength, records draws and cannot rate the same result twice', () => {
  const store = new AccountStore();
  const a = store.register('Alice', 'passphrase').player, b = store.register('Bobby', 'passphrase').player;
  const result = store.rate('game-1', a.id, b.id, 'white');
  assert.equal(result.white.change, 16);
  assert.equal(result.black.change, -16);
  assert.equal(store.player(a.id).wins, 1);
  assert.equal(store.player(b.id).losses, 1);
  assert.deepEqual(store.rate('game-1', a.id, b.id, 'black'), result);
  assert.equal(store.player(a.id).games, 1);
  const draw = store.rate('game-2', a.id, b.id, 'draw');
  assert.equal(draw.white.change, -1);
  assert.equal(draw.black.change, 1);
  assert.equal(store.player(a.id).draws, 1);
  assert.equal(store.rate('same-account', a.id, a.id, 'white'), null);
  assert.equal(store.rate('guest', a.id, null, 'white'), null);
  assert.equal(store.player(a.id).games, 2);
});

test('account data, sessions and rated result deduplication survive a host restart', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopechess-accounts-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'accounts.json');
  let store = new AccountStore(file);
  const alice = store.register('Alice', 'secret-passphrase'), bob = store.register('Bobby', 'another-passphrase');
  store.rate('saved-game', alice.player.id, bob.player.id, 'black');
  const disk = readFileSync(file, 'utf8');
  assert.ok(!disk.includes('secret-passphrase'));
  assert.ok(!disk.includes(alice.token));
  store = new AccountStore(file);
  assert.equal(store.authenticate(alice.token).elo, 984);
  assert.equal(store.login('Alice', 'secret-passphrase').player.losses, 1);
  store.rate('saved-game', alice.player.id, bob.player.id, 'white');
  assert.equal(store.player(bob.player.id).elo, 1016);
  assert.equal(store.search('ALi').players[0].username, 'Alice');
  assert.equal(store.search('nobody').total, 0);
  assert.equal(store.search().players[0].username, 'Bobby');
});

test('2v2 Elo compares team averages and records one result for every distinct account', () => {
  const store = new AccountStore();
  const players = ['WhiteOne','WhiteTwo','BlackOne','BlackTwo'].map(name => store.register(name,'passphrase').player);
  for (const [index,elo] of [2000,1000,1500,1500].entries()) store.data.users[index].ratings['2v2'].elo = elo;
  const teams = {white:players.slice(0,2).map(player => player.id),black:players.slice(2).map(player => player.id)};
  const ratings = store.rateTeams('teams-game',teams,'white');
  assert.deepEqual(Object.values(ratings).map(rating => rating.change),[16,16,-16,-16]);
  assert.equal(Object.values(ratings).reduce((sum,rating) => sum + rating.change,0),0);
  store.rateTeams('teams-game',teams,'black');
  for (const player of players) assert.equal(store.player(player.id).games,1);
  assert.equal(store.player(players[1].id).wins,1);
  assert.equal(store.player(players[0].id).ratings['2v2'].elo,2016);
  assert.equal(store.player(players[0].id).ratings['1v1'].elo,1000);
  assert.equal(store.player(players[3].id).losses,1);
  assert.equal(store.rateTeams('duplicate',{white:[players[0].id,players[0].id],black:teams.black},'white'),null);
});


test('guests keep distinct 1v1 and 2v2 ratings and can save the same profile as an account', () => {
  const store = new AccountStore();
  const guests = Array.from({length:4},() => store.createGuest());
  for (const guest of guests) assert.equal(store.authenticate(guest.token).guest,true);
  const [a,b,c,d] = guests.map(guest => guest.player.id);
  store.rate('guest-duel',a,b,'white');
  assert.equal(store.player(a).ratings['1v1'].elo,1016);
  assert.equal(store.player(a).ratings['2v2'].elo,1000);
  const result = store.rateTeams('guest-teams',{white:[a,b],black:[c,d]},'black');
  assert.equal(result.white.mode,'2v2');
  assert.equal(result.white.change,-16);
  assert.equal(store.player(a).ratings['1v1'].elo,1016);
  assert.equal(store.player(a).ratings['2v2'].elo,984);
  const account = store.register('NamedPlayer','passphrase',guests[0].token);
  assert.equal(account.player.id,a);
  assert.equal(account.player.guest,false);
  assert.equal(account.player.ratings['1v1'].elo,1016);
  assert.equal(account.player.ratings['2v2'].elo,984);
  assert.equal(store.login('NamedPlayer','passphrase').player.id,a);
  assert.equal(store.authenticate(guests[0].token).username,'NamedPlayer');
  assert.throws(() => store.login(guests[1].player.username,'anything'),{status:401});
  assert.equal(store.search('',0,'1v1').players[0].id,a);
  assert.ok([c,d].includes(store.search('',0,'2v2').players[0].id));
});

test('legacy account data migrates without losing the old rating, sessions, or rated results', t => {
  const dir = mkdtempSync(path.join(tmpdir(),'hopechess-migration-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'accounts.json');
  const previous = new AccountStore();
  const alice = previous.register('Alice','passphrase');
  delete previous.data.users[0].ratings;
  Object.assign(previous.data.users[0],{elo:1432,games:10,wins:7,losses:2,draws:1});
  previous.data.results['legacy-game'] = {white:{id:alice.player.id,before:1416,after:1432,change:16}};
  writeFileSync(file,JSON.stringify(previous.data));
  const migrated = new AccountStore(file);
  const profile = migrated.authenticate(alice.token);
  assert.deepEqual(profile.ratings['1v1'],{elo:1432,games:10,wins:7,losses:2,draws:1});
  assert.deepEqual(profile.ratings['2v2'],{elo:1000,games:0,wins:0,losses:0,draws:0});
  assert.equal(migrated.data.results['legacy-game'].white.after,1432);
  assert.equal(new AccountStore(file).player(alice.player.id).ratings['1v1'].elo,1432);
});
