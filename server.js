/*
    FILE: server.js (Server-Side)
    UPDATE:
    - Sửa lỗi đa tab: Giờ đây hệ thống có thể quản lý nhiều kết nối (tab) cho một người dùng.
    - Phòng chơi sẽ chỉ bị ảnh hưởng khi người dùng đóng tab cuối cùng.
    - Xác thực và logic game được dựa trên userId ổn định, không phải socketId tạm thời.
*/
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const NUM_PLAYERS_REQUIRED = 2;
const FINISH_LINE = 10;
const MIN_TURNS = 10;

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const gameRooms = {};
const users = {}; // Lưu { userId: name }
const socketIdToUserId = {}; // Lưu { socketId: userId }
const userConnections = {}; // Lưu { userId: Set<socketId> }

// --- HELPER FUNCTIONS ---
const sleep = ms => new Promise(res => setTimeout(res, ms));
const translateColor = (c) => ({ R: 'Đỏ', G: 'Xanh', Y: 'Vàng', W: 'Trắng' }[c] || '?');
const getColorClass = (c) => ({ R: 'red', G: 'green', Y: 'yellow' }[c] || 'gray');

// --- LOBBY FUNCTION ---
function getLobbyInfo() {
    return Object.values(gameRooms).map(room => ({
        roomId: room.roomId,
        playerCount: room.players.filter(p => p.isConnected).length,
        maxPlayers: NUM_PLAYERS_REQUIRED,
        gamePhase: room.gamePhase,
    }));
}

// --- GAME STATE MANAGEMENT ---
function createNewGameState(roomId) {
    return {
        roomId, turn: 1, players: [], gmChoices: [], priorityColor: null, gamePhase: 'WAITING',
        removeGmUsedThisTurn: false, removeGmPlayerId: null, isResolvingMoves: false, logHistory: [],
        specialNextTurnEffects: { highestPlayerCannotMove: false, lowestPlayerBonusMove: false, allMovesMinusOne: false },
        lastLog: { tag: 'Chờ', message: `Đang chờ đủ ${NUM_PLAYERS_REQUIRED} người chơi...`, tagBg: 'bg-gray-500' }
    };
}

function getRoomByUserId(userId) {
    if (!userId) return null;
    return Object.values(gameRooms).find(room => room.players.some(p => p.userId === userId));
}

function logAndEmit(roomId, tag, message, options = {}) {
    const state = gameRooms[roomId];
    if (!state) return;
    const { colorClass = 'text-slate-300', tagBg = 'bg-gray-500' } = options;
    const logEntry = { tag, message, colorClass, tagBg };
    state.logHistory.push(logEntry);
    state.lastLog = logEntry;
    io.to(roomId).emit('gameStateUpdate', state);
}

function markPlayerAsDisconnected(userId) {
    const room = getRoomByUserId(userId);
    if (room) {
        const player = room.players.find(p => p.userId === userId);
        if (player) {
            player.isConnected = false;
            if (room.gamePhase === 'WAITING') {
                room.players = room.players.filter(p => p.userId !== userId);
                room.players.forEach((p, index) => { p.id = index; });
            }
            
            logAndEmit(room.roomId, 'Mất kết nối', `<b>${player.name}</b> đã mất kết nối.`, { tagBg: 'bg-red-500' });

            if (room.players.filter(p => p.isConnected).length === 0) {
                delete gameRooms[room.roomId];
            }

            io.to(room.roomId).emit('gameStateUpdate', room);
            io.emit('updateRoomList', getLobbyInfo());
        }
    }
}

// --- CORE GAME LOGIC (Không thay đổi) ---
async function startTurn(roomId) {
    const state = gameRooms[roomId];
    if (!state || state.gamePhase === 'GAMEOVER') return;
    
    state.movementVisuals = null;
    
    state.gamePhase = 'CHOOSING';
    state.isResolvingMoves = false;
    state.players.forEach(p => { p.choice = null; p.prevPosition = p.position; });
    state.removeGmUsedThisTurn = false;
    state.removeGmPlayerId = null;
    state.priorityColor = null;
    state.colorCounts = {};
    
    const connectedPlayersCount = state.players.filter(p => p.isConnected).length;
    const numGmCards = connectedPlayersCount < 5 ? 5 - connectedPlayersCount : 1;
    
    state.gmChoices = [];
    const possibleColors = ['R', 'G', 'Y'];
    for (let i = 0; i < numGmCards; i++) {
        const randomColor = possibleColors[Math.floor(Math.random() * possibleColors.length)];
        state.gmChoices.push(randomColor);
    }

    logAndEmit(roomId, `Lượt ${state.turn}`, 'Tất cả người chơi hãy chọn thẻ của mình.', { tagBg: 'bg-blue-500' });
}

