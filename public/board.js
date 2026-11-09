/* global io, Physics */
const socket = io();
const $ = (id) => document.getElementById(id);
const P = Physics;

const canvas = $('board');
const ctx = canvas.getContext('2d');
const overlay = $('overlay');

const ZONE_COLORS = { 4: 'rgba(230,110,30,.5)', 3: 'rgba(241,190,20,.48)', 2: 'rgba(46,190,110,.42)', 1: 'rgba(52,142,215,.42)' };
const EDITABLE_PHASES = ['lobby', 'roundOver', 'matchOver'];
const TRAIL_LENGTH = 16;

let state = null;
let isHost = false;
let joinInfo = null;
let view = { width: P.BASE_WIDTH, obstacles: [], mods: {}, pucks: [] };
let rolling = false;
let replay = null;
let aim = null;
let editMode = false;
let dragged = null;
let hovered = null;
let cssW = 0;
let cssH = 0;
let scale = 1;
let dpr = 1;
let staticLayer = null;
let staticKey = '';
let clockEnd = 0;
let clockTotal = 0;
let lastFeedId = 0;
let accumulator = 0;
let lastFrame = performance.now();

const trails = new Map();
const particles = [];
const floaters = [];
const bumperFlash = new Map();

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function dot(color) {
  const node = el('span', { className: 'dot' });
  node.style.background = color;
  return node;
}

function button(label, className, onClick) {
  return el('button', { className: `btn ${className}`, textContent: label, onclick: onClick });
}

