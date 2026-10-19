import { createGame, dispatch, viewFor } from '../src/engine.js';

const HEADERS = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const PHASE_ROLE = {NIGHT_MAFIA:'MAFIA',NIGHT_DOCTOR:'DOCTOR',NIGHT_POLICE:'POLICE'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEADERS});
const failure=(msg,status)=>json({error:msg},status);
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomCode=()=>Array.from(crypto.getRandomValues(new Uint8Array(6)),n=>alphabet[n%alphabet.length]).join('');
const bearer=request=>{const header=request.headers.get('authorization')||'';return /^Bearer\s+\S+$/i.test(header)?header.replace(/^Bearer\s+/i,''):null;};
const allowed=(state,credential)=>Boolean(credential)&&(state?.hostToken===credential||state?.players.some(p=>p.token===credential));
export function websocketIdentity(state,offered=''){
  const protocols=offered.split(',').map(s=>s.trim());
  if(!protocols.includes('mafia'))return null;
  const raw=protocols.find(p=>/^t-[a-f0-9]{64}$/.test(p));
  if(!raw||!allowed(state,raw.slice(2)))return null;
  const token=raw.slice(2);
  return {id:state.hostToken===token?'HOST':state.players.find(p=>p.token===token).id,token};
}
const enforceJson=async request=>{const raw=await request.text();if(raw.length>8192)throw new Error('Request is too large');try{return JSON.parse(raw||'{}');}catch{throw new Error('Invalid JSON');}};

export class MafiaRoom {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.serialQueue=Promise.resolve();this.rateBuckets=new Map();}
  rateLimited(request,route){
    if(!['join','action'].includes(route))return false;
    const ip=request.headers.get('CF-Connecting-IP')||'unknown';
    const now=Date.now(),prior=this.rateBuckets.get(ip);
    const bucket=!prior||now-prior.started>=10000?{started:now,count:0}:prior;
    bucket.count++;this.rateBuckets.set(ip,bucket);
    if(this.rateBuckets.size>2000)for(const [key,b] of this.rateBuckets)if(now-b.started>=10000)this.rateBuckets.delete(key);
    // 120 requests / 10 s permits 30 people sharing a Wi-Fi IP.
    return bucket.count>120;
  }
  serialize(work){const next=this.serialQueue.then(work);this.serialQueue=next.catch(()=>{});return next;}
  async load(){return await this.ctx.storage.get('state');}
  async save(state){await this.ctx.storage.put('state',state);await this.schedule(state);}
  async schedule(state){if(state.deadline){await this.ctx.storage.setAlarm(state.deadline);}else{await this.ctx.storage.deleteAlarm();}}
  async alarm(){return this.serialize(async()=>{const state=await this.load();if(state&&['DISCUSS','DISCUSS_2','VOTE','VOTE_2'].includes(state.phase)&&state.deadline&&Date.now()>=state.deadline){
    const type=['VOTE','VOTE_2'].includes(state.phase)?'CLOSE_VOTE':'END_DISCUSSION';
     const updated=dispatch(state,state.hostToken,{type,expectedVersion:state.version},Date.now());
    await this.save(updated);await this.push(updated);
  }});}
  async push(state){for(const socket of this.ctx.getWebSockets()){
    const principal=socket.deserializeAttachment();if(!principal?.id)continue;
    const credential=principal.id==='HOST'?state.hostToken:state.players.find(p=>p.id===principal.id)?.token;
    if(!credential){try{socket.close(1008,'Session expired');}catch{}continue;}
    try{socket.send(JSON.stringify({type:'STATE',state:viewFor(state,credential)}));}catch{}
  }}
  async webSocketMessage(_socket,_message){/* All WebSocket identities are authenticated at handshake. Clients receive server-pushed snapshots only. */}
  autoSkip(state){while(PHASE_ROLE[state.phase]&&!state.players.some(p=>p.alive&&p.role===PHASE_ROLE[state.phase])){state=dispatch(state,state.hostToken,{type:'FINALIZE_NIGHT',method:'skip',expectedVersion:state.version});}return state;}
  async fetch(request){return this.serialize(async()=>{const url=new URL(request.url),route=url.pathname.split('/').filter(Boolean).at(-1);
    try{
      if(route==='init'&&request.method==='POST'){
        const existing=await this.load();if(existing)return failure('Room code unavailable',409);
        const input=await enforceJson(request);
        const state=createGame({roomCode:input.code,hostToken:token()});
        await this.save(state);
        return json({code:state.code,token:state.hostToken,state:viewFor(state,state.hostToken)},201);
      }
      if(this.rateLimited(request,route))return failure('Too many requests. Try again shortly.',429);
      if(route==='ws'){
        if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return failure('WebSocket required',426);
        const state=await this.load();
        const principal=websocketIdentity(state,request.headers.get('sec-websocket-protocol')||'');
        if(!principal)return failure('WebSocket session invalid',401);
        const origin=request.headers.get('origin');
        if(origin&&origin!==new URL(request.url).origin)return failure('Origin not allowed',403);
        if(this.ctx.getWebSockets().length>=64)return failure('Room connection limit reached',429);
        const pair=new WebSocketPair(),[client,server]=Object.values(pair);
        this.ctx.acceptWebSocket(server);server.serializeAttachment({id:principal.id});
        server.send(JSON.stringify({type:'STATE',state:viewFor(state,principal.token)}));
        return new Response(null,{status:101,webSocket:client,headers:{'sec-websocket-protocol':'mafia'}});
      }
      if(route==='join'&&request.method==='POST'){
        const data=await enforceJson(request),guestToken=token();
        const state=await this.load();if(!state)return failure('Room does not exist',404);
        const next=dispatch(state,guestToken,{type:'JOIN',name:data.name});
        await this.save(next);await this.push(next);
        return json({code:next.code,token:guestToken,state:viewFor(next,guestToken)},201);
      }
      const credential=bearer(request),state=await this.load();
      if(!state)return failure('Room does not exist',404);
      if(!credential||!allowed(state,credential))return failure('Session invalid. Rejoin with your original device or recovery link.',401);
      if(route==='state'&&request.method==='GET')return json({state:viewFor(state,credential)});
      if(route==='action'&&request.method==='POST'){
        const command=await enforceJson(request);
        const next=this.autoSkip(dispatch(state,credential,command,Date.now()));
        await this.save(next);await this.push(next);
        return json({state:viewFor(next,credential)});
      }
      return failure('Not found',404);
    }catch(err){return failure(err?.message||'Unable to process action',400);}
  });}
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    // Static assets and API share a single origin: no permissive cross-origin access.
    if(url.pathname==='/api/rooms'&&request.method==='POST'){
      for(let attempt=0;attempt<5;attempt++){
        const code=roomCode(),id=env.MAFIA_ROOM.idFromName(code),stub=env.MAFIA_ROOM.get(id);
        const res=await stub.fetch(new Request(`https://room.internal/init`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})}));
        if(res.status!==409)return res;
      }
      return failure('Unable to allocate a room right now',503);
    }
    const match=url.pathname.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/(join|action|state|ws)$/);
    if(match){const stub=env.MAFIA_ROOM.get(env.MAFIA_ROOM.idFromName(match[1]));return stub.fetch(request);}
    if(url.pathname.startsWith('/api/'))return failure('Not found',404);
    const res=await env.ASSETS.fetch(request);
    const headers=new Headers(res.headers);
    headers.set('x-content-type-options','nosniff');
    headers.set('referrer-policy','no-referrer');
    headers.set('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    return new Response(res.body,{status:res.status,headers});
  }
};