async function proceedWithResolution(roomId) {
    const state = gameRooms[roomId];
    if(!state) return;
    state.isResolvingMoves = true;
    state.gamePhase = 'REVEAL';

    io.to(roomId).emit('showChoices', state.players);
    await sleep(1000);
    let colorCounts = { R: 0, G: 0, Y: 0 };
    let playersToCount = state.players.filter(p => p.isConnected && !p.isFinished);
    
    if (!state.removeGmUsedThisTurn) {
        state.gmChoices.forEach(gmCard => playersToCount.push({ choice: gmCard }));
    }

    playersToCount.forEach(p => { if (p.choice && colorCounts[p.choice] !== undefined) colorCounts[p.choice]++; });
    state.colorCounts = colorCounts;
    logAndEmit(roomId, 'Đếm thẻ', 'Đang đếm số lượng thẻ...', {tagBg: 'bg-slate-600'});
    await sleep(1500);
    
    if (!state.priorityColor) {
        const counts = Object.entries(colorCounts).filter(([_, v]) => v > 0).map(([color, count]) => ({color, count}));
        const firstGmChoice = state.gmChoices.length > 0 ? state.gmChoices[0] : null;

        if (counts.length === 0) state.priorityColor = null;
        else if (counts.length === 1) state.priorityColor = counts[0].color;
        else if (counts.length === 3) {
            counts.sort((a,b) => a.count - b.count);
            if (counts[0].count < counts[1].count && counts[1].count < counts[2].count) state.priorityColor = counts[0].color;
            else if (counts[0].count === counts[1].count && counts[1].count < counts[2].count) state.priorityColor = counts[2].color;
            else if (counts[0].count < counts[1].count && counts[1].count === counts[2].count) state.priorityColor = counts[0].color;
            else state.priorityColor = !state.removeGmUsedThisTurn ? firstGmChoice : null;
        } else if (counts.length === 2) {
             state.priorityColor = counts[0].count === counts[1].count ? (!state.removeGmUsedThisTurn ? firstGmChoice : null) : (counts[0].count < counts[1].count ? counts[0].color : counts[1].color);
        }
    }
    
    if (state.priorityColor) {
        logAndEmit(roomId, `Ưu tiên`, `Màu ưu tiên là <b class="text-${getColorClass(state.priorityColor)}-400">${translateColor(state.priorityColor)}</b>!`, { tagBg: 'bg-green-500', colorClass: 'text-green-300' });
        await sleep(1500);
        await moveCars(roomId);
    } else {
        logAndEmit(roomId, 'Hòa', 'Không có Màu Ưu Tiên, không ai di chuyển.', { tagBg: 'bg-gray-500' });
        await sleep(1500);
        await endTurn(roomId);
    }
}

