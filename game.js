(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const hintEl = document.getElementById("hint");
  const touch = document.getElementById("touch");

  // If canvas isn't found, show a useful error
  if (!canvas || !ctx) {
    const msg = "Canvas not found or 2D context failed. Check index.html has <canvas id='game'> and that game.js loads.";
    alert(msg);
    throw new Error(msg);
  }

  // --- Responsive canvas with devicePixelRatio ---
  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    // If height is 0 (common cause of black screen), force a fallback
    const cssW = Math.max(320, rect.width);
    const cssH = Math.max(240, rect.height);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize, { passive: true });
  resize();

  // --- Load a "realistic" samurai image if you add it ---
  // Put your file at: assets/samurai.png
  const samuraiImg = new Image();
  let samuraiReady = false;
  samuraiImg.onload = () => (samuraiReady = true);
  samuraiImg.onerror = () => (samuraiReady = false);
  samuraiImg.src = "assets/samurai.png";

  // --- World / lanes ---
  const LANES = 4;
  const LANE_H = 220;               // logical lane height in world units
  const GRAVITY = 2200;
  const JUMP_V = 840;
  const SPEED_BASE = 280;           // scroll speed
  const SPEED_GROWTH = 12;          // speed increases over time
  const OBSTACLE_BASE_GAP = 520;
  const OBSTACLE_GAP_DECAY = 0.995; // gets tighter over time
  const SPIKE_W = 26, SPIKE_H = 42;

  // Each player runs in their own endless lane (race).
  // We draw each lane as a separate "screen" (quadrant).
  const players = [];
  const obstacles = [[], [], [], []];
  let time = 0;
  let aliveCount = 4;

  function makePlayer(i) {
    return {
      id: i,
      x: 140,
      y: 0,
      vy: 0,
      w: 44,
      h: 74,
      onGround: true,
      score: 0,
      isHuman: i === 0,  // default: P1 human, others CPU (you can toggle on mobile)
      input: { left: false, right: false, jump: false },
      cpuJumpCooldown: 0,
      dead: false
    };
  }
  for (let i = 0; i < LANES; i++) players.push(makePlayer(i));

  function laneGroundY() {
    return LANE_H - 40;
  }

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function spawnObstacle(lane, worldX) {
    // mix spikes + knives (vertical blade) as difficulty grows
    const kind = Math.random() < 0.65 ? "spike" : "knife";
    const h = kind === "spike" ? SPIKE_H : rand(50, 90);
    const w = kind === "spike" ? SPIKE_W : rand(14, 20);
    const y = laneGroundY() - h;
    obstacles[lane].push({ x: worldX, y, w, h, kind });
  }

  // initial obstacles
  for (let lane = 0; lane < LANES; lane++) {
    let x = 600;
    for (let k = 0; k < 6; k++) {
      spawnObstacle(lane, x);
      x += OBSTACLE_BASE_GAP + rand(-120, 120);
    }
  }

  // --- Controls (Desktop) ---
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"].includes(e.code)) e.preventDefault();
  }, { passive: false });
  window.addEventListener("keyup", (e) => keys.delete(e.code), { passive: true });

  // Key maps per player (desktop)
  const keyMap = [
    { left: "ArrowLeft", right: "ArrowRight", jump: "ArrowUp" }, // P1
    { left: "KeyA",      right: "KeyD",      jump: "KeyW" },     // P2
    { left: "KeyJ",      right: "KeyL",      jump: "KeyI" },     // P3
    { left: "Numpad4",   right: "Numpad6",   jump: "Numpad8" },  // P4
  ];

  function readInputs() {
    for (let i = 0; i < LANES; i++) {
      const p = players[i];
      p.input.left = false;
      p.input.right = false;
      p.input.jump = false;

      if (!p.isHuman || p.dead) continue;

      const m = keyMap[i];
      p.input.left = keys.has(m.left);
      p.input.right = keys.has(m.right);
      p.input.jump = keys.has(m.jump) || keys.has("Space");
    }
  }

  // --- Touch controls (mobile) ---
  // Touch always controls P1; buttons can toggle P2/P3/P4 human on tablets if you want.
  const touchState = { left:false, right:false, jump:false };
  function bindTouchButton(btn, act) {
    const on = (v) => {
      if (act === "left") touchState.left = v;
      if (act === "right") touchState.right = v;
      if (act === "jump") touchState.jump = v;
    };
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); on(true); }, { passive:false });
    btn.addEventListener("pointerup",   (e) => { e.preventDefault(); on(false); }, { passive:false });
    btn.addEventListener("pointercancel",(e)=> { on(false); }, { passive:true });
    btn.addEventListener("pointerleave",(e)=> { on(false); }, { passive:true });
  }

  if (touch) {
    touch.querySelectorAll(".btn").forEach((b) => {
      const act = b.getAttribute("data-act");
      if (act === "left" || act === "right" || act === "jump") bindTouchButton(b, act);

      if (act === "toggleP2") b.addEventListener("click", () => players[1].isHuman = !players[1].isHuman);
      if (act === "toggleP3") b.addEventListener("click", () => players[2].isHuman = !players[2].isHuman);
      if (act === "toggleP4") b.addEventListener("click", () => players[3].isHuman = !players[3].isHuman);
    });
  }

  function applyTouchToP1() {
    const p1 = players[0];
    if (!p1.dead && p1.isHuman) {
      p1.input.left = touchState.left;
      p1.input.right = touchState.right;
      p1.input.jump = touchState.jump;
    }
  }

  // --- CPU logic ---
  function cpuThink(p, lane, dt, speed) {
    if (p.cpuJumpCooldown > 0) p.cpuJumpCooldown -= dt;

    // Look at the next obstacle in front
    const obs = obstacles[lane].find(o => o.x + o.w > p.x && o.x - p.x < 220);
    if (!obs) return;

    const dist = obs.x - p.x;
    const timeToHit = dist / Math.max(1, speed);
    const shouldJump = (timeToHit < 0.35);

    if (shouldJump && p.onGround && p.cpuJumpCooldown <= 0) {
      p.vy = -JUMP_V;
      p.onGround = false;
      p.cpuJumpCooldown = 0.25 + Math.random() * 0.18;
    }
  }

  // --- Collision ---
  function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // --- Drawing helpers ---
  function drawSamurai(px, py, w, h, tint) {
    if (samuraiReady) {
      ctx.save();
      ctx.globalAlpha = 0.98;
      ctx.drawImage(samuraiImg, px, py, w, h);
      ctx.globalCompositeOperation = "source-atop";
      ctx.globalAlpha = 0.20;
      ctx.fillStyle = tint;
      ctx.fillRect(px, py, w, h);
      ctx.restore();
      return;
    }

    // Fallback silhouette
    ctx.save();
    ctx.fillStyle = tint;
    ctx.fillRect(px + 12, py + 18, w - 24, h - 18); // body
    ctx.beginPath(); // head
    ctx.arc(px + w/2, py + 16, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(px + w/2 - 2, py + 26, 4, 16); // neck
    // katana
    ctx.fillRect(px + w - 10, py + 30, 26, 4);
    ctx.restore();
  }

  function drawObstacle(o) {
    if (o.kind === "spike") {
      ctx.beginPath();
      ctx.moveTo(o.x, o.y + o.h);
      ctx.lineTo(o.x + o.w/2, o.y);
      ctx.lineTo(o.x + o.w, o.y + o.h);
      ctx.closePath();
      ctx.fill();
    } else {
      // knife: thin blade + handle
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.fillRect(o.x - 6, o.y + o.h - 14, o.w + 12, 6);
    }
  }

  // --- Viewports (4 screens) ---
  function getViewports() {
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;
    const halfW = w / 2;
    const halfH = h / 2;
    return [
      { x: 0,     y: 0,     w: halfW, h: halfH }, // P1
      { x: halfW, y: 0,     w: halfW, h: halfH }, // P2
      { x: 0,     y: halfH, w: halfW, h: halfH }, // P3
      { x: halfW, y: halfH, w: halfW, h: halfH }, // P4
    ];
  }

  const tints = ["#7bd6ff", "#ffd27b", "#a7ff7b", "#ff7bd6"];

  // --- Game Loop ---
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    time += dt;

    readInputs();
    applyTouchToP1();

    const speed = SPEED_BASE + time * SPEED_GROWTH;
    const gapFactor = Math.pow(OBSTACLE_GAP_DECAY, time);

    // update each lane/player
    aliveCount = 0;
    for (let lane = 0; lane < LANES; lane++) {
      const p = players[lane];
      if (!p.dead) aliveCount++;

      if (!p.isHuman && !p.dead) cpuThink(p, lane, dt, speed);

      // Horizontal run (endless)
      let vx = speed;
      if (p.isHuman) {
        if (p.input.left) vx -= 90;
        if (p.input.right) vx += 90;
      }
      p.x += vx * dt;
      p.score += vx * dt;

      // jump
      if (!p.dead && p.input.jump && p.onGround) {
        p.vy = -JUMP_V;
        p.onGround = false;
      }

      // gravity
      p.vy += GRAVITY * dt;
      p.y += p.vy * dt;

      // ground
      const gy = laneGroundY() - p.h;
      if (p.y > gy) {
        p.y = gy;
        p.vy = 0;
        p.onGround = true;
      }

      // Spawn more obstacles ahead
      const obsList = obstacles[lane];
      const lastObs = obsList[obsList.length - 1];
      if (lastObs && (lastObs.x - p.x) < 1100) {
        const nextX = lastObs.x + (OBSTACLE_BASE_GAP * gapFactor) + rand(-140, 160);
        spawnObstacle(lane, nextX);
      }

      // death check
      if (!p.dead) {
        for (const o of obsList) {
          if (aabb(p.x, p.y, p.w, p.h, o.x, o.y, o.w, o.h)) {
            p.dead = true;
            break;
          }
        }
      }

      // cleanup old obstacles (behind)
      while (obsList.length && obsList[0].x < p.x - 600) obsList.shift();
    }

    // draw
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    const vps = getViewports();

    for (let i = 0; i < LANES; i++) {
      const vp = vps[i];
      const p = players[i];

      ctx.save();
      ctx.beginPath();
      ctx.rect(vp.x, vp.y, vp.w, vp.h);
      ctx.clip();

      // background
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(vp.x, vp.y, vp.w, vp.h);

      // camera (follow player)
      const camX = p.x - 140;

      // floor
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      const floorY = vp.y + (vp.h - 36);
      ctx.fillRect(vp.x, floorY, vp.w, 36);

      // subtle grid
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let gx = 0; gx < vp.w; gx += 40) {
        ctx.beginPath();
        ctx.moveTo(vp.x + gx, vp.y);
        ctx.lineTo(vp.x + gx, vp.y + vp.h);
        ctx.stroke();
      }

      // obstacles
      ctx.fillStyle = "rgba(255,90,90,0.95)";
      for (const o of obstacles[i]) {
        const sx = vp.x + (o.x - camX);
        const sy = vp.y + (o.y) + (vp.h - LANE_H);
        if (sx > vp.x - 60 && sx < vp.x + vp.w + 60) {
          ctx.save();
          ctx.translate(sx, sy);
          drawObstacle({ ...o, x: 0, y: 0 });
          ctx.restore();
        }
      }

      // player
      const px = vp.x + (p.x - camX);
      const py = vp.y + (p.y) + (vp.h - LANE_H);
      drawSamurai(px, py, p.w, p.h, tints[i]);

      // HUD
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      const mode = p.isHuman ? "HUMAN" : "CPU";
      const status = p.dead ? "💀" : "⚔️";
      ctx.fillText(`P${i+1} ${status} ${mode}`, vp.x + 10, vp.y + 18);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillText(`Distance: ${Math.floor(p.score/10)}m`, vp.x + 10, vp.y + 36);

      // border
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 2;
      ctx.strokeRect(vp.x + 1, vp.y + 1, vp.w - 2, vp.h - 2);

      ctx.restore();
    }

    hintEl.textContent =
      `Desktop: P1 arrows, P2 WASD, P3 IJKL, P4 numpad 4/6/8 | Mobile: touch controls (P1) | Alive: ${aliveCount}/4`;

    // if all dead, restart
    if (aliveCount === 0) {
      time = 0;
      for (let i = 0; i < LANES; i++) {
        players[i] = makePlayer(i);
        obstacles[i].length = 0;
        let x = 600;
        for (let k = 0; k < 6; k++) { spawnObstacle(i, x); x += OBSTACLE_BASE_GAP + rand(-120, 120); }
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();