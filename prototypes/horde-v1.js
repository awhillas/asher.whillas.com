"use strict";

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const TILE = 32;
const COLS = WIDTH / TILE;
const ROWS = HEIGHT / TILE;
const TOWER_COST = 50;
const STARTING_CASH = 150;
const MAX_CORE = 20;
const ENEMY_RADIUS = 8;
const GRID = Array.from({ length: ROWS }, () => Array(COLS).fill(0));

const ui = {
    level: document.getElementById("levelValue"),
    money: document.getElementById("moneyValue"),
    health: document.getElementById("healthValue"),
    wave: document.getElementById("waveValue"),
    goalAmount: document.getElementById("goalAmount"),
    goalFill: document.getElementById("goalFill"),
    pause: document.getElementById("pauseButton"),
    speed: document.getElementById("speedButton"),
};

const game = {
    level: 1,
    cash: STARTING_CASH,
    core: MAX_CORE,
    bountyEarned: 0,
    wave: 1,
    spawnedThisWave: 0,
    waveSize: 22,
    spawnTimer: 0,
    spawnInterval: 0.55,
    state: "playing",
    paused: false,
    speed: 1,
    transitionTimer: 0,
    elapsed: 0,
    lastFrame: 0,
    hoverCell: null,
    notice: "",
    noticeTimer: 0,
};

let route = [];
let routeSegments = [];
let routeLength = 0;
const enemies = [];
const towers = [];
const projectiles = [];

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function formatMoney(amount) {
    return "$" + Math.floor(amount).toLocaleString("en-US");
}

function setNotice(message, duration = 1.8) {
    game.notice = message;
    game.noticeTimer = duration;
}

function updateUI() {
    const goal = game.level * 1000;
    ui.level.textContent = String(game.level).padStart(2, "0");
    ui.money.textContent = formatMoney(game.cash);
    ui.health.innerHTML = `${game.core} <small>/ ${MAX_CORE}</small>`;
    ui.wave.innerHTML = `${String(game.wave).padStart(2, "0")} <small>· ${String(enemies.length).padStart(2, "0")} on field</small>`;
    ui.goalAmount.textContent = `${formatMoney(game.bountyEarned)} / ${formatMoney(goal)}`;
    ui.goalFill.style.width = `${clamp((game.bountyEarned / goal) * 100, 0, 100)}%`;
    ui.pause.textContent = game.paused ? "Resume" : "Pause";
    ui.speed.textContent = `Speed ${game.speed}×`;
}

function generateRoute() {
    route = [];
    routeSegments = [];
    const bandRows = [2, 5, 8, 11, 14, 17];
    const yValues = bandRows.map((row) => row * TILE + TILE / 2);
    const leftTurns = bandRows.map(() => randomInt(1, 3) * TILE + TILE / 2);
    const rightTurns = bandRows.map(() => randomInt(COLS - 4, COLS - 2) * TILE + TILE / 2);

    route.push({ x: -TILE, y: yValues[0] });
    for (let i = 0; i < yValues.length; i++) {
        const turnX = i % 2 === 0 ? rightTurns[i] : leftTurns[i];
        route.push({ x: turnX, y: yValues[i] });
        if (i < yValues.length - 1) {
            route.push({ x: turnX, y: yValues[i + 1] });
        } else {
            route.push({ x: -TILE, y: yValues[i] });
        }
    }

    routeLength = 0;
    for (let i = 0; i < route.length - 1; i++) {
        const from = route[i];
        const to = route[i + 1];
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        routeSegments.push({
            start: routeLength,
            end: routeLength + length,
            length,
            from,
            to,
            tx: dx / length,
            ty: dy / length,
            nx: -dy / length,
            ny: dx / length,
            width: randomInt(42, 72),
        });
        routeLength += length;
    }
}