const nameList = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} og ${names[names.length - 1]}` : names[0] || '');

// --- Lyd (syntetisk, ingen filer) ---

const sound = (() => {
  let audio = null;
  let muted = false;
  try { muted = localStorage.getItem('shuffle_muted') === '1'; } catch { /* lagring er valgfritt */ }

  function ensure() {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  function tone({ type = 'sine', from, to, ms, gain = 0.25, delay = 0 }) {
    if (muted || !audio || audio.state !== 'running') return;
    const t = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const vol = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
    vol.gain.setValueAtTime(gain, t);
    vol.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
    osc.connect(vol).connect(audio.destination);
    osc.start(t);
    osc.stop(t + ms / 1000);
  }

  const melody = (notes, step, opts = {}) => notes.forEach((f, i) => tone({ from: f, to: f, ms: 200, delay: i * step, ...opts }));

  return {
    unlock: ensure,
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('shuffle_muted', muted ? '1' : '0'); } catch { /* lagring er valgfritt */ }
      return muted;
    },
    glass: () => tone({ from: 880, to: 1760, ms: 350, gain: 0.25 }),
    click: (v) => tone({ type: 'triangle', from: 420, to: 90, ms: 60, gain: Math.min(0.5, 0.12 + v / 1400) }),
    bumper: () => tone({ type: 'square', from: 260, to: 720, ms: 110, gain: 0.14 }),
    fall: () => tone({ type: 'sawtooth', from: 340, to: 60, ms: 380, gain: 0.12 }),
    shoot: () => tone({ type: 'triangle', from: 120, to: 340, ms: 140, gain: 0.25 }),
    turn: () => melody([660], 0, { gain: 0.1 }),
    score: (n) => melody([523, 659, 784, 1047].slice(0, Math.min(4, n)), 0.09, { type: 'triangle', gain: 0.2 }),
    knockout: () => melody([196, 147, 110], 0.11, { type: 'square', gain: 0.14 }),
    fanfare: () => melody([523, 659, 784, 1047, 784, 1047, 1319], 0.14, { type: 'triangle', gain: 0.24 }),
  };
})();

window.addEventListener('pointerdown', () => sound.unlock(), { once: false });

// --- Skjermstørrelse ---

function resize() {
  const stage = $('stage');
  const width = view.width || P.BASE_WIDTH;
  const maxH = stage.clientHeight - 64;
  const maxW = stage.clientWidth - 64;
  cssH = Math.max(240, Math.min(maxH, (maxW * P.LENGTH) / width));
  cssW = (cssH * width) / P.LENGTH;
  scale = cssH / P.LENGTH;
  dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  staticKey = '';
  updateCalibrationWarning();
}

window.addEventListener('resize', resize);

// --- Tegning ---

function worldTransform(target) {
  target.setTransform(scale * dpr, 0, 0, scale * dpr, (cssW / 2) * dpr, 0);
}

function seededRandom(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function drawWood(g, halfW) {
  const random = seededRandom(4711);
  const base = g.createLinearGradient(-halfW, 0, halfW, 0);
  base.addColorStop(0, '#c08a55');
  base.addColorStop(0.5, '#d6a671');
  base.addColorStop(1, '#bd8650');
  g.fillStyle = base;
  g.fillRect(-halfW, 0, halfW * 2, P.LENGTH);

  const plank = 75;
  for (let x = -halfW, i = 0; x < halfW; x += plank, i++) {
    g.fillStyle = `rgba(70,35,10,${0.03 + random() * 0.09})`;
    g.fillRect(x, 0, plank, P.LENGTH);
    g.fillStyle = 'rgba(55,28,10,.28)';
    g.fillRect(x, 0, 1.2, P.LENGTH);
    for (let j = 0; j < 9; j++) {
      const gx = x + random() * plank;
      g.strokeStyle = `rgba(90,50,20,${0.05 + random() * 0.11})`;
      g.lineWidth = 0.6 + random() * 1.2;
      g.beginPath();
      g.moveTo(gx, 0);
      g.bezierCurveTo(gx + random() * 20 - 10, 330, gx + random() * 20 - 10, 660, gx + random() * 8 - 4, P.LENGTH);
      g.stroke();
    }
  }
  const sheen = g.createLinearGradient(-halfW, 0, halfW, P.LENGTH);
  sheen.addColorStop(0.3, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,.1)');
  sheen.addColorStop(0.7, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fillRect(-halfW, 0, halfW * 2, P.LENGTH);
}

function drawZones(g, halfW, mods) {
  for (let i = 0; i < 4; i++) {
    const points = P.zonePoints(i * P.ZONE_H + 1, mods);
    const y = i * P.ZONE_H;
    g.fillStyle = ZONE_COLORS[points];
    g.fillRect(-halfW, y, halfW * 2, P.ZONE_H);
    g.fillStyle = 'rgba(50,25,8,.75)';
    g.fillRect(-halfW, y + P.ZONE_H - 1.5, halfW * 2, 3);
    g.font = 'bold 44px Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(40,20,5,.55)';
    g.fillText(String(points), 0, y + P.ZONE_H / 2 + 2);
  }
  g.fillStyle = 'rgba(50,25,8,.4)';
  g.fillRect(-halfW, 905, halfW * 2, 2.5);
}

function drawSurfaces(g, mods) {
  for (const s of mods.patches || []) {
    const ice = s.type === 'ice';
    const fill = g.createRadialGradient(s.x, s.y, s.r * 0.2, s.x, s.y, s.r);
    fill.addColorStop(0, ice ? 'rgba(205,240,255,.85)' : 'rgba(226,196,140,.92)');
    fill.addColorStop(1, ice ? 'rgba(160,215,245,.35)' : 'rgba(200,165,105,.5)');
    g.fillStyle = fill;
    g.beginPath();
    g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    g.fill();
    const random = seededRandom(Math.floor(Math.abs(s.x * 97 + s.y * 13)) + 7);
    g.fillStyle = ice ? 'rgba(255,255,255,.7)' : 'rgba(105,75,40,.45)';
    for (let i = 0; i < (ice ? 12 : 90); i++) {
      const a = random() * Math.PI * 2;
      const d = Math.sqrt(random()) * s.r * 0.92;
      g.beginPath();
      g.arc(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, ice ? 2.4 : 1.2, 0, Math.PI * 2);
      g.fill();
    }
  }
  if (mods.gold) {
    const { x, y, r, points } = mods.gold;
    const fill = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 4, x, y, r);
    fill.addColorStop(0, '#fff3b0');
    fill.addColorStop(0.65, '#eab92f');
    fill.addColorStop(1, '#b37e10');
    g.fillStyle = fill;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(90,55,0,.85)';
    g.font = 'bold 34px Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`+${points}`, x, y + 2);
  }
  if (mods.wind) {
    const dir = Math.sign(mods.wind);
    g.strokeStyle = 'rgba(255,255,255,.35)';
    g.lineWidth = 3;
    g.lineCap = 'round';
    for (let y = 400; y <= 800; y += 130) {
      g.beginPath();
      g.moveTo(-dir * 60, y);
      g.lineTo(dir * 60, y);
      g.lineTo(dir * 44, y - 12);
      g.moveTo(dir * 60, y);
      g.lineTo(dir * 44, y + 12);
      g.stroke();
    }
  }
}

function rebuildStaticLayer() {
  const key = `${canvas.width}x${canvas.height}|${view.width}|${JSON.stringify(view.mods)}`;
  if (key === staticKey) return;
  staticKey = key;
  staticLayer = document.createElement('canvas');
  staticLayer.width = canvas.width;
  staticLayer.height = canvas.height;
  const g = staticLayer.getContext('2d');
  worldTransform(g);
  const halfW = view.width / 2;
  drawWood(g, halfW);
  drawZones(g, halfW, view.mods || {});
  drawSurfaces(g, view.mods || {});
}

function drawObstacles() {
  for (const o of view.obstacles) {
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
    if (editMode) {
      ctx.fillStyle = o === hovered ? 'rgba(241,196,15,.35)' : 'rgba(255,255,255,.25)';
      ctx.strokeStyle = o === hovered ? '#f39c12' : 'rgba(255,255,255,.6)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 7]);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,.15)';
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([]);
    }
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawBumpers(now) {
  (view.mods.bumpers || []).forEach((b, i) => {
    const flash = Math.max(0, 1 - (now - (bumperFlash.get(i) || 0)) / 220);
    const r = b.r + flash * 5;
    const fill = ctx.createRadialGradient(b.x - 7, b.y - 7, 3, b.x, b.y, r);
    fill.addColorStop(0, flash > 0 ? '#fff' : '#ff9a8f');
    fill.addColorStop(1, '#c62f35');
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffe0a8';
    ctx.lineWidth = 4;
    ctx.stroke();
  });
}

function drawPuck(x, y, color, label, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(30,15,5,.4)';
  ctx.beginPath();
  ctx.ellipse(x + 3, y + 5, P.PUCK_R, P.PUCK_R, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, P.PUCK_R, 0, Math.PI * 2);
  ctx.fill();
  const shine = ctx.createRadialGradient(x - 7, y - 8, 1, x, y, P.PUCK_R);
  shine.addColorStop(0, 'rgba(255,255,255,.65)');
  shine.addColorStop(0.5, 'rgba(255,255,255,.05)');
  shine.addColorStop(1, 'rgba(0,0,0,.28)');
  ctx.fillStyle = shine;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,.95)';
  ctx.stroke();

  if (label) {
    ctx.font = 'bold 21px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.strokeText(label, x, y + 1);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x, y + 1);
  }
  ctx.globalAlpha = 1;
}

function drawTrails() {
  for (const p of view.pucks) {
    const trail = trails.get(p.id);
    if (!trail) continue;
    if (p.vx !== 0 || p.vy !== 0) {
      trail.push({ x: p.x, y: p.y });
      if (trail.length > TRAIL_LENGTH) trail.shift();
    } else if (trail.length) {
      trail.shift();
    }
    trail.forEach((point, i) => {
      ctx.globalAlpha = (i / trail.length) * 0.28;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, P.PUCK_R * (0.45 + (0.5 * i) / trail.length), 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.globalAlpha = 1;
}

function activePlayer() {
  return state && state.turn ? state.players.find((p) => p.id === state.turn.playerId) : null;
}

function drawAim(now) {
  const player = activePlayer();
  if (!player || replay || state.phase !== 'aiming') return;
  const pulse = 0.65 + Math.sin(now / 240) * 0.2;
  drawPuck(0, P.START_Y, player.color, null, aim ? 1 : pulse);
  if (!aim || aim.power === null) return;

  const length = 70 + aim.power * 330;
  const dx = Math.sin(aim.angle);
  const dy = -Math.cos(aim.angle);
  const tipX = dx * length;
  const tipY = P.START_Y + dy * length;

  ctx.strokeStyle = player.color;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.setLineDash([3, 18]);
  ctx.lineDashOffset = -now / 25;
  ctx.beginPath();
  ctx.moveTo(dx * 28, P.START_Y + dy * 28);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;

  ctx.fillStyle = player.color;
  ctx.save();
  ctx.translate(tipX, tipY);
  ctx.rotate(aim.angle);
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.lineTo(15, 6);
  ctx.lineTo(-15, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(0, P.START_Y, P.PUCK_R + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * aim.power);
  ctx.stroke();
}

function spawnSparks(x, y, color, count, power) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = power * (0.3 + Math.random() * 0.7);
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color, size: 2 + Math.random() * 3 });
  }
}

function drawEffects(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const s = particles[i];
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx *= 0.94;
    s.vy *= 0.94;
    s.life -= dt * 2;
    if (s.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = s.life;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.y -= dt * 70;
    f.life -= dt * 0.7;
    if (f.life <= 0) {
      floaters.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = Math.min(1, f.life * 2);
    ctx.font = 'bold 54px Georgia, serif';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0,0,0,.8)';
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

function handleSimEvents(events, now) {
  for (const e of events) {
    if (e.type === 'obstacle') {
      sound.glass();
      spawnSparks(e.x, e.y, '#fff', 10, 260);
    } else if (e.type === 'bumper') {
      sound.bumper();
      spawnSparks(e.x, e.y, '#ffd27a', 16, 420);
      (view.mods.bumpers || []).forEach((b, i) => {
        if (Math.hypot(b.x - e.x, b.y - e.y) < b.r + 2) bumperFlash.set(i, now);
      });
    } else if (e.type === 'puck') {
      sound.click(e.speed);
      spawnSparks(e.x, e.y, '#ffe9c4', 8, 240);
    } else if (e.type === 'fall') {
      sound.fall();
    }
  }
}

function draw(now, dt) {
  rebuildStaticLayer();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(staticLayer, 0, 0);
  worldTransform(ctx);
  drawObstacles();
  drawBumpers(now);
  drawTrails();
  drawAim(now);
  for (const p of view.pucks) {
    const still = p.vx === 0 && p.vy === 0;
    const points = still ? P.puckPoints(p, view) : 0;
    drawPuck(p.x, p.y, p.color, points > 0 ? String(points) : null);
  }
  drawEffects(dt);
}

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (rolling || (replay && !replay.finished)) {
    accumulator += dt * (replay ? 0.55 : 1);
    while (accumulator >= P.DT) {
      accumulator -= P.DT;
      const events = [];
      const moving = P.step(view, events);
      handleSimEvents(events, now);
      if (!moving) {
        accumulator = 0;
        if (replay) finishReplay();
        break;
      }
    }
  }

  if (clockTotal) {
    const left = Math.max(0, clockEnd - now);
    $('clockBar').style.width = `${(left / clockTotal) * 100}%`;
    $('clockBar').style.background = left < 8000 ? 'var(--bad)' : 'var(--brass)';
  } else {
    $('clockBar').style.width = '0';
  }

  draw(now, dt);
  requestAnimationFrame(frame);
}

// --- Replay av rundens beste skudd ---

function startReplay(best) {
  view = P.cloneWorld(best.world);
  const puck = { ...best.puck };
  view.pucks.push(puck);
  trails.clear();
  trails.set(puck.id, []);
  accumulator = 0;
  replay = { finished: false };
  sound.shoot();
  showBanner('REPRISE', `Rundens skudd: ${best.name}`);
}

function finishReplay() {
  replay.finished = true;
  setTimeout(() => {
    if (!replay) return;
    replay = null;
    syncView();
    renderOverlay();
    celebrateIfMatchOver();
  }, 900);
}

function cancelReplay() {
  replay = null;
  accumulator = 0;
}

function celebrateIfMatchOver() {
  if (state.phase !== 'matchOver') return;
  sound.fanfare();
  launchConfetti(state.summary.ranking[0]?.color);
}

// --- Visuelle meldinger ---

function showBanner(big, sub) {
  const banner = $('banner');
  const lines = [el('div', { className: 'big', textContent: big })];
  if (sub) lines.push(el('div', { className: 'sub', textContent: sub }));
  banner.replaceChildren(...lines);
  [...banner.children].forEach((child) => child.addEventListener('animationend', () => child.remove(), { once: true }));
}

function showReaction({ emoji, name, color }) {
  const node = el('div', { className: 'reaction' }, el('div', { className: 'e', textContent: emoji }), el('div', { className: 'n', textContent: name }));
  node.style.left = `${6 + Math.random() * 84}%`;
  node.querySelector('.n').style.color = color;
  node.addEventListener('animationend', () => node.remove());
  $('reactions').append(node);
}

function launchConfetti(mainColor) {
  const fx = $('confetti');
  fx.width = window.innerWidth;
  fx.height = window.innerHeight;
  const g = fx.getContext('2d');
  const colors = [mainColor || '#e2b35c', '#e2b35c', '#fff', '#4fd08f', '#e5574f', '#3e8ef7'];
  const pieces = Array.from({ length: 220 }, () => ({
    x: Math.random() * fx.width,
    y: -Math.random() * fx.height,
    vx: (Math.random() - 0.5) * 2,
    vy: 2.5 + Math.random() * 3.5,
    spin: Math.random() * 6,
    size: 6 + Math.random() * 8,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const end = performance.now() + 7000;
  (function tick(now) {
    g.clearRect(0, 0, fx.width, fx.height);
    if (now > end) return;
    for (const c of pieces) {
      c.x += c.vx + Math.sin(c.y / 40);
      c.y += c.vy;
      c.spin += 0.12;
      g.save();
      g.translate(c.x, c.y);
      g.rotate(c.spin);
      g.fillStyle = c.color;
      g.fillRect(-c.size / 2, -c.size / 4, c.size, c.size / 2);
      g.restore();
    }
    requestAnimationFrame(tick);
  })(performance.now());
}

// --- Grensesnitt ---

function renderScores() {
  const list = $('scoreList');
  const players = [...state.players].sort((a, b) => b.total + b.roundScore - (a.total + a.roundScore));
  const inRound = ['intro', 'aiming', 'rolling'].includes(state.phase);
  const adminOpen = isHost && !$('setup').hidden;

  list.replaceChildren(
    ...players.map((p) => {
      const pts = el('div', { className: 'pts' });
      if (inRound && p.roundScore > 0) pts.append(el('small', { textContent: `+${p.roundScore}` }));
      pts.append(el('b', { textContent: String(p.total) }));

      const right = el('div', {}, adminOpen ? el('button', { className: 'kick', textContent: 'Fjern', onclick: () => socket.emit('kickPlayer', p.id) }) : null);
      const pucks = inRound ? '●'.repeat(p.pucksLeft) : '';
      const name = el('div', { className: 'name', textContent: `${p.isBot ? '🤖 ' : ''}${p.name}` });
      const nameBox = el('div', { style: 'min-width:0' }, name, pucks ? el('div', { className: 'pucks', textContent: pucks }) : null);

      const active = state.turn && state.turn.playerId === p.id;
      return el('li', { className: `row${active ? ' active' : ''}${p.connected ? '' : ' offline'}` }, dot(p.color), nameBox, pts, right);
    })
  );
  $('roundLabel').textContent = state.round ? `Runde ${state.round} av ${state.settings.rounds}` : 'Spillere';
}

function renderTurn() {
  const player = activePlayer();
  const label = $('turnLabel');
  const name = $('turnName');
  name.style.color = player ? player.color : '';
  if (player) {
    label.textContent = 'Kaster nå';
    name.textContent = player.connected ? player.name : `${player.name} (borte)`;
  } else {
    label.textContent = 'Status';
    name.textContent = {
      lobby: state.players.length ? 'Klare til å starte' : 'Venter på spillere',
      intro: `Runde ${state.round}`,
      rolling: 'Pucken glir',
      aiming: 'Venter på spillere',
      roundOver: 'Runden er ferdig',
      matchOver: 'Kampen er ferdig',
    }[state.phase];
  }

  if (state.turn && state.turn.remainingMs !== null) {
    clockEnd = performance.now() + state.turn.remainingMs;
    clockTotal = state.turn.totalMs;
  } else {
    clockTotal = 0;
  }
}

function renderTwist() {
  $('twistName').textContent = state.twist ? state.twist.name : 'Ikke startet';
  $('twistText').textContent = state.twist ? state.twist.text : 'Skann koden og samle gjengen.';
}

function renderFeed() {
  const entries = [...state.feed].reverse().slice(0, 12);
  $('feed').replaceChildren(
    ...entries.map((f) => el('li', { className: `${f.kind}${f.id > lastFeedId ? ' fresh' : ''}`, textContent: f.text }))
  );
  if (state.feed.length) lastFeedId = state.feed[state.feed.length - 1].id;
}

function setIfIdle(input, value) {
  if (document.activeElement !== input) input.value = value;
}

function renderSetup() {
  const { settings, config } = state;
  setIfIdle($('puckSlider'), settings.pucksPerPlayer);
  setIfIdle($('roundSlider'), settings.rounds);
  setIfIdle($('clockSelect'), settings.shotClock);
  setIfIdle($('widthSlider'), config.widthRatio);
  $('twistCheck').checked = settings.twists;
  $('puckVal').textContent = settings.pucksPerPlayer;
  $('roundVal').textContent = settings.rounds;
  $('widthVal').textContent = config.widthRatio;
  $('editBtn').disabled = !EDITABLE_PHASES.includes(state.phase);
  $('clearBtn').disabled = !EDITABLE_PHASES.includes(state.phase);
  updateCalibrationWarning();
}

function updateCalibrationWarning() {
  if (!state) return;
  const { calibratedFor, obstacles } = state.config;
  $('calibrationWarn').hidden = !(calibratedFor && obstacles.length && Math.abs(calibratedFor - cssH) > 3);
}

function fillQr(root) {
  if (!joinInfo) return;
  root.querySelectorAll('[data-qr]').forEach((node) => { node.innerHTML = joinInfo.svg; });
  root.querySelectorAll('[data-url]').forEach((node) => { node.textContent = joinInfo.url; });
}

function hostAction(event) {
  socket.emit(event);
}

function lobbySheet() {
  const chips = state.players.map((p) => el('span', { className: 'chip' }, dot(p.color), `${p.isBot ? '🤖 ' : ''}${p.name}`));
  const qr = el('div', { className: 'qr' });
  qr.dataset.qr = '';
  const url = el('div', { className: 'url' });
  url.dataset.url = '';
  const start = button('Start spillet', 'primary', () => hostAction('hostStart'));
  start.disabled = state.players.length === 0;
  return el(
    'div',
    { className: 'sheet' },
    el('h2', { textContent: 'Skann og bli med' }),
    el('p', { className: 'lead', textContent: 'Mobilen din er kølla. Alle kan trykke start.' }),
    qr,
    url,
    el('div', { className: 'chips' }, ...chips),
    isHost ? start : null
  );
}

function rankingTable(ranking, showRound) {
  return el(
    'table',
    { className: 'ranking' },
    el('tbody', {}, ...ranking.map((r, i) =>
      el(
        'tr',
        {},
        el('td', { textContent: `${i + 1}.` }),
        el('td', {}, dot(r.color), r.name),
        showRound ? el('td', { className: 'num', textContent: `+${r.roundScore}` }) : null,
        el('td', { className: 'num' }, el('b', { textContent: String(r.total) }))
      )
    ))
  );
}

function winnerLine(winners) {
  const names = nameList(winners.names);
  if (winners.reason === 'none') return 'Ingen pucker igjen. Ingen vinner.';
  if (winners.reason === 'pucks') {
    return winners.names.length > 1
      ? `Ingen poeng! Delt seier til ${names} med ${winners.pucks} pucker på bordet.`
      : `Ingen poeng! ${names} vinner med flest pucker på bordet (${winners.pucks}).`;
  }
  return winners.names.length > 1 ? `Uavgjort! Delt seier til ${names}.` : `${names} vinner med ${winners.points} poeng!`;
}

function roundSheet() {
  const { summary, settings } = state;
  return el(
    'div',
    { className: 'sheet' },
    el('h2', { textContent: `Runde ${summary.round} ferdig` }),
    el('p', { className: 'lead', textContent: `${settings.rounds - summary.round} igjen. Hammeren går til den som ligger bakerst.` }),
    rankingTable(summary.ranking, true),
    isHost ? button('Neste runde', 'primary', () => hostAction('hostNext')) : el('p', { className: 'note', textContent: 'Trykk «Neste runde» på en mobil.' })
  );
}

function matchSheet() {
  const { summary } = state;
  const awards = (summary.awards || []).map((a) =>
    el('div', { className: 'award' }, el('b', { textContent: `${a.emoji} ${a.title}` }), el('span', { textContent: `${nameList(a.names)}, ${a.detail}` }))
  );
  return el(
    'div',
    { className: 'sheet' },
    el('h2', { textContent: '🏆 Sluttresultat' }),
    el('p', { className: 'winner', textContent: winnerLine(summary.winners) }),
    rankingTable(summary.ranking, false),
    awards.length ? el('div', { className: 'awards' }, ...awards) : null,
    isHost
      ? el('div', { className: 'actions' }, button('Spill igjen', 'primary', () => hostAction('hostRematch')), button('Til lobbyen', '', () => hostAction('resetToLobby')))
      : null
  );
}

function renderOverlay() {
  const sheet = (() => {
    if (!state || editMode || replay) return null;
    if (state.phase === 'lobby') return lobbySheet();
    if (state.phase === 'roundOver') return roundSheet();
    if (state.phase === 'matchOver') return matchSheet();
    return null;
  })();
  overlay.hidden = !sheet;
  overlay.replaceChildren(...(sheet ? [sheet] : []));
  fillQr(overlay);
}

function renderAll() {
  renderTurn();
  renderScores();
  renderTwist();
  renderFeed();
  renderSetup();
  renderOverlay();
}

// --- Tilstand fra serveren ---

// Serverens verdensbilde vises bare når ingen lokal animasjon kjører.
function syncView() {
  const widthChanged = view.width !== state.world.width;
  view = {
    width: state.world.width,
    obstacles: editMode ? view.obstacles : state.world.obstacles,
    mods: state.world.mods,
    pucks: state.world.pucks.map((p) => ({ ...p, vx: 0, vy: 0 })),
  };
  if (widthChanged) resize();
}

function onPhaseChange(previous) {
  aim = null;
  if (state.phase === 'intro') {
    showBanner(`Runde ${state.round}`, state.twist.id === 'classic' ? null : `${state.twist.name}: ${state.twist.text}`);
    sound.score(2);
    return;
  }
  if ((state.phase === 'roundOver' || state.phase === 'matchOver') && previous) {
    const best = state.summary && state.summary.bestShot;
    if (best) {
      startReplay(best);
    } else {
      celebrateIfMatchOver();
    }
  }
}

socket.on('connect', () => {
  let pin = '';
  try { pin = sessionStorage.getItem('shuffle_pin') || ''; } catch { /* lagring er valgfritt */ }
  socket.emit('registerBoard', { pin });
});

socket.on('hostStatus', (status) => {
  isHost = status.isHost;
  $('hostControls').hidden = !isHost;
  $('pinForm').hidden = isHost;
  $('pinNote').hidden = isHost;
  if (!isHost && editMode) setEditMode(false);
  if (state) renderAll();
});

socket.on('state', (next) => {
  const previous = state;
  state = next;

  const phaseChanged = !previous || previous.phase !== state.phase;
  if (replay && phaseChanged) cancelReplay();
  if (phaseChanged && !EDITABLE_PHASES.includes(state.phase) && editMode) setEditMode(false);
  if (rolling && state.phase !== 'rolling') rolling = false;

  if (!rolling && !replay) syncView();
  if (phaseChanged) onPhaseChange(previous);

  const previousTurn = previous && previous.turn && previous.turn.playerId;
  const currentTurn = state.turn && state.turn.playerId;
  if (currentTurn && currentTurn !== previousTurn) {
    aim = null;
    sound.turn();
  }
  renderAll();
});

socket.on('shot', ({ puck }) => {
  rolling = true;
  aim = null;
  accumulator = 0;
  view.pucks.push({ ...puck });
  trails.set(puck.id, []);
  sound.shoot();
});

socket.on('shotResult', ({ points, x, y, banner }) => {
  rolling = false;
  if (x !== null && points > 0) {
    floaters.push({ text: `+${points}`, x, y: y - 30, life: 1, color: '#ffe08a' });
    spawnSparks(x, y, '#ffd76a', 24, 420);
    sound.score(points);
  }
  if (banner) {
    showBanner(banner);
    if (banner.includes('KNOCKOUT')) sound.knockout();
  }
});

socket.on('aim', ({ playerId, power, angle }) => {
  aim = power === null || !state.turn || state.turn.playerId !== playerId ? null : { power, angle };
});

socket.on('reaction', showReaction);

// --- Oppsett og hindringer ---

function setEditMode(on) {
  editMode = on;
  dragged = null;
  hovered = null;
  if (on) view.obstacles = view.obstacles.map((o) => ({ ...o }));
  else if (state) view.obstacles = state.world.obstacles;
  $('editBtn').textContent = on ? 'Ferdig med hindringer' : 'Rediger hindringer';
  $('editBtn').classList.toggle('on', on);
  $('editHelp').hidden = !on;
  canvas.style.cursor = on ? 'crosshair' : 'default';
  renderOverlay();
}

function pointerWorld(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / scale - view.width / 2, y: (e.clientY - rect.top) / scale };
}

function obstacleAt(point) {
  return view.obstacles.find((o) => Math.hypot(point.x - o.x, point.y - o.y) <= o.r + 8);
}

function saveObstacles() {
  socket.emit('setConfig', { obstacles: view.obstacles, calibratedFor: cssH });
}

canvas.addEventListener('pointerdown', (e) => {
  if (!editMode) return;
  const point = pointerWorld(e);
  dragged = obstacleAt(point);
  if (!dragged) {
    dragged = { x: point.x, y: point.y, r: 44 };
    view.obstacles.push(dragged);
  }
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!editMode) return;
  const point = pointerWorld(e);
  hovered = obstacleAt(point) || null;
  canvas.style.cursor = hovered ? 'move' : 'crosshair';
  if (dragged) {
    dragged.x = Math.max(-view.width / 2, Math.min(view.width / 2, point.x));
    dragged.y = Math.max(0, Math.min(P.LENGTH, point.y));
  }
});

canvas.addEventListener('pointerup', () => {
  if (!editMode || !dragged) return;
  dragged = null;
  saveObstacles();
});

let wheelSave = null;
canvas.addEventListener('wheel', (e) => {
  if (!editMode) return;
  const target = obstacleAt(pointerWorld(e)) || hovered;
  if (!target) return;
  e.preventDefault();
  target.r = Math.max(15, Math.min(150, target.r + (e.deltaY < 0 ? 3 : -3)));
  clearTimeout(wheelSave);
  wheelSave = setTimeout(saveObstacles, 200);
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
  if (!editMode) return;
  const hit = obstacleAt(pointerWorld(e));
  if (!hit) return;
  view.obstacles = view.obstacles.filter((o) => o !== hit);
  hovered = null;
  saveObstacles();
});

$('setupToggle').addEventListener('click', () => {
  $('setup').hidden = !$('setup').hidden;
  if ($('setup').hidden && editMode) setEditMode(false);
  if (state) renderScores();
});

$('muteBtn').textContent = sound.muted ? '🔇' : '🔊';
$('muteBtn').addEventListener('click', () => {
  $('muteBtn').textContent = sound.toggle() ? '🔇' : '🔊';
});

$('fullBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});

$('pinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = $('pinInput').value.trim();
  try { sessionStorage.setItem('shuffle_pin', pin); } catch { /* lagring er valgfritt */ }
  socket.emit('registerBoard', { pin });
  $('pinInput').value = '';
});

$('puckSlider').addEventListener('input', (e) => socket.emit('setSettings', { pucksPerPlayer: Number(e.target.value) }));
$('roundSlider').addEventListener('input', (e) => socket.emit('setSettings', { rounds: Number(e.target.value) }));
$('clockSelect').addEventListener('change', (e) => socket.emit('setSettings', { shotClock: Number(e.target.value) }));
$('twistCheck').addEventListener('change', (e) => socket.emit('setSettings', { twists: e.target.checked }));
$('widthSlider').addEventListener('input', (e) => socket.emit('setConfig', { widthRatio: Number(e.target.value) }));
$('editBtn').addEventListener('click', () => setEditMode(!editMode));
$('clearBtn').addEventListener('click', () => {
  view.obstacles = [];
  socket.emit('setConfig', { obstacles: [], calibratedFor: cssH });
});
$('botBtn').addEventListener('click', () => socket.emit('addBot'));
$('lobbyBtn').addEventListener('click', () => {
  if (confirm('Avbryte kampen og gå til lobbyen?')) socket.emit('resetToLobby');
});
$('kickAllBtn').addEventListener('click', () => {
  if (confirm('Vil du kaste ut ALLE spillere?')) socket.emit('kickAllPlayers');
});

fetch('/join-info')
  .then((res) => res.json())
  .then((info) => {
    joinInfo = info;
    fillQr(document);
  })
  .catch((err) => console.error('Fikk ikke hentet QR-kode:', err));

resize();
requestAnimationFrame(frame);
