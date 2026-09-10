// VANGUARD - Living Strategy Frontend
const $ = s=>document.querySelector(s);
const $$ = s=>[...document.querySelectorAll(s)];

let ws=null, playerId=null, maps=[], lobbies=[], currentLobby=null, gameState=null;
let selectedId=null, hoveredId=null, attackRatio=0.55;
let camera={x:500,y:300,zoom:1, tx:500, ty:300, tzoom:1};
let showTerrain=false;
let perfFPS=60, lastFpsTime=performance.now(), frameCount=0;
let minimapCanvas=null, minimapCtx=null;
let isDragging=false, dragStart=null, lastMouse=null;
let animFrame=null;
let particlesEnabled=true, shakeEnabled=true, reduceMotion=false;
let musicEnabled=true, sfxEnabled=true;
let audioCtx=null, musicGain=null, sfxGain=null, musicOsc=null;
let lastGameTick=0, interpolPos={}; // for smooth troops
let pendingNotifications=[];
let chatCategory="Alliance";

// Poly cache
const polyCache=new Map();
function getPoly(terr){
  if(polyCache.has(terr.id)) return polyCache.get(terr.id);
  // generate irregular polygon around center
  const pts=[];
  const sides= 7 + (hash(terr.id)%4); // 7-10
  const baseR = 22 + (hash(terr.id)%10); // 22-31
  // coastal slight larger?
  const isCoastal = terr.coastal;
  const r = isCoastal ? baseR+2 : baseR;
  for(let i=0;i<sides;i++){
    const ang = (i/sides)*Math.PI*2 + (hash(terr.id+i)*0.13);
    const rad = r + (Math.sin(hash(terr.id+i)*0.5)*4) + (Math.random()*2);
    const x = terr.x + Math.cos(ang)*rad;
    const y = terr.y + Math.sin(ang)*rad;
    pts.push([x,y]);
  }
  polyCache.set(terr.id, pts);
  return pts;
}
function hash(s){ let h=0; for(let i=0;i<s.length;i++) h=(h*31 + s.charCodeAt(i))|0; return Math.abs(h); }
function lerp(a,b,t){return a+(b-a)*t}
function dist(a,b,c,d){return Math.hypot(a-c,b-d)}

// WebSocket
function connect(){
  const proto = location.protocol==="https:"?"wss:":"ws:";
  const url = proto+"//"+location.host+"/ws";
  ws=new WebSocket(url);
  ws.onopen=()=>{ console.log("ws open"); toast("Connected"); };
  ws.onclose=()=>{ console.log("ws close"); setTimeout(connect,1200); };
  ws.onerror=e=>console.error(e);
  ws.onmessage=e=>{
    try{
      const msg=JSON.parse(e.data);
      handleMessage(msg);
    }catch(err){console.error(err)}
  };
}
function send(obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }
function handleMessage(msg){
  switch(msg.type){
    case "connected":
      playerId=msg.playerId;
      if(msg.maps) maps=msg.maps;
      refreshMapSelectors();
      refreshMapsPreview();
      break;
    case "lobbies":
      lobbies=msg.lobbies;
      renderLobbyList();
      break;
    case "lobby_update":
      currentLobby=msg.lobby;
      renderLobby();
      if(currentLobby.game){
        gameState=currentLobby.game;
        // switch to game screen if playing/countdown/finished
        if(["playing","countdown","finished"].includes(gameState.state)){
          showScreen("screen-game");
          $("#topStats").classList.remove("hidden");
          $("#btnLeave").classList.remove("hidden");
          updateHUD();
        }
      }
      break;
    case "game_state":
      gameState=msg.state;
      // ensure lobby reflects
      if(currentLobby) currentLobby.game=gameState;
      lastGameTick=performance.now();
      updateHUD();
      pushEventsToUI();
      checkVictory();
      break;
    case "joined":
      // already handled via lobby_update
      break;
    case "error":
      toast(msg.message, true);
      break;
    case "chat":
      // lobby chat? ignore
      break;
  }
}

// UI helpers
function toast(txt, isErr=false){
  const c=$("#toast");
  const el=document.createElement("div");
  el.className="toast";
  el.textContent=txt;
  if(isErr) el.style.borderColor="#ff5a6a";
  c.appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transform="translateY(8px)"; setTimeout(()=>el.remove(),400)}, 2600);
}
function notify(txt, important=false){
  const c=$("#notifications");
  const el=document.createElement("div");
  el.className="notif";
  if(important) el.style.borderColor="#ffd166";
  el.textContent=txt;
  c.appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; setTimeout(()=>el.remove(),400)}, 3800);
  // sfx
  playSfx(important? "alert":"notif");
}
function showScreen(id){
  $$(".screen").forEach(s=>s.classList.remove("active"));
  $("#"+id).classList.add("active");
}
function refreshMapSelectors(){
  const opts = maps.map(m=>`<option value="${m.id}">${m.name}</option>`).join("");
  ["#selMap","#soloMap","#createMap"].forEach(sel=>{
    const el=$(sel); if(el) el.innerHTML=opts;
  });
  if(maps.length) {
    // default preview
  }
}
function refreshMapsPreview(){
  const c=$("#mapsPreview");
  if(!c) return;
  c.innerHTML = maps.map(m=>`<div class="map-card" data-map="${m.id}"><b>${m.name}</b><small>${m.id} • ${m.territories||"?"} territories</small></div>`).join("");
  c.querySelectorAll(".map-card").forEach(card=>{
    card.onclick=()=>{
      $("#soloMap").value=card.dataset.map;
      showScreen("screen-menu");
      // open solo modal
      openSolo();
    };
  });
}

