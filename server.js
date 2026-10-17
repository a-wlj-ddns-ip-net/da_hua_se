const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = []; // { id, name, dice: [], isReady: false }
let gameState = 'LOBBY'; // 'LOBBY', 'PLAYING', 'ROUND_OVER'
let turnIndex = 0;
let currentBid = null; // { count: number, value: number, playerId: string, playerName: string }

function rollDice() {
  return Array.from({ length: 5 }, () => Math.floor(Math.random() * 6) + 1);
}

io.on('connection', (socket) => {
  console.log('玩家已连接:', socket.id);

  // 玩家加入
  socket.on('joinGame', (playerName) => {
    if (players.length >= 6) {
      socket.emit('errorMsg', '房间已满（最多6人）');
      return;
    }
    const name = playerName.trim() || `玩家_${socket.id.slice(0, 4)}`;
    players.push({
      id: socket.id,
      name: name,
      dice: [],
      isReady: false
    });
    io.emit('updateRoom', { players, gameState, currentBid, turnPlayerId: players[turnIndex]?.id });
  });

  // 玩家准备
  socket.on('toggleReady', () => {
    const player = players.find(p => p.id === socket.id);
    if (player && gameState === 'LOBBY') {
      player.isReady = !player.isReady;
      
      const allReady = players.length >= 2 && players.every(p => p.isReady);
      if (allReady) {
        startGame();
      } else {
        io.emit('updateRoom', { players, gameState, currentBid, turnPlayerId: players[turnIndex]?.id });
      }
    }
  });

  // 叫注 (Bid)
  socket.on('placeBid', ({ count, value }) => {
    if (gameState !== 'PLAYING') return;
    if (players[turnIndex].id !== socket.id) return;

    if (currentBid) {
      const isValid = count > currentBid.count || (count === currentBid.count && value > currentBid.value);
      if (!isValid) {
        socket.emit('errorMsg', '叫注必须高于上家！');
        return;
      }
    }

    currentBid = {
      count,
      value,
      playerId: socket.id,
      playerName: players[turnIndex].name
    };

    turnIndex = (turnIndex + 1) % players.length;
    io.emit('updateRoom', { players: getPublicPlayersData(), gameState, currentBid, turnPlayerId: players[turnIndex].id });
    io.emit('logMessage', `${players.find(p => p.id === socket.id).name} 叫了：${count} 个 ${value} 点`);
  });

  // 开/质疑 (Challenge)
  socket.on('challenge', () => {
    if (gameState !== 'PLAYING' || !currentBid) return;
    if (players[turnIndex].id !== socket.id) return;

    const challenger = players[turnIndex];
    const bidder = players.find(p => p.id === currentBid.playerId);

    let totalCount = 0;
    players.forEach(p => {
      p.dice.forEach(d => {
        if (d === currentBid.value || d === 1) {
          totalCount++;
        }
      });
    });

    const isSuccess = totalCount >= currentBid.count;
    let resultMsg = `${challenger.name} 质疑了 ${bidder.name} 的叫注（${currentBid.count} 个 ${currentBid.value} 点）！\n`;
    resultMsg += `结算结果：全场共有 ${totalCount} 个 ${currentBid.value} 点 (含1点)。\n`;

    if (isSuccess) {
      resultMsg += `👉 ${bidder.name} 吹牛失败！${challenger.name} 质疑成功！`;
    } else {
      resultMsg += `👉 ${bidder.name} 没有吹牛！${challenger.name} 质疑失败！`;
    }

    gameState = 'ROUND_OVER';
    io.emit('roundResult', {
      message: resultMsg,
      allPlayersDice: players.map(p => ({ name: p.name, dice: p.dice }))
    });

    setTimeout(() => {
      resetForNextRound();
    }, 6000);
  });

  // 断开连接
  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    if (players.length < 2 && gameState === 'PLAYING') {
      gameState = 'LOBBY';
      currentBid = null;
      io.emit('logMessage', '玩家人数不足，游戏重置');
    }
    if (turnIndex >= players.length) turnIndex = 0;
    io.emit('updateRoom', { players: getPublicPlayersData(), gameState, currentBid, turnPlayerId: players[turnIndex]?.id });
  });
});

function startGame() {
  gameState = 'PLAYING';
  currentBid = null;
  turnIndex = Math.floor(Math.random() * players.length);

  players.forEach(p => {
    p.dice = rollDice().sort((a, b) => a - b);
    p.isReady = false;
  });

  players.forEach(p => {
    io.to(p.id).emit('yourDice', p.dice);
  });

  io.emit('updateRoom', { players: getPublicPlayersData(), gameState, currentBid, turnPlayerId: players[turnIndex].id });
  io.emit('logMessage', `游戏开始！轮到 ${players[turnIndex].name} 先叫注。`);
}

function resetForNextRound() {
  gameState = 'LOBBY';
  currentBid = null;
  players.forEach(p => p.isReady = false);
  io.emit('updateRoom', { players: getPublicPlayersData(), gameState, currentBid, turnPlayerId: null });
  io.emit('logMessage', '本局结束，请重新点击准备！');
}

function getPublicPlayersData() {
  return players.map(p => ({
    id: p.id,
    name: p.name,
    isReady: p.isReady,
    diceCount: p.dice.length
  }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器已启动：http://localhost:${PORT}`);
});