async function moveCars(roomId) {
    const state = gameRooms[roomId];
    if(!state) return;

    logAndEmit(roomId, 'Di Chuyển', `Bắt đầu tính toán...`, { tagBg: 'bg-blue-500' });
    await sleep(1000);
    
    let movements = new Map(state.players.map(p => [p.id, 0]));
    const activePlayers = state.players.filter(p => p.isConnected && !p.isFinished);
    
    if(state.specialNextTurnEffects.lowestPlayerBonusMove && activePlayers.length > 0) {
        const lowestPos = Math.min(...activePlayers.map(p => p.position));
        const rewardedPlayers = activePlayers.filter(p => p.position === lowestPos);
        rewardedPlayers.forEach(p => movements.set(p.id, movements.get(p.id) + 1));
        logAndEmit(roomId, `Hiệu ứng`, `Thưởng đáy bảng: ${rewardedPlayers.map(p=>`<b>${p.name}</b>`).join(', ')} (+1 ô).`, {tagBg: 'bg-green-500'});
        await sleep(800);
    }

    let baseMove = { R: 0, Y: 1, G: 2 }[state.priorityColor] ?? 0;
    if (state.specialNextTurnEffects.allMovesMinusOne && baseMove > 0) {
        baseMove--;
        logAndEmit(roomId, 'Hiệu ứng', 'Mọi di chuyển cơ bản -1.', {tagBg: 'bg-yellow-500'});
    }
    if (baseMove > 0) {
        logAndEmit(roomId, `Cơ bản`, `Mọi người tiến (+${baseMove} ô).`, {tagBg: 'bg-gray-500'});
        activePlayers.forEach(p => movements.set(p.id, movements.get(p.id) + baseMove));
        await sleep(800);
    }

    const matchingPlayers = activePlayers.filter(p => p.choice === state.priorityColor);
    if (state.priorityColor !== 'R' && matchingPlayers.length > 0) {
        matchingPlayers.forEach(p => movements.set(p.id, movements.get(p.id) + 1));
        logAndEmit(roomId, `Thưởng`, `Trùng màu: ${matchingPlayers.map(p=>`<b>${p.name}</b>`).join(', ')} (+1 ô).`, {tagBg: 'bg-green-500'});
        await sleep(800);
    }
    
    const nonMatchingPlayers = activePlayers.filter(p => p.choice !== state.priorityColor);
    if (nonMatchingPlayers.length > 0) {
        if (state.priorityColor !== 'R') {
            const highestPos = Math.max(...nonMatchingPlayers.map(p => p.position));
            const penalized = nonMatchingPlayers.filter(p => p.position === highestPos);
            penalized.forEach(p => movements.set(p.id, movements.get(p.id) - 1));
            logAndEmit(roomId, `Phạt`, `Khác màu cao nhất: ${penalized.map(p=>`<b>${p.name}</b>`).join(', ')} (-1 ô).`, {tagBg: 'bg-red-500'});
        } else {
            const isLateGame = state.turn > MIN_TURNS || state.players.some(p=>p.isFinished);
            if (!isLateGame) {
                nonMatchingPlayers.forEach(p => movements.set(p.id, movements.get(p.id) - 1));
                logAndEmit(roomId, `Phạt`, `Không chọn Đỏ: ${nonMatchingPlayers.map(p=>`<b>${p.name}</b>`).join(', ')} (-1 ô).`, {tagBg: 'bg-red-500'});
                await sleep(800);
                
                const highestPos = Math.max(...nonMatchingPlayers.map(p => p.position));
                const highestGroup = nonMatchingPlayers.filter(p => p.position === highestPos);
                if (highestGroup.length === 1) {
                    movements.set(highestGroup[0].id, movements.get(highestGroup[0].id) - 1);
                    logAndEmit(roomId, `Phạt`, `Thêm cho người cao nhất: <b>${highestGroup[0].name}</b> (-1 ô nữa).`, {tagBg: 'bg-red-500'});
                }
            } else { logAndEmit(roomId, 'Thông báo', 'Cuối trận, bỏ qua hình phạt của màu Đỏ.', {tagBg: 'bg-gray-500'}); }
        }
        await sleep(800);
    }
    
    if(state.specialNextTurnEffects.highestPlayerCannotMove && activePlayers.length > 0) {
        const highestPos = Math.max(...activePlayers.map(p => p.position));
        const blocked = activePlayers.filter(p => p.position === highestPos && movements.get(p.id) > 0);
        if (blocked.length > 0) {
            blocked.forEach(p => movements.set(p.id, 0));
            logAndEmit(roomId, `Hiệu ứng`, `Chặn người dẫn đầu: ${blocked.map(p=>`<b>${p.name}</b>`).join(', ')}!`, {tagBg: 'bg-red-500'});
        }
    }
    
    const movementVisuals = {};
    activePlayers.forEach(p => {
        const move = movements.get(p.id) || 0;
        p.position = Math.min(FINISH_LINE, Math.max(0, p.position + move));
        if (move !== 0) {
            movementVisuals[p.id] = { prevPos: p.prevPosition, finalPos: p.position, move, start: Math.min(p.position, p.prevPosition), end: Math.max(p.position, p.prevPosition) };
        }
    });
    
    state.movementVisuals = movementVisuals;
    io.to(roomId).emit('visualizeMovements', movementVisuals);
    logAndEmit(roomId, `Kết quả`, `Cập nhật vị trí...`, {tagBg: 'bg-blue-500'});
    await sleep(1500);

    const canTriggerRedLight = state.priorityColor === 'R' && !state.players.some(p=>p.isFinished) && state.turn <= MIN_TURNS;
    if(canTriggerRedLight) {
        const atStartNotRed = activePlayers.filter(p => p.prevPosition === 0 && p.choice !== 'R');
        if (atStartNotRed.length > 0) {
            logAndEmit(roomId, `Vượt Đèn Đỏ`, `${atStartNotRed.map(p=>`<b>${p.name}</b>`).join(', ')} bị phạt.`, {tagBg: 'bg-amber-500', colorClass: 'text-amber-300'});
            await sleep(800);
            const redPickers = activePlayers.filter(p => p.choice === 'R');
            if (redPickers.length > 0) {
                logAndEmit(roomId, `Thưởng`, `Người chọn Đỏ ${redPickers.map(p=>`<b>${p.name}</b>`).join(', ')} (+${atStartNotRed.length} ô).`, {tagBg: 'bg-green-500'});
                redPickers.forEach(p => { p.position = Math.min(FINISH_LINE, p.position + atStartNotRed.length); });
                io.to(roomId).emit('gameStateUpdate', state);
                await sleep(1000);
            }
        }
    }

    await endTurn(roomId);
}