// Screens wiring
$("#btnPlaySolo").onclick=openSolo;
$("#btnCreateLobby").onclick=()=>{ $("#modalCreate").classList.remove("hidden"); };
$("#btnJoinLobby").onclick=()=>{
  send({type:"get_lobbies"});
  showScreen("screen-browser");
};
$("#btnHowTo").onclick=()=>showScreen("screen-howto");
$("#btnHowToBack").onclick=()=>showScreen("screen-menu");
$("#btnSettings").onclick=()=>showScreen("screen-settings");
$("#btnSettings2").onclick=()=>showScreen("screen-settings");
$("#btnSettingsBack").onclick=()=>showScreen("screen-menu");
$("#btnBrowserBack").onclick=()=>showScreen("screen-menu");
$("#btnLeaderboard").onclick=async()=>{
  // fetch online leaderboard and show in lobby or game?
  try{
    const res=await fetch("/api/leaderboard");
    const data=await res.json();
    const rec=JSON.parse(localStorage.getItem("vanguard_stats")||"{}");
    let html=`<div class="panel" style="max-width:520px;margin:20px auto"><h3>Leaderboard</h3>`;
    html+=`<div style="display:grid;gap:6px;margin:10px 0">`;
    if(data && data.length){
      data.forEach((e,i)=>{ html+=`<div class="lb-row"><span>#${i+1} ${e.name}</span><span>${e.wins} wins • best ${e.bestTerr} terr</span></div>`; });
    } else {
      html+=`<div class="empty">No wins yet — be the first Vanguard!</div>`;
    }
    html+=`</div>`;
    html+=`<div style="background:#0f1b3d;padding:10px;border-radius:10px;border:1px solid var(--border)"><b>Your Stats</b><br>Matches: ${rec.matches||0} • Wins: ${rec.wins||0} • Best Terr: ${rec.bestTerr||0} • Best Gold: ${rec.bestGold||0}</div>`;
    html+=`<button class="btn" onclick="this.closest('.panel').parentElement.remove()" style="margin-top:10px">Close</button></div>`;
    const overlay=document.createElement("div");
    overlay.className="modal";
    overlay.innerHTML=html;
    overlay.onclick=e=>{ if(e.target===overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }catch(e){
    showScreen("screen-game");
    $$(".tab").forEach(t=>t.classList.remove("active"));
    $$(".tab-pane").forEach(p=>p.classList.remove("active"));
    document.querySelector('[data-tab="leader"]').classList.add("active");
    $("#tab-leader").classList.add("active");
  }
};
$("#btnRefreshLobbies").onclick=()=>send({type:"get_lobbies"});
$("#btnJoinByCode").onclick=()=>{
  const code=$("#joinCode").value.trim();
  if(!code) return toast("Enter code");
  send({type:"join_lobby", lobbyId:code, playerName: getPlayerName()});
};
function openSolo(){
  $("#modalSolo").classList.remove("hidden");
}
$("#btnSoloCancel").onclick=()=>$("#modalSolo").classList.add("hidden");
$("#btnSoloStart").onclick=()=>{
  const mapId=$("#soloMap").value||"world";
  const bots=parseInt($("#soloBots").value);
  const diff=$("#soloDiff").value;
  const vic=parseInt($("#soloVictory").value);
  const timer=parseInt($("#soloTimer").value);
  const fog=$("#soloFog").checked;
  const superw=$("#soloSuper").checked;
  send({type:"create_lobby", name:getPlayerName()+"'s Solo", mapId, settings:{botCount:bots, botDifficulty:diff, victoryPercent:vic, matchTimer:timer, fogOfWar:fog, superweapons:superw, maxPlayers:8}, playerName:getPlayerName()});
  $("#modalSolo").classList.add("hidden");
  // wait for lobby_update then auto start?
  setTimeout(()=>{
    // Host auto start after short delay
    send({type:"start_game"});
  }, 800);
};
$("#btnCreateCancel").onclick=()=>$("#modalCreate").classList.add("hidden");
$("#btnCreateConfirm").onclick=()=>{
  const name=$("#createName").value.trim()|| getPlayerName()+"'s Game";
  const mapId=$("#createMap").value||"world";
  const maxP=parseInt($("#createMax").value);
  const bots=parseInt($("#createBots").value);
  const diff=$("#createDiff").value;
  const vicSel=$("#createVictory").value;
  const isPrivate=$("#createPrivate").checked;
  let victoryCondition="domination", victoryPercent=60;
  if(vicSel==="elimination"){victoryCondition="elimination"; victoryPercent=100;}
  else if(vicSel==="domination"){victoryCondition="domination"; victoryPercent=60;}
  send({type:"create_lobby", name, mapId, settings:{maxPlayers:maxP, botCount:bots, botDifficulty:diff, victoryCondition, victoryPercent, private:isPrivate}, playerName:getPlayerName()});
  $("#modalCreate").classList.add("hidden");
};
$("#btnLobbyLeave").onclick=()=>{ send({type:"leave_lobby"}); showScreen("screen-menu"); $("#topStats").classList.add("hidden"); };
$("#btnLeave").onclick=()=>{ send({type:"leave_lobby"}); showScreen("screen-menu"); $("#topStats").classList.add("hidden"); $("#btnLeave").classList.add("hidden"); };
$("#btnStartTutorial").onclick=()=>{
  $("#soloMap").value="world";
  $("#soloBots").value="2";
  $("#soloDiff").value="easy";
  $("#modalSolo").classList.remove("hidden");
};
function getPlayerName(){
  let n=localStorage.getItem("vanguard_name");
  if(!n){ n="Commander"+Math.floor(Math.random()*900+100); localStorage.setItem("vanguard_name", n); }
  return n;
}

// Lobby rendering
function renderLobbyList(){
  const c=$("#lobbyList");
  if(!c) return;
  if(!lobbies.length){ c.innerHTML=`<div class="empty">No open lobbies — create one!</div>`; return; }
  c.innerHTML=lobbies.map(l=>`
    <div class="lobby-item">
      <div><b>${l.name}</b> <small>• ${l.mapName}</small><br><small>${l.players}/${l.maxPlayers} players • ${l.state}</small></div>
      <button class="btn primary" data-join="${l.id}">Join</button>
    </div>
  `).join("");
  c.querySelectorAll("[data-join]").forEach(b=>b.onclick=()=>send({type:"join_lobby", lobbyId:b.dataset.join, playerName:getPlayerName()}));
}
function renderLobby(){
  if(!currentLobby) return;
  $("#lobbyName").textContent=currentLobby.name;
  $("#lobbyCode").textContent=currentLobby.id;
  $("#lobbyCount").textContent=`${currentLobby.players.length}/${currentLobby.settings.maxPlayers}`;
  const isHost = currentLobby.hostId===playerId;
  $("#btnStartGame").style.display=isHost?"":"none";
  $("#hostOnlyNote").classList.toggle("hidden", isHost);
  $("#selMap").disabled=!isHost;
  $("#selMap").value=currentLobby.mapId;
  // players
  $("#lobbyPlayers").innerHTML=currentLobby.players.map(p=>`
    <div class="player-row ${p.id===currentLobby.hostId?"host":""}">
      <span class="dot" style="background:${p.color}"></span>
      <b style="flex:1">${p.name} ${p.id===currentLobby.hostId?"👑":""} ${p.isBot?"🤖":""} </b>
      <small>${p.isBot? p.botDifficulty : (p.ready?"Ready":"Not ready")}</small>
    </div>
  `).join("");
  // lobby settings grid
  const s=currentLobby.settings;
  const settingsHtml = `
    <label>Starting Gold <select data-set="startingGold" ${!isHost?"disabled":""}><option ${s.startingGold==300?"selected":""} value="300">300</option><option ${s.startingGold==500?"selected":""} value="500">500</option><option ${s.startingGold==800?"selected":""} value="800">800</option></select></label>
    <label>Game Speed <select data-set="gameSpeed" ${!isHost?"disabled":""}><option value="0.5" ${s.gameSpeed==0.5?"selected":""}>0.5x</option><option value="1" ${s.gameSpeed==1?"selected":""}>1x</option><option value="1.5" ${s.gameSpeed==1.5?"selected":""}>1.5x</option><option value="2" ${s.gameSpeed==2?"selected":""}>2x</option></select></label>
    <label>Bots <select data-set="botCount" ${!isHost?"disabled":""}><option value="0" ${getBotCount()==0?"selected":""}>0</option><option value="1" ${getBotCount()==1?"selected":""}>1</option><option value="2" ${getBotCount()==2?"selected":""}>2</option><option value="4" ${getBotCount()==4?"selected":""}>4</option><option value="6" ${getBotCount()==6?"selected":""}>6</option></select></label>
    <label>Bot Difficulty <select data-set="botDifficulty" ${!isHost?"disabled":""}><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option><option value="extreme">Extreme</option></select></label>
    <label>Victory % <select data-set="victoryPercent" ${!isHost?"disabled":""}><option value="50" ${s.victoryPercent==50?"selected":""}>50%</option><option value="60" ${s.victoryPercent==60?"selected":""}>60%</option><option value="75" ${s.victoryPercent==75?"selected":""}>75%</option></select></label>
    <label><input type="checkbox" data-set="fogOfWar" ${s.fogOfWar?"checked":""} ${!isHost?"disabled":""}> Fog of War</label>
    <label><input type="checkbox" data-set="superweapons" ${s.superweapons?"checked":""} ${!isHost?"disabled":""}> Superweapons</label>
    <label><input type="checkbox" data-set="naval" ${s.naval?"checked":""} ${!isHost?"disabled":""}> Naval</label>
  `;
  $("#lobbySettings").innerHTML=settingsHtml;
  // hook change
  $("#lobbySettings").querySelectorAll("[data-set]").forEach(el=>{
    el.onchange=()=>{
      if(!isHost) return;
      const set={};
      const key=el.dataset.set;
      if(el.type==="checkbox") set[key]=el.checked;
      else if(key==="botCount") set[key]=parseInt(el.value);
      else if(["startingGold","victoryPercent"].includes(key)) set[key]=parseInt(el.value);
      else if(key==="gameSpeed") set[key]=parseFloat(el.value);
      else set[key]=el.value;
      // include map if changed
      send({type:"update_settings", settings:set});
    };
  });
  // selMap change
  $("#selMap").onchange=()=>{
    if(!isHost) return;
    send({type:"update_settings", settings:{}, mapId: $("#selMap").value});
  };
  // Ready button
  const me=currentLobby.players.find(p=>p.id===playerId);
  if(me){
    $("#btnReady").textContent=me.ready?"Not Ready":"Ready";
    $("#btnReady").onclick=()=>send({type:"set_ready", ready:!me.ready});
  }
  // If lobby is in countdown/playing, show game screen
  if(["countdown","playing","finished"].includes(currentLobby.state)){
    showScreen("screen-game");
    $("#topStats").classList.remove("hidden");
  } else {
    showScreen("screen-lobby");
  }
}
function getBotCount(){
  if(!currentLobby) return 0;
  return currentLobby.players.filter(p=>p.isBot).length;
}
$("#btnReady").onclick=()=>send({type:"set_ready", ready:true});
$("#btnStartGame").onclick=()=>send({type:"start_game"});
$("#selMap").onchange=()=>{};

// Settings wiring
$("#volMusic").oninput=e=>{
  if(musicGain) musicGain.gain.value = e.target.value/100 * 0.22;
};
$("#volSfx").oninput=e=>{
  if(sfxGain) sfxGain.gain.value = e.target.value/100 * 0.5;
};
$("#chkParticles").onchange=e=>particlesEnabled=e.target.checked;
$("#chkShake").onchange=e=>shakeEnabled=e.target.checked;
$("#chkReduceMotion").onchange=e=>reduceMotion=e.target.checked;
$("#selQuality").onchange=e=>{};
$("#btnMusic").onclick=()=>{
  musicEnabled=!musicEnabled;
  if(musicEnabled) startMusic(); else stopMusic();
  $("#btnMusic").style.opacity=musicEnabled?1:0.45;
};

// Quick chat
$("#btnSendChat").onclick=()=>{
  const cat=$("#chatCategory").value;
  const txt=$("#chatText").value.trim();
  if(!txt) return;
  send({type:"quick_chat", category:cat, message:txt});
  $("#chatText").value="";
};
$$("[data-qc]").forEach(b=>b.onclick=()=>{
  const txt=b.dataset.qc;
  send({type:"quick_chat", category:"Alliance", message:txt});
});

// Tabs
$$(".tab").forEach(t=>{
  t.onclick=()=>{
    $$(".tab").forEach(x=>x.classList.remove("active"));
    $$(".tab-pane").forEach(p=>p.classList.remove("active"));
    t.classList.add("active");
    $("#tab-"+t.dataset.tab).classList.add("active");
  };
});

// Attack ratio
$("#ratioSlider").oninput=e=>{
  attackRatio=parseInt(e.target.value)/100;
  $("#ratioVal").textContent=Math.round(attackRatio*100)+"%";
  updateRatioDisplay();
};
document.addEventListener("keydown", e=>{
  if(e.key===" "){
    e.preventDefault();
    showTerrain=true;
    const hint=$("#terrainHint");
    if(hint) hint.classList.remove("hidden");
  }
  if(e.key==="1"){ attackRatio=Math.max(0.1, attackRatio-0.05); $("#ratioSlider").value=Math.round(attackRatio*100); $("#ratioVal").textContent=Math.round(attackRatio*100)+"%"; updateRatioDisplay(); }
  if(e.key==="2"){ attackRatio=Math.min(0.95, attackRatio+0.05); $("#ratioSlider").value=Math.round(attackRatio*100); $("#ratioVal").textContent=Math.round(attackRatio*100)+"%"; updateRatioDisplay(); }
  if(e.key==="t"||e.key==="T"){ attackRatio=Math.min(0.95, attackRatio+0.05); $("#ratioSlider").value=Math.round(attackRatio*100); $("#ratioVal").textContent=Math.round(attackRatio*100)+"%"; updateRatioDisplay(); }
  if(e.key==="y"||e.key==="Y"){ attackRatio=Math.max(0.1, attackRatio-0.05); $("#ratioSlider").value=Math.round(attackRatio*100); $("#ratioVal").textContent=Math.round(attackRatio*100)+"%"; updateRatioDisplay(); }
  if(e.key==="c"||e.key==="C"){ centerOnOwn(); }
  if(e.key==="Escape"){ selectedId=null; updateSelection(); hideRadial(); }
  if(e.key==="D" && e.shiftKey){ const ov=$("#perfOverlay"); if(ov) ov.classList.toggle("hidden"); }
});
function updateRatioDisplay(){
  if(!gameState || !selectedId){ $("#ratioCommitted").textContent="—"; $("#ratioRemain").textContent="—"; return; }
  const terr=gameState.territories[selectedId];
  if(!terr || terr.ownerId!==playerId){ $("#ratioCommitted").textContent="—"; $("#ratioRemain").textContent="—"; return; }
  const committed=Math.floor(terr.troops*attackRatio);
  const remain=Math.floor(terr.troops-committed);
  $("#ratioCommitted").textContent=committed;
  $("#ratioRemain").textContent=remain;
}

// Canvas setup
const canvas=$("#gameCanvas");
const ctx=canvas.getContext("2d");
minimapCanvas=$("#minimap");
if(minimapCanvas) minimapCtx=minimapCanvas.getContext("2d");
function resizeCanvas(){
  const wrap=$("#canvasWrap");
  const rect=wrap.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  // maintain aspect: use wrap size
  canvas.width = rect.width * dpr;
  canvas.height = (rect.height - 0) * dpr;
  canvas.style.width=rect.width+"px";
  canvas.style.height=rect.height+"px";
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener("resize", resizeCanvas);
setTimeout(resizeCanvas, 200);

// Camera controls
canvas.addEventListener("wheel", e=>{
  e.preventDefault();
  if(e.shiftKey){
    attackRatio=Math.max(0.1, Math.min(0.95, attackRatio + (e.deltaY>0?-0.05:0.05)));
    $("#ratioSlider").value=Math.round(attackRatio*100);
    $("#ratioVal").textContent=Math.round(attackRatio*100)+"%";
    updateRatioDisplay();
    return;
  }
  const delta = e.deltaY>0? 0.9 : 1.1;
  camera.tzoom = Math.max(0.55, Math.min(2.6, camera.tzoom*delta));
  // also adjust attack ratio with ctrl
  if(e.ctrlKey || e.metaKey){
    attackRatio=Math.max(0.1, Math.min(0.95, attackRatio + (e.deltaY>0?-0.04:0.04)));
    $("#ratioSlider").value=Math.round(attackRatio*100);
    $("#ratioVal").textContent=Math.round(attackRatio*100)+"%";
    updateRatioDisplay();
  }
}, {passive:false});
canvas.addEventListener("mousedown", e=>{
  if(e.button===0){
    isDragging=true;
    dragStart={x:e.clientX, y:e.clientY, cx:camera.tx, cy:camera.ty};
    canvas.style.cursor="grabbing";
  }
});
window.addEventListener("mouseup", e=>{
  isDragging=false;
  canvas.style.cursor="grab";
});
canvas.addEventListener("mousemove", e=>{
  lastMouse={x:e.clientX, y:e.clientY};
  if(isDragging && dragStart){
    const dx=(e.clientX - dragStart.x)/camera.tzoom;
    const dy=(e.clientY - dragStart.y)/camera.tzoom;
    camera.tx = dragStart.cx - dx;
    camera.ty = dragStart.cy - dy;
    clampCamera();
  } else {
    // hover detection
    const pos = screenToWorld(e.clientX, e.clientY);
    const hid = pickTerritory(pos.x, pos.y);
    if(hid!==hoveredId){ hoveredId=hid; canvas.style.cursor=hid?"pointer":"grab"; }
  }
});
canvas.addEventListener("click", e=>{
  if(isDragging && Math.hypot(e.clientX-dragStart.x, e.clientY-dragStart.y)>6) return;
  const pos=screenToWorld(e.clientX,e.clientY);
  const tid=pickTerritory(pos.x,pos.y);
  if(!tid) { selectedId=null; updateSelection(); return; }
  // if we have a selected source and clicking target: attempt attack
  if(selectedId && selectedId!==tid && gameState){
    const src=gameState.territories[selectedId];
    const tgt=gameState.territories[tid];
    if(src && src.ownerId===playerId){
      // attempt attack
      const isNeighbor = src.neighbors.includes(tid);
      const hasPort = src.buildings.port>0;
      const navalOk = src.coastal && tgt.coastal && hasPort;
      if(isNeighbor || navalOk){
        // send attack
        send({type:"attack", sourceId:selectedId, targetId:tid, ratio:attackRatio});
        playSfx("attack");
        // visual feedback
        notify(`Order: ${src.name} → ${tgt.name} (${Math.round(attackRatio*100)}%)`);
        return;
      } else if(tgt.ownerId===playerId){
        // transfer? just select new
        selectedId=tid;
        updateSelection();
        return;
      } else {
        // not reachable
        toast("Not reachable — need adjacency or Port for naval", true);
        playSfx("error");
        selectedId=tid;
        updateSelection();
        return;
      }
    }
  }
  selectedId=tid;
  updateSelection();
  playSfx("select");
});
canvas.addEventListener("contextmenu", e=>{
  e.preventDefault();
  const pos=screenToWorld(e.clientX,e.clientY);
  const tid=pickTerritory(pos.x,pos.y);
  if(tid){
    selectedId=tid; updateSelection();
    const terr=gameState?.territories[tid];
    if(terr && terr.ownerId===playerId && !terr.isWater){
      showRadial(e.clientX, e.clientY, tid);
    }
  } else {
    hideRadial();
  }
});
// Touch
let pinchDist=0;
canvas.addEventListener("touchstart", e=>{
  if(e.touches.length===1){
    const t=e.touches[0];
    isDragging=true;
    dragStart={x:t.clientX, y:t.clientY, cx:camera.tx, cy:camera.ty};
  } else if(e.touches.length===2){
    isDragging=false;
    pinchDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
  }
}, {passive:false});
canvas.addEventListener("touchmove", e=>{
  e.preventDefault();
  if(e.touches.length===1 && isDragging){
    const t=e.touches[0];
    const dx=(t.clientX - dragStart.x)/camera.tzoom;
    const dy=(t.clientY - dragStart.y)/camera.tzoom;
    camera.tx=dragStart.cx - dx;
    camera.ty=dragStart.cy - dy;
    clampCamera();
  } else if(e.touches.length===2){
    const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
    const delta=d/pinchDist;
    camera.tzoom=Math.max(0.55, Math.min(2.6, camera.tzoom* (delta>1?1.04:0.96)));
    pinchDist=d;
  }
}, {passive:false});
canvas.addEventListener("touchend", e=>{
  if(e.touches.length===0){
    isDragging=false;
    // tap select
    if(e.changedTouches.length===1){
      const t=e.changedTouches[0];
      // Use last pos
    }
  }
});
function screenToWorld(sx,sy){
  const rect=canvas.getBoundingClientRect();
  const cx=rect.width/2, cy=rect.height/2;
  const wx = camera.x + (sx - rect.left - cx)/camera.zoom;
  const wy = camera.y + (sy - rect.top - cy)/camera.zoom;
  return {x:wx,y:wy};
}
function pickTerritory(wx,wy){
  if(!gameState) return null;
  let best=null, bestDist=Infinity;
  // check polygons distance or point in poly
  for(const tid in gameState.territories){
    const t=gameState.territories[tid];
    // quick distance to center
    const d=Math.hypot(t.x-wx, t.y-wy);
    if(d>42) continue; // outside max radius
    // more accurate point in polygon approximation
    const poly=getPoly(t);
    if(pointInPoly([wx,wy], poly)){
      if(d<bestDist){ bestDist=d; best=tid; }
    } else if(d<28 && !best){
      // fallback circle
      if(d<bestDist){ bestDist=d; best=tid; }
    }
  }
  return best;
}
function pointInPoly(pt, poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][0], yi=poly[i][1];
    const xj=poly[j][0], yj=poly[j][1];
    const intersect = ((yi>pt[1])!==(yj>pt[1])) && (pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi)+xi);
    if(intersect) inside=!inside;
  }
  return inside;
}
function clampCamera(){
  // keep within map bounds (0-1000, 0-600)
  camera.tx=Math.max(150, Math.min(850, camera.tx));
  camera.ty=Math.max(100, Math.min(500, camera.ty));
}
function centerOnOwn(){
  if(!gameState) return;
  const owned=Object.values(gameState.territories).filter(t=>t.ownerId===playerId);
  if(!owned.length) return;
  const avgX=owned.reduce((s,t)=>s+t.x,0)/owned.length;
  const avgY=owned.reduce((s,t)=>s+t.y,0)/owned.length;
  camera.tx=avgX; camera.ty=avgY;
}
// Minimap
function initMinimap(){
  if(!minimapCanvas) return;
  minimapCanvas.addEventListener("click", e=>{
    const rect=minimapCanvas.getBoundingClientRect();
    const x=(e.clientX-rect.left)/rect.width;
    const y=(e.clientY-rect.top)/rect.height;
    // map is 0-1000 x, 0-600 y
    camera.tx = x*1000;
    camera.ty = y*600;
  });
}
setTimeout(initMinimap, 500);
function drawMinimap(){
  if(!minimapCtx || !gameState) return;
  const w=minimapCanvas.width, h=minimapCanvas.height;
  minimapCtx.clearRect(0,0,w,h);
  // background
  minimapCtx.fillStyle="#08102a";
  minimapCtx.fillRect(0,0,w,h);
  // draw territories as dots
  for(const tid in gameState.territories){
    const terr=gameState.territories[tid];
    const owner=gameState.players[terr.ownerId];
    const x=(terr.x/1000)*w;
    const y=(terr.y/600)*h;
    minimapCtx.fillStyle = owner? owner.color : (terr.isWater?"#0a2a5a":"#1e274d");
    minimapCtx.fillRect(x-1,y-1,2,2);
  }
  // viewport rect
  const rectW = ( (canvas.getBoundingClientRect().width / camera.zoom) /1000)*w;
  const rectH = ( (canvas.getBoundingClientRect().height / camera.zoom)/600)*h;
  const vx = (camera.x/1000)*w - rectW/2;
  const vy = (camera.y/600)*h - rectH/2;
  minimapCtx.strokeStyle="#ffd166";
  minimapCtx.lineWidth=1;
  minimapCtx.strokeRect(vx,vy,rectW,rectH);
}

