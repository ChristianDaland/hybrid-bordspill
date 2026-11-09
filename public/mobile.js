/* global io */
const socket = io();
const $ = (id) => document.getElementById(id);

const MAX_PULL = 200;
const MIN_POWER = 0.06;
const MIN_DOWN_PULL = 8;
const AIM_DAMPING = 0.6;
const MAX_ANGLE = 0.7;
const AIM_SEND_MS = 50;
// Kraftområdet som typisk havner i poengsonene på et vanlig bord.
const SCORING_BAND = [0.345, 0.78];
const REACTIONS = ['😂', '🔥', '😱', '👏', '💀', '🍻'];

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* valgfritt */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* valgfritt */ } },
};

let token = storage.get('shuffle_token');
let me = null;
let state = null;
let isMyTurn = false;
let clockEnd = 0;
let lastThrow = null;
let lastPower = null;

const pad = $('pad');
const g = pad.getContext('2d');
const drag = { active: false, startX: 0, startY: 0, x: 0, y: 0, power: 0, angle: 0, valid: false, lastSend: 0, lastBuzz: 0 };

const vibrate = (pattern) => { if (navigator.vibrate) navigator.vibrate(pattern); };

const inLobby = () => Boolean(state) && (state.phase === 'lobby' || state.phase === 'practice');
const canThrow = () => isMyTurn || (inLobby() && me !== null);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

// --- Tilkobling ---

// Kjører også etter at mobilen har sovet, så spilleren kommer inn igjen av seg selv.
socket.on('connect', () => {
  $('offline').hidden = true;
  if (token) socket.emit('joinGame', { token, name: storage.get('shuffle_name') });
});

socket.on('disconnect', () => { $('offline').hidden = me === null; });

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !socket.connected) socket.connect();
});

function join() {
  const name = $('nameInput').value.trim();
  if (name) socket.emit('joinGame', { token, name });
}

$('joinBtn').addEventListener('click', join);
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('nameInput').value = storage.get('shuffle_name') || '';

socket.on('joined', (info) => {
  me = info;
  token = info.token;
  storage.set('shuffle_token', info.token);
  storage.set('shuffle_name', info.name);
  $('join').hidden = true;
  $('game').hidden = false;
  $('myName').textContent = info.name;
  resizePad();
  render();
});

socket.on('joinRefused', ({ reason }) => { $('joinNote').textContent = reason; });

socket.on('kicked', () => {
  me = null;
  token = null;
  storage.remove('shuffle_token');
  cancelDrag();
  $('game').hidden = true;
  $('join').hidden = false;
  $('joinNote').textContent = 'Du ble fjernet av verten. Du kan bli med på nytt.';
});

socket.on('state', (next) => {
  const wasMyTurn = isMyTurn;
  state = next;
  isMyTurn = Boolean(me && state.turn && state.turn.playerId === me.id && state.phase === 'aiming');
  if (isMyTurn && !wasMyTurn) vibrate([120, 60, 120]);
  if (!canThrow()) cancelDrag();
  clockEnd = state.turn && state.turn.remainingMs !== null ? performance.now() + state.turn.remainingMs : 0;
  render();
});

socket.on('shotResult', ({ shooterId, points, x }) => {
  if (!me || shooterId !== me.id || lastPower === null) return;
  lastThrow = { power: lastPower, result: x === null ? 'av bordet' : points > 0 ? `${points} poeng` : 'utenfor sonene' };
  if (points > 0) vibrate([30, 40, 30]);
});

// --- Skjerm ---

const myPlayer = () => (state && me ? state.players.find((p) => p.id === me.id) : null);

function myColor() {
  const player = myPlayer();
  return (player && player.teamColor) || me.color;
}

function statusFor(player) {
  if (inLobby()) return 'Prøv et kast mens dere venter';
  if (state.phase === 'intro') return `Runde ${state.round}: ${state.twist.name}. ${state.twist.text}`;
  if (state.phase === 'rolling') return 'Pucken glir …';
  if (state.phase === 'roundOver') return `Runde ${state.round} er ferdig`;
  if (state.phase === 'matchOver') return 'Kampen er ferdig';
  if (isMyTurn) return `DIN TUR! ${player.pucksLeft} ${player.pucksLeft === 1 ? 'puck' : 'pucker'} igjen`;
  const active = state.turn && state.players.find((p) => p.id === state.turn.playerId);
  return active ? `Venter på ${active.name}` : 'Venter på spillere';
}