async function endTurn(roomId) {
    const state = gameRooms[roomId];
    if(!state) return;

    state.specialNextTurnEffects = { highestPlayerCannotMove: false, lowestPlayerBonusMove: false, allMovesMinusOne: false };
    const activeEntities = state.players.filter(p => p.isConnected && !p.isFinished);
    if (!state.removeGmUsedThisTurn) {
        state.gmChoices.forEach(gmCard => activeEntities.push({ choice: gmCard }));
    }
    const threshold = activeEntities.length > 1 ? activeEntities.length - 1 : 0;
    if (threshold > 1) {
        let colorCounts = { R: 0, G: 0, Y: 0 };
        activeEntities.forEach(p => { if (p.choice && colorCounts[p.choice] !== undefined) colorCounts[p.choice]++ });
        for (const color of ['R', 'G', 'Y']) {
            if (colorCounts[color] >= threshold) {
                logAndEmit(roomId, `Hiệu ứng (n-1)`, `Kích hoạt cho lượt sau.`, {tagBg: 'bg-orange-500', colorClass: 'text-orange-300'});
                await sleep(800);
                if (color === 'R') state.specialNextTurnEffects.highestPlayerCannotMove = true;
                if (color === 'G') state.specialNextTurnEffects.lowestPlayerBonusMove = true;
                if (color === 'Y') state.specialNextTurnEffects.allMovesMinusOne = true;
                break;
            }
        }
    }

    state.players.forEach(p => {
        if (p.position >= FINISH_LINE && !p.isFinished) {
            p.isFinished = true;
            p.finishTurn = state.turn;
            logAndEmit(roomId, `Về Đích!`, `<b>${p.name}</b> đã hoàn thành cuộc đua!`, { tagBg: 'bg-amber-500', colorClass: 'text-amber-300' });
        }
        if (!p.isFinished) p.lastPlayed = p.choice;
    });

    const connectedPlayers = state.players.filter(p => p.isConnected);
    const allPlayersFinished = connectedPlayers.length > 0 && connectedPlayers.every(p => p.isFinished);
    const finishers = state.players.filter(p => p.isFinished);
    
    if ((finishers.length >= (NUM_PLAYERS_REQUIRED-1) && state.turn >= MIN_TURNS) || state.turn >= 30 || allPlayersFinished) {
        state.gamePhase = 'GAMEOVER';
        io.to(roomId).emit('gameOver', state);
        logAndEmit(roomId, 'Kết thúc', 'Trò chơi đã kết thúc!', {tagBg: 'bg-amber-500'});
        return;
    }
    
    state.turn++;
    await sleep(2000);
    await startTurn(roomId);
}