// WASD
const keys={};
window.addEventListener("keydown", e=>{ keys[e.key.toLowerCase()]=true; });
window.addEventListener("keyup", e=>{ keys[e.key.toLowerCase()]=false; if(e.key===" "){ showTerrain=false; const hint=$("#terrainHint"); if(hint) hint.classList.add("hidden"); }});
function handleKeys(dt){
  const speed= 420*dt / camera.zoom; // pan speed
  if(keys["w"]||keys["arrowup"]) camera.ty-=speed;
  if(keys["s"]||keys["arrowdown"]) camera.ty+=speed;
  if(keys["a"]||keys["arrowleft"]) camera.tx-=speed;
  if(keys["d"]||keys["arrowright"]) camera.tx+=speed;
  if(keys["q"]) camera.tzoom=Math.min(2.6, camera.tzoom+dt*0.6);
  if(keys["e"]) camera.tzoom=Math.max(0.55, camera.tzoom-dt*0.6);
  clampCamera();
}

// HUD
function updateHUD(){
  if(!gameState) return;
  const me=gameState.players[playerId];
  if(me){
    $("#hudGold").textContent=Math.floor(me.gold);
    $("#hudGoldInc").textContent=`+${me.goldIncome.toFixed(1)}/s`;
    $("#hudTroops").textContent=Math.floor(me.troops);
    $("#hudTroopInc").textContent=`+${me.troopIncome?.toFixed(1)??"0.0"}/s`;
    // territory %
    const totalLand=Object.values(gameState.territories).filter(t=>!t.isWater).length;
    const pct = totalLand? (me.territories/totalLand*100):0;
    $("#hudTerr").textContent=pct.toFixed(1)+"%";
    // victory bar
    const thresh=gameState.settings.victoryPercent||60;
    const vBar=$("#victoryBar");
    if(gameState.state==="playing"){
      vBar.classList.remove("hidden");
      $("#victoryFill").style.width=Math.min(100, pct/thresh*100)+"%";
      $("#victoryText").textContent=pct.toFixed(1)+"% / "+thresh+"%";
    } else vBar.classList.add("hidden");
  } else {
    $("#hudGold").textContent="—";
  }
  // timer
  if(gameState.settings.matchTimer>0){
    const elapsed = (Date.now()/1000 - (gameState.tick*0.1)); // approx? use tick? better compute from startedAt but we don't have. Use game tick.
    // We have no startedAt in snapshot, approximate
    const total = gameState.settings.matchTimer*60;
    const remaining = Math.max(0, total - gameState.tick*0.1);
    const m=Math.floor(remaining/60), s=Math.floor(remaining%60);
    $("#hudTimer").textContent=`${m}:${s.toString().padStart(2,"0")}`;
  } else {
    $("#hudTimer").textContent= gameState.state==="countdown"? `Starting…` : `${Math.floor(gameState.tick/10)}s`;
  }
  // countdown overlay
  if(gameState.state==="countdown"){
    $("#countdownOverlay").classList.remove("hidden");
    $("#countdownText").textContent=gameState.countdown;
  } else {
    $("#countdownOverlay").classList.add("hidden");
  }
  updateLeaderboard();
  updateSelection();
  updateDiplomacy();
  updateRatioDisplay();
}
function updateLeaderboard(){
  if(!gameState) return;
  const totalLand=Object.values(gameState.territories).filter(t=>!t.isWater).length;
  const sorted=Object.values(gameState.players).sort((a,b)=> b.territories - a.territories);
  $("#leaderboard").innerHTML=sorted.map((p,i)=>{
    const pct = totalLand? (p.territories/totalLand*100).toFixed(1):"0";
    const me = p.id===playerId;
    return `<div class="lb-row ${me?"me":""}">
      <div class="lb-rank">#${i+1}</div>
      <div class="lb-name"><span class="dot" style="background:${p.color};display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px"></span>${p.name} ${me?"(You)":""}</div>
      <div class="lb-stat">${pct}%<small>${p.territories} terr</small></div>
      <div class="lb-stat">${Math.floor(p.gold)}<small>${Math.floor(p.troops)} troops</small></div>
    </div>`;
  }).join("");
}
function updateSelection(){
  if(!gameState){ $("#selectedNone").classList.remove("hidden"); $("#selectedInfo").classList.add("hidden"); return; }
  if(!selectedId || !gameState.territories[selectedId]){
    $("#selectedNone").classList.remove("hidden");
    $("#selectedInfo").classList.add("hidden");
    $("#selectedNone").textContent="Select a territory to inspect";
    return;
  }
  const t=gameState.territories[selectedId];
  const owner=gameState.players[t.ownerId];
  $("#selectedNone").classList.add("hidden");
  $("#selectedInfo").classList.remove("hidden");
  $("#selName").textContent=t.name;
  $("#selOwner").textContent= owner? owner.name : "Neutral";
  $("#selOwner").style.color= owner? owner.color : "#9aa7d0";
  $("#selTerrain").textContent=t.terrain + (t.coastal?" • coastal":"");
  $("#selCoastal").classList.toggle("hidden", !t.coastal);
  $("#selTroops").textContent=Math.floor(t.troops);
  $("#selDefense").textContent= t.buildings.defense>0 ? `+${t.buildings.defense*45}%` : "—";
  $("#selBuildings").textContent=Object.values(t.buildings).reduce((a,b)=>a+b,0);
  // actions
  const isOwn = t.ownerId===playerId;
  const canAttack = isOwn && t.troops>30;
  const allyOwner = t.ownerId && gameState.players[playerId]?.allies?.includes(t.ownerId);
  let actionsHtml="";
  if(isOwn){
    actionsHtml+=`<button ${!canAttack?"disabled":""} data-act="attack">⚔ Attack Neighbor</button>`;
    actionsHtml+=`<button data-act="center">◎ Center</button>`;
  } else {
    // if we have selected own source, this panel shows target info
    const srcSel = selectedId ? gameState.territories[selectedId] : null;
    // Actually we are showing target; add attack button if we have own source? No, we show target details; attack is done via map click
    actionsHtml+=`<button data-act="focus">🔎 Focus</button>`;
    if(allyOwner) actionsHtml+=`<button data-act="break">💔 Break Alliance</button>`;
    else if(t.ownerId) actionsHtml+=`<button data-act="ally">🤝 Ally Request</button>`;
  }
  if(!t.isWater && isOwn) actionsHtml+=`<button data-act="build">🏙 Buildings</button>`;
  // Naval/missile
  if(isOwn && t.buildings.silo>0) actionsHtml+=`<button data-act="missile">🚀 Missile</button>`;
  $("#selActions").innerHTML=actionsHtml;
  $("#selActions").querySelectorAll("button").forEach(b=>{
    b.onclick=()=>{
      const act=b.dataset.act;
      if(act==="attack") toast("Click a neighboring enemy territory to attack");
      if(act==="center") centerOnOwn();
      if(act==="focus"){ camera.tx=t.x; camera.ty=t.y; }
      if(act==="ally") send({type:"diplomacy", action:"request", targetId:t.ownerId});
      if(act==="break") send({type:"diplomacy", action:"break", targetId:t.ownerId});
      if(act==="build") {
        // scroll to build panel?
      }
      if(act==="missile"){
        // pick target: need to select target then missile? For now missile strikes selected enemy? If selected is own, need target picker
        // If selected own silo territory, we need to allow clicking enemy to missile strike.
        // We'll set a missile mode?
        enterMissileMode();
      }
    };
  });
  // build panel
  if(isOwn && !t.isWater){
    const bdefs = {
      city:{name:"City",icon:"🏙️",cost:100,desc:"Pop & economy"},
      factory:{name:"Factory",icon:"🏭",cost:120,desc:"Troops +40%"},
      port:{name:"Port",icon:"⚓",cost:150,desc:"Naval + trade",coastal:true},
      defense:{name:"Defense",icon:"🛡️",cost:80,desc:"+45% defense"},
      silo:{name:"Silo",icon:"🚀",cost:500,desc:"Missile"},
    };
    let html="";
    for(const [k,def] of Object.entries(bdefs)){
      const lvl=t.buildings[k]||0;
      const cost=Math.floor(def.cost*(1+lvl*0.6));
      const canAfford = gameState.players[playerId].gold>=cost;
      const disabled = lvl>=3 || (def.coastal && !t.coastal) || !canAfford || gameState.constructions.some(c=>c.territoryId===t.id);
      const constructing = gameState.constructions.find(c=>c.territoryId===t.id && c.building===k);
      html+=`<div class="build-card">
        <div class="icon">${def.icon}</div>
        <div class="meta"><b>${def.name} Lv.${lvl}</b><small>${def.desc} • ${cost} gold${constructing?` • ${(constructing.progress*100).toFixed(0)}%`:""}</small></div>
        <button ${disabled?"disabled":""} data-build="${k}">${lvl===0?"Build":"Upgrade"}</button>
      </div>`;
    }
    $("#buildPanel").innerHTML=html;
    $("#buildPanel").querySelectorAll("button").forEach(b=>{
      b.onclick=()=>{
        const building=b.dataset.build;
        send({type:"build", territoryId:t.id, building});
        playSfx("build");
      };
    });
    // also show queue progress bar?
  } else {
    $("#buildPanel").innerHTML="";
  }
  // context help
  let help="";
  if(t.isWater) help="Water — naval routes pass here. Ports enable control.";
  else if(!isOwn) help= t.ownerId? `Enemy territory. Select your own source then click here to attack (${allyOwner?"Allied — cannot attack":"Reachable if adjacent or via Port"})` : "Neutral territory — good for expansion. Attack from neighbor.";
  else help="You own this. Use slider to set commitment, then click neighbor to attack. Build to grow.";
  $("#contextHelp").textContent=help;
}

