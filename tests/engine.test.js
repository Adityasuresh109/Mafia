import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, dispatch, viewFor, resolvePlurality } from '../src/engine.js';

const HOST = 'host-very-private';
const players = Array.from({length: 9}, (_, i) => `guest-${i+1}`);
let clock = 1_700_000_000_000;
const run = (state, token, command) => dispatch(state, token, command, clock++, () => 0.45);
const host = (state, type, extra={}) => run(state, HOST, {type, expectedVersion:state.version, ...extra});
function setup(n=9, preset={mafia:2, police:1, doctors:1, kills:1, saves:1, checks:1, boots:1, discussionSeconds:180}) {
  let game=createGame({roomCode:'ABC234',hostToken:HOST});
  for(let i=0;i<n;i++) game=run(game,players[i],{type:'JOIN',name:`Guest ${i+1}`});
  game=host(game,'LOCK'); game=host(game,'CONFIGURE',{config:preset});
  game=host(game,'DEAL');
  return game;
}
const getRole=(s,r)=>s.players.find(p=>p.role===r);
const eligible=(s,r)=>s.players.filter(p=>p.role!==r);
const advanceToNight=s=>host(s,'NEXT');

// Verified against the dependency-free single-host state machine.
test('lobby joins, duplicates and lock enforce 7-player minimum',()=>{
  let s=createGame({roomCode:'ABC234',hostToken:HOST});
  s=run(s,'alice-secret',{type:'JOIN',name:'Alice'});
  s=run(s,'bob-secret',{type:'JOIN',name:'Alice'});
  assert.deepEqual(s.players.map(p=>p.name),['Alice','Alice 2']);
  assert.throws(()=>host(s,'LOCK'),/at least 7/i);
  for(let i=0;i<5;i++) s=run(s,players[i],{type:'JOIN',name:`Person ${i+1}`});
  s=host(s,'LOCK'); assert.equal(s.phase,'CONFIG');
  assert.throws(()=>run(s,players[8],{type:'JOIN',name:'Latecomer'}),/locked|started/i);
});

test('invalid credentials and invalid role distributions are rejected',()=>{
  let s=setup(9);
  assert.throws(()=>run(s,'stranger',{type:'NEXT'}),/host|authorized/i);
  assert.throws(()=>run(s,players[0],{type:'NEXT'}),/host/i);
  assert.throws(()=>host(s,'CONFIGURE',{config:{mafia:5,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:180}}),/CONFIG|phase/i);
  let c=createGame({roomCode:'ABC234',hostToken:HOST});
  for(let i=0;i<7;i++) c=run(c,players[i],{type:'JOIN',name:`Person ${i+1}`});
  c=host(c,'LOCK');
  assert.throws(()=>host(c,'CONFIGURE',{config:{mafia:4,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:180}}),/half/i);
});

test('the deal is deterministic for tests, and player views reveal only the owner role',()=>{
  const s=setup(9);
  assert.equal(s.phase,'DEAL');
  assert.equal(s.players.filter(p=>p.role==='MAFIA').length,2);
  assert.equal(s.players.filter(p=>p.role==='POLICE').length,1);
  assert.equal(s.players.filter(p=>p.role==='DOCTOR').length,1);
  const guest=viewFor(s,players[0]);
  assert.equal(guest.self.role,s.players[0].role);
  assert.equal(guest.roster.length,9);
  assert.ok(guest.roster.every(p=>!('role' in p)));
  const text=JSON.stringify(guest);
  assert.ok(!text.includes('host-very-private'));
  assert.throws(()=>viewFor(s,'stranger'),/authorized/i);
  assert.equal(viewFor(s,HOST).roster.filter(p=>p.role==='MAFIA').length,2);
});

test('host version gate blocks a stale duplicate transition',()=>{
  let s=setup(); const before=s.version;
  s=host(s,'NEXT'); assert.equal(s.phase,'NIGHT_MAFIA');
  assert.throws(()=>run(s,HOST,{type:'NEXT',expectedVersion:before}),/stale/i);
});

test('Mafia all-living target list never identifies peers, but server rejects friendly fire',()=>{
  let s=advanceToNight(setup());
  const m=getRole(s,'MAFIA'); const teammate=s.players.find(p=>p.role==='MAFIA'&&p.id!==m.id);
  const v=viewFor(s,m.token);
  assert.ok(v.roster.some(p=>p.id===teammate.id));
  assert.ok(v.roster.every(p=>!('role' in p)));
  assert.throws(()=>run(s,m.token,{type:'NIGHT_PICK',targets:[teammate.id]}),/mafia|target/i);
});

test('one Mafia pick is provisionally unanimous and all-submitting intersection responds to dissent',()=>{
  let s=advanceToNight(setup());
  const mafia=s.players.filter(p=>p.role==='MAFIA');
  const targets=s.players.filter(p=>p.role!=='MAFIA');
  s=run(s,mafia[0].token,{type:'NIGHT_PICK',targets:[targets[0].id]});
  assert.deepEqual(viewFor(s,HOST).night.consensus,[targets[0].id]);
  s=run(s,mafia[1].token,{type:'NIGHT_PICK',targets:[targets[1].id]});
  assert.deepEqual(viewFor(s,HOST).night.consensus,[]);
  assert.throws(()=>host(s,'FINALIZE_NIGHT',{method:'consensus'}),/consensus/i);
  s=host(s,'FINALIZE_NIGHT',{method:'majority',tiebreak:[targets[1].id]});
  assert.equal(s.phase,'NIGHT_DOCTOR');
  assert.deepEqual(s.night.kills,[targets[1].id]);
});

