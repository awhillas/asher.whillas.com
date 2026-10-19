'use strict';
/* Horde Tower Defence v2
 * - Snake-like corridor of varying width, randomly generated each level on a grid.
 * - Enemies are physical bodies: they collide with each other, the corridor walls and towers.
 * - Towers can be built anywhere; towers inside the corridor are attacked by the horde.
 * All units below are in grid cells unless stated otherwise.
 */
(() => {
  // ---------------------------------------------------------------- config
  // Must match the mobile @media query in horde-v2.html.
  const IS_MOBILE = window.matchMedia('(max-width: 500px)').matches;
  const CELL = 24; // canvas px per cell; CSS scales the canvas to fit the window
  // Desktop: fixed 40 x 28 grid. Mobile: cells are twice the size a 40-column grid would have
  // at 360px (18 CSS px), and the grid is sized on load to fill the window between the HUD
  // and the screen-size footer.
  const MOBILE_CELL_CSS = 2 * 360 / 40;
  const [COLS, ROWS] = (() => {
    if (!IS_MOBILE) return [40, 28];
    const cols = Math.max(12, Math.floor(window.innerWidth / MOBILE_CELL_CSS));
    const cellCss = window.innerWidth / cols;
    const top = document.getElementById('stage').getBoundingClientRect().top;
    const footer = document.getElementById('dims').offsetHeight;
    return [cols, Math.max(16, Math.floor((window.innerHeight - top - footer) / cellCss))];
  })();
  const N = COLS * ROWS;
  const W = COLS * CELL, H = ROWS * CELL;

  const TOWER_COST = 50;                 // fixed on every level
  const SELL_REFUND = TOWER_COST / 2;
  const towerCost = () => TOWER_COST;
  const levelStartMoney = lvl => TOWER_COST * (lvl + 1); // exactly (level + 1) towers
  const START_LIVES = 20;
  const LEVEL_GOAL = 1000;          // target = level * LEVEL_GOAL
  const MAX_ENEMIES = 450;
  const TOWER_PATH_COST = 30;       // pathing cost for walking through a tower cell

  const TOWER = { range: 3.6, damage: 10, fireRate: 2.2, hp: 150, bulletSpeed: 12 };

  // Enemy types. The first 5 are size tiers: small = fast & fragile, large = slow, tough & hits
  // towers hard. The gunner shoots at towers in range like a tower does, at half the fire rate.
  // reward = money per kill. Radius must stay < 0.5 (spatial hash assumption).
  // weight = base spawn weight, grow = how much faster that weight grows per level.
  // hpGrowth = HP multiplier applied per level.
  // HP grows exponentially with size: HP_BASE * HP_FACTOR^tier -> 15, 33, 73, 160, 351
  const HP_BASE = 15, HP_FACTOR = 2.2;
  const sizeHp = tier => Math.round(HP_BASE * HP_FACTOR ** tier);
  const ENEMY_TYPES = [
    { name: 'Tiny',    r: 0.20, speed: 3.0,  hp: sizeHp(0), dps: 4,  reward: 5,  color: '#f7e05a', rim: '#7a6a10', weight: 30, grow: 0 },
    { name: 'Small',   r: 0.26, speed: 2.3,  hp: sizeHp(1), dps: 8,  reward: 10, color: '#f39c34', rim: '#7a4710', weight: 30, grow: 0.25 },
    { name: 'Medium',  r: 0.32, speed: 1.7,  hp: sizeHp(2), dps: 14, reward: 15, color: '#4cc25a', rim: '#1d5a26', weight: 22, grow: 0.5 },
    { name: 'Large',   r: 0.39, speed: 1.25, hp: sizeHp(3), dps: 24, reward: 20, color: '#b04ad8', rim: '#55206e', weight: 12, grow: 0.75 },
    { name: 'Huge',    r: 0.46, speed: 0.95, hp: sizeHp(4), dps: 40, reward: 25, color: '#4a4fd8', rim: '#1f2266', weight: 6,  grow: 1 },
    // gunners: rare on level 1 (weight 2), growing quickly each level (~4 at L2, ~6 at L3, ~10 at L5)
    { name: 'Gunner',  r: 0.33, speed: 1.4,  hp: 80,        dps: 10, reward: 50, color: '#ff2a2a', rim: '#6e0000', weight: 2,  grow: 3,
      gunner: true, hpGrowth: 1.10 },
  ];
  const GUNNER_FIRE_RATE = TOWER.fireRate / 2;

  const WAVE_INTERVAL = 20;          // seconds between single-type waves
  const WAVE_SPAWN_RATE = 6;         // enemies per second while a wave is pouring in
  const waveSize = () => 10 + 4 * S.level;

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  // ---------------------------------------------------------------- DOM
  const canvas = document.getElementById('game');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const bg = document.createElement('canvas');
  bg.width = W; bg.height = H;
  const bctx = bg.getContext('2d');

  const $ = id => document.getElementById(id);
  const ui = {
    level: $('level'), money: $('money'), target: $('target'), progress: $('progress'),
    lives: $('lives'), kills: $('kills'), alive: $('alive'), wave: $('wave'),
    pauseBtn: $('pauseBtn'), speedBtn: $('speedBtn'),
    banner: $('banner'), bannerText: $('bannerText'), startBtn: $('startBtn'),
    overlay: $('overlay'), ovTitle: $('ovTitle'), ovBody: $('ovBody'), ovBtn: $('ovBtn'),
  };

  // ---------------------------------------------------------------- grid data
  const walk = new Uint8Array(N);      // 1 = corridor
  const noBuild = new Uint8Array(N);   // entrance / exit mouths
  const goal = new Uint8Array(N);      // exit cells
  const entrance = new Uint8Array(N);
  const wallPen = new Float32Array(N); // pathing penalty near walls (keeps horde centred)
  const dist = new Float32Array(N);    // distance-to-exit field
  const flowX = new Float32Array(N);
  const flowY = new Float32Array(N);
  const towerAt = new Array(N).fill(null);
  let entranceCells = [];
  let exitDir = 1;

  const idx = (x, y) => y * COLS + x;
  const inB = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- game state
  const S = {
    level: 1, money: levelStartMoney(1), lives: START_LIVES, kills: 0,
    state: 'menu', // menu | ready | playing | paused | levelComplete | gameOver
    speed: 1, time: 0, spawnAcc: 0,
    waveTimer: WAVE_INTERVAL, waveNum: 0, waveType: 0, waveLeft: 0, waveAcc: 0, waveMsgT: 0,
    bonusMsg: '', bonusMsgT: 0, bonusUsed: false,
    enemies: [], towers: [], bullets: [], enemyBullets: [], particles: [], texts: [],
    hover: null,
  };
  const target = () => S.level * LEVEL_GOAL;

  // ================================================================ corridor generation
  function segDist(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const qx = a.x + dx * t, qy = a.y + dy * t;
    return { d: Math.hypot(px - qx, py - qy), t };
  }

  function tryGenerate() {
    walk.fill(0); noBuild.fill(0); goal.fill(0); entrance.fill(0);

    // as many lanes as fit with 7..10.5 rows between them (3 or 4 on the 28-row desktop grid)
    const marginY = 3.5;
    const minLanes = Math.ceil((ROWS - 2 * marginY) / 10.5) + 1;
    const maxLanes = Math.max(minLanes, Math.floor((ROWS - 2 * marginY) / 7) + 1);
    const lanes = minLanes + Math.floor(Math.random() * (maxLanes - minLanes + 1));
    const spacing = (ROWS - 2 * marginY) / (lanes - 1);
    const jit = clamp(0.8 + (spacing - 7) * (0.8 / 3.5), 0.8, 1.6); // vertical wiggle of a lane
    const maxR = Math.min(2.8, (spacing - 1.2 - 2 * jit) / 2); // half width cap so lanes never merge
    const minR = 1.0;
    const rr = (cap = maxR) => minR + Math.random() * (Math.max(minR, cap) - minR);
    const edgeCap = x => (x < 0 || x > COLS) ? maxR : Math.min(maxR, Math.min(x, COLS - x) - 1);

    const laneY = [];
    for (let i = 0; i < lanes; i++) laneY.push(marginY + i * spacing + rand(-0.4, 0.4));
    const turnX = [];
    for (let k = 0; k < lanes - 1; k++) {
      const off = rand(3.5, Math.max(3.5, Math.min(6.5, COLS * 0.2))); // narrow grids turn tighter
      turnX.push(k % 2 === 0 ? COLS - off : off);
    }

    // centre-line waypoints with a half-width each
    const pts = [];
    for (let i = 0; i < lanes; i++) {
      const right = i % 2 === 0;
      const y = laneY[i];
      const sx = i === 0 ? -3 : turnX[i - 1];
      const ex = i === lanes - 1 ? (right ? COLS + 3 : -3) : turnX[i];
      pts.push({ x: sx, y, r: rr(edgeCap(sx)) });
      const m = 2 + Math.floor(Math.random() * clamp(Math.round(Math.abs(ex - sx) / 8), 1, 3)); // fewer bends on short lanes
      for (let j = 1; j <= m; j++) {
        const t = j / (m + 1);
        pts.push({ x: sx + (ex - sx) * t + rand(-1.2, 1.2), y: y + rand(-jit, jit), r: rr() });
      }
      pts.push({ x: ex, y, r: rr(edgeCap(ex)) });
    }

    // rasterise: a cell is corridor if its centre lies within the interpolated half-width
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const px = x + 0.5, py = y + 0.5;
        for (let s = 0; s < pts.length - 1; s++) {
          const a = pts[s], b = pts[s + 1];
          const { d, t } = segDist(px, py, a, b);
          if (d <= a.r + (b.r - a.r) * t) { walk[idx(x, y)] = 1; break; }
        }
      }
    }

    // entrance (always left) and exit
    const exitRight = (lanes - 1) % 2 === 0;
    exitDir = exitRight ? 1 : -1;
    const exitX = exitRight ? COLS - 1 : 0;
    const band = maxR + jit + 1.5;
    entranceCells = [];
    let goalCount = 0;
    for (let y = 0; y < ROWS; y++) {
      if (walk[idx(0, y)] && Math.abs(y + 0.5 - laneY[0]) <= band) {
        entranceCells.push({ x: 0, y });
        entrance[idx(0, y)] = 1;
        noBuild[idx(0, y)] = 1;
        if (walk[idx(1, y)]) noBuild[idx(1, y)] = 1;
      }
      if (walk[idx(exitX, y)] && Math.abs(y + 0.5 - laneY[lanes - 1]) <= band) {
        goal[idx(exitX, y)] = 1; goalCount++;
        noBuild[idx(exitX, y)] = 1;
        if (walk[idx(exitX - exitDir, y)]) noBuild[idx(exitX - exitDir, y)] = 1;
      }
    }
    if (entranceCells.length < 2 || goalCount < 2) return false;

    // connectivity check
    const seen = new Uint8Array(N);
    const q = entranceCells.map(c => idx(c.x, c.y));
    q.forEach(i => (seen[i] = 1));
    let reached = false;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      if (goal[i]) reached = true;
      const x = i % COLS, y = (i / COLS) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (!inB(nx, ny)) continue;
        const n = idx(nx, ny);
        if (walk[n] && !seen[n]) { seen[n] = 1; q.push(n); }
      }
    }
    return reached;
  }

  function generateMap() {
    for (let a = 0; a < 200; a++) if (tryGenerate()) break;
    computeWallPenalty();
  }

  function computeWallPenalty() {
    const wd = new Int16Array(N).fill(-1);
    const q = [];
    for (let i = 0; i < N; i++) if (!walk[i]) { wd[i] = 0; q.push(i); }
    for (let i = 0; i < N; i++) {
      if (!walk[i] || entrance[i] || goal[i]) continue;
      const x = i % COLS, y = (i / COLS) | 0;
      if (x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) { wd[i] = 1; q.push(i); }
    }
    for (let h = 0; h < q.length; h++) {
      const i = q[h], x = i % COLS, y = (i / COLS) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!inB(nx, ny)) continue;
        const n = idx(nx, ny);
        if (wd[n] === -1) { wd[n] = wd[i] + 1; q.push(n); }
      }
    }
    for (let i = 0; i < N; i++) wallPen[i] = wd[i] === 1 ? 1.5 : wd[i] === 2 ? 0.4 : 0;
  }

  // ================================================================ flow field (Dijkstra from exit)
  const heapI = new Int32Array(N * 9), heapD = new Float32Array(N * 9);
  let hs = 0, popD = 0;
  function hpush(i, d) {
    let k = hs++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapD[p] <= d) break;
      heapI[k] = heapI[p]; heapD[k] = heapD[p]; k = p;
    }
    heapI[k] = i; heapD[k] = d;
  }
  function hpop() {
    const top = heapI[0]; popD = heapD[0];
    hs--;
    if (hs > 0) {
      const li = heapI[hs], ld = heapD[hs];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= hs) break;
        if (c + 1 < hs && heapD[c + 1] < heapD[c]) c++;
        if (heapD[c] >= ld) break;
        heapI[k] = heapI[c]; heapD[k] = heapD[c]; k = c;
      }
      heapI[k] = li; heapD[k] = ld;
    }
    return top;
  }

  // can a body step from (x,y) to (x+dx,y+dy)? diagonals may not cut wall/tower corners
  function canStep(x, y, dx, dy) {
    const nx = x + dx, ny = y + dy;
    if (!inB(nx, ny) || !walk[idx(nx, ny)]) return false;
    if (dx !== 0 && dy !== 0) {
      const a = idx(x + dx, y), b = idx(x, y + dy);
      if (!walk[a] || !walk[b] || towerAt[a] || towerAt[b]) return false;
    }
    return true;
  }

  function computeFlow() {
    dist.fill(Infinity);
    hs = 0;
    for (let i = 0; i < N; i++) if (goal[i]) { dist[i] = 0; hpush(i, 0); }
    while (hs > 0) {
      const i = hpop();
      if (popD > dist[i]) continue;
      const x = i % COLS, y = (i / COLS) | 0;
      const enter = (1 + wallPen[i]);
      const tcost = towerAt[i] ? TOWER_PATH_COST : 0;
      for (let d = 0; d < 8; d++) {
        const dx = DIRS[d][0], dy = DIRS[d][1];
        if (!canStep(x, y, dx, dy)) continue;
        const n = idx(x + dx, y + dy);
        const nd = popD + (d < 4 ? 1 : Math.SQRT2) * enter + tcost;
        if (nd < dist[n]) { dist[n] = nd; hpush(n, nd); }
      }
    }
    for (let i = 0; i < N; i++) {
      flowX[i] = 0; flowY[i] = 0;
      if (!walk[i]) continue;
      if (goal[i]) { flowX[i] = exitDir; continue; }
      const x = i % COLS, y = (i / COLS) | 0;
      let best = dist[i], bx = 0, by = 0;
      for (let d = 0; d < 8; d++) {
        const dx = DIRS[d][0], dy = DIRS[d][1];
        if (!canStep(x, y, dx, dy)) continue;
        const nd = dist[idx(x + dx, y + dy)];
        if (nd < best) { best = nd; bx = dx; by = dy; }
      }
      const l = Math.hypot(bx, by) || 1;
      flowX[i] = bx / l; flowY[i] = by / l;
    }
  }

  // bilinear sample of the flow field at a continuous position
  const fOut = { x: 0, y: 0 };
  function sampleFlow(px, py) {
    const fx = px - 0.5, fy = py - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    let vx = 0, vy = 0, ws = 0;
    for (let k = 0; k < 4; k++) {
      const cx = x0 + (k & 1), cy = y0 + (k >> 1);
      if (!inB(cx, cy)) continue;
      const i = idx(cx, cy);
      if (!walk[i] || dist[i] === Infinity) continue;
      const w = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty);
      vx += flowX[i] * w; vy += flowY[i] * w; ws += w;
    }
    if (ws < 1e-6) {
      const cx = clamp(Math.floor(px), 0, COLS - 1), cy = clamp(Math.floor(py), 0, ROWS - 1);
      const i = idx(cx, cy);
      vx = flowX[i]; vy = flowY[i];
    }
    const l = Math.hypot(vx, vy) || 1;
    fOut.x = vx / l; fOut.y = vy / l;
    return fOut;
  }

  // ================================================================ spatial hash for enemies
  const head = new Int32Array(N);
  let next = new Int32Array(1024);
  function buildHash() {
    const E = S.enemies;
    head.fill(-1);
    if (next.length < E.length) next = new Int32Array(E.length * 2);
    for (let i = 0; i < E.length; i++) {
      const e = E[i];
      const c = idx(clamp(Math.floor(e.x), 0, COLS - 1), clamp(Math.floor(e.y), 0, ROWS - 1));
      next[i] = head[c]; head[c] = i;
    }
  }

  // ================================================================ enemies
  // larger / special types become more common as levels go up
  function pickType() {
    let total = 0;
    const w = ENEMY_TYPES.map(t => {
      const v = t.weight * (1 + 0.35 * (S.level - 1) * t.grow);
      total += v;
      return v;
    });
    let r = Math.random() * total;
    for (let k = 0; k < w.length; k++) { r -= w[k]; if (r <= 0) return k; }
    return w.length - 1;
  }

  function spawnEnemy(type = pickType()) {
    if (!entranceCells.length) return false;
    const T = ENEMY_TYPES[type];
    const strengthMul = 1.05 ** (S.level - 1);
    const hpMul = (T.hpGrowth || 1.05) ** (S.level - 1);
    const speedMul = 1.01 ** (S.level - 1);
    for (let tries = 0; tries < 6; tries++) {
      const c = entranceCells[(Math.random() * entranceCells.length) | 0];
      const x = T.r + 0.05 + Math.random() * 0.8;
      const y = c.y + T.r + Math.random() * (1 - 2 * T.r);
      let ok = true;
      for (const o of S.enemies) {
        if (o.x > 3) continue;
        const rs = o.r + T.r;
        if ((o.x - x) ** 2 + (o.y - y) ** 2 < rs * rs) { ok = false; break; }
      }
      if (!ok) continue;
      S.enemies.push({
        type, x, y, vx: T.speed * 0.5, vy: 0, r: T.r,
        speed: T.speed * speedMul * rand(0.9, 1.1),
        hp: T.hp * hpMul, maxHp: T.hp * hpMul, dps: T.dps * strengthMul,
        color: T.color, rim: T.rim, dead: false, leaked: false, hitT: 0,
        gunner: !!T.gunner, cd: Math.random() / GUNNER_FIRE_RATE, aim: 0, reward: T.reward,
      });
      return true;
    }
    return false;
  }

  function moveEnemies(dt) {
    const k = Math.min(1, dt * 6);
    for (const e of S.enemies) {
      const f = sampleFlow(e.x, e.y);
      e.vx += (f.x * e.speed - e.vx) * k;
      e.vy += (f.y * e.speed - e.vy) * k;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      if (e.hitT > 0) e.hitT -= dt;
    }
  }

  // push overlapping enemies apart (heavier bodies move less)
  function separate() {
    const E = S.enemies;
    for (let i = 0; i < E.length; i++) {
      const a = E[i];
      const cx = Math.floor(a.x), cy = Math.floor(a.y);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const x = cx + ox, y = cy + oy;
          if (!inB(x, y)) continue;
          for (let j = head[idx(x, y)]; j !== -1; j = next[j]) {
            if (j <= i) continue;
            const b = E[j];
            let dx = b.x - a.x, dy = b.y - a.y;
            const rs = a.r + b.r;
            let d2 = dx * dx + dy * dy;
            if (d2 >= rs * rs) continue;
            if (d2 < 1e-10) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy; }
            const d = Math.sqrt(d2);
            const ov = rs - d, nx = dx / d, ny = dy / d;
            const ma = a.r * a.r, mb = b.r * b.r, mt = ma + mb;
            a.x -= nx * ov * (mb / mt); a.y -= ny * ov * (mb / mt);
            b.x += nx * ov * (ma / mt); b.y += ny * ov * (ma / mt);
          }
        }
      }
    }
  }

  // 0 = free, 1 = wall / outside, 2 = tower
  function blockedAt(cx, cy) {
    if (!inB(cx, cy)) return 1;
    const i = idx(cx, cy);
    if (!walk[i]) return 1;
    return towerAt[i] ? 2 : 0;
  }

  function resolveWalls(e, dt, applyDamage) {
    const x0 = Math.floor(e.x - e.r), x1 = Math.floor(e.x + e.r);
    const y0 = Math.floor(e.y - e.r), y1 = Math.floor(e.y + e.r);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const b = blockedAt(cx, cy);
        if (!b) continue;
        const qx = clamp(e.x, cx, cx + 1), qy = clamp(e.y, cy, cy + 1);
        const dx = e.x - qx, dy = e.y - qy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= e.r * e.r) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2), push = e.r - d;
          e.x += (dx / d) * push; e.y += (dy / d) * push;
        } else {
          // centre inside the block: eject through the nearest face
          const l = e.x - cx, r = cx + 1 - e.x, t = e.y - cy, bt = cy + 1 - e.y;
          const m = Math.min(l, r, t, bt);
          if (m === l) e.x = cx - e.r; else if (m === r) e.x = cx + 1 + e.r;
          else if (m === t) e.y = cy - e.r; else e.y = cy + 1 + e.r;
        }
        if (b === 2 && applyDamage) damageTower(towerAt[idx(cx, cy)], e.dps * dt);
      }
    }
  }

  function killEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    S.money += e.reward;
    S.kills++;
    burst(e.x, e.y, e.color, 8 + (e.r * 10) | 0);
    if (S.texts.length < 40) S.texts.push({ x: e.x, y: e.y - 0.3, text: '+$' + e.reward, life: 0.9, max: 0.9 });
  }

  // ================================================================ towers
  function canBuild(cx, cy) {
    if (!inB(cx, cy)) return false;
    const i = idx(cx, cy);
    if (towerAt[i] || noBuild[i]) return false;
    if (S.money < towerCost()) return false;
    for (const e of S.enemies) {
      const qx = clamp(e.x, cx, cx + 1), qy = clamp(e.y, cy, cy + 1);
      if ((e.x - qx) ** 2 + (e.y - qy) ** 2 < e.r * e.r) return false;
    }
    return true;
  }

  function buildTower(cx, cy) {
    if (!canBuild(cx, cy)) return;
    const i = idx(cx, cy);
    const t = {
      cx, cy, x: cx + 0.5, y: cy + 0.5, hp: TOWER.hp, maxHp: TOWER.hp,
      cd: 0, angle: -Math.PI / 2, hitT: 0, inCorridor: !!walk[i], dead: false,
      cost: towerCost(),
    };
    S.towers.push(t);
    towerAt[i] = t;
    S.money -= t.cost;
    if (t.inCorridor) computeFlow();
  }

  function removeTower(t, destroyed) {
    if (t.dead) return;
    t.dead = true;
    towerAt[idx(t.cx, t.cy)] = null;
    S.towers = S.towers.filter(o => o !== t);
    if (destroyed) burst(t.x, t.y, '#9aa6b4', 18);
    if (t.inCorridor) computeFlow();
  }

  function sellTower(cx, cy) {
    if (!inB(cx, cy)) return;
    const t = towerAt[idx(cx, cy)];
    if (!t) return;
    S.money += SELL_REFUND;
    S.texts.push({ x: t.x, y: t.y - 0.3, text: '+$' + SELL_REFUND, life: 0.9, max: 0.9 });
    removeTower(t, false);
  }

  function damageTower(t, amount) {
    if (!t || t.dead) return;
    t.hp -= amount;
    t.hitT = 0.12;
    if (t.hp <= 0) removeTower(t, true);
  }

  function findTarget(t) {
    const R = TOWER.range, R2 = R * R, E = S.enemies;
    let best = null, bestD = Infinity;
    const x0 = clamp(Math.floor(t.x - R), 0, COLS - 1), x1 = clamp(Math.floor(t.x + R), 0, COLS - 1);
    const y0 = clamp(Math.floor(t.y - R), 0, ROWS - 1), y1 = clamp(Math.floor(t.y + R), 0, ROWS - 1);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let j = head[idx(cx, cy)]; j !== -1; j = next[j]) {
          const e = E[j];
          if (e.dead || e.leaked) continue;
          if ((e.x - t.x) ** 2 + (e.y - t.y) ** 2 > R2) continue;
          const d = dist[idx(cx, cy)]; // the enemy furthest along the corridor
          if (d < bestD) { bestD = d; best = e; }
        }
      }
    }
    return best;
  }

  function updateTowers(dt) {
    for (const t of S.towers) {
      if (t.hitT > 0) t.hitT -= dt;
      t.cd -= dt;
      if (t.cd > 0) continue;
      const e = findTarget(t);
      if (!e) continue;
      t.angle = Math.atan2(e.y - t.y, e.x - t.x);
      t.cd = 1 / TOWER.fireRate;
      S.bullets.push({
        x: t.x + Math.cos(t.angle) * 0.4, y: t.y + Math.sin(t.angle) * 0.4,
        target: e, tx: e.x, ty: e.y, dmg: TOWER.damage, life: 2,
      });
    }
  }

  function updateBullets(dt) {
    const step = TOWER.bulletSpeed * dt;
    for (const b of S.bullets) {
      b.life -= dt;
      const alive = b.target && !b.target.dead && !b.target.leaked;
      if (alive) { b.tx = b.target.x; b.ty = b.target.y; }
      const dx = b.tx - b.x, dy = b.ty - b.y;
      const d = Math.hypot(dx, dy);
      if (d <= step + (alive ? b.target.r : 0)) {
        if (alive) {
          b.target.hp -= b.dmg;
          b.target.hitT = 0.08;
          if (b.target.hp <= 0) killEnemy(b.target);
        }
        b.life = 0;
      } else {
        b.x += (dx / d) * step; b.y += (dy / d) * step;
      }
    }
    S.bullets = S.bullets.filter(b => b.life > 0);
  }

  // ================================================================ gunner enemies
  // Gunners shoot the nearest tower in range with the same range / rate / damage / speed as towers.
  function updateGunners(dt) {
    if (!S.towers.length) return;
    const R2 = TOWER.range * TOWER.range;
    for (const e of S.enemies) {
      if (!e.gunner || e.dead || e.leaked) continue;
      e.cd -= dt;
      if (e.cd > 0) continue;
      let best = null, bestD = R2;
      for (const t of S.towers) {
        const d2 = (t.x - e.x) ** 2 + (t.y - e.y) ** 2;
        if (d2 <= bestD) { bestD = d2; best = t; }
      }
      if (!best) continue;
      e.aim = Math.atan2(best.y - e.y, best.x - e.x);
      e.cd = 1 / GUNNER_FIRE_RATE;
      S.enemyBullets.push({
        x: e.x + Math.cos(e.aim) * e.r, y: e.y + Math.sin(e.aim) * e.r,
        target: best, tx: best.x, ty: best.y, dmg: TOWER.damage, life: 2,
      });
    }
  }

  function updateEnemyBullets(dt) {
    const step = TOWER.bulletSpeed * dt;
    for (const b of S.enemyBullets) {
      b.life -= dt;
      const alive = b.target && !b.target.dead;
      if (alive) { b.tx = b.target.x; b.ty = b.target.y; }
      const dx = b.tx - b.x, dy = b.ty - b.y;
      const d = Math.hypot(dx, dy);
      if (d <= step + (alive ? 0.4 : 0)) {
        if (alive) damageTower(b.target, b.dmg);
        b.life = 0;
      } else {
        b.x += (dx / d) * step; b.y += (dy / d) * step;
      }
    }
    S.enemyBullets = S.enemyBullets.filter(b => b.life > 0);
  }

  // ================================================================ waves
  // Every WAVE_INTERVAL seconds a burst of a single enemy type pours in, on top of the normal
  // mixed trickle. Waves follow ENEMY_TYPES order: Tiny, Small, Medium, Large, Huge, Gunner,
  // then repeat from Tiny. Each level starts again at Tiny.
  const waveTypeFor = waveNum => (waveNum - 1) % ENEMY_TYPES.length;

  function updateWaves(dt) {
    S.waveTimer -= dt;
    if (S.waveMsgT > 0) S.waveMsgT -= dt;
    if (S.waveTimer <= 0) {
      S.waveTimer += WAVE_INTERVAL;
      S.waveNum++;
      S.waveType = waveTypeFor(S.waveNum);
      S.waveLeft += waveSize();
      S.waveMsgT = 2.5;
    }
    if (S.waveLeft <= 0) return;
    S.waveAcc += WAVE_SPAWN_RATE * dt;
    while (S.waveAcc >= 1 && S.waveLeft > 0 && S.enemies.length < MAX_ENEMIES) {
      if (!spawnEnemy(S.waveType)) { S.waveAcc = Math.min(S.waveAcc, 2); break; }
      S.waveAcc -= 1;
      S.waveLeft--;
    }
  }

  // ================================================================ effects
  function burst(x, y, color, n) {
    for (let i = 0; i < n && S.particles.length < 600; i++) {
      const a = Math.random() * Math.PI * 2, sp = rand(0.8, 3.5);
      const life = rand(0.3, 0.7);
      S.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, color, size: rand(2, 4) });
    }
  }

  function updateFx(dt) {
    for (const p of S.particles) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
    }
    S.particles = S.particles.filter(p => p.life > 0);
    for (const t of S.texts) { t.life -= dt; t.y -= dt * 0.8; }
    S.texts = S.texts.filter(t => t.life > 0);
  }

  // ================================================================ simulation step
  function step(dt) {
    S.time += dt;

    // horde spawning: rate climbs with level and with time spent in the level
    const rate = Math.min(10, 0.9 + 0.35 * (S.level - 1) + S.time * (0.015 + 0.006 * S.level));
    S.spawnAcc += rate * dt;
    while (S.spawnAcc >= 1 && S.enemies.length < MAX_ENEMIES) {
      if (!spawnEnemy()) { S.spawnAcc = Math.min(S.spawnAcc, 3); break; }
      S.spawnAcc -= 1;
    }
    updateWaves(dt);

    moveEnemies(dt);
    for (let it = 0; it < 2; it++) {
      buildHash();
      separate();
      for (const e of S.enemies) resolveWalls(e, dt, it === 0);
    }

    // leaking through the exit
    for (const e of S.enemies) {
      const cx = clamp(Math.floor(e.x), 0, COLS - 1), cy = clamp(Math.floor(e.y), 0, ROWS - 1);
      if (goal[idx(cx, cy)] && (exitDir > 0 ? e.x > COLS - 0.55 : e.x < 0.55)) {
        e.leaked = true;
        S.lives--;
        S.texts.push({ x: e.x - exitDir, y: e.y, text: '-1 life', life: 1.2, max: 1.2, color: '#ff6b6b' });
      }
    }

    buildHash();
    updateTowers(dt);
    updateBullets(dt);
    updateGunners(dt);
    updateEnemyBullets(dt);
    S.enemies = S.enemies.filter(e => !e.dead && !e.leaked);
    updateFx(dt);
    if (S.bonusMsgT > 0) S.bonusMsgT -= dt;
    checkEmergencyFunds();

    if (S.lives <= 0) { S.lives = 0; gameOver(); return; }
    if (S.money >= target()) levelComplete();
  }

  // Broke and no towers left: grant a random amount that buys between 2 and 10 towers.
  // Only once per level.
  function checkEmergencyFunds() {
    const cost = towerCost();
    if (S.bonusUsed || S.towers.length > 0 || S.money >= cost) return;
    S.bonusUsed = true;
    const n = 2 + Math.floor(Math.random() * 9);                 // 2..10 towers
    const total = n * cost + Math.floor(Math.random() * cost);   // still buys exactly n
    const grant = total - S.money;
    S.money = total;
    S.bonusMsg = `EMERGENCY FUNDS: +$${grant} (${n} towers)`;
    S.bonusMsgT = 3;
  }

  // ================================================================ level flow
  function setupLevel() {
    S.enemies = []; S.bullets = []; S.enemyBullets = []; S.particles = []; S.texts = [];
    S.towers = []; towerAt.fill(null);
    S.time = 0; S.spawnAcc = 0; S.lives = START_LIVES;
    S.waveTimer = WAVE_INTERVAL; S.waveNum = 0; S.waveLeft = 0; S.waveAcc = 0; S.waveMsgT = 0;
    S.bonusMsgT = 0; S.bonusUsed = false;
    S.money = levelStartMoney(S.level);
    generateMap();
    computeFlow();
    drawBackground();
    S.state = 'ready';
    hideOverlay();
    ui.bannerText.textContent =
      `Level ${S.level}: start with $${S.money}, reach $${target()} to win. Build towers, then start.`;
    ui.banner.classList.remove('hidden');
  }

  function startPlaying() {
    if (S.state !== 'ready') return;
    S.state = 'playing';
    ui.banner.classList.add('hidden');
  }

  function levelComplete() {
    S.state = 'levelComplete';
    showOverlay(`Level ${S.level} cleared!`,
      `<p>You reached <b>$${S.money}</b> (goal $${target()}).</p>
       <p>A new corridor awaits. Your towers are left behind and your money resets to
          <b>$${levelStartMoney(S.level + 1)}</b>.</p>
       <p>Next goal: <b>$${(S.level + 1) * LEVEL_GOAL}</b>. The horde gets tougher.</p>`,
      'Next Level', () => {
        S.level++;
        setupLevel();
      });
  }

  function gameOver() {
    S.state = 'gameOver';
    showOverlay('The horde broke through!',
      `<p>You reached level <b>${S.level}</b> with <b>${S.kills}</b> kills.</p>`,
      'Play Again', newGame);
  }

  function newGame() {
    S.level = 1; S.kills = 0; S.speed = 1;
    setupLevel();
  }

  function showOverlay(title, body, btn, fn) {
    ui.ovTitle.textContent = title;
    ui.ovBody.innerHTML = body;
    ui.ovBtn.textContent = btn;
    ui.ovBtn.onclick = fn;
    ui.overlay.classList.remove('hidden');
    ui.banner.classList.add('hidden');
  }
  function hideOverlay() { ui.overlay.classList.add('hidden'); }

  function togglePause() {
    if (S.state === 'ready') startPlaying();
    else if (S.state === 'playing') S.state = 'paused';
    else if (S.state === 'paused') S.state = 'playing';
  }

  // ================================================================ rendering
  function drawBackground() {
    const g = bctx;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = idx(x, y);
        const v = Math.random();
        if (walk[i]) g.fillStyle = `rgb(${104 + v * 14 | 0},${80 + v * 10 | 0},${54 + v * 8 | 0})`;
        else g.fillStyle = `rgb(${38 + v * 8 | 0},${70 + v * 14 | 0},${40 + v * 8 | 0})`;
        g.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
    // grass tufts and corridor pebbles
    for (let k = 0; k < N * 0.45; k++) {
      const x = Math.random() * COLS, y = Math.random() * ROWS;
      const i = idx(x | 0, y | 0);
      g.fillStyle = walk[i] ? 'rgba(60,44,28,0.5)' : 'rgba(90,140,70,0.45)';
      g.fillRect(x * CELL, y * CELL, walk[i] ? 2 : 1, walk[i] ? 2 : 3);
    }
    // grid lines
    g.strokeStyle = 'rgba(0,0,0,0.13)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= COLS; x++) { g.moveTo(x * CELL + 0.5, 0); g.lineTo(x * CELL + 0.5, H); }
    for (let y = 0; y <= ROWS; y++) { g.moveTo(0, y * CELL + 0.5); g.lineTo(W, y * CELL + 0.5); }
    g.stroke();
    // corridor rims
    g.fillStyle = '#2e2214';
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = idx(x, y);
        if (!walk[i]) continue;
        const px = x * CELL, py = y * CELL;
        const open = (nx, ny) => inB(nx, ny) ? walk[idx(nx, ny)] : (entrance[i] || goal[i]);
        if (!open(x - 1, y)) g.fillRect(px, py, 3, CELL);
        if (!open(x + 1, y)) g.fillRect(px + CELL - 3, py, 3, CELL);
        if (!open(x, y - 1)) g.fillRect(px, py, CELL, 3);
        if (!open(x, y + 1)) g.fillRect(px, py + CELL - 3, CELL, 3);
      }
    }
    // entrance / exit mouths
    for (let i = 0; i < N; i++) {
      if (!noBuild[i]) continue;
      const x = i % COLS, y = (i / COLS) | 0;
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
    g.font = 'bold 12px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const ey = entranceCells.reduce((s, c) => s + c.y + 0.5, 0) / entranceCells.length;
    g.fillStyle = '#7dff7d';
    g.fillText('IN ▶', 1 * CELL, ey * CELL - CELL * 0.9);
    let gy = 0, gc = 0, gx = 0;
    for (let i = 0; i < N; i++) if (goal[i]) { gy += ((i / COLS) | 0) + 0.5; gx = i % COLS; gc++; }
    g.fillStyle = '#ff6b6b';
    g.fillText(exitDir > 0 ? 'EXIT ▶' : '◀ EXIT', (gx + 0.5 - exitDir * 0.8) * CELL, (gy / gc) * CELL - CELL * 0.9);
  }

  function render() {
    ctx.drawImage(bg, 0, 0);

    // hover preview
    const h = S.hover;
    if (h && inB(h.x, h.y) && ['ready', 'playing', 'paused'].includes(S.state)) {
      const t = towerAt[idx(h.x, h.y)];
      const ok = canBuild(h.x, h.y);
      ctx.beginPath();
      ctx.arc((h.x + 0.5) * CELL, (h.y + 0.5) * CELL, TOWER.range * CELL, 0, Math.PI * 2);
      ctx.fillStyle = t ? 'rgba(120,180,255,0.08)' : ok ? 'rgba(120,255,120,0.08)' : 'rgba(255,90,90,0.06)';
      ctx.fill();
      ctx.strokeStyle = t ? 'rgba(120,180,255,0.5)' : ok ? 'rgba(120,255,120,0.45)' : 'rgba(255,90,90,0.35)';
      ctx.stroke();
      if (!t) {
        ctx.fillStyle = ok ? 'rgba(120,255,120,0.35)' : 'rgba(255,80,80,0.35)';
        ctx.fillRect(h.x * CELL, h.y * CELL, CELL, CELL);
      }
    }

    // towers
    for (const t of S.towers) {
      const px = t.cx * CELL, py = t.cy * CELL;
      ctx.fillStyle = t.hitT > 0 ? '#c9554f' : t.inCorridor ? '#6b6f78' : '#566577';
      ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
      ctx.strokeStyle = t.inCorridor ? '#e08a3c' : '#1f2a35';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 3, py + 3, CELL - 6, CELL - 6);
      const cx = px + CELL / 2, cy = py + CELL / 2;
      ctx.strokeStyle = '#1b222b'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(t.angle) * CELL * 0.48, cy + Math.sin(t.angle) * CELL * 0.48); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, CELL * 0.24, 0, Math.PI * 2);
      ctx.fillStyle = '#cfd8e3'; ctx.fill();
      if (t.hp < t.maxHp) {
        const f = Math.max(0, t.hp / t.maxHp);
        ctx.fillStyle = '#111'; ctx.fillRect(px + 2, py - 4, CELL - 4, 3);
        ctx.fillStyle = f > 0.5 ? '#5cd65c' : f > 0.25 ? '#f0b429' : '#e0564a';
        ctx.fillRect(px + 2, py - 4, (CELL - 4) * f, 3);
      }
    }

    // enemies
    ctx.lineWidth = 1.5;
    for (const e of S.enemies) {
      const px = e.x * CELL, py = e.y * CELL, r = e.r * CELL;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = e.hitT > 0 ? '#ffffff' : e.color; ctx.fill();
      ctx.strokeStyle = e.rim; ctx.stroke();
      if (e.gunner) {
        // gun barrel pointing at its last target
        ctx.strokeStyle = '#2a0000'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(e.aim) * r * 1.5, py + Math.sin(e.aim) * r * 1.5); ctx.stroke();
        ctx.lineWidth = 1.5;
      }
      // eyes facing movement direction
      const a = Math.atan2(e.vy, e.vx);
      ctx.fillStyle = '#111';
      for (const s of [-0.5, 0.5]) {
        ctx.fillRect(px + Math.cos(a + s) * r * 0.55 - 1, py + Math.sin(a + s) * r * 0.55 - 1, 2, 2);
      }
      if (e.hp < e.maxHp) {
        const f = Math.max(0, e.hp / e.maxHp);
        ctx.fillStyle = '#111'; ctx.fillRect(px - r, py - r - 4, r * 2, 2);
        ctx.fillStyle = '#5cd65c'; ctx.fillRect(px - r, py - r - 4, r * 2 * f, 2);
      }
    }

    // bullets
    ctx.fillStyle = '#ffe873';
    for (const b of S.bullets) ctx.fillRect(b.x * CELL - 2, b.y * CELL - 2, 4, 4);
    ctx.fillStyle = '#ff4040';
    for (const b of S.enemyBullets) ctx.fillRect(b.x * CELL - 2, b.y * CELL - 2, 4, 4);

    // particles
    for (const p of S.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x * CELL - p.size / 2, p.y * CELL - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // floating texts
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const t of S.texts) {
      ctx.globalAlpha = Math.max(0, t.life / t.max);
      ctx.fillStyle = t.color || '#ffd54a';
      ctx.fillText(t.text, t.x * CELL, t.y * CELL);
    }
    ctx.globalAlpha = 1;

    // wave announcement
    if (S.waveMsgT > 0) {
      const T = ENEMY_TYPES[S.waveType];
      ctx.globalAlpha = Math.min(1, S.waveMsgT);
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      const msg = `WAVE ${S.waveNum}: ${T.name.toUpperCase()} x${waveSize()}`;
      ctx.strokeText(msg, W / 2, 40);
      ctx.fillStyle = T.color;
      ctx.fillText(msg, W / 2, 40);
      ctx.globalAlpha = 1;
    }

    // emergency funds announcement
    if (S.bonusMsgT > 0) {
      ctx.globalAlpha = Math.min(1, S.bonusMsgT);
      ctx.font = `bold ${Math.min(24, W / 22) | 0}px system-ui, sans-serif`; // fit narrow grids
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(S.bonusMsg, W / 2, 80);
      ctx.fillStyle = '#ffd54a';
      ctx.fillText(S.bonusMsg, W / 2, 80);
      ctx.globalAlpha = 1;
    }

    if (S.state === 'paused') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 32px system-ui, sans-serif';
      ctx.fillText('PAUSED', W / 2, H / 2);
    }
  }

  // ================================================================ HUD
  const hudCache = {};
  function setText(el, key, v) { if (hudCache[key] !== v) { hudCache[key] = v; el.textContent = v; } }
  function updateHud() {
    setText(ui.level, 'level', String(S.level));
    setText(ui.money, 'money', '$' + S.money);
    setText(ui.target, 'target', '$' + target());
    setText(ui.lives, 'lives', String(S.lives));
    setText(ui.kills, 'kills', String(S.kills));
    setText(ui.alive, 'alive', String(S.enemies.length));
    setText(ui.wave, 'wave', Math.ceil(S.waveTimer) + 's');
    setText(ui.pauseBtn, 'pause', S.state === 'paused' ? 'Resume' : S.state === 'ready' ? 'Start' : 'Pause');
    setText(ui.speedBtn, 'speed', 'Speed x' + S.speed);
    const buildCost = towerCost();
    setText($('buildCost'), 'buildCost', '$' + buildCost);
    setText($('sellRefund'), 'sellRefund', '$' + Math.floor(buildCost / 2));
    const pct = Math.min(100, (S.money / target()) * 100).toFixed(1) + '%';
    if (hudCache.pct !== pct) { hudCache.pct = pct; ui.progress.style.width = pct; }
  }

  // ================================================================ input
  function cellFromEvent(ev) {
    const r = canvas.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    const y = ((ev.clientY - r.top) / r.height) * H;
    return { x: Math.floor(x / CELL), y: Math.floor(y / CELL) };
  }
  const canInteract = () => S.state === 'ready' || S.state === 'playing' || S.state === 'paused';

  // pointer events cover mouse and touch; touch has no hover, so a tap shows the preview briefly
  let hoverTimer = 0;
  canvas.addEventListener('pointermove', ev => { if (ev.pointerType === 'mouse') S.hover = cellFromEvent(ev); });
  canvas.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse') S.hover = null; });
  canvas.addEventListener('pointerdown', ev => {
    if (!canInteract()) return;
    const c = cellFromEvent(ev);
    if (ev.button !== 0 && ev.button !== 2) return;
    if (ev.pointerType !== 'mouse') {
      S.hover = c;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => { S.hover = null; }, 900);
    }
    if (ev.button === 0) buildTower(c.x, c.y);
    else if (ev.button === 2) sellTower(c.x, c.y);
  });
  canvas.addEventListener('contextmenu', ev => ev.preventDefault());

  ui.pauseBtn.addEventListener('click', togglePause);
  ui.startBtn.addEventListener('click', startPlaying);
  ui.speedBtn.addEventListener('click', () => { S.speed = S.speed >= 3 ? 1 : S.speed + 1; });
  window.addEventListener('keydown', ev => {
    if (ev.code === 'Space') { ev.preventDefault(); if (canInteract()) togglePause(); }
    else if (ev.code === 'KeyF') S.speed = S.speed >= 3 ? 1 : S.speed + 1;
  });

  // ================================================================ main loop
  const DT = 1 / 60;
  let last = performance.now(), acc = 0;
  function frame(now) {
    const el = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (S.state === 'playing') {
      acc += el * S.speed;
      let steps = 0;
      while (acc >= DT && steps < 12) {
        step(DT);
        acc -= DT; steps++;
        if (S.state !== 'playing') { acc = 0; break; }
      }
    } else {
      acc = 0;
    }
    render();
    updateHud();
    requestAnimationFrame(frame);
  }

  // ================================================================ fit to window
  // Scale the canvas (via CSS) so the whole UI fits the viewport without scrolling.
  const appEl = $('app');
  function fitToWindow() {
    for (let pass = 0; pass < 2; pass++) { // HUD may re-wrap at a new width, so measure twice
      const chrome = appEl.offsetHeight - canvas.offsetHeight;
      const scale = IS_MOBILE
        ? Math.min(window.innerWidth / W, (window.innerHeight - chrome) / H) // edge to edge
        : Math.min((window.innerWidth - 16) / W, (window.innerHeight - chrome - 2) / H, 1.5);
      appEl.style.width = Math.max(240, Math.floor(W * scale)) + 'px';
    }
  }
  // footer: current screen size and grid, handy when testing the mobile layout
  function showDims() {
    $('dims').textContent =
      `Screen ${window.innerWidth} × ${window.innerHeight} · grid ${COLS} × ${ROWS}${IS_MOBILE ? ' · mobile' : ''}`;
  }
  window.addEventListener('resize', () => { fitToWindow(); showDims(); });

  // ================================================================ boot
  generateMap();
  computeFlow();
  drawBackground();
  showOverlay('Horde Tower Defence v2',
    `<p>Hordes march down a winding corridor.</p>
     <p>Click to place towers to stop them</p>
     <p>Have Fun!</p>`,
    'Play', newGame);
  showDims();
  fitToWindow();
  requestAnimationFrame(frame);
})();