function sampleRoute(distance) {
    const d = clamp(distance, 0, routeLength);
    let segment = routeSegments[routeSegments.length - 1];
    for (const candidate of routeSegments) {
        if (d <= candidate.end) {
            segment = candidate;
            break;
        }
    }
    const t = segment.length === 0 ? 0 : clamp((d - segment.start) / segment.length, 0, 1);
    const width = segment.width;
    return {
        x: segment.from.x + (segment.to.x - segment.from.x) * t,
        y: segment.from.y + (segment.to.y - segment.from.y) * t,
        tx: segment.tx,
        ty: segment.ty,
        nx: segment.nx,
        ny: segment.ny,
        width,
        maxOffset: Math.max(0, width / 2 - ENEMY_RADIUS - 2),
    };
}

function getEnemyPosition(enemy) {
    const point = sampleRoute(enemy.progress);
    const offset = clamp(enemy.offset, -point.maxOffset, point.maxOffset);
    enemy.offset = offset;
    return {
        x: point.x + point.nx * offset,
        y: point.y + point.ny * offset,
        ...point,
    };
}

function generateLevel() {
    generateRoute();
    enemies.length = 0;
    projectiles.length = 0;
    game.bountyEarned = 0;
    game.wave = 1;
    game.spawnedThisWave = 0;
    game.waveSize = 22 + Math.min(game.level * 2, 18);
    game.spawnTimer = 0;
    game.spawnInterval = Math.max(0.34, 0.56 - game.level * 0.012);
    game.state = "playing";
    game.transitionTimer = 0;
    setNotice(`LEVEL ${String(game.level).padStart(2, "0")} · NEW ROUTE GENERATED`, 2.5);
    updateUI();
}

class Enemy {
    constructor() {
        const health = 40 + game.level * 5;
        this.progress = 0;
        this.offset = (Math.random() - 0.5) * 5;
        this.radius = ENEMY_RADIUS;
        this.speed = 39 + Math.random() * 8 + Math.min(game.level * 1.1, 12);
        this.hp = health;
        this.maxHp = health;
        this.reward = 10;
        this.attackTimer = 0;
        this.tint = Math.random() < 0.5 ? "#fa7466" : "#ed625c";
        this.seed = Math.random() * Math.PI * 2;
    }

    update(dt) {
        let slowFactor = 1;
        this.attackTimer = Math.max(0, this.attackTimer - dt);
        let position = getEnemyPosition(this);
        let contacted = null;

        for (const tower of towers) {
            const closestX = clamp(position.x, tower.x - tower.halfSize, tower.x + tower.halfSize);
            const closestY = clamp(position.y, tower.y - tower.halfSize, tower.y + tower.halfSize);
            let dx = position.x - closestX;
            let dy = position.y - closestY;
            let distance = Math.hypot(dx, dy);
            const touchDistance = this.radius + 1;
            if (distance < touchDistance) {
                contacted = tower;
                slowFactor = 0.18;
                if (this.attackTimer <= 0) {
                    tower.hp -= 9 + game.level * 1.4;
                    this.attackTimer = 0.65;
                }
                if (distance < 0.01) {
                    dx = position.nx * (Math.random() < 0.5 ? -1 : 1);
                    dy = position.ny * (Math.random() < 0.5 ? -1 : 1);
                    distance = 1;
                }
                const shove = touchDistance - distance + 0.5;
                const pushX = (dx / distance) * shove;
                const pushY = (dy / distance) * shove;
                this.progress += pushX * position.tx + pushY * position.ty;
                this.offset += pushX * position.nx + pushY * position.ny;
                position = getEnemyPosition(this);
            }
        }

        if (contacted) {
            // A tower in the lane slows the horde; it must be destroyed or bypassed.
            this.progress = Math.max(0, this.progress - this.speed * dt * 0.12);
        }
        this.progress += this.speed * dt * slowFactor;
        position = getEnemyPosition(this);
        return this.progress >= routeLength;
    }

    draw(position = getEnemyPosition(this)) {
        const x = position.x;
        const y = position.y;
        const r = this.radius;
        ctx.save();
        ctx.shadowColor = "#f66d5c";
        ctx.shadowBlur = 9;
        ctx.fillStyle = this.tint;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "#682f2d";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const barWidth = 20;
        const hpRatio = clamp(this.hp / this.maxHp, 0, 1);
        ctx.fillStyle = "#231b1a";
        ctx.fillRect(x - barWidth / 2, y - r - 7, barWidth, 3);
        ctx.fillStyle = hpRatio > 0.45 ? "#c5ea79" : "#ff9a6b";
        ctx.fillRect(x - barWidth / 2, y - r - 7, barWidth * hpRatio, 3);
        ctx.restore();
    }
}

