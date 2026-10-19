'use strict';
const app=document.getElementById('app'),status=document.getElementById('connection'),toastBox=document.getElementById('toast');
const store='ad-arcade-mafia-session-v1';
const joinUrl=code=>`${location.origin}${location.pathname}#join=${code}`;
const storyPrefix='ad-arcade-mafia-public-story-v1-';
let storyEntries=[],storyKey='',storyExpanded=false,lastActionKey=null,wakeSentinel=null,wakeRequest=null;
function storyStorageKey(snapshot){return `${storyPrefix}${snapshot.code}-${snapshot.kind==='HOST'?'HOST':snapshot.self?.id||'PLAYER'}`;}
function recordPublicStory(snapshot){
 if(!session||!snapshot||snapshot.phase==='LOBBY')return;
 const key=storyStorageKey(snapshot);
 if(key!==storyKey){storyKey=key;try{storyEntries=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(storyEntries))storyEntries=[];}catch{storyEntries=[];}}
 // Server-persisted public events are authoritative: they survive reconnects,
 // cleared browser storage and identity recovery on another phone.
 if(Array.isArray(snapshot.publicHistory)){
  storyEntries=snapshot.publicHistory.map(event=>({key:event.key,text:event.text}));
  try{localStorage.setItem(key,JSON.stringify(storyEntries));}catch{}
  return;
 }
 // Legacy fallback for old server snapshots without the public history field.
 // Another game in the same room starts with a fresh story.
 if(snapshot.round===0&&snapshot.phase==='CONFIG'&&storyEntries.length)storyEntries=[];
 const round=snapshot.round;
 if(round>0&&snapshot.announced&&typeof snapshot.announcement==='string'){
  const ann=snapshot.announcement;
  const summary=ann==='No one died last night.'?'No one died.':ann.replace(/ died last night\.$/,' was killed.');
  const key=`night-${round}`;
  if(!storyEntries.some(x=>x.key===key))storyEntries.push({key,text:`Night ${round} — ${summary}`});
 }
 // RESULTS comes only after the vote. GAME_OVER may follow a night or a vote:
 // resultTallies proves a vote concluded, preventing a night death from becoming a Day entry.
 if(round>0&&(snapshot.phase==='RESULTS'||snapshot.phase==='GAME_OVER'&&Object.keys(snapshot.resultTallies||{}).length>0)){
  const ids=snapshot.lastEliminations||[];
  const readable=ids.map(id=>{
    const p=snapshot.roster?.find(x=>x.id===id);
    return p?`${p.name}${p.role?' ('+p.role+')':''}`:null;
  }).filter(Boolean);
  // Only record publicly revealed roles. If a snapshot is incomplete, omit the event.
  if(ids.length===readable.length){const key=`day-${round}`;
   if(!storyEntries.some(x=>x.key===key))storyEntries.push({key,text:`Day ${round} — ${readable.length?readable.join(', ')+(readable.length===1?' was':' were')+' voted out.':'No one was voted out.'}`});}
 }
 storyEntries.sort((a,b)=>Number(a.key.split('-')[1])-Number(b.key.split('-')[1])||(a.key.startsWith('night-')?-1:1));
 try{localStorage.setItem(key,JSON.stringify(storyEntries));}catch{}
}
function storyMarkup(){
 if(!state||['LOBBY','CONFIG'].includes(state.phase))return '';
 const rows=storyEntries.map(e=>`<li>${h(e.text)}</li>`).join('');
 return `<details class="story" ${storyExpanded?'open':''}><summary>Story so far</summary>${rows?`<ul>${rows}</ul>`:'<p class="note">The story begins after the first announcement.</p>'}</details>`;
}
function playerCanAct(s){return s?.kind==='PLAYER'&&s.self?.alive&&((s.phase.startsWith('NIGHT_')&&s.canAct&&!s.choiceLocked)||(['VOTE','VOTE_2'].includes(s.phase)&&!s.myVote));}
function vibrateOnTurn(s){const key=playerCanAct(s)?`${s.code}:${s.round}:${s.phase}:${s.self.id}`:null;
 if(key&&key!==lastActionKey){try{navigator.vibrate?.(85);}catch{}}
 lastActionKey=key;
}
function wantsWakeLock(){return !!(session&&['PLAYER','HOST'].includes(state?.kind)&&!returnHome&&!['LOBBY','GAME_OVER','ENDED'].includes(state.phase)&&document.visibilityState!=='hidden');}
function updateWakeLock(){
 if(!wantsWakeLock()){
  if(wakeSentinel){const held=wakeSentinel;wakeSentinel=null;Promise.resolve(held.release()).catch(()=>{});}
  return;
 }
 if(wakeSentinel||wakeRequest||typeof navigator==='undefined'||!navigator.wakeLock?.request)return;
 wakeRequest=Promise.resolve().then(()=>navigator.wakeLock.request('screen')).then(lock=>{
   wakeSentinel=lock;
   lock.addEventListener?.('release',()=>{if(wakeSentinel===lock)wakeSentinel=null;});
   if(!wantsWakeLock()){wakeSentinel=null;return lock.release();}
 }).catch(()=>{}).finally(()=>{wakeRequest=null;});
}
document.addEventListener?.('visibilitychange',updateWakeLock);