// --- SOCKET.IO EVENT HANDLERS ---
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on('authenticate', (data) => {
        let userId;
        let name;

        if (data.userId && users[data.userId]) {
            userId = data.userId;
            name = users[userId];
            console.log(`User re-authenticated: ${name} (${userId})`);
        } else if (data.name) {
            const trimmedName = data.name.trim();
            if (!trimmedName || trimmedName.length > 15) return socket.emit('authError', 'Tên không hợp lệ.');
            name = trimmedName;
            userId = crypto.randomUUID();
            users[userId] = name;
            console.log(`New user created: ${name} (${userId})`);
        } else {
            return socket.emit('authError', 'Dữ liệu xác thực không hợp lệ.');
        }

        socketIdToUserId[socket.id] = userId;
        if (!userConnections[userId]) {
            userConnections[userId] = new Set();
        }
        userConnections[userId].add(socket.id);
        
        socket.emit('authenticated', { userId, name });
        socket.emit('updateRoomList', getLobbyInfo());
    });
    
    socket.on('requestRoomList', () => {
        socket.emit('updateRoomList', getLobbyInfo());
    });
    
    socket.on('createRoom', () => {
        const userId = socketIdToUserId[socket.id];
        if (!userId) return socket.emit('error', 'Bạn chưa được xác thực.');
        
        let roomId;
        do { roomId = Math.random().toString(36).substring(2, 7).toUpperCase(); } while (gameRooms[roomId]);
        
        gameRooms[roomId] = createNewGameState(roomId);
        const state = gameRooms[roomId];
        const newPlayer = {
            id: 0, userId, name: users[userId], isConnected: true,
            position: 0, prevPosition: 0, hasWhiteCard: true, canUseRemoveGm: true,
            lastPlayed: null, choice: null, isFinished: false, finishTurn: null,
        };
        state.players.push(newPlayer);
        
        socket.join(roomId);
        socket.emit('roomJoined', { roomId, gameState: state });
        io.emit('updateRoomList', getLobbyInfo());
    });

    socket.on('joinRoom', (roomId) => {
        const userId = socketIdToUserId[socket.id];
        if (!userId) return socket.emit('error', 'Bạn chưa được xác thực.');

        const room = gameRooms[roomId];
        if (!room) return socket.emit('error', 'Phòng không tồn tại.');
        
        const rejoinSlot = room.players.find(p => p.userId === userId);
        if (rejoinSlot) {
            rejoinSlot.isConnected = true;
            socket.join(roomId);
            socket.emit('roomJoined', { roomId, gameState: room });
            logAndEmit(roomId, 'Tái kết nối', `<b>${rejoinSlot.name}</b> đã kết nối lại.`, { tagBg: 'bg-green-600' });
            io.emit('updateRoomList', getLobbyInfo());
            return;
        }

        if (room.gamePhase !== 'WAITING') return socket.emit('error', 'Trò chơi đã bắt đầu.');
        if (room.players.length >= NUM_PLAYERS_REQUIRED) return socket.emit('error', 'Phòng đã đầy.');
        
        const newPlayer = {
            id: room.players.length, userId, name: users[userId], isConnected: true,
            position: 0, prevPosition: 0, hasWhiteCard: true, canUseRemoveGm: true,
            lastPlayed: null, choice: null, isFinished: false, finishTurn: null,
        };
        room.players.push(newPlayer);

        socket.join(roomId);
        socket.emit('roomJoined', { roomId, gameState: room });
        logAndEmit(roomId, 'Tham gia', `<b>${users[userId]}</b> đã vào phòng.`, {tagBg: 'bg-blue-600'});
        
        io.emit('updateRoomList', getLobbyInfo());

        if (room.players.filter(p => p.isConnected).length === NUM_PLAYERS_REQUIRED) {
            startTurn(roomId);
        }
    });

    socket.on('playerAction', async (action) => {
        const userId = socketIdToUserId[socket.id];
        if (!userId) return;
        
        const room = getRoomByUserId(userId);
        if (!room) return;
        
        const player = room.players.find(p => p.userId === userId);
        if (!player || room.gamePhase !== 'CHOOSING' || player.choice) return;

        if (action.type === 'CHOOSE_CARD') { player.choice = action.card; } 
        else if (action.type === 'USE_POWER') {
            room.removeGmUsedThisTurn = true;
            room.removeGmPlayerId = player.id;
            player.canUseRemoveGm = false;
        } else if (action.type === 'RESELECT_CARD') { player.choice = action.card; }
        
        logAndEmit(room.roomId, 'Đã chọn', `<b>${player.name}</b> đã chọn xong.`, { tagBg: 'bg-slate-600' });
        io.to(room.roomId).emit('gameStateUpdate', room);
        
        const activePlayers = room.players.filter(p => p.isConnected && !p.isFinished);
        const allChosen = activePlayers.every(p => p.choice !== null);

        if (allChosen) {
             if (room.players.some(p => p.choice === 'W' && room.removeGmUsedThisTurn)) {
                await proceedWithResolution(room.roomId);
             } else {
                await proceedWithResolution(room.roomId);
             }
        }
    });

    socket.on('leaveRoom', () => { 
        const userId = socketIdToUserId[socket.id];
        const room = getRoomByUserId(userId);
        if (room) {
            socket.leave(room.roomId);
            markPlayerAsDisconnected(userId);
        }
    });

    socket.on('disconnect', () => { 
        console.log(`Socket disconnected: ${socket.id}`);
        const userId = socketIdToUserId[socket.id];
        if (userId) {
            userConnections[userId].delete(socket.id);
            // Chỉ xử lý ngắt kết nối khỏi game nếu đây là tab cuối cùng
            if (userConnections[userId].size === 0) {
                console.log(`User ${users[userId]} fully disconnected.`);
                markPlayerAsDisconnected(userId);
                delete userConnections[userId];
            }
        }
        delete socketIdToUserId[socket.id];
    });
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