function renderStatus() {
  const status = $('status');
  const seconds = clockEnd ? Math.ceil((clockEnd - performance.now()) / 1000) : null;
  const clock = isMyTurn && seconds !== null && seconds >= 0 ? ` (${seconds})` : '';
  status.textContent = statusFor(myPlayer()) + clock;
  status.className = isMyTurn ? (seconds !== null && seconds <= 8 ? 'warn' : 'mine') : '';
}

function playerList(rows, renderValue) {
  return el(
    'ol',
    { className: 'list' },
    ...rows.map((r) => {
      const swatch = el('span', { className: 'dot' });
      swatch.style.background = r.color;
      return el('li', { className: r.id === me.id ? 'me' : '' }, swatch, el('span', { className: 'n', textContent: r.name }), renderValue ? el('b', { textContent: renderValue(r) }) : null);
    })
  );
}

function actionButton(label, event) {
  return el('button', { className: 'btn', textContent: label, onclick: () => { vibrate(20); socket.emit(event); } });
}

function panelContent() {
  const { summary } = state;
  const myTeam = myPlayer().teamName;
  const rows = summary.teams || summary.ranking;
  const place = (summary.teams ? rows.findIndex((r) => r.name === myTeam) : rows.findIndex((r) => r.id === me.id)) + 1;

  if (state.phase === 'roundOver') {
    return [
      el('h2', { textContent: `Runde ${summary.round}` }),
      el('div', { className: 'big', textContent: `${place}.` }),
      playerList(rows, (r) => `+${r.roundScore} · ${r.total}`),
      el('div', { className: 'spacer' }),
      actionButton('Neste runde', 'next'),
    ];
  }

  const won = summary.winners.names.includes(myTeam || me.name);
  const myAwards = (summary.awards || []).filter((a) => a.names.includes(me.name));
  return [
    el('h2', { textContent: won ? '🏆 Du vant!' : 'Sluttresultat' }),
    el('div', { className: 'big', textContent: `${place}.` }),
    playerList(rows, (r) => String(r.total)),
    ...myAwards.map((a) => el('div', { className: 'muted', textContent: `${a.emoji} ${a.title}: ${a.detail}` })),
    el('div', { className: 'spacer' }),
    actionButton('Spill igjen', 'rematch'),
  ];
}

let panelKey = '';

function render() {
  if (!state || !me) return;
  const player = myPlayer();
  if (!player) return;

  const inPlay = ['intro', 'aiming', 'rolling'].includes(state.phase);
  const showPad = inPlay || inLobby();
  $('myDot').style.background = myColor();
  const score = $('myScore');
  score.replaceChildren(
    ...(inPlay && player.roundScore > 0 ? [el('small', { textContent: `+${player.roundScore}` })] : []),
    String(player.total)
  );
  renderStatus();

  const panel = $('panel');
  panel.hidden = showPad;
  pad.style.display = showPad ? 'block' : 'none';
  $('startBar').hidden = !inLobby();
  if (!showPad) {
    const key = JSON.stringify([state.phase, state.players.map((p) => p.name), state.summary && state.summary.round]);
    if (key !== panelKey) {
      panelKey = key;
      panel.replaceChildren(...panelContent());
    }
  } else {
    panelKey = '';
  }
}

setInterval(() => { if (state && me && isMyTurn) renderStatus(); }, 250);

// --- Kastefeltet ---