let session=JSON.parse(localStorage.getItem(store)||'null'),state=null,ws=null,selected=[],revealed=false,formConfig=null,returnHome=false,lastVersion=-1;
let lastConnectionErrorAt=0,lastReconnectAttemptAt=0,reconnectDelayMs=4000;
let rolePeekVisible=false,rolePeekTimeout=null;
function hideRolePeek(){if(rolePeekTimeout!==null)clearTimeout(rolePeekTimeout);rolePeekTimeout=null;rolePeekVisible=false;}
function showRolePeek(){
 if(!state?.self?.role)return;
 hideRolePeek();rolePeekVisible=true;render();
 rolePeekTimeout=setTimeout(()=>{rolePeekVisible=false;rolePeekTimeout=null;render();},1000);
}
function peekControl(){
 if(state?.kind!=='PLAYER'||!state.self?.role||['LOBBY','CONFIG','ENDED'].includes(state.phase))return '';
 return `<button class="role-peek ${rolePeekVisible?'is-revealed':''}" type="button" data-act="rolePeek" aria-label="Peek at your role briefly" title="Your role">${rolePeekVisible?h(state.self.role):'♠'}</button>`;
}
const h=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const name=id=>state?.roster?.find(p=>p.id===id)?.name||id;
const eliminatedName=id=>{const p=state?.roster?.find(x=>x.id===id);return p?`${h(p.name)}${p.role?' ('+h(p.role)+')':''}`:h(id);};
const getPhase=()=>state?.phase||'';
const roleIcons={MAFIA:'♠',POLICE:'⚖',DOCTOR:'✚',CIVILIAN:'♣'};
const phaseText={LOBBY:'The Gathering',CONFIG:'Set the Rules',DEAL:'The Cards Are Dealt',NIGHT_MAFIA:'Mafia, Awake',NIGHT_DOCTOR:'Doctors, Awake',NIGHT_POLICE:'Police, Awake',MORNING:'The Morning After',DISCUSS:'The Interrogation',VOTE:'The Verdict',DISCUSS_2:'One Final Argument',VOTE_2:'The Final Vote',RESULTS:'The Judgment',GAME_OVER:'The Final Reveal',ENDED:'The Party Has Ended'};
const alertMsg=(text)=>{toastBox.textContent=text;toastBox.classList.add('show');clearTimeout(alertMsg.timeout);alertMsg.timeout=setTimeout(()=>toastBox.classList.remove('show'),6000);};
const button=(label,act,kind='')=>`<button class="btn ${kind}" data-act="${act}">${h(label)}</button>`;
const field=(name,label,value,min=0,max=30)=>`<label class="formfield"><span>${h(label)}</span><input class="field" name="${name}" type="number" min="${min}" max="${max}" value="${h(value)}" required></label>`;
const rosterList=(showRole=false)=>`<div class="roster">${(state?.roster||[]).map(p=>`<div class="rosteritem ${p.alive?'':'out'}"><strong>${h(p.name)}</strong><span>${showRole&&p.role?h(p.role):p.alive?'ALIVE':'ELIMINATED'}</span></div>`).join('')}</div>`;
const panel=(title,body)=>`<section class="card"><h3>${title}</h3>${body}</section>`;
const phaseHeading=()=>`<div class="phase"><span class="phasebadge">ROUND ${state.round||'—'}</span><span class="eyecap">${state.kind==='HOST'?'HOST CONTROL':'PLAYER CARD'}</span></div><h2>${phaseText[getPhase()]||h(getPhase())}</h2>`;
const progress=(label,done,total)=>`<div class="countline"><span>${h(label)}</span><strong>${done} / ${total}</strong></div>`;
const zero=(n)=>String(n).padStart(2,'0');
const countdown=()=>{if(!state?.deadline)return '';const left=Math.max(0,Math.ceil((state.deadline-Date.now())/1000));return `${zero(Math.floor(left/60))}:${zero(left%60)}`;};
const saved=()=>{localStorage.setItem(store,JSON.stringify(session));};
async function request(path,{method='GET',body,authenticated=true}={}){
 const headers={'accept':'application/json'};
 if(body!==undefined)headers['content-type']='application/json';
 if(authenticated&&session?.token)headers.authorization=`Bearer ${session.token}`;
 let response;try{response=await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});}catch{throw Error('Connection lost. Check your internet and try again.');}
 const data=await response.json().catch(()=>({error:'Unexpected server response'}));if(!response.ok)throw Error(data.error||'Request failed');return data;
}
const endpoint=(action)=>`/api/rooms/${session.code}/${action}`;
async function command(type,values={}){const payload={type,...values};if(state?.kind==='HOST')payload.expectedVersion=state.version;
 try{const data=await request(endpoint('action'),{method:'POST',body:payload});putState(data.state);}catch(error){alertMsg(error.message);await refresh();}}
