/** Mafia Night v2.0 — dependency-free authoritative rules engine.
 * Never ship the raw state to a player. Use viewFor(state, credential).
 * The Cloudflare adapter, when implemented, must authenticate & serialize commands.
 */
const ROLES = Object.freeze({ NIGHT_MAFIA:'MAFIA', NIGHT_DOCTOR:'DOCTOR', NIGHT_POLICE:'POLICE' });
const NIGHT_ORDER = ['NIGHT_MAFIA','NIGHT_DOCTOR','NIGHT_POLICE'];
const ASSERT = (ok, why) => { if (!ok) throw new Error(why); };
const isIntBetween=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
const publicPlayer=p=>({id:p.id,name:p.name,alive:p.alive});
const normalize=name=>String(name??'').trim().replace(/\s+/g,' ');
const rngDefault=()=>{
  const a=new Uint32Array(1);crypto.getRandomValues(a);
  return a[0] / 4294967296;
};

export function createGame({roomCode,hostToken}) {
  ASSERT(/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode),'Invalid six-character room code');
  ASSERT(typeof hostToken==='string'&&hostToken.length>0,'Missing primary host credential');
  return {
    code:roomCode, version:0, phase:'LOBBY', hostToken, players:[], nextPlayerId:1, config:null, round:0,
    night:null, ballots:{}, runoff:null, deadline:null, policeHistory:[], publicHistory:[], hostHistory:[], publicReveals:[],
    announcement:null, announced:false, lastEliminations:[], resultTallies:{}, winner:null,
  };
}

export function validateConfig(config, playerCount) {
  ASSERT(config && typeof config==='object','Missing role configuration');
  for (const [key,min,max] of [
    ['mafia',1,30],['police',0,3],['doctors',0,3],
    ['kills',1,3],['saves',1,3],['checks',1,3],['boots',1,2],
  ]) ASSERT(isIntBetween(config[key],min,max),`Invalid ${key} count`);
  ASSERT([60,120,180,300].includes(config.discussionSeconds),'Invalid discussion timer');
  ASSERT(config.mafia < playerCount/2,'Mafia must be less than half the players');
  ASSERT(config.mafia+config.police+config.doctors<=playerCount,'Special roles exceed players');
  ASSERT(config.kills<=playerCount-config.mafia,'Not enough non-mafia kill targets');
  if(config.doctors>0) ASSERT(config.saves<=playerCount,'Not enough doctor save targets');
  if(config.police>0) ASSERT(config.checks<=playerCount-1,'Not enough police check targets');
  return {...config};
}

export function resolvePlurality(ballots, eligibleIds, count) {
  const tally=Object.fromEntries(eligibleIds.map(id=>[id,0]));
  for(const pick of Object.values(ballots)) if (Object.hasOwn(tally,pick)) tally[pick]++;
  const ranked=Object.entries(tally).filter(([,v])=>v>0)
    .sort((a,b)=>b[1]-a[1] || eligibleIds.indexOf(a[0])-eligibleIds.indexOf(b[0]));
  const cutoff=ranked[count-1]?.[1];
  if(cutoff!=null && ranked.length>count && ranked[count][1]===cutoff) {
    const winners=ranked.filter(([,v])=>v>cutoff).map(([id])=>id);
    const tied=ranked.filter(([,v])=>v===cutoff).map(([id])=>id);
    return {winners,tied,remaining:count-winners.length,tally};
  }
  return {winners:ranked.slice(0,count).map(([id])=>id),tied:[],remaining:0,tally};
}

