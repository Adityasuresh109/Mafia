import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createGame, dispatch, viewFor} from '../src/engine.js';

const HOST='host-regression-token';
const act=(s,token,command)=>dispatch(s,token,command,1_700_000_000_000,()=>0.42);
const host=(s,type,extra={})=>act(s,HOST,{type,expectedVersion:s.version,...extra});
function setup(){
 let s=createGame({roomCode:'ABC234',hostToken:HOST});
 for(let i=1;i<=7;i++)s=act(s,`t${i}`,{type:'JOIN',name:`Guest ${i}`});
 s=host(s,'LOCK');s=host(s,'CONFIGURE',{config:{mafia:2,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:60}});
 s=host(s,'DEAL');return host(s,'NEXT');
}
function markup(snapshot){
 const app={innerHTML:'',addEventListener(){}};
 const status={className:'',textContent:''};const toast={textContent:'',classList:{add(){},remove(){}}};
 const doc={getElementById(id){return id==='app'?app:id==='connection'?status:toast},querySelectorAll(){return []}};
 const sandbox={document:doc,localStorage:{getItem(){return null},setItem(){},removeItem(){}},location:{hash:'',pathname:'/',origin:'https://example.org',protocol:'https:',host:'example.org'},URLSearchParams,clearTimeout(){},setTimeout(){},setInterval(){},history:{replaceState(){}},console};
 vm.runInNewContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+`
;globalThis.testRender=s=>{session={code:s.code,token:'test'};putState(s);};`,sandbox);
 sandbox.testRender(snapshot);return app.innerHTML;
}
test('runoff mobile screen shows exactly tied candidates and runoff completes an elimination',()=>{
 let s=setup();for(let i=0;i<3;i++)s=host(s,'FINALIZE_NIGHT',{method:'skip'});
 s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');
 const [a,b]=s.players;
 for(let i=0;i<s.players.length;i++){const p=s.players[i],id=[b.id,a.id,a.id,b.id][i]||'ABSTAIN';s=act(s,p.token,{type:'BALLOT',targetId:id===p.id?'ABSTAIN':id});}
 s=host(s,'CLOSE_VOTE');assert.equal(s.phase,'DISCUSS_2');s=host(s,'END_DISCUSSION');assert.equal(s.phase,'VOTE_2');
 const voter=s.players[4],v=viewFor(s,voter.token);
 assert.deepEqual(v.runoff.candidates,[a.id,b.id]);
 const buttons=[...markup(v).matchAll(/<button class="target[^"\n]*" data-target="(p\d+)"/g)].map(x=>x[1]);
 assert.deepEqual(buttons.sort(),[a.id,b.id].sort());
 assert.throws(()=>act(s,voter.token,{type:'BALLOT',targetId:s.players[2].id}),/Invalid vote target/);
 for(const p of s.players)s=act(s,p.token,{type:'BALLOT',targetId:[a.id,b.id].includes(p.id)?'ABSTAIN':a.id});
 s=host(s,'CLOSE_VOTE');assert.equal(s.phase,'RESULTS');assert.deepEqual(s.lastEliminations,[a.id]);
});
test('host sees cumulative police verdicts with round numbers, civilians never do',()=>{
 let s=setup();const cop=s.players.find(p=>p.role==='POLICE'),mafia=s.players.find(p=>p.role==='MAFIA'),civilian=s.players.find(p=>p.role==='CIVILIAN');
 for(let i=0;i<2;i++)s=host(s,'FINALIZE_NIGHT',{method:'skip'});
 s=act(s,cop.token,{type:'NIGHT_PICK',targets:[mafia.id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
 assert.deepEqual(viewFor(s,HOST).policeReport,[{round:1,targetId:mafia.id,name:mafia.name,isMafia:true}]);
 assert.equal(viewFor(s,civilian.token).policeReport,undefined);
 assert.match(markup(viewFor(s,HOST)),/Round 1/);
 s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');s=host(s,'CLOSE_VOTE');s=host(s,'NEXT');
 for(let i=0;i<2;i++)s=host(s,'FINALIZE_NIGHT',{method:'skip'});
 s=act(s,cop.token,{type:'NIGHT_PICK',targets:[civilian.id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
 assert.deepEqual(viewFor(s,HOST).policeReport,[{round:1,targetId:mafia.id,name:mafia.name,isMafia:true},{round:2,targetId:civilian.id,name:civilian.name,isMafia:false}]);
 assert.match(markup(viewFor(s,HOST)),/Round 2/);assert.match(markup(viewFor(s,HOST)),/NOT MAFIA/);
 assert.equal(viewFor(s,civilian.token).policeReport,undefined);
});
test('normal night, Doctor save, votes, next night and Town victory do not regress',()=>{
 let s=setup();const mafia=s.players.filter(p=>p.role==='MAFIA'),doctor=s.players.find(p=>p.role==='DOCTOR'),police=s.players.find(p=>p.role==='POLICE'),civilian=s.players.find(p=>p.role==='CIVILIAN');
 s=act(s,mafia[0].token,{type:'NIGHT_PICK',targets:[civilian.id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
 s=act(s,doctor.token,{type:'NIGHT_PICK',targets:[civilian.id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
 s=act(s,police.token,{type:'NIGHT_PICK',targets:[mafia[0].id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
 assert.deepEqual(s.night.deaths,[]);assert.equal(s.phase,'MORNING');
 s=host(s,'ANNOUNCE');assert.equal(s.announcement,'No one died last night.');
 s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');
 for(const p of s.players)s=act(s,p.token,{type:'BALLOT',targetId:p.id===mafia[0].id?'ABSTAIN':mafia[0].id});
 s=host(s,'CLOSE_VOTE');assert.equal(s.phase,'RESULTS');s=host(s,'NEXT');
 for(let i=0;i<3;i++)s=host(s,'FINALIZE_NIGHT',{method:'skip'});
 s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');
 for(const p of s.players.filter(p=>p.alive))s=act(s,p.token,{type:'BALLOT',targetId:p.id===mafia[1].id?'ABSTAIN':mafia[1].id});
 s=host(s,'CLOSE_VOTE');assert.equal(s.phase,'GAME_OVER');assert.equal(s.winner,'TOWN');
 assert.equal(viewFor(s,civilian.token).policeReport,undefined);
});