let missileMode=false;
function enterMissileMode(){
  missileMode=true;
  toast("Missile mode: click enemy territory to strike (5s warning)");
  setTimeout(()=>missileMode=false, 8000);
}
// Radial menu
function showRadial(x,y, territoryId){
  const el=$("#radial");
  if(!el || !territoryId) return;
  el.style.left=x+"px";
  el.style.top=y+"px";
  el.classList.remove("hidden");
  el.dataset.terr=territoryId;
  // disable port if not coastal
  const terr=gameState?.territories[territoryId];
  const portBtn=el.querySelector('[data-radial="port"]');
  if(portBtn) portBtn.style.opacity = (terr && terr.coastal)?"1":"0.35";
}
function hideRadial(){
  const el=$("#radial");
  if(el) el.classList.add("hidden");
}
document.addEventListener("click", e=>{
  const rad=$("#radial");
  if(rad && !rad.classList.contains("hidden") && !rad.contains(e.target)){
    hideRadial();
  }
});
if($("#radial")){
  $("#radial").querySelectorAll("button").forEach(btn=>{
    btn.onclick=(e)=>{
      e.stopPropagation();
      const act=btn.dataset.radial;
      const tid=$("#radial").dataset.terr;
      if(act==="close"){ hideRadial(); return; }
      if(!tid || !gameState) return;
      const terr=gameState.territories[tid];
      if(!terr) return;
      if(terr.ownerId!==playerId){ toast("You don't own this territory",true); hideRadial(); return; }
      send({type:"build", territoryId:tid, building:act});
      playSfx("build");
      notify(`Building ${act} in ${terr.name}`);
      hideRadial();
    };
  });
}
// Hook missile mode into canvas click already handled? Need intercept
const origCanvasClick = canvas.onclick;
canvas.addEventListener("click", e=>{
  if(missileMode && gameState){
    const pos=screenToWorld(e.clientX,e.clientY);
    const tid=pickTerritory(pos.x,pos.y);
    if(tid){
      send({type:"missile", targetId:tid});
      missileMode=false;
      playSfx("alert");
      e.stopImmediatePropagation();
    }
  }
}, true);

