// Isolated production room integration regression; do not log bearer credentials.
import assert from 'node:assert/strict';
const base=process.env.MAFIA_URL;
assert.ok(base?.startsWith('https://'),'MAFIA_URL must use HTTPS');
async function call(path, method='GET', body, token, expected=200){
 const res=await fetch(base+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const value=await res.json().catch(()=>({error:'invalid JSON'}));
 assert.equal(res.status,expected,path+' returned '+JSON.stringify(value));return value;
}
const owner=await call('/api/rooms','POST',{},undefined,201);
const root='/api/rooms/'+owner.code;
const guests=[];
for(let n=1;n<=7;n++)guests.push(await call(root+'/join','POST',{name:'Smoke Player '+n},undefined,201));
const tokenFor=id=>guests.find(g=>g.state.self.id===id)?.token;
let state=owner.state;
async function host(type,extra={}){
 state=(await call(root+'/state','GET',undefined,owner.token)).state;
 state=(await call(root+'/action','POST',{type,expectedVersion:state.version,...extra},owner.token)).state;
 return state;
}
async function player(id,type,extra={}){return (await call(root+'/action','POST',{type,...extra},tokenFor(id))).state;}
await host('LOCK');
await host('CONFIGURE',{config:{mafia:2,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:60}});
await host('DEAL');await host('NEXT');
const mafia=state.roster.filter(p=>p.role==='MAFIA');
const cop=state.roster.find(p=>p.role==='POLICE'),doctor=state.roster.find(p=>p.role==='DOCTOR');
const civilians=state.roster.filter(p=>p.role==='CIVILIAN');
assert.equal(mafia.length,2);assert.ok(cop&&doctor&&civilians.length>=2);
await player(mafia[0].id,'NIGHT_PICK',{targets:[civilians[0].id]});
await host('FINALIZE_NIGHT',{method:'consensus'});
await player(doctor.id,'NIGHT_PICK',{targets:[civilians[0].id]});
await host('FINALIZE_NIGHT',{method:'consensus'});
await player(cop.id,'NIGHT_PICK',{targets:[mafia[0].id]});
await host('FINALIZE_NIGHT',{method:'consensus'});
assert.equal(state.phase,'MORNING');
assert.deepEqual(state.publicHistory,[],'pre-announcement history stays private');
assert.deepEqual(state.pendingDeaths,[],'doctor protected target');
assert.deepEqual(state.policeReport,[{round:1,targetId:mafia[0].id,name:mafia[0].name,isMafia:true}]);
const copView=(await call(root+'/state','GET',undefined,tokenFor(cop.id))).state;
assert.equal(copView.policeReport[0].isMafia,true);
const civilianView=(await call(root+'/state','GET',undefined,tokenFor(civilians[1].id))).state;
assert.equal(civilianView.policeReport,undefined);
await host('ANNOUNCE');assert.equal(state.announcement,'No one died last night.');
assert.deepEqual(state.publicHistory,[{key:'night-1',text:'Night 1 — No one died.'}]);
await host('START_DISCUSSION');await host('END_DISCUSSION');
assert.equal(state.phase,'VOTE');assert.ok(state.deadline>Date.now(),'primary 60-second vote timer');
assert.equal((await call(root+'/state','GET',undefined,tokenFor(civilians[1].id))).state.deadline,state.deadline,'player and host clocks match');
const a=mafia[0].id,b=civilians[0].id;
const voters=state.roster.filter(p=>![a,b].includes(p.id));
for(const p of state.roster){
 const j=voters.findIndex(v=>v.id===p.id);
 await player(p.id,'BALLOT',{targetId:j<0||j>=4?'ABSTAIN':j<2?a:b});
}
await host('CLOSE_VOTE');assert.equal(state.phase,'DISCUSS_2');
assert.ok(state.deadline>Date.now(),'runoff discussion must have a live 60-second deadline');
// Use the real Durable Object alarm: the game must auto-enter the runoff vote.
await new Promise(resolve=>setTimeout(resolve,63000));
state=(await call(root+'/state','GET',undefined,owner.token)).state;
assert.equal(state.phase,'VOTE_2','the runoff timer must advance without host intervention');
assert.ok(state.deadline>Date.now(),'the runoff vote has its own 60-second timer');
const runoff=(await call(root+'/state','GET',undefined,tokenFor(voters[4].id))).state;
assert.deepEqual([...runoff.runoff.candidates].sort(),[a,b].sort());
await call(root+'/action','POST',{type:'BALLOT',targetId:voters[0].id},tokenFor(voters[4].id),400);
for(const p of state.roster)await player(p.id,'BALLOT',{targetId:p.id===a?'ABSTAIN':a});
await host('CLOSE_VOTE');assert.equal(state.phase,'RESULTS');assert.deepEqual(state.lastEliminations,[a]);
assert.deepEqual(state.publicHistory.map(x=>x.key),['night-1','day-1']);
 const privacySnapshot=(await call(root+'/state','GET',undefined,tokenFor(civilians[1].id))).state;
 assert.equal(privacySnapshot.roster.find(p=>p.id===a).role,undefined,'guest cannot read eliminated Mafia role');
 assert.ok(privacySnapshot.publicHistory.every(event=>!event.text.includes('(MAFIA)')&&!event.text.includes('(CIVILIAN)')),'player story has names only');
 assert.ok(state.publicHistory[1].text.includes('(MAFIA)'),'host retains historical roles');
await host('NEXT');
const earlierVotedOut=(await call(root+'/state','GET',undefined,tokenFor(civilians[1].id))).state;
assert.equal(earlierVotedOut.roster.find(p=>p.id===a).role,undefined,'eliminated player role remains secret until final reveal');
await host('FINALIZE_NIGHT',{method:'skip'});await host('FINALIZE_NIGHT',{method:'skip'});
await player(cop.id,'NIGHT_PICK',{targets:[civilians[1].id]});
await host('FINALIZE_NIGHT',{method:'consensus'});
assert.deepEqual(state.policeReport,[
 {round:1,targetId:a,name:mafia[0].name,isMafia:true},
 {round:2,targetId:civilians[1].id,name:civilians[1].name,isMafia:false},
]);
assert.deepEqual((await call(root+'/state','GET',undefined,tokenFor(cop.id))).state.policeReport.map(p=>p.round),[1,2],'Police retain private prior-round checks');
assert.equal((await call(root+'/state','GET',undefined,tokenFor(doctor.id))).state.policeReport,undefined);
await host('ANNOUNCE');
const reconnectedGuest=(await call(root+'/state','GET',undefined,tokenFor(civilians[1].id))).state;
assert.deepEqual(reconnectedGuest.publicHistory.map(x=>x.key),['night-1','day-1','night-2'],'reconnecting guest receives missed history');
assert.equal(reconnectedGuest.ballots,undefined,'history does not expose private ballots');
assert.equal(reconnectedGuest.policeReport,undefined,'history does not expose Police investigations');
await host('START_DISCUSSION');await host('END_DISCUSSION');
 assert.ok(state.deadline>Date.now(),'the following round has a fixed vote deadline');
 for(const p of state.roster.filter(p=>p.alive))await player(p.id,'BALLOT',{targetId:p.id===mafia[1].id?'ABSTAIN':mafia[1].id});
 // Do not manually close the second vote: assert actual Cloudflare alarm behavior.
 await new Promise(resolve=>setTimeout(resolve,63000));
 state=(await call(root+'/state','GET',undefined,owner.token)).state;
 assert.equal(state.phase,'GAME_OVER','60-second vote automatically resolves to game over');assert.equal(state.winner,'TOWN');
assert.deepEqual(state.publicHistory.map(x=>x.key),['night-1','day-1','night-2','day-2']);
const finalGuest=(await call(root+'/state','GET',undefined,tokenFor(civilians[1].id))).state;
 assert.ok(finalGuest.roster.every(player=>player.role),'game-over restores full role reveal');
 assert.ok(finalGuest.publicHistory.every(e=>!/(?: \((?:MAFIA|DOCTOR|POLICE|CIVILIAN)\))/.test(e.text)),'player history never leaks eliminated roles');
 assert.equal(finalGuest.publicHistory.length,state.publicHistory.length);
console.log('LIVE REGRESSIONS PASSED: Doctor save, private Police reports for rounds 1 and 2, tied runoff, restricted ballot, elimination, Town victory, durable public history across reconnect');