test('Doctor save cancels a kill and police verdicts are private to submitting officers',()=>{
  let s=advanceToNight(setup());
  const mafia=getRole(s,'MAFIA'); const cop=getRole(s,'POLICE'); const doctor=getRole(s,'DOCTOR');
  const victim=s.players.find(p=>p.role==='CIVILIAN');
  s=run(s,mafia.token,{type:'NIGHT_PICK',targets:[victim.id]});
  s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
  s=run(s,doctor.token,{type:'NIGHT_PICK',targets:[victim.id]});
  s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
  s=run(s,cop.token,{type:'NIGHT_PICK',targets:[mafia.id]});
  s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
  assert.equal(s.phase,'MORNING');
  assert.deepEqual(s.night.deaths,[]);
  assert.deepEqual(viewFor(s,cop.token).policeReport,[{targetId:mafia.id,name:mafia.name,isMafia:true}]);
  assert.equal(viewFor(s,doctor.token).policeReport,undefined);
  assert.equal(viewFor(s,HOST).policeReport,undefined);
  s=host(s,'ANNOUNCE');
  assert.equal(s.announcement,'No one died last night.');
});

test('host secrets not present in player views, and votes are only exposed to host',()=>{
  let s=advanceToNight(setup());
  for(let i=0;i<3;i++) s=host(s,'FINALIZE_NIGHT',{method:'skip'});
  s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');
  const voter=s.players[0], target=s.players[1];
  s=run(s,voter.token,{type:'BALLOT',targetId:target.id});
  const p=viewFor(s,voter.token); const h=viewFor(s,HOST);
  assert.equal(p.myVote,target.id);
  assert.ok(!('ballots' in p));
  assert.equal(h.ballots[voter.id],target.id);
  assert.ok(JSON.stringify(p).includes('VOTE'));
});

test('plurality cutoff tie generates secondary runoff, unresolved secondary tie boots nobody',()=>{
  const tally=resolvePlurality({a:'x',b:'x',c:'x',d:'y',e:'y',f:'z',g:'z'},['x','y','z'],2);
  assert.deepEqual(tally.winners,['x']);
  assert.deepEqual(tally.tied,['y','z']);
  assert.equal(tally.remaining,1);
  let s=advanceToNight(setup(9,{mafia:2,police:1,doctors:1,kills:1,saves:1,checks:1,boots:2,discussionSeconds:180}));
  for(let i=0;i<3;i++) s=host(s,'FINALIZE_NIGHT',{method:'skip'});
  s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');
  const [a,b,c]=s.players; const candidates=[a.id,b.id,c.id];
  const choices=[b.id,a.id,a.id,a.id,a.id,b.id,c.id,c.id,s.players[3].id];
  s.players.forEach((p,i)=>{const target=choices[i]===p.id ? candidates.find(c=>c!==p.id) : choices[i];s=run(s,p.token,{type:'BALLOT',targetId:target});});
  s=host(s,'CLOSE_VOTE');
  assert.equal(s.phase,'DISCUSS_2');
  assert.ok(s.runoff.candidates.length>=2);
  s=host(s,'END_DISCUSSION');assert.equal(s.phase,'VOTE_2');
  // An abstention-only runoff contains no decisive winner; no elimination, including undisputed primary winner.
  s=host(s,'CLOSE_VOTE');
  assert.equal(s.phase,'RESULTS');
  assert.deepEqual(s.lastEliminations,[]);
});

test('night resolution detects mafia parity and ends with entire role roster',()=>{
  let s=advanceToNight(setup(7,{mafia:3,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:180}));
  const mafia=getRole(s,'MAFIA');const citizen=s.players.find(p=>p.role!=='MAFIA');
  s=run(s,mafia.token,{type:'NIGHT_PICK',targets:[citizen.id]});
  s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
  s=host(s,'FINALIZE_NIGHT',{method:'skip'});
  s=host(s,'FINALIZE_NIGHT',{method:'skip'});
  s=host(s,'ANNOUNCE');
  assert.equal(s.phase,'GAME_OVER');
  assert.equal(s.winner,'MAFIA');
  assert.ok(viewFor(s,players[0]).roster.every(p=>'role' in p));
});

test('only one host can control room, co-host join is rejected and replay is gated',()=>{
  let s=setup();
  assert.equal(viewFor(s,HOST).hostCount,1);
  assert.throws(()=>run(s,'cohost-token',{type:'COHOST_JOIN',pin:'1234'}),/Unknown command/);
  assert.throws(()=>run(s,'cohost-token',{type:'LOCK',expectedVersion:s.version}),/Only an authorized host/);
  s=advanceToNight(s);
  for(let i=0;i<3;i++) s=host(s,'FINALIZE_NIGHT',{method:'skip'});
  s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');
  s=host(s,'CLOSE_VOTE');
  assert.equal(s.phase,'RESULTS');
  assert.throws(()=>host(s,'PLAY_AGAIN'),/game.over|finished/i);
});