// Mobile dock
$$(".dock-btn").forEach(b=>{
  b.onclick=()=>{
    const act=b.dataset.act;
    if(act==="attack") toast("Select source then tap enemy");
    if(act==="build"){
      document.querySelector('[data-tab="selected"]').click();
      if(!selectedId) toast("Select your territory first");
    }
    if(act==="diplo") document.querySelector('[data-tab="diplo"]').click();
    if(act==="missile") enterMissileMode();
    if(act==="naval") toast("Build Port on coastal territory to enable naval assaults");
  };
});

// Events UI
let lastEventId=null;
function pushEventsToUI(){
  if(!gameState) return;
  const list=$("#eventList");
  // active attacks panel
  let attacksHtml="";
  if(gameState.attacks && gameState.attacks.length){
    attacksHtml = `<div style="display:grid;gap:6px;margin-bottom:10px"><b style="font-size:11px;letter-spacing:.1em;color:var(--muted)">ACTIVE OPERATIONS</b>`+
      gameState.attacks.filter(a=>a.attackerId===playerId).map(a=>{
        const tgt=gameState.territories[a.targetId];
        const src=gameState.territories[a.sourceId];
        return `<div class="evt attack" style="display:flex;justify-content:space-between;align-items:center">
          <span>${src?src.name:"?"} → ${tgt?tgt.name:a.targetId} • ${Math.floor(a.troops)} troops • ${(a.progress*100).toFixed(0)}%</span>
          <button class="btn ghost" style="padding:4px 8px;font-size:11px" data-retreat="${a.id}">Retreat</button>
        </div>`;
      }).join("")+`</div>`;
  }
  // render last 30 events newest first
  const evs = [...gameState.events].reverse();
  list.innerHTML=attacksHtml + evs.map(ev=>{
    const cls= ev.type||"info";
    const tidAttr = ev.territoryId? ` data-tid="${ev.territoryId}"` : "";
    return `<div class="evt ${cls}"${tidAttr} style="cursor:${ev.territoryId?"pointer":"default"}">${ev.message}<br><small>${new Date(ev.ts*1000).toLocaleTimeString()}</small></div>`;
  }).join("");
  // click to focus
  list.querySelectorAll("[data-tid]").forEach(el=>{
    el.onclick=()=>{
      const tid=el.dataset.tid;
      const terr=gameState.territories[tid];
      if(terr){ camera.tx=terr.x; camera.ty=terr.y; toast(`Focused on ${terr.name}`); }
    };
  });
  list.querySelectorAll("[data-retreat]").forEach(b=>{
    b.onclick=()=>{
      send({type:"cancel_attack", attackId:b.dataset.retreat});
      toast("Retreating…");
    };
  });
  // also push notifications for new events
  const newest = gameState.events[gameState.events.length-1];
  if(newest && newest.id!==lastEventId){
    lastEventId=newest.id;
    if(newest.important || ["capture","attack","missile_warning","missile_impact","naval"].includes(newest.type)){
      notify(newest.message, newest.important);
      // subtle shake for important
      if(shakeEnabled && newest.important && window.navigator.vibrate) try{ navigator.vibrate(60);}catch{}
    }
  }
}
function updateDiplomacy(){
  if(!gameState){ $("#diploList").innerHTML=""; return; }
  const me=gameState.players[playerId];
  if(!me){ $("#diploList").innerHTML=""; return; }
  const rows=Object.values(gameState.players).filter(p=>p.id!==playerId).map(p=>{
    const allied = me.allies?.includes(p.id);
    return `<div class="diplo-row">
      <div><span class="dot" style="background:${p.color};display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px"></span><b>${p.name}</b> <small>${p.isBot?"Bot "+p.botDifficulty:"Player"} • ${p.territories} terr</small> ${allied?'<span class="ally">Allied</span>':''}</div>
      <div style="display:flex;gap:6px">
        ${allied? `<button class="btn ghost" data-break="${p.id}">Break</button>` : `<button class="btn" data-ally="${p.id}">Ally</button>`}
      </div>
    </div>`;
  }).join("");
  $("#diploList").innerHTML=rows||`<div class="empty">No other players</div>`;
  $("#diploList").querySelectorAll("[data-ally]").forEach(b=>b.onclick=()=>send({type:"diplomacy", action:"request", targetId:b.dataset.ally}));
  $("#diploList").querySelectorAll("[data-break]").forEach(b=>b.onclick=()=>send({type:"diplomacy", action:"break", targetId:b.dataset.break}));
}