class Tower {
    constructor(col, row) {
        this.col = col;
        this.row = row;
        this.x = col * TILE + TILE / 2;
        this.y = row * TILE + TILE / 2;
        this.halfSize = 12;
        this.range = 154;
        this.hp = 150;
        this.maxHp = this.hp;
        this.cooldown = Math.random() * 0.3;
        this.target = null;
        this.angle = -Math.PI / 2;
        GRID[row][col] = 1;
    }

    update(dt) {
        this.cooldown = Math.max(0, this.cooldown - dt);
        let target = null;
        let bestProgress = -Infinity;
        for (const enemy of enemies) {
            if (enemy.hp <= 0) continue;
            const position = getEnemyPosition(enemy);
            const distance = Math.hypot(position.x - this.x, position.y - this.y);
            if (distance <= this.range && enemy.progress > bestProgress) {
                target = enemy;
                bestProgress = enemy.progress;
            }
        }
        this.target = target;
        if (target) {
            const position = getEnemyPosition(target);
            this.angle = Math.atan2(position.y - this.y, position.x - this.x);
            if (this.cooldown <= 0) {
                projectiles.push(new Projectile(this.x, this.y, target));
                this.cooldown = 0.72;
            }
        }
    }

    draw() {
        ctx.save();
        if (game.hoverCell && game.hoverCell.col === this.col && game.hoverCell.row === this.row) {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.range, 0, Math.PI * 2);
            ctx.fillStyle = "#c9f06a09";
            ctx.fill();
            ctx.strokeStyle = "#c9f06a2c";
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);
        ctx.shadowColor = "#b9e959";
        ctx.shadowBlur = 12;
        ctx.fillStyle = "#aacf53";
        ctx.fillRect(-4, -4, 21, 8);
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#dff79d";
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#52653b";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#354329";
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        const barWidth = 28;
        const ratio = clamp(this.hp / this.maxHp, 0, 1);
        ctx.fillStyle = "#171c17";
        ctx.fillRect(this.x - barWidth / 2, this.y + 15, barWidth, 4);
        ctx.fillStyle = ratio > 0.5 ? "#aacf53" : "#ff806a";
        ctx.fillRect(this.x - barWidth / 2, this.y + 15, barWidth * ratio, 4);
    }
}

class Projectile {
    constructor(x, y, target) {
        this.x = x;
        this.y = y;
        this.target = target;
        this.speed = 390;
        this.damage = 23 + Math.min(game.level * 1.2, 12);
        this.alive = true;
    }

    update(dt) {
        if (!enemies.includes(this.target) || this.target.hp <= 0) return false;
        const target = getEnemyPosition(this.target);
        const dx = target.x - this.x;
        const dy = target.y - this.y;
        const distance = Math.hypot(dx, dy);
        const step = this.speed * dt;
        if (distance <= step + this.target.radius) {
            this.target.hp -= this.damage;
            this.alive = false;
        } else if (distance > 0) {
            this.x += (dx / distance) * step;
            this.y += (dy / distance) * step;
        }
        return this.alive;
    }

