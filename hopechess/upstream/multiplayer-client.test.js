import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiplayerClient, roomCode } from './multiplayer.js';

function client() { return new MultiplayerClient({onState:()=>{},onConnection:()=>{},onError:()=>{}}); }

test('a failed leave preserves the seat so a player can reconnect or retry', async () => {
  const game = client();
  const session = {code:'0123',token:'my-seat',color:'white'};
  const snapshot = {code:session.code,revision:4};
  game.session = session; game.snapshot = snapshot;
  game.request = async () => { throw new Error('Wi-Fi unavailable'); };
  await assert.rejects(game.leave(), /Wi-Fi unavailable/);
  assert.equal(game.session, session);
  assert.equal(game.snapshot, snapshot);
  assert.equal(game.leaving, false);
  game.request = async () => ({ok:true});
  await game.leave();
  assert.equal(game.session, null);
  assert.equal(game.snapshot, null);
});

test('an expired or released seat can leave without trapping the client', async () => {
  for (const status of [401,404]) {
    const game = client();
    game.session = {code:'0123',token:'expired',color:'white'};
    game.request = async () => { throw Object.assign(new Error('Seat gone'), {status}); };
    await game.leave();
    assert.equal(game.session, null);
  }
});

test('an older HTTP reply cannot overwrite newer live game state', () => {
  const game = client();
  game.session = {code:'0123',token:'my-seat',color:'white'};
  const updates = [];
  game.onState = snapshot => updates.push(snapshot);
  game.accept({code:'0123',revision:8,game:{round:2}});
  game.accept({code:'0123',revision:7,game:{round:1}});
  game.accept({code:'0123',revision:8,game:{round:1}});
  game.accept({code:'9876',revision:99,game:{round:1}});
  assert.equal(game.snapshot.game.round, 2);
  assert.equal(updates.length, 1);
});

test('numeric room codes and invite links preserve leading zeroes', () => {
  assert.equal(roomCode('0017'), '0017');
  assert.equal(roomCode(' 0 0 1 7 '), '0017');
  assert.equal(roomCode('http://192.168.1.1:4173/?room=0017'), '0017');
});

test('spectators use public state URLs, cannot mutate games, and leave without a player API request', async () => {
  const game = client();
  game.session = {code:'0017',spectator:true};
  let requests = 0;
  game.request = async endpoint => { requests++; assert.equal(endpoint,'/api/rooms/0017/watch'); return {code:'0017',revision:2}; };
  await game.refresh();
  assert.equal(requests,1);
  for (const action of [()=>game.submit({from:52,to:36}),()=>game.rematch(),()=>game.resign()]) await assert.rejects(action(),/Spectators cannot/);
  await game.leave();
  assert.equal(requests,1);
  assert.equal(game.session,null);
  assert.equal(game.snapshot,null);
  assert.equal(roomCode('http://localhost:4173/?watch=0017'),'0017');
});

test('creating a party opts into Elo and passes the guest identity to the UI before attaching', async () => {
  const game = client();
  const identity = {token:'guest-profile',player:{id:'guest',guest:true}};
  let received;
  game.onIdentity = value => { received = value; };
  game.listen = () => {};
  game.request = async (url,body) => {
    assert.equal(url,'/api/rooms');
    assert.equal(body.rated,true);
    return {code:'0123',token:'seat',color:'white',seat:'white',identity,snapshot:{code:'0123',revision:1}};
  };
  await game.create();
  assert.equal(received,identity);
  game.request = async (url,body) => { assert.equal(body.rated,false); return {code:'0123',token:'seat',snapshot:{code:'0123',revision:2}}; };
  await game.create('white',null,undefined,'1v1',false);
});

test('leaving returns Elo changes for the home screen while clearing the reconnect session', async () => {
  const game = client();
  game.session = {code:'0123',token:'seat'};
  const outcome = {ok:true,mode:'1v1',ratingResult:{white:{change:-16,after:984}}};
  game.request = async () => outcome;
  assert.equal(await game.leave(),outcome);
  assert.equal(game.session,null);
  assert.equal(game.savedSession(),null);
});