function checkVictory(){
  if(!gameState) return;
  if(gameState.state==="finished" && gameState.winner){
    const winner=gameState.players[gameState.winner];
    const meWon = gameState.winner===playerId;
    $("#endScreen").classList.remove("hidden");
    $("#endTitle").textContent= meWon ? "Victory!" : (winner? `${winner.name} Wins` : "Match Ended");
    $("#endTitle").style.color= meWon ? "#7af0c0" : "#ff5a6a";
    const totalLand=Object.values(gameState.territories).filter(t=>!t.isWater).length;
    const statsHtml = Object.values(gameState.players).sort((a,b)=>b.territories-a.territories).map(p=>{
      const pct=(p.territories/totalLand*100).toFixed(1);
      return `<div class="lb-row ${p.id===playerId?"me":""}"><b>${p.name}</b><span>${p.territories} terr • ${pct}%</span><span>${Math.floor(p.gold)} gold • ${Math.floor(p.troops)} troops</span></div>`;
    }).join("");
    $("#endStats").innerHTML=statsHtml;
    // local high score
    try{
      const me=gameState.players[playerId];
      if(me){
        const rec=JSON.parse(localStorage.getItem("vanguard_stats")||"{}");
        rec.matches=(rec.matches||0)+1;
        if(meWon) rec.wins=(rec.wins||0)+1;
        rec.bestTerr=Math.max(rec.bestTerr||0, me.territories);
        rec.bestGold=Math.max(rec.bestGold||0, Math.floor(me.gold));
        rec.lastPct= (me.territories/totalLand*100).toFixed(1);
        localStorage.setItem("vanguard_stats", JSON.stringify(rec));
        // append local stats to endScreen
        $("#endStats").innerHTML += `<div style="margin-top:10px;padding:10px;background:#0f1b3d;border-radius:10px;border:1px dashed var(--border);font-size:12px">
          <b>Your Career</b> — Matches: ${rec.matches} • Wins: ${rec.wins||0} • Best Terr: ${rec.bestTerr} • Best Gold: ${rec.bestGold}
        </div>`;
      }
    }catch(e){}
    // play victory sound once
    if(!checkVictory.played){ playSfx(meWon?"victory":"defeat"); checkVictory.played=true; }
    // fetch online leaderboard to show
    fetch("/api/leaderboard").then(r=>r.json()).then(data=>{
      if(data && data.length){
        const html=`<div style="margin-top:10px"><b style="font-size:12px;letter-spacing:.08em;color:var(--muted)">ONLINE LEADERBOARD (WINS)</b>`+
          data.slice(0,5).map((e,i)=>`<div class="lb-row"><span>#${i+1} ${e.name}</span><span>${e.wins} wins • best ${e.bestTerr} terr</span></div>`).join("")+`</div>`;
        $("#endStats").insertAdjacentHTML("beforeend", html);
      }
    }).catch(()=>{});
  } else {
    $("#endScreen").classList.add("hidden");
    checkVictory.played=false;
  }
}
$("#btnRematch").onclick=()=>{
  // return to lobby
  showScreen("screen-lobby");
  $("#endScreen").classList.add("hidden");
};
$("#btnMenuReturn").onclick=()=>{
  send({type:"leave_lobby"});
  showScreen("screen-menu");
  $("#topStats").classList.add("hidden");
  $("#endScreen").classList.add("hidden");
};