    draw() {
        ctx.save();
        ctx.shadowColor = "#f4f49a";
        ctx.shadowBlur = 9;
        ctx.fillStyle = "#f9f2a6";
        ctx.beginPath();
        ctx.arc(this.x, this.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

function resolveCrowdCollisions() {
    // Multiple short passes keep packed enemies apart while still allowing them to queue.
    for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < enemies.length; i++) {
            const a = enemies[i];
            if (a.hp <= 0) continue;
            const pa = getEnemyPosition(a);
            for (let j = i + 1; j < enemies.length; j++) {
                const b = enemies[j];
                if (b.hp <= 0) continue;
                const pb = getEnemyPosition(b);
                let dx = pa.x - pb.x;
                let dy = pa.y - pb.y;
                let distance = Math.hypot(dx, dy);
                const minimum = a.radius + b.radius + 1;
                if (distance >= minimum) continue;
                if (distance < 0.001) {
                    const flip = (i + j) % 2 === 0 ? 1 : -1;
                    dx = pa.nx * flip;
                    dy = pa.ny * flip;
                    distance = 1;
                }
                const overlap = minimum - distance;
                const ux = dx / distance;
                const uy = dy / distance;
                const tx = pa.tx + pb.tx;
                const ty = pa.ty + pb.ty;
                const tangentLength = Math.hypot(tx, ty) || 1;
                const tangentX = tx / tangentLength;
                const tangentY = ty / tangentLength;
                const normalX = -tangentY;
                const normalY = tangentX;
                const pushX = ux * overlap * 0.53;
                const pushY = uy * overlap * 0.53;

                a.progress += pushX * tangentX + pushY * tangentY;
                a.offset += pushX * normalX + pushY * normalY;
                b.progress -= pushX * tangentX + pushY * tangentY;
                b.offset -= pushX * normalX + pushY * normalY;

                const maxA = sampleRoute(a.progress).maxOffset;
                const maxB = sampleRoute(b.progress).maxOffset;
                a.progress = Math.max(0, a.progress);
                b.progress = Math.max(0, b.progress);
                a.offset = clamp(a.offset, -maxA, maxA);
                b.offset = clamp(b.offset, -maxB, maxB);
            }
        }
    }
}

function awardBounty(enemy) {
    game.cash += enemy.reward;
    game.bountyEarned += enemy.reward;
    if (game.bountyEarned >= game.level * 1000) {
        completeLevel();
    }
}

function completeLevel() {
    if (game.state !== "playing") return;
    game.state = "level-complete";
    game.transitionTimer = 2.8;
    enemies.length = 0;
    projectiles.length = 0;
    setNotice(`BOUNTY SECURED · LEVEL ${game.level} CLEARED`, 2.8);
}

function removeDestroyedTowers() {
    for (let i = towers.length - 1; i >= 0; i--) {
        const tower = towers[i];
        if (tower.hp > 0) continue;
        GRID[tower.row][tower.col] = 0;
        towers.splice(i, 1);
        setNotice("A TOWER HAS BEEN OVERRUN", 2.2);
    }
}

function update(dt) {
    if (game.state === "game-over") return;
    game.elapsed += dt;
    if (game.noticeTimer > 0) game.noticeTimer = Math.max(0, game.noticeTimer - dt);

    if (game.state === "level-complete") {
        game.transitionTimer -= dt;
        if (game.transitionTimer <= 0) {
            game.level++;
            generateLevel();
        }
        updateUI();
        return;
    }

    if (game.spawnedThisWave < game.waveSize) {
        game.spawnTimer += dt;
        if (game.spawnTimer >= game.spawnInterval) {
            game.spawnTimer -= game.spawnInterval;
            enemies.push(new Enemy());
            game.spawnedThisWave++;
        }
    } else if (enemies.length === 0) {
        game.wave++;
        game.spawnedThisWave = 0;
        game.waveSize = 22 + Math.min(game.level * 2, 18);
        game.spawnTimer = 0;
        setNotice(`WAVE ${String(game.wave).padStart(2, "0")} INBOUND`, 1.5);
    }

    for (const tower of towers) tower.update(dt);
    for (let i = projectiles.length - 1; i >= 0; i--) {
        if (!projectiles[i].update(dt)) projectiles.splice(i, 1);
    }

    for (let i = enemies.length - 1; i >= 0; i--) {
        const enemy = enemies[i];
        if (enemy.hp <= 0) {
            awardBounty(enemy);
            enemies.splice(i, 1);
            if (game.state !== "playing") break;
            continue;
        }
        if (enemy.update(dt)) {
            game.core = Math.max(0, game.core - 1);
            enemies.splice(i, 1);
            setNotice("AN ENEMY REACHED THE CORE", 1.2);
            if (game.core <= 0) {
                game.state = "game-over";
                break;
            }
        }
    }

    if (game.state === "playing") resolveCrowdCollisions();
    removeDestroyedTowers();
    updateUI();
}

function drawGrid() {
    ctx.fillStyle = "#151b16";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = "#252d26";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= WIDTH; x += TILE) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, HEIGHT);
    }
    for (let y = 0; y <= HEIGHT; y += TILE) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(WIDTH, y + 0.5);
    }
    ctx.stroke();
}