function resizePad() {
  const rect = $('stage').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  pad.width = Math.round(rect.width * dpr);
  pad.height = Math.round(rect.height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', resizePad);

function padPoint(e) {
  const rect = pad.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function updateDrag(point) {
  drag.x = point.x;
  drag.y = point.y;
  const dx = point.x - drag.startX;
  const dy = point.y - drag.startY;
  drag.power = Math.min(1, Math.hypot(dx, dy) / MAX_PULL);
  drag.valid = dy > MIN_DOWN_PULL && drag.power >= MIN_POWER;
  drag.angle = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, Math.atan2(-dx, Math.max(1, dy)) * AIM_DAMPING));
}

function cancelDrag() {
  if (!drag.active) return;
  drag.active = false;
  socket.emit('aim', null);
}

pad.addEventListener('pointerdown', (e) => {
  if (!canThrow()) return;
  const point = padPoint(e);
  drag.active = true;
  drag.startX = point.x;
  drag.startY = point.y;
  drag.lastBuzz = 0;
  updateDrag(point);
  pad.setPointerCapture(e.pointerId);
});

pad.addEventListener('pointermove', (e) => {
  if (!drag.active) return;
  updateDrag(padPoint(e));

  const notch = Math.floor(drag.power * 10);
  if (notch !== drag.lastBuzz) {
    drag.lastBuzz = notch;
    vibrate(6);
  }

  const now = performance.now();
  if (isMyTurn && now - drag.lastSend > AIM_SEND_MS) {
    drag.lastSend = now;
    socket.volatile.emit('aim', drag.valid ? { power: drag.power, angle: drag.angle } : null);
  }
});

pad.addEventListener('pointerup', () => {
  if (!drag.active) return;
  const { valid, power, angle } = drag;
  drag.active = false;
  if (valid && isMyTurn) {
    vibrate(35);
    lastPower = power;
    socket.emit('shoot', { power, angle });
  } else if (valid && inLobby()) {
    vibrate(35);
    lastPower = power;
    socket.emit('practice', { power, angle });
  } else if (isMyTurn) {
    socket.emit('aim', null);
  }
});

pad.addEventListener('pointercancel', cancelDrag);

function drawPuck(x, y, r, color, alpha = 1) {
  g.globalAlpha = alpha;
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(255,255,255,.95)';
  g.stroke();
  g.globalAlpha = 1;
}

function drawPowerMeter(w, h) {
  const x = w - 22;
  const top = 26;
  const height = h - 52;
  g.fillStyle = 'rgba(255,255,255,.1)';
  g.fillRect(x, top, 10, height);
  const [low, high] = SCORING_BAND;
  g.fillStyle = 'rgba(79,208,143,.4)';
  g.fillRect(x, top + height * (1 - high), 10, height * (high - low));
  g.fillStyle = drag.power > SCORING_BAND[1] ? '#e5574f' : '#e2b35c';
  g.fillRect(x, top + height * (1 - drag.power), 10, height * drag.power);
  if (lastThrow) {
    g.fillStyle = '#fff';
    g.fillRect(x - 6, top + height * (1 - lastThrow.power) - 1.5, 22, 3);
  }
}

function drawPad(now) {
  requestAnimationFrame(drawPad);
  if (!me || pad.style.display === 'none') return;
  const w = pad.clientWidth;
  const h = pad.clientHeight;
  g.clearRect(0, 0, w, h);
  const color = myColor();

  if (!canThrow()) {
    drawPuck(w / 2, h * 0.3, 34, color, 0.25);
    return;
  }

  if (!drag.active) {
    const bob = Math.sin(now / 260) * 16;
    g.strokeStyle = 'rgba(255,255,255,.3)';
    g.lineWidth = 3;
    g.setLineDash([6, 10]);
    g.beginPath();
    g.moveTo(w / 2, h * 0.22);
    g.lineTo(w / 2, h * 0.22 + 150);
    g.stroke();
    g.setLineDash([]);
    drawPuck(w / 2, h * 0.22 + 42 + bob, 34, color);
    g.fillStyle = '#b3a491';
    g.font = '600 15px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('Sett fingeren høyt oppe, dra ned og slipp', w / 2, h - (inLobby() ? 84 : 18));
    if (lastThrow) {
      g.fillStyle = '#f6ecdf';
      g.fillText(`Forrige kast: ${Math.round(lastThrow.power * 100)} % gav ${lastThrow.result}`, w / 2, 28);
    }
    return;
  }

  const { startX, startY, x, y, power, valid, angle } = drag;
  g.strokeStyle = valid ? color : 'rgba(255,255,255,.3)';
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(startX, startY);
  g.lineTo(x, y);
  g.stroke();

  g.strokeStyle = 'rgba(255,255,255,.35)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(startX, startY, 14, 0, Math.PI * 2);
  g.stroke();

  if (valid) {
    const length = 40 + power * 90;
    const tipX = startX + Math.sin(angle) * length;
    const tipY = startY - Math.cos(angle) * length;
    g.strokeStyle = '#fff';
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(startX, startY);
    g.lineTo(tipX, tipY);
    g.stroke();
  }

  drawPuck(x, y, 34, color);
  drawPowerMeter(w, h);

  g.fillStyle = '#f6ecdf';
  g.font = '800 26px system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText(valid ? `${Math.round(power * 100)} %` : 'Avbryt', 16, 36);
}

requestAnimationFrame(drawPad);

$('startBtn').addEventListener('click', () => { vibrate(20); socket.emit('start'); });

$('reactions').append(
  ...REACTIONS.map((emoji) => el('button', { textContent: emoji, onclick: () => { vibrate(10); socket.emit('react', emoji); } }))
);
