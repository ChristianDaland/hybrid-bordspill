const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Game } = require('./game');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'lagring.json');
const MAX_PIN_FAILURES = 8;
const PIN_LOCK_MS = 60000;

function loadSaved() {
  try {
    return JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const saved = loadSaved();
const hostPin = process.env.HOST_PIN || saved.hostPin || String(crypto.randomInt(1000, 10000));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = { hostPin, config: game.config, settings: game.settings };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(SAVE_FILE, JSON.stringify(data, null, 2), (err) => {
      if (err) console.error('Kunne ikke lagre oppsettet:', err.message);
    });
  }, 200);
}

const game = new Game({
  config: saved.config,
  settings: saved.settings,
  onSave: scheduleSave,
  emit: (event, payload, room) => {
    if (room === 'boards') io.to('board_room').emit(event, payload);
    else io.emit(event, payload);
  },
});
scheduleSave();

function lanAddress() {
  const skip = /^(docker|br-|veth|virbr|tailscale|tun|zt|wg)/;
  const addresses = Object.entries(os.networkInterfaces())
    .filter(([name]) => !skip.test(name))
    .flatMap(([, list]) => list || [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  return addresses.find((a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a)) || addresses[0] || 'localhost';
}

const isLoopbackHost = (host) => host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
const isLoopbackAddress = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

// Mobilene kan ikke bruke «localhost», så da peker QR-koden til maskinens nettverksadresse.
app.get('/join-info', async (req, res) => {
  let origin = `${req.protocol}://${req.get('host')}`;
  if (process.env.PUBLIC_URL) {
    origin = process.env.PUBLIC_URL.replace(/\/$/, '');
  } else if (isLoopbackHost(req.hostname)) {
    origin = `${req.protocol}://${lanAddress()}:${server.address().port}`;
  }
  const url = `${origin}/mobile.html`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.json({ url, svg });
});

app.use(express.static(path.join(__dirname, 'public')));

let pinFailures = 0;
let pinLockedUntil = 0;

function checkPin(pin) {
  if (Date.now() < pinLockedUntil) return false;
  if (typeof pin === 'string' && pin === hostPin) {
    pinFailures = 0;
    return true;
  }
  if (typeof pin === 'string' && pin !== '' && ++pinFailures >= MAX_PIN_FAILURES) {
    pinFailures = 0;
    pinLockedUntil = Date.now() + PIN_LOCK_MS;
  }
  return false;
}

io.on('connection', (socket) => {
  const on = (event, handler) => {
    socket.on(event, (...args) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`Feil i «${event}»:`, err);
      }
    });
  };
  const hostOn = (event, handler) => on(event, (...args) => socket.data.isHost && handler(...args));
  const playerOn = (event, handler) => on(event, (...args) => socket.data.playerId && handler(socket.data.playerId, ...args));

  socket.emit('state', game.publicState());

  on('registerBoard', (input) => {
    socket.join('board_room');
    socket.data.isHost = isLoopbackAddress(socket.handshake.address) || checkPin(input && input.pin);
    socket.emit('hostStatus', { isHost: socket.data.isHost });
  });

  hostOn('setConfig', (config) => game.setConfig(config));
  hostOn('setSettings', (settings) => game.setSettings(settings));
  hostOn('addBot', () => game.addBot());
  hostOn('resetToLobby', () => game.resetToLobby());
  hostOn('hostStart', () => game.start());
  hostOn('hostNext', () => game.next());
  hostOn('hostRematch', () => game.rematch());

  const notifyKicked = (player) => {
    const target = player && player.socketId && io.sockets.sockets.get(player.socketId);
    if (!target) return;
    target.data.playerId = null;
    target.emit('kicked');
  };

  hostOn('kickPlayer', (id) => notifyKicked(game.remove(id)));
  hostOn('kickAllPlayers', () => game.removeAll().forEach(notifyKicked));

  on('joinGame', (input) => {
    const { token, name } = input || {};
    const player = game.join({ token, name, socketId: socket.id });
    if (!player) {
      socket.emit('joinRefused', { reason: 'Spillet er fullt.' });
      return;
    }
    socket.data.playerId = player.id;
    socket.emit('joined', { id: player.id, token: player.token, name: player.name, color: player.color });
  });

  playerOn('aim', (id, input) => game.aim(id, input));
  playerOn('shoot', (id, input) => game.shoot(id, input));
  playerOn('react', (id, emoji) => game.react(id, emoji));
  playerOn('start', () => game.start());
  playerOn('next', () => game.next());
  playerOn('rematch', () => game.rematch());

  socket.on('disconnect', () => {
    if (socket.data.playerId) game.disconnect(socket.data.playerId, socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server kjører på port ${PORT}`);
  console.log(`Storskjerm: http://localhost:${PORT}  (verts-PIN fra andre maskiner: ${hostPin})`);
});
