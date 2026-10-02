const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Global tilstand for bordkonfigurasjon
let boardConfig = {
  widthRatio: 100,
  heightRatio: 100,
  obstacles: [] // Array med { id, x, y, radius, label }
};

let players = {};

io.on('connection', (socket) => {
  console.log('Ny tilkobling:', socket.id);

  socket.emit('boardConfigUpdate', boardConfig);

  // --- STORSKJERM / BORD ---
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

  // --- MOBIL / SPILLER ---
  socket.on('joinGame', ({ uuid, name }) => {
    const playerUuid = uuid || uuidv4();
    
    players[playerUuid] = {
      uuid: playerUuid,
      name: name || `Spiller ${Object.keys(players).length + 1}`,
      socketId: socket.id,
      connected: true,
      score: players[playerUuid]?.score || 0
    };

    socket.playerUuid = playerUuid;
    socket.emit('sessionCreated', { uuid: playerUuid, name: players[playerUuid].name });
    io.to('board_room').emit('playerListUpdate', Object.values(players));
  });

  socket.on('disconnect', () => {
    if (socket.playerUuid && players[socket.playerUuid]) {
      players[socket.playerUuid].connected = false;
      io.to('board_room').emit('playerListUpdate', Object.values(players));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server kjører på port ${PORT}`);
});