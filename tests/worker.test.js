import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {MafiaRoom} from '../worker/index.js';

function harness(){
  const rooms=new Map();
  function getRoom(code){
    if(!rooms.has(code)){
      const data=new Map();const sockets=[];
      const storage={
        get:async key=>data.get(key),put:async(k,v)=>{data.set(k,v);},
        setAlarm:async t=>data.set('__alarm',t),deleteAlarm:async()=>data.delete('__alarm')
      };
      const ctx={storage,getWebSockets:()=>sockets,acceptWebSocket:s=>sockets.push(s)};
      rooms.set(code,{data,ctx,room:new MafiaRoom(ctx,{})});
    }
    return rooms.get(code);
  }
  const env={MAFIA_ROOM:{idFromName:code=>code,get:code=>({fetch:request=>getRoom(code).room.fetch(request)})},ASSETS:{fetch:()=>Promise.resolve(new Response('ok'))}};
  async function call(url,method='GET',body,token){
    const headers={};if(body!==undefined)headers['content-type']='application/json';if(token)headers.authorization=`Bearer ${token}`;
    const response=await worker.fetch(new Request(`https://example.test${url}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),env);
    return {status:response.status,data:await response.json()};
  }
  return {rooms,env,getRoom,call};
}

test('one-host room creation and authenticated guest admission',async()=>{
 const {call}=harness();const init=await call('/api/rooms','POST',{});
 assert.equal(init.status,201);assert.match(init.data.code,/^[A-HJ-NP-Z2-9]{6}$/);
 const {code,token}=init.data;
 const join=await call(`/api/rooms/${code}/join`,'POST',{name:'Alice'});
 assert.equal(join.status,201);assert.equal(join.data.state.kind,'PLAYER');
 assert.equal(join.data.state.roster.length,1);
 const unauthorized=await call(`/api/rooms/${code}/state`);assert.equal(unauthorized.status,401);
 const host=await call(`/api/rooms/${code}/state`,'GET',undefined,token);
 assert.equal(host.data.state.kind,'HOST');assert.equal(host.data.state.hostCount,1);
 const forged=await call(`/api/rooms/${code}/action`,'POST',{type:'LOCK',expectedVersion:2},join.data.token);
 assert.equal(forged.status,400);
 const pin=await call(`/api/rooms/${code}/action`,'POST',{type:'COHOST_JOIN',pin:'0000'},join.data.token);
 assert.equal(pin.status,400);
});

test('host action requires current state version and player views never expose votes',async()=>{
 const {call}=harness(),init=(await call('/api/rooms','POST',{})).data;
 const players=[];for(let i=0;i<7;i++) players.push((await call(`/api/rooms/${init.code}/join`,'POST',{name:`Guest ${i+1}`})).data);
 const url=`/api/rooms/${init.code}/action`;
 const host=async(type,extra={})=>{
   const latest=(await call(`/api/rooms/${init.code}/state`,'GET',undefined,init.token)).data.state;
   return call(url,'POST',{type,expectedVersion:latest.version,...extra},init.token);
 };
 let result=await host('LOCK');assert.equal(result.data.state.phase,'CONFIG');
 result=await host('CONFIGURE',{config:{mafia:2,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:180}});
 result=await host('DEAL');
 const roles=result.data.state.roster.map(p=>p.role);assert.equal(roles.filter(r=>r==='MAFIA').length,2);
 const playerState=(await call(`/api/rooms/${init.code}/state`,'GET',undefined,players[0].token)).data.state;
 assert.ok(playerState.roster.every(p=>!Object.hasOwn(p,'role')));
 assert.ok(!JSON.stringify(playerState).includes(init.token));
 const oldVersion=result.data.state.version;
 result=await host('NEXT');assert.equal(result.data.state.phase,'NIGHT_MAFIA');
 const stale=await call(url,'POST',{type:'NEXT',expectedVersion:oldVersion},init.token);
 assert.equal(stale.status,400);assert.match(stale.data.error,/stale/i);
 for(let i=0;i<3;i++)await host('FINALIZE_NIGHT',{method:'skip'});
 await host('ANNOUNCE');await host('START_DISCUSSION');await host('END_DISCUSSION');
 result=await call(url,'POST',{type:'BALLOT',targetId:'p2'},players[0].token);assert.equal(result.status,200);
 const v=(await call(`/api/rooms/${init.code}/state`,'GET',undefined,players[2].token)).data.state;
 assert.equal(v.ballots,undefined);assert.equal(v.myVote,undefined);
 const hv=(await call(`/api/rooms/${init.code}/state`,'GET',undefined,init.token)).data.state;
 assert.equal(hv.ballots.p1,'p2');
});

test('Durable Object storage survives room object reconstruction',async()=>{
 const {getRoom,call,env}=harness(),init=(await call('/api/rooms','POST',{})).data;
 const slot=getRoom(init.code);slot.room=new MafiaRoom(slot.ctx,env);
 const state=(await call(`/api/rooms/${init.code}/state`,'GET',undefined,init.token)).data.state;
 assert.equal(state.code,init.code);assert.equal(state.kind,'HOST');
});

test('natural expiry advances discussion exactly once even after duplicate alarm',async()=>{
 const {call,getRoom}=harness(),init=(await call('/api/rooms','POST',{})).data;
 let s=(await call(`/api/rooms/${init.code}/state`,'GET',undefined,init.token)).data.state;
 for(let i=0;i<7;i++)await call(`/api/rooms/${init.code}/join`,'POST',{name:`P${i}`});
 const host=async(type,extra={})=>{s=(await call(`/api/rooms/${init.code}/state`,'GET',undefined,init.token)).data.state;return call(`/api/rooms/${init.code}/action`,'POST',{type,expectedVersion:s.version,...extra},init.token);};
 await host('LOCK');await host('CONFIGURE',{config:{mafia:2,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1,discussionSeconds:60}});
 await host('DEAL');await host('NEXT');for(let i=0;i<3;i++)await host('FINALIZE_NIGHT',{method:'skip'});
 await host('ANNOUNCE');await host('START_DISCUSSION');
 const room=getRoom(init.code),raw=await room.room.load();raw.deadline=Date.now()-1;await room.room.save(raw);
 await room.room.alarm();assert.equal((await room.room.load()).phase,'VOTE');
 await room.room.alarm();assert.equal((await room.room.load()).phase,'VOTE');
});


test('simultaneous joining of 30 players keeps all unique seats',async()=>{
  const {call}=harness(),init=(await call('/api/rooms','POST',{})).data;
  const joined=await Promise.all(Array.from({length:30},(_,i)=>call(`/api/rooms/${init.code}/join`,'POST',{name:`Guest ${i+1}`})));
  assert.ok(joined.every(r=>r.status===201),'All thirty guest joins must succeed');
  const state=(await call(`/api/rooms/${init.code}/state`,'GET',undefined,init.token)).data.state;
  assert.equal(state.roster.length,30);
  assert.equal(new Set(state.roster.map(p=>p.id)).size,30);
  assert.equal(new Set(state.roster.map(p=>p.name)).size,30);
  const overflow=await call(`/api/rooms/${init.code}/join`,'POST',{name:'Guest 31'});
  assert.equal(overflow.status,400);
});

test('WebSocket handshake rejects unauthenticated and cross-session credentials',async()=>{
  const {call,getRoom}=harness();
  const init=(await call('/api/rooms','POST',{})).data;
  const player=(await call(`/api/rooms/${init.code}/join`,'POST',{name:'Guest'})).data;
  const state=await getRoom(init.code).room.load();
  const {websocketIdentity}=await import('../worker/index.js');
  assert.equal(websocketIdentity(state,'mafia'),null);
  assert.equal(websocketIdentity(state,'mafia, t-invalid'),null);
  assert.equal(websocketIdentity(state,`other, t-${init.token}`),null);
  assert.deepEqual(websocketIdentity(state,`mafia, t-${init.token}`),{id:'HOST',token:init.token});
  assert.deepEqual(websocketIdentity(state,`mafia, t-${player.token}`),{id:'p1',token:player.token});
});

test('two simultaneous host transitions cannot advance the phase twice',async()=>{
  const {call}=harness(),init=(await call('/api/rooms','POST',{})).data;
  await Promise.all(Array.from({length:7},(_,i)=>call(`/api/rooms/${init.code}/join`,'POST',{name:`Guest ${i+1}`})));
  const room=`/api/rooms/${init.code}`;
  const state=(await call(`${room}/state`,'GET',undefined,init.token)).data.state;
  const command={type:'LOCK',expectedVersion:state.version};
  const responses=await Promise.all([
    call(`${room}/action`,'POST',command,init.token),
    call(`${room}/action`,'POST',command,init.token)
  ]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
  assert.equal((await call(`${room}/state`,'GET',undefined,init.token)).data.state.phase,'CONFIG');
});

test('WebSocket room broadcast sends player-specific redacted snapshots',async()=>{
  const {call,getRoom}=harness(),init=(await call('/api/rooms','POST',{})).data;
  const player=(await call(`/api/rooms/${init.code}/join`,'POST',{name:'Guest'})).data;
  const room=getRoom(init.code),sent=[];
  room.ctx.acceptWebSocket({deserializeAttachment:()=>({id:'p1'}),send:raw=>sent.push(JSON.parse(raw))});
  await room.room.push(await room.room.load());
  assert.equal(sent.length,1);
  assert.equal(sent[0].state.kind,'PLAYER');
  assert.equal(sent[0].state.roster.length,1);
  assert.equal(sent[0].state.roster[0].role,undefined);
  assert.equal(JSON.stringify(sent[0]).includes(init.token),false);
  assert.equal(JSON.stringify(sent[0]).includes(player.token),false);
});

test('21-player night with K2 S2 C2 resolves saved kills and private police verdicts',async()=>{
  const {call}=harness(),init=(await call('/api/rooms','POST',{})).data;
  const guests=[];
  for(let i=0;i<21;i++)guests.push((await call(`/api/rooms/${init.code}/join`,'POST',{name:`Guest ${i+1}`})).data);
  const base=`/api/rooms/${init.code}`;
  const host=async(type,extra={})=>{
    const s=(await call(`${base}/state`,'GET',undefined,init.token)).data.state;
    const r=await call(`${base}/action`,'POST',{type,expectedVersion:s.version,...extra},init.token);
    assert.equal(r.status,200,`${type} failed: ${r.data.error||''}`);
    return r.data.state;
  };
  await host('LOCK');
  await host('CONFIGURE',{config:{mafia:5,police:2,doctors:2,kills:2,saves:2,checks:2,boots:2,discussionSeconds:180}});
  let hv=await host('DEAL');assert.equal(hv.roster.filter(p=>p.role==='MAFIA').length,5);
  await host('NEXT');
  const civilians=hv.roster.filter(p=>p.role==='CIVILIAN'),mafia=hv.roster.filter(p=>p.role==='MAFIA'),doctors=hv.roster.filter(p=>p.role==='DOCTOR'),police=hv.roster.filter(p=>p.role==='POLICE');
  const tokenFor=id=>guests[Number(id.slice(1))-1].token;
  let r=await call(`${base}/action`,'POST',{type:'NIGHT_PICK',targets:[civilians[0].id,civilians[1].id]},tokenFor(mafia[0].id));assert.equal(r.status,200);
  await host('FINALIZE_NIGHT',{method:'consensus'});
  r=await call(`${base}/action`,'POST',{type:'NIGHT_PICK',targets:[civilians[0].id,doctors[0].id]},tokenFor(doctors[0].id));assert.equal(r.status,200);
  await host('FINALIZE_NIGHT',{method:'consensus'});
  r=await call(`${base}/action`,'POST',{type:'NIGHT_PICK',targets:[mafia[0].id,mafia[1].id]},tokenFor(police[0].id));assert.equal(r.status,200);
  await host('FINALIZE_NIGHT',{method:'consensus'});
  hv=(await call(`${base}/state`,'GET',undefined,init.token)).data.state;assert.equal(hv.phase,'MORNING');assert.deepEqual(hv.pendingDeaths,[civilians[1].id]);
  const copView=(await call(`${base}/state`,'GET',undefined,tokenFor(police[0].id))).data.state;
  assert.equal(copView.policeReport.length,2);assert.ok(copView.policeReport.every(x=>x.isMafia));
  assert.deepEqual(hv.policeReport,mafia.slice(0,2).map(p=>({round:1,targetId:p.id,name:p.name,isMafia:true})));
  const nonCop=(await call(`${base}/state`,'GET',undefined,tokenFor(civilians[0].id))).data.state;
  assert.equal(nonCop.policeReport,undefined);
  await host('ANNOUNCE');hv=await host('START_DISCUSSION');assert.equal(hv.phase,'DISCUSS');
  hv=await host('END_DISCUSSION');assert.equal(hv.phase,'VOTE');
  const living=hv.roster.filter(p=>p.alive);
  for(const voter of living){
    const targetId=voter.id===mafia[0].id?mafia[1].id:mafia[0].id;
    const ballot=await call(`${base}/action`,'POST',{type:'BALLOT',targetId},tokenFor(voter.id));
    assert.equal(ballot.status,200);
  }
  hv=await host('CLOSE_VOTE');assert.ok(['RESULTS','DISCUSS_2','GAME_OVER'].includes(hv.phase));
});
