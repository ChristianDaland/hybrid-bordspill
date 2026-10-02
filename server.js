const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let boardConfig = { widthRatio: 100, heightRatio: 90, obstacles: [] };
let players = {}; 
let gameState = {
  activePlayerIndex: 0,
  pucksPerPlayer: 4, // Standard 4 pucker per spiller
  pucksLeft: {},     // Hvor mange pucker hver spiller har igjen
  pucks: [], 
  gameEnded: false,
  winnerMessage: ''
};

function getActivePlayers() {
  return Object.values(players).filter(p => p.connected);
}

function checkNextTurnOrEnd() {
  const activeList = getActivePlayers();
  if (activeList.length === 0) return;

  // Sjekk om alle har kastet opp brukt opp sine pucker
  let totalRemainingPucks = 0;
  activeList.forEach(p => {
    totalRemainingPucks += (gameState.pucksLeft[p.uuid] || 0);
  });

  if (totalRemainingPucks <= 0) {
    gameState.gameEnded = true;
    io.emit('gameEnded');
    return;
  }

  // Finn neste spiller som faktisk har pucker igjen
  let attempts = 0;
  while (attempts < activeList.length) {
    const candidate = activeList[gameState.activePlayerIndex % activeList.length];
    if ((gameState.pucksLeft[candidate.uuid] || 0) > 0) {
      io.emit('turnUpdate', { 
        activeUuid: candidate.uuid, 
        name: candidate.name,
        pucksLeft: gameState.pucksLeft[candidate.uuid]
      });
      break;
    }
    gameState.activePlayerIndex++;
    attempts++;
  }
}

io.on('connection', (socket) => {
  socket.emit('boardConfigUpdate', boardConfig);
  socket.emit('gameStateUpdate', gameState);

  socket.on('registerBoard', () => {
    socket.join('board_room');
    socket.emit('playerListUpdate', Object.values(players));
  });

  socket.on('updateBoardConfig', (newConfig) => {
    boardConfig = { ...boardConfig, ...newConfig };
    io.emit('boardConfigUpdate', boardConfig);
  });

  socket.on('addObstacle', (obstacle) => {
    obstacle.id = uuidv4();
    boardConfig.obstacles.push(obstacle);
    io.emit('boardConfigUpdate', boardConfig);
  });

  socket.on('clearObstacles', () => {
    boardConfig.obstacles = [];
    io.emit('boardConfigUpdate', boardConfig);
  });

  socket.on('setPucksPerPlayer', (count) => {
    gameState.pucksPerPlayer = parseInt(count) || 4;
    // Nullstill pucker for aktive spillere
    const activeList = getActivePlayers();
    activeList.forEach(p => {
      gameState.pucksLeft[p.uuid] = gameState.pucksPerPlayer;
    });
    io.emit('gameStateUpdate', gameState);
  });

  // --- SHUFFLEBOARD LOGIKK ---
  socket.on('shootPuck', ({ vx, vy }) => {
    if (gameState.gameEnded) return;

    const activeList = getActivePlayers();
    if (activeList.length === 0) return;

    const currentPlayer = activeList[gameState.activePlayerIndex % activeList.length];
    if (socket.playerUuid !== currentPlayer.uuid) return;

    if ((gameState.pucksLeft[currentPlayer.uuid] || 0) <= 0) return;

    // Trekk fra en puck
    gameState.pucksLeft[currentPlayer.uuid]--;

    const newPuck = {
      id: uuidv4(),
      playerUuid: socket.playerUuid,
      playerName: currentPlayer.name,
      color: currentPlayer.color,
      x: 50,
      y: 95,
      vx: vx,
      vy: vy,
      stopped: false
    };

    io.emit('puckShot', newPuck);

    // Gå videre til neste spiller
    gameState.activePlayerIndex++;
    checkNextTurnOrEnd();
  });

  socket.on('resetGame', () => {
    gameState.pucks = [];
    gameState.activePlayerIndex = 0;
    gameState.gameEnded = false;
    gameState.winnerMessage = '';
    
    const activeList = getActivePlayers();
    activeList.forEach(p => {
      gameState.pucksLeft[p.uuid] = gameState.pucksPerPlayer;
    });

    io.emit('gameStateUpdate', gameState);
    checkNextTurnOrEnd();
  });

  // --- SPILLERHÅNDTERING ---
  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'];

  socket.on('joinGame', ({ uuid, name }) => {
    const playerUuid = uuid || uuidv4();
    const playerArray = Object.values(players);

    players[playerUuid] = {
      uuid: playerUuid,
      name: name || `Spiller ${playerArray.length + 1}`,
      socketId: socket.id,
      connected: true,
      color: players[playerUuid]?.color || colors[playerArray.length % colors.length],
      score: players[playerUuid]?.score || 0
    };

    if (gameState.pucksLeft[playerUuid] === undefined) {
      gameState.pucksLeft[playerUuid] = gameState.pucksPerPlayer;
    }

    socket.playerUuid = playerUuid;
    socket.emit('sessionCreated', { uuid: playerUuid, name: players[playerUuid].name, color: players[playerUuid].color });
    
    io.to('board_room').emit('playerListUpdate', Object.values(players));
    checkNextTurnOrEnd();
  });

  socket.on('disconnect', () => {
    if (socket.playerUuid && players[socket.playerUuid]) {
      players[socket.playerUuid].connected = false;
      io.to('board_room').emit('playerListUpdate', Object.values(players));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));