const authenticated=(s,token)=>({
  host:s.hostToken===token,
  player:s.players.find(p=>p.token===token),
});
const member=(s,id)=>s.players.find(p=>p.id===id);
const living=s=>s.players.filter(p=>p.alive);
const selectedPicks=(s,phase)=>Object.values(s.night?.picks?.[phase]||{});
const countsFor=(s,phase)=>{
  const c={}; for(const targets of selectedPicks(s,phase))for(const id of targets)c[id]=(c[id]||0)+1;
  return c;
};
const consensusFor=(s,phase)=>{
  const votes=selectedPicks(s,phase);if(votes.length===0)return [];
  return votes[0].filter(id=>votes.every(selection=>selection.includes(id)));
};
const nextNight=s=>{
  s.round++;s.phase='NIGHT_MAFIA';s.ballots={};s.runoff=null;
  s.night={picks:{NIGHT_MAFIA:{},NIGHT_DOCTOR:{},NIGHT_POLICE:{}},kills:[],saves:[],checks:[],deaths:[]};
  s.announced=false;s.announcement=null;s.lastEliminations=[];s.resultTallies={};s.deadline=null;
};
const decideWinner=s=>{
  const alive=living(s);const m=alive.filter(p=>p.role==='MAFIA').length;
  if(m===0) return 'TOWN';
  if(m>=alive.length-m) return 'MAFIA';
  return null;
};
const eliminate=(s,ids)=>{
  const eliminated=[];
  for(const id of ids){const p=member(s,id);if(p?.alive){p.alive=false;eliminated.push(id);}}
  s.lastEliminations=eliminated;
  const winner=eliminated.length ? decideWinner(s):null;
  if(winner){s.winner=winner;s.phase='GAME_OVER';s.deadline=null;}
  return eliminated;
};
const advanceNight=s=>{
  const index=NIGHT_ORDER.indexOf(s.phase);
  s.phase = index===2?'MORNING':NIGHT_ORDER[index+1];
  if(s.phase==='MORNING'){
    s.night.deaths=s.night.kills.filter(id=>!s.night.saves.includes(id));
  }
};
const finalizeMajority=(counts, n, tiebreak=[])=>{
  const unique=Object.entries(counts).filter(([,count])=>count>0).sort((a,b)=>b[1]-a[1]);
  ASSERT(unique.length>=n,'Not enough proposed targets; choose Skip or wait for votes');
  const out=[];let i=0;
  while(out.length<n){
    const total=unique[i][1],group=[];
    while(i<unique.length&&unique[i][1]===total){group.push(unique[i][0]);i++;}
    const seats=n-out.length;
    if(group.length<=seats){out.push(...group);continue;}
    const chosen=tiebreak.filter(x=>group.includes(x));
    ASSERT(chosen.length===seats&&new Set(chosen).size===seats,'Host must break the most-voted cutoff tie');
    out.push(...chosen);
  }
  return out;
};
const ensureHost=(host)=>ASSERT(host,'Only an authorized host may do this');
const ensurePhase=(s,phase)=>ASSERT(s.phase===phase,`Action not allowed in ${s.phase} phase`);

