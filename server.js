const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Global tilstand for bordkonfigurasjon og aktuelt spill
let boardConfig = {
  widthRatio: 100, // Prosent av skjermbredde
  obstacles: [],   // Døde soner/hindringer på bordet (f.eks. glass)
  activeGame: 'default'
};

let players = {}; // uuid -> { id, name, socketId, connected, score }

io.on('connection', (socket) => {
  console.log('Ny tilkobling:', socket.id);

  // Send nåværende bordoppsett til nylig tilkoblede klienter
  socket.emit('boardConfigUpdate', boardConfig);

  // --- BORD / STORSKJERM HÅNDTERING ---
  socket.on('registerBoard', () => {
    socket.join('board_room');
    console.log('Storskjerm registrert i board_room');
    socket.emit('playerListUpdate', Object.values(players));
  });

  socket.on('updateBoardConfig', (newConfig) => {
    boardConfig = { ...boardConfig, ...newConfig };
    io.emit('boardConfigUpdate', boardConfig);
  });

  // --- MOBIL / SPILLER HÅNDTERING ---
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
    console.log(`Spiller tilkoblet: ${players[playerUuid].name} (${playerUuid})`);
  });

  socket.on('disconnect', () => {
    if (socket.playerUuid && players[socket.playerUuid]) {
      players[socket.playerUuid].connected = false;
      io.to('board_room').emit('playerListUpdate', Object.values(players));
      console.log(`Spiller frakoblet: ${players[socket.playerUuid].name}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server kjører på port ${PORT}`);
});