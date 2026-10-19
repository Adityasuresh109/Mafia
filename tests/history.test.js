import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createGame,dispatch,viewFor} from '../src/engine.js';

const H='host-test-credential';
const act=(s,token,type,extra={})=>dispatch(s,token,{type,...extra,...(token===H?{expectedVersion:s.version}:{})},1700000000000,()=>0.43);
function room(){
 let s=createGame({roomCode:'ABC234',hostToken:H});
 for(let i=1;i<=7;i++)s=act(s,'token'+i,'JOIN',{name:'Player '+i});
 s=act(s,H,'LOCK');s=act(s,H,'CONFIGURE',{config:{mafia:2,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:60}});
 return act(act(s,H,'DEAL'),H,'NEXT');
}
function endNight(s,withKill=false){
 if(withKill){const killer=s.players.find(p=>p.role==='MAFIA'),victim=s.players.find(p=>p.role==='CIVILIAN');s=act(s,killer.token,'NIGHT_PICK',{targets:[victim.id]});s=act(s,H,'FINALIZE_NIGHT',{method:'consensus'});}
 else s=act(s,H,'FINALIZE_NIGHT',{method:'skip'});
 return act(act(s,H,'FINALIZE_NIGHT',{method:'skip'}),H,'FINALIZE_NIGHT',{method:'skip'});
}
function freshClientMarkup(snapshot){
 const app={innerHTML:'',addEventListener(){}};
 const doc={visibilityState:'visible',getElementById:id=>id==='app'?app:id==='connection'?{textContent:'',className:''}:{classList:{add(){},remove(){}},textContent:''},addEventListener(){},querySelectorAll(){return []}};
 const sandbox={document:doc,window:{},navigator:{},localStorage:{getItem(){return null},setItem(){},removeItem(){}},location:{hash:'',pathname:'/',origin:'https://test.example',protocol:'https:',host:'test.example'},URLSearchParams,history:{replaceState(){}},setInterval(){},setTimeout(){},clearTimeout(){},console};
 vm.runInNewContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+';globalThis.testPut=s=>{session={code:s.code,token:"token"};putState(s);};',sandbox);
 sandbox.testPut(snapshot);return app.innerHTML;
}
test('no private night result leaks before the host publicly announces it',()=>{
 let s=room();const victim=s.players.find(p=>p.role==='CIVILIAN'),guest=s.players.find(p=>p.id!==victim.id);
 s=endNight(s,true);
 assert.deepEqual(viewFor(s,guest.token).publicHistory,[]);
 s=act(s,H,'ANNOUNCE');
 const text='Night 1 — '+victim.name+' was killed.';
 assert.deepEqual(viewFor(s,guest.token).publicHistory,[{key:'night-1',text}]);
 assert.deepEqual(viewFor(s,H).publicHistory,[{key:'night-1',text:'Night 1 — '+victim.name+' ('+victim.role+') was killed.'}]);
 assert.equal(viewFor(s,guest.token).policeReport,undefined);
 const legacy=structuredClone(s);delete legacy.publicHistory;
 assert.deepEqual(viewFor(legacy,guest.token).publicHistory,[]);
});
test('a completed vote adds a public Day entry without revealing ballots',()=>{
 let s=endNight(room());s=act(s,H,'ANNOUNCE');s=act(s,H,'START_DISCUSSION');s=act(s,H,'END_DISCUSSION');
 const mafia=s.players.find(p=>p.role==='MAFIA');
 for(const p of s.players)s=act(s,p.token,'BALLOT',{targetId:p.id===mafia.id?'ABSTAIN':mafia.id});
 assert.deepEqual(viewFor(s,s.players[0].token).publicHistory,[{key:'night-1',text:'Night 1 — No one died.'}]);
 s=act(s,H,'CLOSE_VOTE');
 assert.equal(s.phase,'RESULTS');
 assert.deepEqual(viewFor(s,s.players[0].token).publicHistory.map(e=>e.key),['night-1','day-1']);
 assert.match(viewFor(s,s.players[0].token).publicHistory[1].text,/was voted out/);
 assert.doesNotMatch(viewFor(s,s.players[0].token).publicHistory[1].text,/\(MAFIA\)/);
 assert.match(viewFor(s,H).publicHistory[1].text,/\(MAFIA\)/);
 assert.equal(viewFor(s,s.players[0].token).ballots,undefined);
});
test('rounds missed while disconnected render on a brand-new phone with empty storage',()=>{
 let s=endNight(room());s=act(s,H,'ANNOUNCE');s=act(s,H,'START_DISCUSSION');s=act(s,H,'END_DISCUSSION');s=act(s,H,'CLOSE_VOTE');
 s=act(s,H,'NEXT');s=endNight(s);s=act(s,H,'ANNOUNCE');
 const snapshot=viewFor(s,s.players[0].token);
 assert.deepEqual(snapshot.publicHistory.map(e=>e.key),['night-1','day-1','night-2']);
 const markup=freshClientMarkup(snapshot);
 assert.match(markup,/Story so far/);assert.match(markup,/Night 1/);assert.match(markup,/Day 1/);assert.match(markup,/Night 2/);
 assert.equal((markup.match(/Night 1/g)||[]).length,1);
});
test('replay clears server-side public history and starts the next game clean',()=>{
 let s=room();
 for(let round=0;round<4&&s.phase!=='GAME_OVER';round++){
  s=endNight(s);s=act(s,H,'ANNOUNCE');s=act(s,H,'START_DISCUSSION');s=act(s,H,'END_DISCUSSION');
  const mafia=s.players.find(p=>p.alive&&p.role==='MAFIA');
  for(const p of s.players.filter(p=>p.alive))s=act(s,p.token,'BALLOT',{targetId:p.id===mafia.id?'ABSTAIN':mafia.id});
  s=act(s,H,'CLOSE_VOTE');if(s.phase!=='GAME_OVER')s=act(s,H,'NEXT');
 }
 assert.equal(s.phase,'GAME_OVER');assert.ok(viewFor(s,H).publicHistory.length>=2);
 s=act(s,H,'PLAY_AGAIN');
 assert.deepEqual(viewFor(s,H).publicHistory,[]);
 assert.deepEqual(viewFor(s,s.players[0].token).publicHistory,[]);
});
