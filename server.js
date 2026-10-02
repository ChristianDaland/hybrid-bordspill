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
  pucks: [], // Array av { id, playerUuid, color, x, y, vx, vy, stopped }
  currentRound: 1
};

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

  // --- SHUFFLEBOARD LOGIKK ---
  socket.on('shootPuck', ({ vx, vy }) => {
    const playerList = Object.values(players).filter(p => p.connected);
    if (playerList.length === 0) return;

    const currentPlayer = playerList[gameState.activePlayerIndex % playerList.length];
    if (socket.playerUuid !== currentPlayer.uuid) return; // Kun den aktive spillerens tur

    const newPuck = {
      id: uuidv4(),
      playerUuid: socket.playerUuid,
      playerName: currentPlayer.name,
      color: currentPlayer.color,
      x: 50,  // Starter på midten nederst (50% X)
      y: 95,  // Near bottom (95% Y)
      vx: vx, // Hastighet X
      vy: vy, // Hastighet Y
      stopped: false
    };

    io.emit('puckShot', newPuck);

    // Neste spillers tur
    gameState.activePlayerIndex++;
    const nextPlayer = playerList[gameState.activePlayerIndex % playerList.length];
    io.emit('turnUpdate', { activeUuid: nextPlayer.uuid, name: nextPlayer.name });
  });

  socket.on('updatePuckPositions', (pucks) => {
    gameState.pucks = pucks;
    io.emit('syncPucks', pucks);
  });

  socket.on('resetGame', () => {
    gameState.pucks = [];
    gameState.activePlayerIndex = 0;
    io.emit('gameStateUpdate', gameState);
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

    socket.playerUuid = playerUuid;
    socket.emit('sessionCreated', { uuid: playerUuid, name: players[playerUuid].name, color: players[playerUuid].color });
    
    const activeList = Object.values(players).filter(p => p.connected);
    const activePlayer = activeList[gameState.activePlayerIndex % activeList.length];
    
    io.to('board_room').emit('playerListUpdate', Object.values(players));
    io.emit('turnUpdate', { activeUuid: activePlayer?.uuid, name: activePlayer?.name });
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