/** Immutable transition. `rng` is injected for deterministic tests; live adapter uses crypto. */
export function dispatch(state,actorToken,command,now=Date.now(),rng=rngDefault) {
  ASSERT(typeof command?.type==='string','Missing command type');
  const s=structuredClone(state);
  const {host,player}=authenticated(s,actorToken);
  const type=command.type;
  const hostAction=['LOCK','REMOVE','CONFIGURE','DEAL','NEXT','FINALIZE_NIGHT',
    'ANNOUNCE','START_DISCUSSION','END_DISCUSSION','CLOSE_VOTE','PLAY_AGAIN','END_ROOM'].includes(type);
  if(hostAction){
    ensureHost(host);
    ASSERT(command.expectedVersion===s.version,'Stale host action; refresh room state');
  }
  switch(type){
    case 'JOIN': {
      ASSERT(s.phase==='LOBBY','Lobby locked; this game already started');
      ASSERT(!host&&!player,'Credential already belongs to a room member');
      ASSERT(s.players.length<30,'Room is full');
      const raw=normalize(command.name);
      ASSERT(raw.length>=2&&raw.length<=20,'Name must be 2–20 characters');
      const used=new Set(s.players.map(p=>p.name.toLocaleLowerCase()));
      let name=raw,number=2;
      while(used.has(name.toLocaleLowerCase())) name=`${raw.slice(0,Math.max(1,20-String(number).length-1))} ${number++}`;
      s.players.push({id:`p${s.nextPlayerId++}`,token:actorToken,name,alive:true,role:null});
      break;
    }
    case 'REMOVE': {
      ensurePhase(s,'LOBBY');
      const index=s.players.findIndex(p=>p.id===command.playerId);
      ASSERT(index!==-1,'No such player');s.players.splice(index,1);break;
    }
    case 'LOCK': {
      ensurePhase(s,'LOBBY');ASSERT(s.players.length>=7,'Need at least 7 players');
      s.phase='CONFIG';break;
    }
    case 'CONFIGURE': {
      ensurePhase(s,'CONFIG');s.config=validateConfig(command.config,s.players.length);break;
    }
    case 'DEAL': {
      ensurePhase(s,'CONFIG');ASSERT(s.config,'Configure roles before dealing');
      const roles=[...Array(s.config.mafia).fill('MAFIA'),
        ...Array(s.config.police).fill('POLICE'),...Array(s.config.doctors).fill('DOCTOR')];
      while(roles.length<s.players.length)roles.push('CIVILIAN');
      for(let i=roles.length-1;i>0;i--){
        const u=rng();ASSERT(Number.isFinite(u)&&u>=0&&u<1,'Invalid randomness source');
        const j=Math.floor(u*(i+1));[roles[i],roles[j]]=[roles[j],roles[i]];
      }
      s.players.forEach((p,i)=>{p.role=roles[i];p.alive=true;});
      s.phase='DEAL';break;
    }
    case 'NEXT': {
      ASSERT(['DEAL','RESULTS'].includes(s.phase),'No next-night transition here');
      nextNight(s);break;
    }
    case 'NIGHT_PICK': {
      ASSERT(player?.alive,'Only a living player may act');
      ASSERT(Object.hasOwn(ROLES,s.phase)&&player.role===ROLES[s.phase],'Not your night-action phase');
      const count=({NIGHT_MAFIA:s.config.kills,NIGHT_DOCTOR:s.config.saves,NIGHT_POLICE:s.config.checks})[s.phase];
      const targets=command.targets;
      ASSERT(Array.isArray(targets)&&targets.length===count&&new Set(targets).size===count,`Select exactly ${count} distinct targets`);
      ASSERT(targets.every(id=>member(s,id)?.alive),'All targets must be living players');
      if(s.phase==='NIGHT_MAFIA') ASSERT(targets.every(id=>member(s,id).role!=='MAFIA'),'Invalid target selection');
      if(s.phase==='NIGHT_POLICE') ASSERT(!targets.includes(player.id),'Police cannot investigate themselves');
      ASSERT(!Object.hasOwn(s.night.picks[s.phase],player.id),'Night choice is already locked');
      s.night.picks[s.phase][player.id]=targets;
      break;
    }
    case 'FINALIZE_NIGHT': {
      ASSERT(Object.hasOwn(ROLES,s.phase),'Not in a night-action phase');
      const phase=s.phase,n=({NIGHT_MAFIA:s.config.kills,NIGHT_DOCTOR:s.config.saves,NIGHT_POLICE:s.config.checks})[phase];
      const livingTeam=living(s).filter(p=>p.role===ROLES[phase]);
      let selected=[];
      if(command.method==='skip'||livingTeam.length===0){selected=[];}
      else if(command.method==='consensus'){
        selected=consensusFor(s,phase);
        ASSERT(selected.length===n,'The submitting group has not reached consensus');
      }else if(command.method==='majority') selected=finalizeMajority(countsFor(s,phase),n,command.tiebreak);
      else throw new Error('Choose consensus, majority, or skip');
      const key=({NIGHT_MAFIA:'kills',NIGHT_DOCTOR:'saves',NIGHT_POLICE:'checks'})[phase];
      s.night[key]=selected;
      if(phase==='NIGHT_POLICE')s.policeHistory=[...(s.policeHistory||[]),...selected.map(id=>({round:s.round,targetId:id,name:member(s,id).name,isMafia:member(s,id).role==='MAFIA',submittedBy:Object.keys(s.night.picks.NIGHT_POLICE)}))];
      advanceNight(s);break;
    }
    case 'ANNOUNCE': {
      ensurePhase(s,'MORNING');ASSERT(!s.announced,'Already announced');
      const names=s.night.deaths.map(id=>member(s,id)).filter(Boolean);
      s.announcement=names.length?`${names.map(p=>`${p.name} (${p.role})`).join(', ')} died last night.`:'No one died last night.';
      eliminate(s,s.night.deaths);
      s.announced=true;
      s.publicReveals=[...new Set([...(s.publicReveals||[]),...names.map(p=>p.id)])];
      // Persist only after the host has publicly announced this night's outcome.
      const killed=names.map(p=>`${p.name} (${p.role})`);
      const nightText=killed.length?`${killed.join(', ')} ${killed.length===1?'was':'were'} killed.`:'No one died.';
      s.hostHistory=[...(s.hostHistory||[]),{key:`night-${s.round}`,text:`Night ${s.round} — ${nightText}`}];
      const publicKilled=names.map(p=>p.name);
      const publicNightText=publicKilled.length?`${publicKilled.join(', ')} ${publicKilled.length===1?'was':'were'} killed.`:'No one died.';
      s.publicHistory=[...(s.publicHistory||[]),{key:`night-${s.round}`,text:`Night ${s.round} — ${publicNightText}`}];
      break;
    }
    case 'START_DISCUSSION': {
      ensurePhase(s,'MORNING');ASSERT(s.announced,'Announce morning before discussion');
      s.phase='DISCUSS';s.deadline=now+s.config.discussionSeconds*1000;break;
    }
    case 'END_DISCUSSION': {
      ASSERT(['DISCUSS','DISCUSS_2'].includes(s.phase),'Not discussing');
      s.phase=s.phase==='DISCUSS'?'VOTE':'VOTE_2';s.deadline=now+60000;break;
    }
    case 'BALLOT': {
      ASSERT(player?.alive,'Only living players can vote');
      ASSERT(['VOTE','VOTE_2'].includes(s.phase),'Voting is closed');
      ASSERT(!Object.hasOwn(s.ballots,player.id),'Vote is already locked');
      const targetId=command.targetId;
      const eligible=s.phase==='VOTE_2'?s.runoff.candidates:living(s).map(p=>p.id);
      ASSERT(targetId==='ABSTAIN'||(eligible.includes(targetId)&&targetId!==player.id),'Invalid vote target');
      s.ballots[player.id]=targetId;break;
    }
    case 'CLOSE_VOTE': {
      ASSERT(['VOTE','VOTE_2'].includes(s.phase),'Vote is not open');
      const aliveIds=living(s).map(p=>p.id);
      if(s.phase==='VOTE'){
        const decision=resolvePlurality(s.ballots,aliveIds,s.config.boots);s.resultTallies=decision.tally;
        if(decision.tied.length){
          s.runoff={locked:decision.winners,candidates:decision.tied,seats:decision.remaining};
          s.ballots={};s.phase='DISCUSS_2';s.deadline=now+60000;
        }else{
          eliminate(s,decision.winners);
          if(s.phase!=='GAME_OVER')s.phase='RESULTS';
        }
      }else{
        const decision=resolvePlurality(s.ballots,s.runoff.candidates,s.runoff.seats);s.resultTallies=decision.tally;
        // Any persistent tie (including all-abstain) is all-or-nothing.
        const winners=decision.tied.length||decision.winners.length<s.runoff.seats?[]:[...s.runoff.locked,...decision.winners];
        eliminate(s,winners);
        if(s.phase!=='GAME_OVER')s.phase='RESULTS';
      }
      if(s.phase!=='DISCUSS_2')s.deadline=null;
      if(s.phase==='RESULTS'||s.phase==='GAME_OVER')s.publicReveals=[...new Set([...(s.publicReveals||[]),...s.lastEliminations])];
      // A runoff is not a completed day vote; publish only the final result.
      if(['RESULTS','GAME_OVER'].includes(s.phase)){
        const ousted=s.lastEliminations.map(id=>member(s,id));
        const dayText=ousted.length?`${ousted.map(p=>`${p.name} (${p.role})`).join(', ')} ${ousted.length===1?'was':'were'} voted out.`:'No one was voted out.';
        s.hostHistory=[...(s.hostHistory||[]),{key:`day-${s.round}`,text:`Day ${s.round} — ${dayText}`}];
        const publicDayText=ousted.length?`${ousted.map(p=>p.name).join(', ')} ${ousted.length===1?'was':'were'} voted out.`:'No one was voted out.';
        s.publicHistory=[...(s.publicHistory||[]),{key:`day-${s.round}`,text:`Day ${s.round} — ${publicDayText}`}];
      }
      break;
    }
    case 'END_ROOM': {
      ASSERT(s.phase!=='ENDED','Room already ended');s.phase='ENDED';s.deadline=null;break;
    }
    case 'PLAY_AGAIN': {
      ASSERT(s.phase==='GAME_OVER','Play again requires a finished game-over session');s.players.forEach(p=>{p.alive=true;p.role=null;});
      s.phase='CONFIG';s.round=0;s.night=null;s.ballots={};s.runoff=null;s.deadline=null;
      s.announcement=null;s.announced=false;s.winner=null;s.lastEliminations=[];s.resultTallies={};s.policeHistory=[];s.publicHistory=[];s.hostHistory=[];s.publicReveals=[];break;
    }
    default:throw new Error('Unknown command');
  }
  s.version++;
  return s;
}