function drawRoute() {
    for (let i = 0; i < routeSegments.length; i++) {
        const segment = routeSegments[i];
        ctx.lineCap = "butt";
        ctx.strokeStyle = "#313b31";
        ctx.lineWidth = segment.width + 10;
        ctx.beginPath();
        ctx.moveTo(segment.from.x, segment.from.y);
        ctx.lineTo(segment.to.x, segment.to.y);
        ctx.stroke();

        ctx.strokeStyle = "#475345";
        ctx.lineWidth = segment.width;
        ctx.beginPath();
        ctx.moveTo(segment.from.x, segment.from.y);
        ctx.lineTo(segment.to.x, segment.to.y);
        ctx.stroke();

        ctx.strokeStyle = "#596652";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 8]);
        ctx.beginPath();
        ctx.moveTo(segment.from.x, segment.from.y);
        ctx.lineTo(segment.to.x, segment.to.y);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Junction caps make differently sized grid sections meet cleanly.
    for (let i = 1; i < route.length - 1; i++) {
        const before = routeSegments[i - 1];
        const after = routeSegments[i];
        ctx.fillStyle = "#475345";
        ctx.beginPath();
        ctx.arc(route[i].x, route[i].y, Math.max(before.width, after.width) / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#596652";
        ctx.beginPath();
        ctx.arc(route[i].x, route[i].y, 1.5, 0, Math.PI * 2);
        ctx.fill();
    }

    drawGate(-18, route[0].y, "ENTRY", true);
    drawGate(-18, route[route.length - 1].y, "CORE", false);
}

function drawGate(x, y, label, entry) {
    ctx.save();
    ctx.fillStyle = entry ? "#f2a25f" : "#b7df66";
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#a6b09f";
    ctx.font = "700 9px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, 9, y - 13);
    ctx.restore();
}

