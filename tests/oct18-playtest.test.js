import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createGame,dispatch,viewFor} from '../src/engine.js';
import {MafiaRoom} from '../worker/index.js';

const H='host-Oct18';
let now=1730000000000;
const action=(s,t,type,props={})=>dispatch(s,t,{type,...props,...(t===H?{expectedVersion:s.version}:{})},++now,()=>0.37);
const host=(s,type,props={})=>action(s,H,type,props);
function setup(n=9,config={mafia:2,doctors:1,police:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:180}){
 let s=createGame({roomCode:'ABC234',hostToken:H});
 for(let i=0;i<n;i++)s=action(s,'guest-'+i,'JOIN',{name:'Guest '+(i+1)});
 s=host(s,'LOCK');s=host(s,'CONFIGURE',{config});s=host(s,'DEAL');return host(s,'NEXT');
}
function night(s,kill=null,save=null){
 if(kill){const mafia=s.players.find(p=>p.alive&&p.role==='MAFIA');s=action(s,mafia.token,'NIGHT_PICK',{targets:[kill.id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});}
 else s=host(s,'FINALIZE_NIGHT',{method:'skip'});
 if(save){const doctor=s.players.find(p=>p.alive&&p.role==='DOCTOR');s=action(s,doctor.token,'NIGHT_PICK',{targets:[save.id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});}
 else s=host(s,'FINALIZE_NIGHT',{method:'skip'});
 return host(s,'FINALIZE_NIGHT',{method:'skip'});
}
function vote(s,target=null){
 s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');
 for(const p of s.players.filter(x=>x.alive))s=action(s,p.token,'BALLOT',{targetId:target&&p.id!==target.id?target.id:'ABSTAIN'});
 return host(s,'CLOSE_VOTE');
}
function client(snapshot){
 let html='',tick=0,seq=0;
 const timeouts=new Map(),handlers={};
 const app={get innerHTML(){return html;},set innerHTML(v){html=v;},addEventListener(type,handler){handlers[type]=handler;}};
 const doc={visibilityState:'visible',getElementById(id){return id==='app'?app:id==='connection'?{className:'',textContent:''}:{classList:{add(){},remove(){}},textContent:''};},addEventListener(){},querySelectorAll(){return [];}};
 const ctx={document:doc,window:{},navigator:{},localStorage:{getItem(){return null;},setItem(){},removeItem(){}},location:{origin:'https://example.test',host:'example.test',pathname:'/',hash:'',protocol:'https:'},URLSearchParams,history:{replaceState(){}},setInterval(){},setTimeout(fn,delay){const id=++seq;timeouts.set(id,{fn,at:tick+delay});return id;},clearTimeout(id){timeouts.delete(id);},console};
 vm.runInNewContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+';globalThis.testState=(s)=>{session={code:s.code,token:"secret"};putState(s);};',ctx);
 ctx.testState(snapshot);
 return {markup:()=>html,updated:s=>ctx.testState(s),click:act=>handlers.click({target:{closest(selector){return selector==='[data-act]'?{dataset:{act}}:null;}}}),advance(ms){tick+=ms;for(const [id,t] of [...timeouts]){if(t.at<=tick){timeouts.delete(id);t.fn();}}}};
}

test('player role peek uses only self role, hides after 1s and resets timer on repeated taps',()=>{
 const s=setup(),citizen=s.players.find(p=>p.role==='CIVILIAN'),guest=viewFor(s,citizen.token),c=client(guest);
 assert.match(c.markup(),/data-act="rolePeek"/);
 assert.doesNotMatch(c.markup(),/class="role-peek[^"]*is-revealed/);
 c.click('rolePeek');assert.match(c.markup(),/CIVILIAN/);
 c.advance(600);c.click('rolePeek');c.advance(600);assert.match(c.markup(),/CIVILIAN/);
 c.advance(400);assert.doesNotMatch(c.markup(),/class="role-peek[^"]*is-revealed/);
 assert.equal(guest.roster.some(p=>p.role),false);
 const deceased={...guest,self:{...guest.self,alive:false},phase:'RESULTS',version:guest.version+1};
 c.updated(deceased);assert.match(c.markup(),/data-act="rolePeek"/);
});

test('names-only player announcements, role-free roster and history, host retains full roles',()=>{
 let s=setup(),civil=s.players.find(p=>p.role==='CIVILIAN'),mafia=s.players.filter(p=>p.role==='MAFIA');
 s=night(s,civil);
 const observer=s.players.find(p=>p.role==='DOCTOR');
 assert.equal(viewFor(s,observer.token).announcement,null,'No early death announcement');
 s=host(s,'ANNOUNCE');
 const player=viewFor(s,observer.token),hv=viewFor(s,H);
 assert.equal(player.announcement, civil.name+' died last night.');
 assert.match(hv.announcement,/\(CIVILIAN\)/);
 assert.equal(player.roster.find(p=>p.id===civil.id).role,undefined);
 assert.ok(!JSON.stringify(player.publicHistory).includes('CIVILIAN'));
 assert.ok(JSON.stringify(hv.publicHistory).includes('CIVILIAN'));
 s=vote(s,mafia[0]);
 const dayPlayer=viewFor(s,observer.token),dayHost=viewFor(s,H);
 assert.equal(s.phase,'RESULTS');
 assert.match(dayPlayer.publicHistory[1].text,/voted out/);
 assert.doesNotMatch(dayPlayer.publicHistory[1].text,/\(MAFIA\)/);
 assert.match(dayHost.publicHistory[1].text,/\(MAFIA\)/);
 assert.ok(!JSON.stringify(dayPlayer.roster).includes('role'));
 assert.match(client(dayPlayer).markup(),/was voted out/);
});

