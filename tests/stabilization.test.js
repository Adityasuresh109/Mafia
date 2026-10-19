import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createGame,dispatch,viewFor} from '../src/engine.js';
import {MafiaRoom} from '../worker/index.js';
const HOST='host-t'; let clock=1720000000000;
const act=(s,token,type,extra={})=>dispatch(s,token,{type,...extra,...(token===HOST?{expectedVersion:s.version}:{})},clock++,()=>0.45);
const host=(s,type,extra={})=>act(s,HOST,type,extra);
function setup(){let s=createGame({roomCode:'ABC234',hostToken:HOST});for(let i=1;i<=9;i++)s=act(s,'guest-'+i,'JOIN',{name:'Guest '+i});s=host(s,'LOCK');s=host(s,'CONFIGURE',{config:{mafia:2,doctors:1,police:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:60}});s=host(s,'DEAL');return host(s,'NEXT');}
function runoff(){let s=setup();for(let i=0;i<3;i++)s=host(s,'FINALIZE_NIGHT',{method:'skip'});s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');const a=s.players[0],b=s.players[1];let i=0;for(const p of s.players){const pick=i===0?b.id:i<=4?a.id:i<=7?b.id:'ABSTAIN';i++;s=act(s,p.token,'BALLOT',{targetId:p.id===pick?'ABSTAIN':pick});}return host(s,'CLOSE_VOTE');}

test('runoff discussion retains its 60-second deadline and Durable Object alarm auto-advances once',async()=>{
 let s=runoff();assert.equal(s.phase,'DISCUSS_2');assert.ok(s.deadline>0);assert.equal(viewFor(s,HOST).deadline,s.deadline);
 const map=new Map([['state',s]]);const storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),setAlarm:async()=>{},deleteAlarm:async()=>{}};
 const room=new MafiaRoom({storage,getWebSockets:()=>[]},{});
 s.deadline=Date.now()-1;await room.save(s);await room.alarm();const updated=await room.load();
 assert.equal(updated.phase,'VOTE_2');assert.ok(updated.deadline>Date.now());const version=updated.version;
 await room.alarm();assert.equal((await room.load()).version,version);
});

test('Police see only their own cumulative results with rounds; civilians see nothing',()=>{
 let s=setup();const cop=s.players.find(p=>p.role==='POLICE'),m=s.players.find(p=>p.role==='MAFIA'),civilian=s.players.find(p=>p.role==='CIVILIAN');
 for(let i=0;i<2;i++)s=host(s,'FINALIZE_NIGHT',{method:'skip'});
 s=act(s,cop.token,'NIGHT_PICK',{targets:[m.id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
 assert.equal(viewFor(s,cop.token).policeReport[0].round,1);assert.equal(viewFor(s,civilian.token).policeReport,undefined);
 s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');s=host(s,'CLOSE_VOTE');s=host(s,'NEXT');
 assert.equal(viewFor(s,cop.token).policeReport[0].round,1);
 for(let i=0;i<2;i++)s=host(s,'FINALIZE_NIGHT',{method:'skip'});
 s=act(s,cop.token,'NIGHT_PICK',{targets:[civilian.id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
 assert.deepEqual(viewFor(s,cop.token).policeReport.map(r=>r.round),[1,2]);
 assert.equal(viewFor(s,civilian.token).policeReport,undefined);
 assert.deepEqual(viewFor(s,HOST).policeReport.map(r=>r.round),[1,2]);
});

test('roles of dead players remain hidden from guests but available to host',()=>{
 let s=setup();const victim=s.players.find(p=>p.role==='CIVILIAN'),killer=s.players.find(p=>p.role==='MAFIA');
 s=act(s,killer.token,'NIGHT_PICK',{targets:[victim.id]});s=host(s,'FINALIZE_NIGHT',{method:'consensus'});
 s=host(s,'FINALIZE_NIGHT',{method:'skip'});s=host(s,'FINALIZE_NIGHT',{method:'skip'});
 s=host(s,'ANNOUNCE');s=host(s,'START_DISCUSSION');s=host(s,'END_DISCUSSION');s=host(s,'CLOSE_VOTE');s=host(s,'NEXT');
 assert.equal(viewFor(s,s.players.find(p=>p.id!==victim.id).token).roster.find(p=>p.id===victim.id).role,undefined);
 assert.equal(viewFor(s,HOST).roster.find(p=>p.id===victim.id).role,'CIVILIAN');
});

test('room permits more than 40 WebSocket connections during reconnect churn',async()=>{
 const map=new Map(),sockets=Array.from({length:40},()=>({}));
 const storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),setAlarm:async()=>{},deleteAlarm:async()=>{}};
 const ctx={storage,getWebSockets:()=>sockets,acceptWebSocket:socket=>sockets.push(socket)};
 const room=new MafiaRoom(ctx,{}),s=createGame({roomCode:'ABC234',hostToken:'a'.repeat(64)});
 await room.save(s);
 const req=new Request('https://room.internal/ws',{headers:{upgrade:'websocket','sec-websocket-protocol':'mafia, t-'+s.hostToken}});
 const response=await room.fetch(req);
 assert.notEqual(response.status,429);
});

test('host Wake Lock is requested, released at game end; stale client snapshots rejected',async()=>{
 const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 let requested=0,released=0;
 const app={innerHTML:'',addEventListener(){}};
 const doc={visibilityState:'visible',getElementById:id=>id==='app'?app:id==='connection'?{textContent:'',className:''}:{classList:{add(){},remove(){}},textContent:''},addEventListener(){},querySelectorAll(){return []}};
 const sandbox={document:doc,window:{},navigator:{wakeLock:{request:async()=>{requested++;return {release:async()=>{released++;},addEventListener(){}};}}},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},location:{origin:'https://example.test',pathname:'/',host:'example.test',protocol:'https:',hash:''},URLSearchParams,history:{replaceState(){}},setTimeout(){},clearTimeout(){},setInterval(){},console};
 vm.runInNewContext(js+';globalThis.feed=s=>{session={code:s.code,token:"test"};putState(s);};globalThis.phase=()=>state.phase;',sandbox);
 const s=viewFor(setup(),HOST);sandbox.feed(s);await new Promise(r=>setImmediate(r));assert.equal(requested,1);
 sandbox.feed({...s,phase:'GAME_OVER',version:s.version+1});await new Promise(r=>setImmediate(r));assert.equal(released,1);
 sandbox.feed({...s,phase:'DEAL',version:s.version+3});sandbox.feed({...s,phase:'LOBBY',version:s.version+2});assert.equal(sandbox.phase(),'DEAL');
});

test('rate limiter permits same-WiFi join bursts and throttles excessive requests',()=>{
 const room=new MafiaRoom({storage:{},getWebSockets:()=>[]},{}),req=new Request('https://room.internal/join',{headers:{'CF-Connecting-IP':'192.0.2.1'}});
 for(let n=0;n<120;n++)assert.equal(room.rateLimited(req,'join'),false);
 assert.equal(room.rateLimited(req,'join'),true);
 assert.equal(room.rateLimited(req,'state'),false);
});
