(() => {
  // NOTE: GitHub Pages is static. This build supports "joining" across tabs
  // on the SAME browser using BroadcastChannel. True cross-device multiplayer
  // needs a backend (WebSocket/Firebase/Supabase).

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const hintEl = document.getElementById("hint");
  const modal = document.getElementById("modal");
  const nameInput = document.getElementById("nameInput");
  const startBtn = document.getElementById("startBtn");
  const controlsText = document.getElementById("controlsText");
  const touch = document.getElementById("touch");

  canvas.setAttribute("tabindex","0");
  canvas.addEventListener("pointerdown", () => canvas.focus(), { passive:true });

  function resize(){
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(320, rect.width);
    const cssH = Math.max(240, rect.height);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  window.addEventListener("resize", resize, { passive:true });
  resize();

  const samuraiImg = new Image();
  let samuraiReady = false;
  samuraiImg.onload = () => samuraiReady = true;
  samuraiImg.onerror = () => samuraiReady = false;
  samuraiImg.src = "assets/samurai.png";

  const LANES = 4;
  const LANE_H = 90;
  const TRACK_H = LANES * LANE_H;

  const GRAVITY = 2600;
  const JUMP_V = 920;
  const RUN_SPEED = 320;
  const SPEED_GROWTH = 14;

  const GAP_BASE = 520;
  const GAP_DECAY = 0.995;

  const SPIKE_W = 26, SPIKE_H = 42;

  const COLORS = {1:"#47b8ff", 2:"#51e08a", 3:"#ff5a6f", 4:"#ffb14a"};

  const KEYMAP = {
    1: { left: "ArrowLeft", right: "ArrowRight", jump: "ArrowUp" },
    2: { left: "KeyA", right: "KeyD", jump: "KeyW" },
    3: { left: "KeyJ", right: "KeyL", jump: "KeyI" },
    4: { left: "Numpad4", right: "Numpad6", jump: "Numpad8" },
  };

  function controlsLabel(slot){
    const m = KEYMAP[slot];
    const pretty = (code) => {
      if (code.startsWith("Arrow")) return code.replace("Arrow","") + " Arrow";
      if (code.startsWith("Key")) return code.replace("Key","");
      if (code.startsWith("Numpad")) return "Numpad " + code.replace("Numpad","");
      return code;
    };
    return `${pretty(m.left)} / ${pretty(m.right)} to move, ${pretty(m.jump)} to jump`;
  }

  const CPU_NAMES = ["Kenshin","Hanzo","Musashi","Yoshi","Akira","Ryu","Sora","Takeshi","Kaito","Ren","Kaede","Aiko","Hikari","Mika","Yuna","Kira","Rei","Nobu","Shin","Daichi"];
  function randomCpuName(used){
    const pool = CPU_NAMES.filter(n => !used.has(n));
    if (pool.length) return pool[Math.floor(Math.random()*pool.length)];
    return "CPU-" + Math.floor(Math.random()*9999);
  }
  function rand(min,max){ return Math.random()*(max-min)+min; }

  const room = new URLSearchParams(location.search).get("room") || "default";
  const bc = ("BroadcastChannel" in window) ? new BroadcastChannel("samurai-bob-room-" + room) : null;
  const myTabId = Math.random().toString(16).slice(2);

  const players = [];
  const obstacles = [];
  let time = 0;
  let started = false;

  let mySlot = null;
  let myName = "";
  let camX = 0;

  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"].includes(e.code)) e.preventDefault();
    keys.add(e.code);
  }, { passive:false });
  window.addEventListener("keyup", (e) => keys.delete(e.code), { passive:true });

  const touchState = { left:false, right:false, jump:false };
  function bindTouch(btn, act){
    const set = (v) => {
      if (act==="left") touchState.left=v;
      if (act==="right") touchState.right=v;
      if (act==="jump") touchState.jump=v;
    };
    btn.addEventListener("pointerdown", (e)=>{ e.preventDefault(); set(true); }, { passive:false });
    btn.addEventListener("pointerup", (e)=>{ e.preventDefault(); set(false); }, { passive:false });
    btn.addEventListener("pointercancel", ()=>set(false), { passive:true });
    btn.addEventListener("pointerleave", ()=>set(false), { passive:true });
  }
  if (touch){
    touch.querySelectorAll(".btn").forEach(b=>{
      const act=b.getAttribute("data-act");
      bindTouch(b, act);
    });
  }

  function laneTop(slot){ return (slot-1)*LANE_H; }
  function groundY(slot){ return laneTop(slot) + (LANE_H - 16); }

  function makePlayer(slot, name, isCpu){
    return {
      slot, name, isCpu,
      color: COLORS[slot],
      x: 140,
      y: laneTop(slot) + (LANE_H - 64),
      vy: 0,
      w: 44, h: 74,
      onGround: true,
      dead: false,
      distance: 0,
      cpuCooldown: 0
    };
  }

  function spawnObstacle(worldX){
    const kind = Math.random() < 0.65 ? "spike" : "knife";
    const h = kind==="spike" ? SPIKE_H : rand(50,90);
    const w = kind==="spike" ? SPIKE_W : rand(14,20);
    for (let slot=1; slot<=4; slot++){
      const y = groundY(slot) - h;
      obstacles.push({ x: worldX, y, w, h, kind, slot });
    }
  }

  function initWorld(){
    players.length=0;
    obstacles.length=0;
    time=0;
    camX=0;

    const used = new Set();
    if (myName) used.add(myName);

    for (let slot=1; slot<=4; slot++){
      if (slot===mySlot) players.push(makePlayer(slot, myName, false));
      else {
        const cpuName = randomCpuName(used);
        used.add(cpuName);
        players.push(makePlayer(slot, cpuName, true));
      }
    }

    let x=700;
    for (let k=0;k<7;k++){
      spawnObstacle(x);
      x += GAP_BASE + rand(-140,170);
    }
  }

  function readMyInput(){
    const m = KEYMAP[mySlot];
    return {
      left: keys.has(m.left) || touchState.left,
      right: keys.has(m.right) || touchState.right,
      jump: keys.has(m.jump) || keys.has("Space") || touchState.jump
    };
  }

  function cpuThink(p, dt, speed){
    if (p.cpuCooldown>0) p.cpuCooldown -= dt;
    const next = obstacles.find(o => o.slot===p.slot && o.x + o.w > p.x && o.x - p.x < 240);
    if (!next) return;
    const tHit = (next.x - p.x) / Math.max(1, speed);
    if (tHit < 0.36 && p.onGround && p.cpuCooldown<=0){
      p.vy = -JUMP_V;
      p.onGround = false;
      p.cpuCooldown = 0.25 + Math.random()*0.2;
    }
  }

  function aabb(ax,ay,aw,ah,bx,by,bw,bh){
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function drawSamurai(px,py,w,h,tint){
    if (samuraiReady){
      ctx.save();
      ctx.globalAlpha=0.98;
      ctx.drawImage(samuraiImg, px, py, w, h);
      ctx.globalCompositeOperation="source-atop";
      ctx.globalAlpha=0.26;
      ctx.fillStyle=tint;
      ctx.fillRect(px,py,w,h);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.fillStyle=tint;
    ctx.fillRect(px+12, py+18, w-24, h-18);
    ctx.beginPath(); ctx.arc(px+w/2, py+16, 12, 0, Math.PI*2); ctx.fill();
    ctx.fillRect(px+w/2-2, py+26, 4, 16);
    ctx.fillRect(px+w-10, py+30, 26, 4);
    ctx.restore();
  }

  function drawObstacle(o, sx, sy){
    ctx.save(); ctx.translate(sx,sy);
    if (o.kind==="spike"){
      ctx.beginPath();
      ctx.moveTo(0,o.h);
      ctx.lineTo(o.w/2,0);
      ctx.lineTo(o.w,o.h);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(0,0,o.w,o.h);
      ctx.fillRect(-6,o.h-14,o.w+12,6);
    }
    ctx.restore();
  }

  function broadcast(msg){
    if (!bc) return;
    bc.postMessage({ ...msg, _from: myTabId, _t: Date.now() });
  }

  function applyRemoteClaim(slot, name){
    const p = players.find(pp=>pp.slot===slot);
    if (!p) return;
    p.isCpu=false;
    if (name) p.name=name;
  }

  if (bc){
    bc.onmessage = (ev)=>{
      const msg = ev.data;
      if (!msg || msg._from===myTabId) return;
      if (msg.type==="claim" && started) applyRemoteClaim(msg.slot, msg.name);
    };
  }

  let selectedSlot = null;
  function updateStartEnabled(){
    const nameOk = (nameInput.value||"").trim().length>=1;
    startBtn.disabled = !(nameOk && selectedSlot);
    if (selectedSlot) controlsText.textContent = controlsLabel(selectedSlot);
  }

  document.querySelectorAll(".slot").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".slot").forEach(b=>b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedSlot = Number(btn.getAttribute("data-slot"));
      updateStartEnabled();
    });
  });
  nameInput.addEventListener("input", updateStartEnabled);

  const params = new URLSearchParams(location.search);
  const preSlot = Number(params.get("slot")||0);
  const preName = (params.get("name")||"").trim();
  if (preName) nameInput.value = preName;
  if (preSlot>=1 && preSlot<=4){
    const b = document.querySelector(`.slot[data-slot="${preSlot}"]`);
    if (b) b.click();
  }
  updateStartEnabled();

  startBtn.addEventListener("click", ()=>{
    myName = (nameInput.value||"Player").trim().slice(0,16);
    mySlot = selectedSlot;
    started = true;
    modal.style.display="none";
    canvas.focus();
    initWorld();
    broadcast({ type:"claim", slot: mySlot, name: myName });
  });

  let last = performance.now();
  function loop(now){
    const dt = Math.min(0.033, (now-last)/1000);
    last = now;

    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0,0,rect.width,rect.height);

    if (!started){
      hintEl.textContent = "Pick a slot + name. Click the game to enable arrow keys.";
      requestAnimationFrame(loop);
      return;
    }

    time += dt;
    const speed = RUN_SPEED + time*SPEED_GROWTH;
    const gapFactor = Math.pow(GAP_DECAY, time);

    const myInput = readMyInput();

    for (const p of players){
      if (p.dead) continue;

      let vx = speed;
      if (!p.isCpu && p.slot===mySlot){
        if (myInput.left) vx -= 110;
        if (myInput.right) vx += 110;
        if (myInput.jump && p.onGround){
          p.vy = -JUMP_V;
          p.onGround=false;
        }
      } else if (p.isCpu){
        cpuThink(p, dt, speed);
      }

      p.x += vx*dt;
      p.distance += vx*dt;

      p.vy += GRAVITY*dt;
      p.y += p.vy*dt;

      const gy = groundY(p.slot) - p.h;
      if (p.y>gy){
        p.y=gy; p.vy=0; p.onGround=true;
      }

      for (const o of obstacles){
        if (o.slot!==p.slot) continue;
        if (aabb(p.x,p.y,p.w,p.h,o.x,o.y,o.w,o.h)){ p.dead=true; break; }
      }
    }

    const leader = players.reduce((a,b)=> a.distance>b.distance ? a : b, players[0]);
    const lane1 = obstacles.filter(o=>o.slot===1);
    const lastObs = lane1[lane1.length-1];
    if (lastObs && (lastObs.x - leader.x) < 1150){
      const nextX = lastObs.x + (GAP_BASE*gapFactor) + rand(-150,190);
      spawnObstacle(nextX);
    }

    const me = players.find(p=>p.slot===mySlot);
    const follow = (me && !me.dead) ? me : leader;
    camX = follow.x - 180;

    while (obstacles.length && obstacles[0].x < camX - 800) obstacles.shift();

    ctx.fillStyle="rgba(0,0,0,0.18)";
    ctx.fillRect(0,0,rect.width,rect.height);

    const scaleY = rect.height / TRACK_H;

    for (let slot=1; slot<=4; slot++){
      const top = laneTop(slot)*scaleY;
      const h = LANE_H*scaleY;
      ctx.fillStyle="rgba(255,255,255,0.04)";
      ctx.fillRect(0,top,rect.width,h);
      if (slot!==1){
        ctx.strokeStyle="rgba(255,255,255,0.12)";
        ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(0,top); ctx.lineTo(rect.width,top); ctx.stroke();
      }
      ctx.fillStyle="rgba(255,255,255,0.75)";
      ctx.font="12px system-ui";
      ctx.fillText(`P${slot}`, 10, top+16);
    }

    ctx.fillStyle="rgba(255,90,90,0.95)";
    for (const o of obstacles){
      const sx = (o.x - camX);
      const sy = (o.y * scaleY);
      if (sx>-80 && sx<rect.width+80) drawObstacle(o, sx, sy);
    }

    for (const p of players){
      const sx = (p.x - camX);
      const sy = (p.y * scaleY);
      drawSamurai(sx, sy, p.w, p.h, p.color);

      ctx.fillStyle="rgba(0,0,0,0.55)";
      ctx.fillRect(sx-6, sy-18, 160, 16);

      ctx.fillStyle=p.color;
      ctx.font="12px system-ui";
      const role = p.isCpu ? "CPU" : "HUMAN";
      const status = p.dead ? "💀" : "⚔️";
      ctx.fillText(`${status} ${p.name} (${role})`, sx, sy-6);
    }

    const alive = players.filter(p=>!p.dead).length;
    const dist = me ? Math.floor(me.distance/10) : 0;
    hintEl.textContent = `You are P${mySlot} (${myName}) | Distance: ${dist}m | Alive: ${alive}/4 | Room: ${room}`;

    if (alive===0) initWorld();

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();