/** Credential-scoped snapshot. Never send raw state over the network. */
export function viewFor(state,token) {
  const {host,player}=authenticated(state,token);
  ASSERT(host||player,'Not an authorized room member');
  const basic={code:state.code,version:state.version,phase:state.phase,round:state.round,
    config:state.config?{...state.config}:null,deadline:state.deadline,
    announced:state.announced,announcement:state.announced?state.announcement:null,
    winner:state.winner};
  const isHost=Boolean(host);
  const roster=state.players.map(p=>{
    const entry=publicPlayer(p);
    if(isHost||state.phase==='GAME_OVER') entry.role=p.role;
    return entry;
  });
  if(isHost){
    const phase=state.phase;
    const history=(state.publicHistory||[]).map(event=>(state.hostHistory||[]).find(hostEvent=>hostEvent.key===event.key)||event);
    const night=NIGHT_ORDER.includes(phase)?{
      phase,counts:countsFor(state,phase),consensus:consensusFor(state,phase),
      submitted:selectedPicks(state,phase).length,
      active:living(state).filter(p=>p.role===ROLES[phase]).length,
      savedMatches:state.night.kills.filter(id=>(phase==='NIGHT_DOCTOR'?consensusFor(state,phase):state.night.saves).includes(id)),
      resolved:{kills:state.night.kills,saves:state.night.saves,checks:state.night.checks},
    }:null;
    return {...basic,kind:'HOST',roster,night,publicHistory:history.map(event=>({...event})),announcement:state.announced?state.announcement:null,
      hostCount:1,ballots:{...state.ballots},policeReport:(state.policeHistory||[]).map(({submittedBy,...report})=>report),
      runoff:state.runoff?{...state.runoff}:null,
      pendingDeaths:phase==='MORNING'&&!state.announced?[...state.night.deaths]:undefined,
      lastEliminations:[...state.lastEliminations],resultTallies:{...state.resultTallies}};
  }
  // Older persisted rooms may contain role annotations from the former
  // public-history format. Strip them at the per-view boundary as well.
  const publicHistory=(state.publicHistory||[]).map(event=>({
    ...event,text:String(event.text).replace(/ \((?:MAFIA|DOCTOR|POLICE|CIVILIAN)\)(?=,| was| were| died|$)/g,'')
  }));
  const announcement=state.announced
    ?(state.night?.deaths?.length
      ?state.night.deaths.map(id=>member(state,id)?.name).filter(Boolean).join(', ')+' died last night.'
      :'No one died last night.')
    :null;
  const currentPhase=state.phase;
  const canAct=player.alive&&ROLES[currentPhase]===player.role;
  const view={...basic,kind:'PLAYER',roster,publicHistory,announcement,self:{id:player.id,name:player.name,role:player.role,alive:player.alive},
    canAct,choiceLocked:canAct&&Object.hasOwn(state.night.picks[currentPhase],player.id),
    myVote:state.ballots[player.id]};
  if(player.role==='POLICE'){
    const reports=(state.policeHistory||[]).filter(report=>
      report.submittedBy?.includes(player.id)||(!report.submittedBy&&
      state.night?.picks.NIGHT_POLICE[player.id]&&report.round===state.round));
    if(reports.length)view.policeReport=reports.map(({submittedBy,...report})=>report);
  }
  if(state.phase==='VOTE_2')view.runoff={candidates:[...state.runoff.candidates]};
  if(state.phase==='RESULTS') {view.lastEliminations=[...state.lastEliminations];view.resultTallies={...state.resultTallies};}
  return view;
}