test('legacy rooms created before privacy update redact old historical role annotations for players',()=>{
 let s=setup();s=night(s);s=host(s,'ANNOUNCE');
 s.hostHistory=[];s.publicHistory=[{key:'night-1',text:'Night 1 — Alex (MAFIA), Bev (DOCTOR) were killed.'},{key:'day-1',text:'Day 1 — Cam (CIVILIAN) was voted out.'}];
 const guest=s.players.find(p=>p.role==='CIVILIAN');
 const p=viewFor(s,guest.token),h=viewFor(s,H);
 assert.ok(p.publicHistory.every(x=>!/(MAFIA|DOCTOR|CIVILIAN)/.test(x.text)));
 assert.match(h.publicHistory[0].text,/MAFIA/);
});

test('both normal and runoff votes start 60s deadlines, host early close clears them',()=>{
 let s=night(setup());s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');
 const earlier=s.deadline;
 s=host(s,'END_DISCUSSION');assert.equal(s.phase,'VOTE');assert.equal(s.deadline,now+60000);
 assert.equal(viewFor(s,s.players[0].token).deadline,s.deadline);
 assert.equal(viewFor(s,H).deadline,s.deadline);
 let end=host(s,'CLOSE_VOTE');assert.equal(end.phase,'RESULTS');assert.equal(end.deadline,null);
 assert.ok(earlier>0);
 let t=night(setup(7));t=host(t,'ANNOUNCE');t=host(t,'START_DISCUSSION');t=host(t,'END_DISCUSSION');
 const a=t.players[0],b=t.players[1];
 // 3 votes each plus 1 abstain; never self-vote.
 for(let i=0;i<t.players.length;i++){const p=t.players[i],target=[b.id,a.id,b.id,a.id,b.id,a.id,'ABSTAIN'][i];t=action(t,p.token,'BALLOT',{targetId:target===p.id?'ABSTAIN':target});}
 // Make tie explicit via two selected names if the self-vote adjustment changes results.
 const ballots=Object.values(t.ballots).filter(id=>id!=='ABSTAIN');
 assert.ok(ballots.length>=4);
 t=host(t,'CLOSE_VOTE');
 assert.equal(t.phase,'DISCUSS_2');
 t=host(t,'END_DISCUSSION');assert.equal(t.phase,'VOTE_2');assert.equal(t.deadline,now+60000);
});

test('Durable Object alarm closes an expired vote and produces the same result as host CLOSE_VOTE',async()=>{
 let s=night(setup());s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');
 const chosen=s.players.find(p=>p.role==='MAFIA');
 for(const p of s.players.filter(x=>x.alive))s=action(s,p.token,'BALLOT',{targetId:p.id===chosen.id?'ABSTAIN':chosen.id});
 const expected=host(s,'CLOSE_VOTE');
 const map=new Map([['state',{...s,deadline:Date.now()-1}]]),alarms=[];
 const storage={get:async k=>map.get(k),put:async(k,v)=>{map.set(k,v);},setAlarm:async t=>alarms.push(t),deleteAlarm:async()=>{}};
 const room=new MafiaRoom({storage,getWebSockets:()=>[]},{});
 await room.alarm();const result=await room.load();
 assert.equal(result.phase,expected.phase);assert.deepEqual(result.lastEliminations,expected.lastEliminations);
 assert.equal(result.deadline,null);const version=result.version;await room.alarm();assert.equal((await room.load()).version,version);
});

test('Doctor save, both victory conditions, full final reveal, and PLAY_AGAIN remain intact',()=>{
 let s=setup(7);
 const doctor=s.players.find(p=>p.role==='DOCTOR'),civil=s.players.find(p=>p.role==='CIVILIAN');
 s=night(s,civil,doctor?civil:null);assert.deepEqual(s.night.deaths,[]);
 s=host(s,'ANNOUNCE');assert.equal(viewFor(s,civil.token).announcement,'No one died last night.');
 const mafia=s.players.filter(p=>p.role==='MAFIA');s=vote(s,mafia[0]);s=host(s,'NEXT');
 s=night(s);s=host(s,'ANNOUNCE');s=vote(s,mafia[1]);
 assert.equal(s.phase,'GAME_OVER');assert.equal(s.winner,'TOWN');
 assert.equal(viewFor(s,civil.token).roster.every(p=>p.role),true);
 s=host(s,'PLAY_AGAIN');assert.equal(viewFor(s,civil.token).self.role,null);assert.deepEqual(viewFor(s,civil.token).publicHistory,[]);
 let m=setup(7);
 for(let round=0;round<4 && m.phase!=='GAME_OVER';round++){
  const target=m.players.find(p=>p.alive&&p.role==='CIVILIAN')||m.players.find(p=>p.alive&&p.role==='DOCTOR')||m.players.find(p=>p.alive&&p.role==='POLICE');
  m=night(m,target);m=host(m,'ANNOUNCE');
  if(m.phase!=='GAME_OVER'){m=vote(m);if(m.phase==='RESULTS')m=host(m,'NEXT');}
 }
 assert.equal(m.phase,'GAME_OVER');assert.equal(m.winner,'MAFIA');
 assert.ok(viewFor(m,m.players[0].token).roster.every(p=>p.role));
});