// Rendering
function render(){
  requestAnimationFrame(render);
  const now=performance.now();
  const dt=Math.min(0.05, (now - (render.last||now))/1000 );
  render.last=now;
  handleKeys(dt);
  // camera lerp
  camera.x = lerp(camera.x, camera.tx, 0.08);
  camera.y = lerp(camera.y, camera.ty, 0.08);
  camera.zoom = lerp(camera.zoom, camera.tzoom, 0.08);

  const rect=canvas.getBoundingClientRect();
  const w=rect.width, h=rect.height;
  // clear
  ctx.clearRect(0,0,w,h);
  // ocean background gradient
  const oceanGrad=ctx.createLinearGradient(0,0,0,h);
  oceanGrad.addColorStop(0,"#08122e");
  oceanGrad.addColorStop(1,"#040a1e");
  ctx.fillStyle=oceanGrad;
  ctx.fillRect(0,0,w,h);
  // grid subtle
  ctx.strokeStyle="#0f1f4a44";
  ctx.lineWidth=1;
  const gridSize= 80*camera.zoom;
  // not needed heavy

  if(!gameState){
    // draw attract mode map preview?
    ctx.fillStyle="#9aa7d0";
    ctx.font="14px system-ui";
    ctx.textAlign="center";
    ctx.fillText("Connecting to Vanguard network…", w/2, h/2);
    return;
  }

  // Transform to world
  ctx.save();
  ctx.translate(w/2, h/2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  // Draw water territories (if hormuz map has water polys) as blue
  // Draw land shadows?
  // Draw territories
  const terrList=Object.values(gameState.territories);
  // Sort by isWater first, then owner for layering
  terrList.sort((a,b)=> (a.isWater? -1:1));

  // Draw connections faint (adjacency) maybe
  ctx.strokeStyle="#1a2a66aa";
  ctx.lineWidth=1;
  for(const t of terrList){
    if(t.isWater) continue;
    for(const nbId of t.neighbors){
      const nb=gameState.territories[nbId];
      if(!nb || nb.isWater) continue;
      // draw line halfway
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo( (t.x+nb.x)/2, (t.y+nb.y)/2 );
      ctx.stroke();
    }
  }

  // Draw each territory polygon
  for(const t of terrList){
    const poly=getPoly(t);
    const owner=gameState.players[t.ownerId];
    const isSelected = t.id===selectedId;
    const isHovered = t.id===hoveredId;
    const isAllied = owner && gameState.players[playerId]?.allies?.includes(owner.id);
    const isMe = t.ownerId===playerId;
    // fill
    if(t.isWater){
      ctx.fillStyle="#0a1f4a";
      ctx.strokeStyle="#0f2f6a";
      ctx.lineWidth=1.2;
    } else if(showTerrain){
      const terrColors={plains:"#2a3a2a",forest:"#1e3a1e",mountain:"#4a3728",desert:"#3a3520",arctic:"#2a3a4a"};
      ctx.fillStyle=terrColors[t.terrain]||"#2a3358";
      if(owner) ctx.fillStyle=owner.color+"cc";
      ctx.strokeStyle="#1a2a4a";
      ctx.lineWidth=1;
    } else {
      const baseColor = owner? owner.color : "#2a3358";
      // adjust brightness for terrain
      let fill=baseColor;
      if(!owner){
        fill="#1e274d";
      } else {
        // me brighter, ally slightly desaturated? keep
      }
      // coastal glow?
      ctx.fillStyle=fill;
      ctx.strokeStyle = isSelected? "#ffd166" : isHovered? "#ffffffaa" : isAllied? "#7af0c0" : owner? "#0a102a" : "#162042";
      ctx.lineWidth= isSelected? 3 : isMe? 2 : 1.2;
    }
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for(let i=1;i<poly.length;i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // building indicator small dots? We'll draw in separate pass

    // defense glow if building defense
    if(t.buildings.defense>0 && !t.isWater){
      ctx.fillStyle="#ffffff15";
      ctx.beginPath();
      ctx.arc(t.x, t.y, 18 + t.buildings.defense*3, 0, Math.PI*2);
      ctx.fill();
    }
    // selection pulse
    if(isSelected && !reduceMotion){
      const pulse = (Math.sin(now*0.004)+1)/2;
      ctx.strokeStyle=`rgba(255,209,102,${0.35+pulse*0.35})`;
      ctx.lineWidth= 4 + pulse*3;
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for(let i=1;i<poly.length;i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      ctx.stroke();
    }
    // hover highlight
    if(isHovered && !isSelected){
      ctx.fillStyle="#ffffff14";
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for(let i=1;i<poly.length;i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Hover attack preview (OpenFront-style: dashed line to hovered neighbor)
  if(selectedId && hoveredId && selectedId!==hoveredId && gameState){
    const src=gameState.territories[selectedId];
    const tgt=gameState.territories[hoveredId];
    if(src && tgt && src.ownerId===playerId && !tgt.isWater){
      const isNei=src.neighbors.includes(hoveredId);
      const hasPort=src.buildings.port>0;
      const navalOk=src.coastal && tgt.coastal && hasPort;
      if(isNei || navalOk){
        ctx.save();
        ctx.strokeStyle=navalOk?"#00d2ff88":"#ffd16688";
        ctx.lineWidth=2;
        ctx.setLineDash([4,6]);
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        if(navalOk){
          const mx=(src.x+tgt.x)/2, my=(src.y+tgt.y)/2 - 18;
          ctx.quadraticCurveTo(mx,my, tgt.x, tgt.y);
        } else {
          ctx.lineTo(tgt.x, tgt.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        // ghost troops preview
        const committed=Math.floor(src.troops*attackRatio);
        ctx.fillStyle="#ffd166aa";
        ctx.font="700 10px system-ui";
        ctx.textAlign="center";
        ctx.fillText(`→ ${committed}`, (src.x+tgt.x)/2, (src.y+tgt.y)/2 - 10);
        ctx.restore();
      }
    }
  }

  // Draw attacks
  for(const atk of (gameState.attacks||[])){
    const src=gameState.territories[atk.sourceId];
    const tgt=gameState.territories[atk.targetId];
    if(!src||!tgt) continue;
    const prog = atk.progress; // 0-1
    const isNaval=atk.isNaval;
    // route line dashed
    ctx.strokeStyle = isNaval ? "#00d2ffaa" : "#ff5a6aaa";
    ctx.lineWidth= isNaval? 3 : 2.5;
    ctx.setLineDash([6,4]);
    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    // for naval, add curve via sea? simple straight
    if(isNaval){
      const mx=(src.x+tgt.x)/2, my=(src.y+tgt.y)/2 - 20;
      ctx.quadraticCurveTo(mx,my, tgt.x, tgt.y);
    } else {
      ctx.lineTo(tgt.x, tgt.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // moving dot
    const travelX = isNaval? lerp(src.x, tgt.x, prog) : lerp(src.x, tgt.x, prog);
    const travelY = isNaval? lerp(src.y, tgt.y, prog) - Math.sin(prog*Math.PI)*22 : lerp(src.y, tgt.y, prog);
    // fluid front: stretch line from source toward target as progress increases (border sweep)
    if(prog>0.15){
      const frontProg = Math.min(1, (prog-0.15)/0.75);
      const fx = lerp(src.x, tgt.x, frontProg*0.92);
      const fy = isNaval? lerp(src.y, tgt.y, frontProg*0.92) - Math.sin(frontProg*Math.PI)*18 : lerp(src.y, tgt.y, frontProg*0.92);
      // sweep line perpendicular to direction
      const ang2 = Math.atan2(tgt.y-src.y, tgt.x-src.x);
      const perp = ang2 + Math.PI/2;
      const w = 18 + atk.troops/80;
      ctx.save();
      ctx.strokeStyle = (attacker? attacker.color : "#ff5a6a") + "66";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(fx + Math.cos(perp)*w, fy + Math.sin(perp)*w);
      ctx.lineTo(fx - Math.cos(perp)*w, fy - Math.sin(perp)*w);
      ctx.stroke();
      ctx.restore();
      // color blend target toward attacker as battle progresses (capture transition)
      if(prog>0.65){
        const blend = (prog-0.65)/0.35;
        const orig = tgt.isWater? "#0a1f4a" : (gameState.players[tgt.ownerId]?.color || "#1e274d");
        // we draw a translucent attacker color overlay on target polygon
        const polyTgt = getPoly(tgt);
        ctx.save();
        ctx.globalAlpha = blend*0.45;
        ctx.fillStyle = attacker? attacker.color : "#e74c3c";
        ctx.beginPath();
        ctx.moveTo(polyTgt[0][0], polyTgt[0][1]);
        for(let i=1;i<polyTgt.length;i++) ctx.lineTo(polyTgt[i][0], polyTgt[i][1]);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    // draw arrow head
    const ang = Math.atan2(tgt.y - src.y, tgt.x - src.x);
    ctx.save();
    ctx.translate(travelX, travelY);
    ctx.rotate(ang);
    // attacker color
    const attacker=gameState.players[atk.attackerId];
    ctx.fillStyle= attacker? attacker.color : "#ff5a6a";
    ctx.strokeStyle="#0b1020";
    ctx.lineWidth=1;
    // triangle arrow + circle for troops
    ctx.beginPath();
    ctx.arc(0,0, 8 + Math.min(6, atk.troops/120), 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
    // inner troops number
    ctx.fillStyle="white";
    ctx.font="700 9px system-ui";
    ctx.textAlign="center";
    ctx.textBaseline="middle";
    ctx.fillText(Math.floor(atk.troops), 0, 1);
    // arrow pointer
    ctx.fillStyle=ctx.fillStyle; // same
    ctx.beginPath();
    ctx.moveTo(10,0);
    ctx.lineTo(16, -4);
    ctx.lineTo(16, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // progress ring around target?
    if(prog>0.6){
      ctx.strokeStyle="#ffd166aa";
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.arc(tgt.x, tgt.y, 26, -Math.PI/2, -Math.PI/2 + Math.PI*2* ((prog-0.6)/0.4));
      ctx.stroke();
    }
    // combat pulses at target when close
    if(prog>0.78 && !reduceMotion && particlesEnabled){
      const pulse = (now*0.01)%1;
      ctx.strokeStyle=`rgba(255,90,106,${0.5-pulse*0.5})`;
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.arc(tgt.x, tgt.y, 18 + pulse*18, 0, Math.PI*2);
      ctx.stroke();
    }
  }

  // Draw constructions pulse
  for(const c of (gameState.constructions||[])){
    const t=gameState.territories[c.territoryId];
    if(!t) continue;
    const prog=c.progress;
    if(particlesEnabled){
      ctx.fillStyle=`rgba(122,240,192,${0.15+prog*0.15})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 20+prog*8, 0, Math.PI*2);
      ctx.fill();
      // progress arc
      ctx.strokeStyle="#7af0c0";
      ctx.lineWidth=3;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 22, -Math.PI/2, -Math.PI/2+Math.PI*2*prog);
      ctx.stroke();
    }
  }

  // Draw building icons on territories
  ctx.font="12px system-ui";
  ctx.textAlign="center";
  for(const t of terrList){
    if(t.isWater) continue;
    const labs=[];
    if(t.buildings.city>0) labs.push("🏙️".repeat(Math.min(2,t.buildings.city)));
    if(t.buildings.factory>0) labs.push("🏭");
    if(t.buildings.port>0) labs.push("⚓");
    if(t.buildings.defense>0) labs.push("🛡️".repeat(Math.min(2,t.buildings.defense)));
    if(t.buildings.silo>0) labs.push("🚀");
    if(labs.length){
      ctx.fillStyle="#0b1020cc";
      const txt=labs.join("");
      // measure?
      ctx.fillRect(t.x-18, t.y+14, 36, 14);
      ctx.fillStyle="white";
      ctx.fillText(txt, t.x, t.y+24);
    }
  }

  // Draw labels + troops
  for(const t of terrList){
    if(t.isWater){
      ctx.fillStyle="#5a7eff";
      ctx.font="600 10px system-ui";
      ctx.textAlign="center";
      ctx.fillText(t.name, t.x, t.y);
      continue;
    }
    // label
    // hide labels when zoomed out too far? Show but smaller
    const showLabel = camera.zoom>0.7 || t.ownerId===playerId || t.id===selectedId || t.id===hoveredId;
    if(showLabel){
      ctx.fillStyle="white";
      ctx.font=`${t.ownerId===playerId? "800":"600"} 11px system-ui`;
      ctx.textAlign="center";
      ctx.strokeStyle="#0b1020";
      ctx.lineWidth=3;
      ctx.strokeText(t.name, t.x, t.y-12);
      ctx.fillText(t.name, t.x, t.y-12);
    }
    // troops number
    ctx.fillStyle= t.ownerId===playerId ? "#ffd166" : t.ownerId? "white" : "#9aa7d0";
    ctx.font="800 12px system-ui";
    ctx.textAlign="center";
    ctx.strokeStyle="#0b1020";
    ctx.lineWidth=3;
    const troopStr = Math.floor(t.troops).toString();
    ctx.strokeText(troopStr, t.x, t.y+4);
    ctx.fillText(troopStr, t.x, t.y+4);
    // owner dot
    if(t.ownerId){
      const owner=gameState.players[t.ownerId];
      if(owner){
        ctx.fillStyle=owner.color;
        ctx.beginPath();
        ctx.arc(t.x, t.y+12, 4, 0, Math.PI*2);
        ctx.fill();
        ctx.strokeStyle="#0b1020";
        ctx.lineWidth=1;
        ctx.stroke();
      }
    }
  }

  // Missiles warnings
  // Could flash

  ctx.restore();
  drawMinimap();
  // perf
  frameCount++;
  const nowPerf=performance.now();
  if(nowPerf-lastFpsTime>500){
    perfFPS=Math.round(frameCount*1000/(nowPerf-lastFpsTime));
    frameCount=0; lastFpsTime=nowPerf;
    const el=$("#perfText");
    if(el) el.textContent=perfFPS+" FPS • "+Object.keys(gameState.territories).length+" terr";
  }

  // Screen shake if major event?
  // HUD already updated via interval
}
render();

// Audio
function ensureAudio(){
  if(audioCtx) return;
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  musicGain=audioCtx.createGain(); sfxGain=audioCtx.createGain();
  musicGain.gain.value=0.22; sfxGain.gain.value=0.5;
  musicGain.connect(audioCtx.destination);
  sfxGain.connect(audioCtx.destination);
}
function playSfx(type){
  if(!sfxEnabled) return;
  ensureAudio();
  if(audioCtx.state==="suspended") audioCtx.resume();
  const o=audioCtx.createOscillator(), g=audioCtx.createGain();
  o.connect(g); g.connect(sfxGain);
  const now=audioCtx.currentTime;
  if(type==="select"){ o.frequency.setValueAtTime(620,now); o.frequency.exponentialRampToValueAtTime(880,now+0.08); g.gain.setValueAtTime(0.18,now); g.gain.exponentialRampToValueAtTime(0.01,now+0.12); o.start(now); o.stop(now+0.12); }
  else if(type==="attack"){ o.frequency.setValueAtTime(180,now); o.frequency.linearRampToValueAtTime(90,now+0.18); g.gain.setValueAtTime(0.22,now); g.gain.exponentialRampToValueAtTime(0.01,now+0.22); o.start(now); o.stop(now+0.22); }
  else if(type==="build"){ o.frequency.setValueAtTime(440,now); o.frequency.setValueAtTime(550,now+0.08); g.gain.setValueAtTime(0.15,now); g.gain.linearRampToValueAtTime(0.01,now+0.3); o.start(now); o.stop(now+0.3); }
  else if(type==="alert"){ o.frequency.setValueAtTime(880,now); o.frequency.setValueAtTime(660,now+0.15); g.gain.setValueAtTime(0.2,now); g.gain.exponentialRampToValueAtTime(0.01,now+0.35); o.start(now); o.stop(now+0.35); }
  else if(type==="notif"){ o.frequency.setValueAtTime(520,now); g.gain.setValueAtTime(0.08,now); g.gain.exponentialRampToValueAtTime(0.01,now+0.12); o.start(now); o.stop(now+0.12); }
  else if(type==="victory"){ [523,659,784,1046].forEach((f,i)=>{ const oo=audioCtx.createOscillator(); const gg=audioCtx.createGain(); oo.frequency.value=f; oo.connect(gg); gg.connect(sfxGain); gg.gain.setValueAtTime(0.12,now+i*0.12); gg.gain.exponentialRampToValueAtTime(0.01,now+i*0.12+0.4); oo.start(now+i*0.12); oo.stop(now+i*0.12+0.45); }); return; }
  else if(type==="defeat"){ o.frequency.setValueAtTime(240,now); o.frequency.exponentialRampToValueAtTime(80,now+0.6); g.gain.setValueAtTime(0.18,now); g.gain.exponentialRampToValueAtTime(0.01,now+0.7); o.start(now); o.stop(now+0.7); }
  else { o.frequency.value=440; g.gain.setValueAtTime(0.05,now); g.gain.exponentialRampToValueAtTime(0.01,now+0.1); o.start(now); o.stop(now+0.1); }
}
let musicNodes=[];
function startMusic(){
  ensureAudio();
  if(audioCtx.state==="suspended") audioCtx.resume();
  stopMusic();
  // simple chill pad using oscillators
  const now=audioCtx.currentTime;
  // Create two detuned saw pads?
  const chords = [
    [110, 138.59, 164.81], // A minor
    [98, 123.47, 146.83],
    [130.81,164.81,196],
  ];
  let idx=0;
  function playChord(){
    if(!musicEnabled) return;
    const freqs=chords[idx%chords.length];
    freqs.forEach((f,i)=>{
      const o=audioCtx.createOscillator();
      const g=audioCtx.createGain();
      const filt=audioCtx.createBiquadFilter();
      o.type="sawtooth"; o.frequency.value=f;
      filt.type="lowpass"; filt.frequency.value=900;
      o.connect(filt); filt.connect(g); g.connect(musicGain);
      const a=audioCtx.currentTime;
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(0.07, a+2);
      g.gain.linearRampToValueAtTime(0.05, a+6);
      g.gain.linearRampToValueAtTime(0, a+8);
      o.start(a); o.stop(a+8.2);
    });
    idx++;
    setTimeout(playChord, 8200);
  }
  playChord();
  // also subtle percussive tick
  const tickInt=setInterval(()=>{
    if(!musicEnabled) return;
    const o=audioCtx.createOscillator(), g=audioCtx.createGain();
    o.frequency.value= 40; o.connect(g); g.connect(musicGain);
    g.gain.setValueAtTime(0.03, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.2);
    o.start(); o.stop(audioCtx.currentTime+0.2);
  }, 2100);
  musicNodes=[tickInt];
}
function stopMusic(){
  musicNodes.forEach(id=>clearInterval(id));
  musicNodes=[];
}

// Init
connect();
setTimeout(()=>{ if(musicEnabled) startMusic(); }, 800);
// Also resume audio on first interaction
document.body.addEventListener("click", ()=>{ if(audioCtx && audioCtx.state==="suspended") audioCtx.resume(); }, {once:true});

// Expose for debug
window._game={send, get state(){return gameState}};