function drawTowerPreview() {
    const cell = game.hoverCell;
    if (!cell) return;
    const x = cell.col * TILE + TILE / 2;
    const y = cell.row * TILE + TILE / 2;
    const occupied = GRID[cell.row][cell.col] !== 0;
    const canAfford = game.cash >= TOWER_COST;
    const valid = !occupied && canAfford && game.state === "playing";
    const onRoute = isOnRoute(x, y, 19);
    ctx.save();
    ctx.fillStyle = valid ? (onRoute ? "#ff9e5c18" : "#c9f06a12") : "#ff6d5b16";
    ctx.fillRect(cell.col * TILE + 1, cell.row * TILE + 1, TILE - 2, TILE - 2);
    ctx.strokeStyle = valid ? (onRoute ? "#ffad6d99" : "#c9f06a88") : "#ff786b88";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(cell.col * TILE + 3, cell.row * TILE + 3, TILE - 6, TILE - 6);
    ctx.setLineDash([]);
    if (!occupied && game.state === "playing") {
        ctx.beginPath();
        ctx.arc(x, y, 154, 0, Math.PI * 2);
        ctx.strokeStyle = valid ? "#c9f06a20" : "#ff786b20";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = valid ? (onRoute ? "#ffbf78" : "#c9f06a") : "#ff786b";
        ctx.fillRect(x - 8, y - 8, 16, 16);
        ctx.fillStyle = "#26301e";
        ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    ctx.restore();
}

function isOnRoute(x, y, extra = 0) {
    for (const segment of routeSegments) {
        const px = x - segment.from.x;
        const py = y - segment.from.y;
        const t = clamp((px * segment.tx + py * segment.ty) / segment.length, 0, 1);
        const dx = x - (segment.from.x + segment.tx * segment.length * t);
        const dy = y - (segment.from.y + segment.ty * segment.length * t);
        if (Math.hypot(dx, dy) <= segment.width / 2 + extra) return true;
    }
    return false;
}

function drawOverlay(title, subtitle, color = "#e9efdf") {
    ctx.save();
    ctx.fillStyle = "#101411c9";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 20;
    ctx.fillStyle = color;
    ctx.font = "800 38px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(title, WIDTH / 2, HEIGHT / 2 - 10);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#aab5a4";
    ctx.font = "500 14px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(subtitle, WIDTH / 2, HEIGHT / 2 + 23);
    ctx.restore();
}

function draw() {
    drawGrid();
    drawRoute();
    drawTowerPreview();
    for (const tower of towers) tower.draw();

    // Draw order follows the road, keeping the crowd legible in tight bends.
    const orderedEnemies = [...enemies].sort((a, b) => a.progress - b.progress);
    for (const enemy of orderedEnemies) enemy.draw();
    for (const projectile of projectiles) projectile.draw();

    if (game.noticeTimer > 0 && game.notice) {
        ctx.save();
        ctx.textAlign = "center";
        ctx.font = "800 12px ui-sans-serif, system-ui, sans-serif";
        const width = ctx.measureText(game.notice).width + 34;
        ctx.fillStyle = "#111713df";
        ctx.strokeStyle = "#c9f06a55";
        ctx.lineWidth = 1;
        roundRect(ctx, WIDTH / 2 - width / 2, 18, width, 31, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#d8e8c1";
        ctx.fillText(game.notice, WIDTH / 2, 38);
        ctx.restore();
    }

    if (game.paused && game.state === "playing") {
        drawOverlay("PAUSED", "Press resume to continue the defense");
    } else if (game.state === "level-complete") {
        drawOverlay("BOUNTY SECURED", `Level ${game.level} complete · next corridor loading`, "#c9f06a");
    } else if (game.state === "game-over") {
        drawOverlay("CORE OVERRUN", `You reached level ${game.level} · press Restart to try again`, "#ff8275");
    }
}

function roundRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
}

function gameLoop(timestamp) {
    if (!game.lastFrame) game.lastFrame = timestamp;
    const rawDelta = Math.min((timestamp - game.lastFrame) / 1000, 0.05);
    game.lastFrame = timestamp;
    if (!game.paused) update(rawDelta * game.speed);
    draw();
    requestAnimationFrame(gameLoop);
}

function getCanvasCell(event) {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    const col = Math.floor(x / TILE);
    const row = Math.floor(y / TILE);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    return { col, row };
}

canvas.addEventListener("pointermove", (event) => {
    game.hoverCell = getCanvasCell(event);
});

canvas.addEventListener("pointerleave", () => {
    game.hoverCell = null;
});

canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || game.state !== "playing") return;
    const cell = getCanvasCell(event);
    if (!cell) return;
    if (GRID[cell.row][cell.col]) {
        setNotice("THAT TILE IS ALREADY OCCUPIED", 1.2);
        return;
    }
    if (game.cash < TOWER_COST) {
        setNotice("NOT ENOUGH CASH · TOWERS COST $50", 1.6);
        return;
    }
    game.cash -= TOWER_COST;
    towers.push(new Tower(cell.col, cell.row));
    if (isOnRoute(cell.col * TILE + TILE / 2, cell.row * TILE + TILE / 2, 18)) {
        setNotice("TOWER IN THE CORRIDOR · THE HORDE CAN DAMAGE IT", 2.2);
    } else {
        setNotice("TOWER DEPLOYED · $50", 1.2);
    }
    updateUI();
});

ui.pause.addEventListener("click", () => {
    if (game.state === "game-over") return;
    game.paused = !game.paused;
    updateUI();
});

ui.speed.addEventListener("click", () => {
    game.speed = game.speed === 1 ? 2 : 1;
    updateUI();
});

document.getElementById("restartButton").addEventListener("click", () => {
    game.level = 1;
    game.cash = STARTING_CASH;
    game.core = MAX_CORE;
    game.bountyEarned = 0;
    game.wave = 1;
    game.spawnedThisWave = 0;
    game.paused = false;
    game.speed = 1;
    game.elapsed = 0;
    game.lastFrame = 0;
    game.hoverCell = null;
    for (const tower of towers) GRID[tower.row][tower.col] = 0;
    towers.length = 0;
    enemies.length = 0;
    projectiles.length = 0;
    generateLevel();
});

generateLevel();
requestAnimationFrame(gameLoop);