function setOnline(online){status.className='connection '+(online?'online':'offline');status.textContent=online?'● CONNECTED':'● RECONNECTING';}
function putState(snapshot){if(!snapshot)return;if(state?.code===snapshot.code&&snapshot.version<lastVersion)return;if(snapshot.version!==lastVersion){if(state?.phase!==snapshot.phase||snapshot.choiceLocked||snapshot.myVote)selected=[];if(state?.phase!=='DEAL'&&snapshot.phase==='DEAL')revealed=false;lastVersion=snapshot.version;}state=snapshot;recordPublicStory(snapshot);vibrateOnTurn(snapshot);updateWakeLock();render();}
async function refresh(){if(!session)return false;try{const data=await request(endpoint('state'));putState(data.state);setOnline(true);lastConnectionErrorAt=0;reconnectDelayMs=4000;return true;}catch(error){setOnline(false);if(Date.now()-lastConnectionErrorAt>=30000){alertMsg(error.message);lastConnectionErrorAt=Date.now();}reconnectDelayMs=Math.min(reconnectDelayMs*2,30000);return false;}}
function connect(){if(ws){ws.onclose=null;ws.close();}if(!session)return;
 try{ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}${endpoint('ws')}`,['mafia','t-'+session.token]);ws.onopen=()=>setOnline(true);ws.onmessage=e=>{try{const msg=JSON.parse(e.data);if(msg.type==='STATE')putState(msg.state);}catch{}};ws.onclose=()=>{setOnline(false);};ws.onerror=()=>setOnline(false);}catch{setOnline(false);}}
function remember(s){hideRolePeek();session={code:s.code,token:s.token};saved();state=s.state;lastVersion=-1;selected=[];revealed=false;returnHome=false;putState(s.state);connect();}
function home(){return `<div class="intro"><div class="crest">♠</div><div class="subtitle">A GAME OF TRUST AND BETRAYAL</div><h1>MAFIA<br><span class="gold">NIGHT</span></h1><p class="lede">Gather your friends. Hide your secrets. Survive the night. One host. Up to 30 players. Just your phones and your poker faces.</p></div><div class="twocol"><section class="card"><h3>Host a Game</h3><p class="note">Create your private party room and guide the night.</p>${button('CREATE ROOM','create','block')}</section><section class="card"><h3>Join the Table</h3><form id="join"><label class="formfield"><span>6-Character Room Code</span><input class="field" name="code" minlength="6" maxlength="6" required placeholder="ABC234" value="${h(new URLSearchParams(location.hash.slice(1)).get('join')||'')}"></label><label class="formfield"><span>Your Name</span><input class="field" name="name" maxlength="20" minlength="2" required placeholder="Enter your name"></label><button class="btn block" type="submit">JOIN PARTY →</button></form></section></div>`;}
function hostView(){const phase=getPhase();let content=phaseHeading();
 content+=`<div class="statgrid"><div class="stat"><b>${state.roster.length}</b><span>Players</span></div><div class="stat"><b>${state.roster.filter(p=>p.alive).length}</b><span>Alive</span></div><div class="stat"><b>${state.round}</b><span>Round</span></div></div>`;
 if(state.policeReport?.length)content+=panel('Police Investigations — Host Only',state.policeReport.map(r=>`<div class="countline"><span>Round ${r.round} · ${h(r.name)}</span><strong>${r.isMafia?'🔪 MAFIA':'✓ NOT MAFIA'}</strong></div>`).join(''));
 if(phase==='LOBBY'){
 const joinLink=`${location.origin}${location.pathname}#join=${state.code}`;
 content+=panel('YOUR PRIVATE ROOM',`<div class="roomcode">${state.code}</div><div class="join-qr">${window.MafiaQRCode?.render(joinUrl(state.code))||''}<p class="note">Scan to join the party</p></div><div class="center tiny muted">Players enter this code. Keep the host recovery link private.</div><div class="buttonrow">${button('COPY JOIN LINK','invite','secondary')}${button('COPY HOST RECOVERY LINK','recover','quiet')}</div>`);
 content+=panel(`Guest List · ${state.roster.length}/30`,`${rosterList()}${state.roster.length?`<p class="note">Tap below to remove a guest from the waiting lobby.</p><select id="removePlayer" class="field"><option value="">Choose guest</option>${state.roster.map(p=>`<option value="${p.id}">${h(p.name)}</option>`).join('')}</select><div class="buttonrow">${button('REMOVE SELECTED','remove','danger')}</div>`:''}`);
 content+=button(`LOCK LOBBY (${state.roster.length} / 7 MINIMUM)`,'lock','block');
 }
 if(phase==='CONFIG'){
 const preset=state.roster.length<=10?{mafia:2,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1}:state.roster.length<=15?{mafia:3,police:1,doctors:1,kills:1,saves:1,checks:1,boots:1}:state.roster.length<=22?{mafia:4,police:2,doctors:1,kills:2,saves:2,checks:2,boots:1}:{mafia:5,police:2,doctors:2,kills:2,saves:2,checks:2,boots:2};
 const c=formConfig||state.config||{...preset,discussionSeconds:180};
 content+=`<form class="card" id="config"><h3>Role Distribution</h3><p class="note">Choose how many powers enter the room. The rest are Civilians.</p><div class="twocol">${field('mafia','Mafia',c.mafia,1,14)}${field('police','Police',c.police,0,3)}${field('doctors','Doctors',c.doctors,0,3)}</div><div class="divider"></div><h3>Per-Round Rules</h3><div class="twocol">${field('kills','Mafia Kills',c.kills,1,3)}${field('saves','Doctor Saves',c.saves,1,3)}${field('checks','Police Checks',c.checks,1,3)}${field('boots','Vote Eliminations',c.boots,1,2)}</div><label class="formfield"><span>Discussion Timer</span><select class="field" name="discussionSeconds">${[60,120,180,300].map(n=>`<option value="${n}" ${c.discussionSeconds===n?'selected':''}>${n/60} minute${n>60?'s':''}</option>`).join('')}</select></label><button type="submit" class="btn block">SAVE RULES</button></form>`;
 content+=state.config?`${panel('Saved Configuration',`<p class="note">${state.config.mafia} Mafia · ${state.config.police} Police · ${state.config.doctors} Doctors · ${state.roster.length-state.config.mafia-state.config.police-state.config.doctors} Civilians</p>`)}${button('DEAL SECRET ROLES','deal','block')}`:`<p class="note">Save the rules before dealing roles.</p>`;
 }
 if(phase==='DEAL')content+=panel('Everyone, Check Your Phone',`<p class="script">“Keep your card to yourself. No talking. The night will begin when everyone is ready.”</p>`)+button('BEGIN THE FIRST NIGHT','next','block');
 if(phase.startsWith('NIGHT_')){
 const cfg={NIGHT_MAFIA:{label:'Mafia',count:state.config.kills},NIGHT_DOCTOR:{label:'Doctors',count:state.config.saves},NIGHT_POLICE:{label:'Police',count:state.config.checks}}[phase];
 const n=state.night||{counts:{},consensus:[],active:0,submitted:0};
 content+=panel('Read Aloud',`<p class="script">“Everyone, close your eyes. ${phase==='NIGHT_MAFIA'?'Mafia':phase==='NIGHT_DOCTOR'?'Doctors':'Police'}, open your eyes.”</p><p class="note">After finalizing this phase, tell the acting group to close their eyes.</p>`);
 content+=panel('Live Night Dashboard',`${progress('Living actors submitted',n.submitted,n.active)}<div class="countline"><span>Unanimous selections</span><strong>${n.consensus?.length||0} / ${cfg.count}</strong></div>${state.roster.filter(p=>p.alive).map(p=>`<div class="countline"><span>${h(p.name)} ${n.consensus?.includes(p.id)?'✓':''} ${n.savedMatches?.includes(p.id)?'🛟 SAVED':''}</span><strong>${n.counts?.[p.id]||0}</strong></div>`).join('')}<p class="note">Counts do not identify which actor selected each target.</p>`);
 const candidates=state.roster.filter(p=>p.alive&&n.counts?.[p.id]);
 content+=panel('Finalize This Phase',`<p class="note">Consensus accepts exactly ${cfg.count} unanimously selected names. Most-voted requires the host to resolve any ties at the cutoff. Select tied names below if necessary.</p><div class="targetgrid">${candidates.map(p=>`<button class="target ${selected.includes(p.id)?'selected':''}" data-target="${p.id}">${h(p.name)} (${n.counts[p.id]})</button>`).join('')}</div><div class="buttonrow">${button('FINALIZE CONSENSUS','consensus','secondary')}${button('MOST VOTED / BREAK TIE','majority')}${button('SKIP THIS PHASE','skip','quiet')}</div>`);
 }
 if(phase==='MORNING'){
 const names=(state.pendingDeaths||[]).map(id=>state.roster.find(p=>p.id===id)).filter(Boolean);
 if(!state.announced){content+=panel('Read the Morning Announcement',`<p class="script">${names.length?`“The town has lost ${names.map(p=>`${h(p.name)} (${h(p.role)})`).join(', ')} during the night.”`:'“The sun rises. Miraculously, everyone has survived the night.”'}</p><p class="note">Deaths remain private until you announce them.</p>`)+button('ANNOUNCE TO ALL PLAYERS','announce','block');}
 else{content+=panel('The Town Knows',`<p>${h(state.announcement)}</p>`)+button('START DISCUSSION','discuss','block');}
 }
 if(phase==='DISCUSS'||phase==='DISCUSS_2')content+=panel('Discussion in Progress',`<div class="timer" data-countdown>${countdown()}</div><p class="note center">All player clocks use the same server deadline. You can close early.</p>`)+button('END DISCUSSION EARLY','endDiscuss','block');
 if(phase==='VOTE'||phase==='VOTE_2'){
 content+=panel('Voting closes in',`<div class="timer vote-timer" data-countdown>${countdown()}</div>`);
 const tally={};Object.values(state.ballots||{}).forEach(id=>{tally[id]=(tally[id]||0)+1;});
 content+=panel('Secret Votes — Host Only',`${progress('Ballots submitted',Object.keys(state.ballots||{}).length,state.roster.filter(p=>p.alive).length)}${state.roster.filter(p=>p.alive).map(p=>`<div class="countline"><span>${h(p.name)}</span><span>${state.ballots?.[p.id]?h(name(state.ballots[p.id])):'Not yet voted'}</span></div>`).join('')}`);
 content+=panel('Running Tally',`${Object.entries(tally).map(([id,n])=>`<div class="countline"><span>${h(name(id))}</span><strong>${n}</strong></div>`).join('')||'<p class="muted">No votes yet.</p>'}`);
 content+=button(phase==='VOTE'?'CLOSE VOTE':'CLOSE FINAL VOTE','closeVote','block');
 }
 if(phase==='RESULTS')content+=panel('Public Results',`${(state.lastEliminations||[]).length?`<p class="script">${state.lastEliminations.map(eliminatedName).join(', ')} voted out.</p>`:'<p class="script">The town could not agree. No one was eliminated.</p>'}`)+button('CONTINUE TO NEXT NIGHT','next','block');
 if(phase==='GAME_OVER')content+=panel('The Winner',`<div class="intro"><div class="crest">${state.winner==='TOWN'?'⚖':'♠'}</div><h2>${state.winner==='TOWN'?'TOWN VICTORY':'MAFIA VICTORY'}</h2><p>All identities are revealed.</p></div>${rosterList(true)}`)+button('PLAY AGAIN — SAME PLAYERS','replay','block');
 if(phase==='ENDED')content+=panel('Party Concluded','<p>This room is closed. Create a new room for another game.</p>')+button('START A NEW PARTY','newRoom','block');
 else content+=`<div class="divider"></div>${button('END PARTY','endParty','danger')}`;
 return content;
}
function playerView(){const phase=getPhase();const self=state.self;let content=phaseHeading();
 content+=`<p class="eyecap">${h(self.name)} · ${self.alive?'ALIVE':'ELIMINATED'}</p>`;
 if(phase==='LOBBY')return content+panel('Waiting for the Host',`<p class="note">Room code: <strong>${h(state.code)}</strong>. The game begins after the host locks the lobby and deals roles.</p>${progress('Players joined',state.roster.length,30)}`)+rosterList();
 if(phase==='CONFIG')return content+panel('The Room Is Locked','<p class="script">“The host is choosing the rules. Your identity remains a secret.”</p>');
 if(phase==='DEAL')return content+(!revealed?`<div class="rolecard"><div class="symbol">♠</div><h2>YOUR SECRET</h2><p>Shield your phone before revealing.</p>${button('TAP TO REVEAL','reveal')}</div>`:roleCard(self));
 if(phase==='GAME_OVER')return content+panel(state.winner==='TOWN'?'TOWN VICTORY':'MAFIA VICTORY',`<p>Every secret is now public.</p>${rosterList(true)}`);
 if(phase==='ENDED')return content+panel('Party Ended','<p>Your host has ended the room. Thanks for playing.</p>')+button('RETURN HOME','newRoom','block');
 if(!self.alive)return content+(['VOTE','VOTE_2'].includes(phase)?panel('Voting closes in',`<div class="timer vote-timer" data-countdown>${countdown()}</div>`):'')+panel('You Have Been Eliminated','<p class="script">“The dead keep their secrets. Watch the living decide their fate.”</p>')+publicExtras();
 if(phase.startsWith('NIGHT_')){
 if(!state.canAct)return content+panel('Eyes Closed',`<div class="intro"><div class="crest">☾</div><p class="script">“Keep your eyes closed. Remain silent.”</p></div>`);
 const count=phase==='NIGHT_MAFIA'?state.config.kills:phase==='NIGHT_DOCTOR'?state.config.saves:state.config.checks;
 const instructions=phase==='NIGHT_MAFIA'?'Choose people to eliminate. You cannot select other Mafia.':phase==='NIGHT_DOCTOR'?'Choose people to protect. You may save yourself.':'Choose people to investigate. You cannot check yourself.';
 return content+panel(`SELECT ${count} ${phase==='NIGHT_MAFIA'?'KILL':phase==='NIGHT_DOCTOR'?'SAVE':'CHECK'} TARGET${count>1?'S':''}`,`<p class="note">${instructions} Final selections are secret.</p>${state.choiceLocked?'<div class="notice">Choice locked. Close your eyes until your next turn.</div>':`<div class="targetgrid">${state.roster.filter(p=>p.alive).map(p=>`<button class="target ${selected.includes(p.id)?'selected':''}" data-target="${p.id}">${h(p.name)}</button>`).join('')}</div><div class="buttonrow">${button(`LOCK ${selected.length}/${count} TARGETS`,'nightPick','block')}</div>`}`);
 }
 if(phase==='MORNING')return content+panel('Daybreak',state.announced?`<p class="script">“${h(state.announcement)}”</p>`:'<p class="script">“Keep silent until your host makes the announcement.”</p>')+publicExtras();
 if(phase==='DISCUSS'||phase==='DISCUSS_2')return content+panel('Defend Your Innocence',`<div class="timer" data-countdown>${countdown()}</div><p class="note center">Talk. Accuse. Persuade. Your phone will show the vote when the timer ends.</p>`)+publicExtras();
 if(phase==='VOTE'||phase==='VOTE_2'){
 const allowed=state.roster.filter(p=>p.alive&&p.id!==self.id&&(phase==='VOTE'||state.runoff?.candidates?.includes(p.id)));
 return content+panel(phase==='VOTE'?'CAST YOUR SECRET VOTE':'VOTE AGAIN — TIED CANDIDATES',`<div class="timer vote-timer" data-countdown>${countdown()}</div>${state.myVote?'<div class="notice">Vote locked. Nobody else can see your choice.</div>':`<p class="note">One choice only. Your host can see it, but other players cannot.</p><div class="targetgrid">${allowed.map(p=>`<button class="target ${selected.includes(p.id)?'selected':''}" data-target="${p.id}">${h(p.name)}</button>`).join('')}<button class="target ${selected.includes('ABSTAIN')?'selected':''}" data-target="ABSTAIN">ABSTAIN</button></div><div class="buttonrow">${button('LOCK SECRET VOTE','ballot','block')}</div>`}`);
 }
 if(phase==='RESULTS')return content+panel('The Town Has Spoken',`${(state.lastEliminations||[]).length?`<p class="script">${state.lastEliminations.map(eliminatedName).join(', ')} ${state.lastEliminations.length===1?'was':'were'} voted out.</p>`:'<p class="script">“The town could not agree. Nobody leaves.”</p>'}`)+publicExtras();
 return content+panel('Waiting for Host','<p class="note">Stay on this screen for the next instruction.</p>');
}
function publicExtras(){return state.policeReport?.length?panel('Private Police Report',state.policeReport.map(r=>`<div class="countline"><span>${r.round?`Round ${r.round} · `:''}${h(r.name)}</span><strong>${r.isMafia?'🔪 MAFIA':'✓ NOT MAFIA'}</strong></div>`).join('')):'';}
function roleCard(self){const descriptions={MAFIA:'At night, secretly choose whom the town loses.',DOCTOR:'At night, choose who will survive an attack.',POLICE:'At night, investigate the identity of others.',CIVILIAN:'Discover the Mafia through discussion and voting.'};return `<div class="rolecard"><div class="symbol">${roleIcons[self.role]||'♠'}</div><div class="eyecap">YOUR ROLE IS</div><h2>${h(self.role)}</h2><p>${descriptions[self.role]||''}</p><p class="tiny muted">No other player's role is visible.</p></div>`;}
function render(){if(returnHome||!session||!state){app.innerHTML=home();status.textContent='● READY';updateWakeLock();return;}app.innerHTML=(state.kind==='HOST'?hostView():playerView())+storyMarkup()+peekControl();}
async function copyText(text){try{await navigator.clipboard.writeText(text);alertMsg('Copied to clipboard.');}catch{alertMsg('Could not copy. Please copy the link manually.');}}
app.addEventListener('toggle',e=>{if(e.target.matches?.('details.story'))storyExpanded=e.target.open;},true);
app.addEventListener('submit',async e=>{e.preventDefault();const form=e.target;
 if(form.id==='join'){const f=new FormData(form),code=String(f.get('code')).trim().toUpperCase().replace(/\s/g,''),name=String(f.get('name')).trim();if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code)){alertMsg('Enter the valid six-character room code.');return;}
 try{const data=await request(`/api/rooms/${code}/join`,{method:'POST',body:{name},authenticated:false});remember(data);}catch(error){alertMsg(error.message);} }
 if(form.id==='config'){const c=Object.fromEntries([...new FormData(form)].map(([k,v])=>[k,Number(v)]));formConfig=c;await command('CONFIGURE',{config:c});}
});
app.addEventListener('click',async e=>{
 const target=e.target.closest('[data-target]');if(target){const id=target.dataset.target;
 if(state?.phase?.startsWith('NIGHT_')){const max=state.phase==='NIGHT_MAFIA'?state.config.kills:state.phase==='NIGHT_DOCTOR'?state.config.saves:state.config.checks;selected=selected.includes(id)?selected.filter(x=>x!==id):selected.length<max?[...selected,id]:selected;}else if(state?.phase?.startsWith('VOTE'))selected=[id];render();return;}
 const btn=e.target.closest('[data-act]');if(!btn)return;const action=btn.dataset.act;
 if(action==='rolePeek'){showRolePeek();return;}
 if(action==='newRoom'){hideRolePeek();if(ws){ws.onclose=null;ws.close();}localStorage.removeItem(store);session=null;state=null;selected=[];storyEntries=[];storyKey='';storyExpanded=false;lastActionKey=null;returnHome=false;updateWakeLock();history.replaceState(null,'',location.pathname);return render();}
 if(action==='create'){btn.disabled=true;try{const data=await request('/api/rooms',{method:'POST',body:{},authenticated:false});remember(data);}catch(error){alertMsg(error.message);btn.disabled=false;}return;}
 if(action==='invite')return copyText(joinUrl(session.code));
 if(action==='recover')return copyText(`${location.origin}${location.pathname}#host=${session.token}&room=${session.code}`);
 if(action==='remove'){const id=document.getElementById('removePlayer')?.value;if(!id)return alertMsg('Choose a player first.');return command('REMOVE',{playerId:id});}
 if(action==='lock')return command('LOCK');if(action==='deal')return command('DEAL');if(action==='next')return command('NEXT');
 if(action==='consensus'||action==='majority'||action==='skip')return command('FINALIZE_NIGHT',{method:action==='majority'?'majority':action,tiebreak:[...selected]});
 if(action==='announce')return command('ANNOUNCE');if(action==='discuss')return command('START_DISCUSSION');if(action==='endDiscuss')return command('END_DISCUSSION');
 if(action==='closeVote')return command('CLOSE_VOTE');if(action==='reveal'){revealed=true;return render();}
 if(action==='nightPick'){const max=state.phase==='NIGHT_MAFIA'?state.config.kills:state.phase==='NIGHT_DOCTOR'?state.config.saves:state.config.checks;if(selected.length!==max)return alertMsg(`Choose exactly ${max} players.`);return command('NIGHT_PICK',{targets:[...selected]});}
 if(action==='ballot'){if(selected.length!==1)return alertMsg('Choose one candidate or Abstain.');return command('BALLOT',{targetId:selected[0]});}
 if(action==='replay')return command('PLAY_AGAIN');
 if(action==='endParty'){if(confirm('END PARTY? This closes the current game for every player. You cannot return to this room.'))return command('END_ROOM');}
});
const hash=new URLSearchParams(location.hash.slice(1));if(hash.has('host')&&hash.has('room')&&/^[A-HJ-NP-Z2-9]{6}$/.test(hash.get('room'))){session={code:hash.get('room'),token:hash.get('host')};saved();history.replaceState(null,'',location.pathname);}
if(session?.code&&session?.token){refresh().then(ok=>{if(ok)connect();});}else render();
setInterval(()=>{document.querySelectorAll('[data-countdown]').forEach(el=>el.textContent=countdown());if(session&&ws?.readyState!==1&&Date.now()-lastReconnectAttemptAt>=reconnectDelayMs){lastReconnectAttemptAt=Date.now();refresh().then(ok=>{if(ok&&(!ws||ws.readyState===3))connect();});}},4000);
