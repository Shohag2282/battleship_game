const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// serve the frontend HTML/CSS/JS files from the frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// database connection - using mysql2 with promise support
const db = require('./config/db');

// create all the tables we need when the server first starts
async function initDatabase() {
    try {
        // users table stores player names, scores, and match stats
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                score INT DEFAULT 1200,
                games_played INT DEFAULT 0,
                wins INT DEFAULT 0,
                losses INT DEFAULT 0
            )
        `);

        // add missing columns if the table already existed without them
        const newColumns = [
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played INT DEFAULT 0",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS losses INT DEFAULT 0"
        ];
        for (const sql of newColumns) {
            try { await db.query(sql); } catch (e) { /* skip if already exists */ }
        }

        // game_rooms tracks all active and finished game sessions
        await db.query(`
            CREATE TABLE IF NOT EXISTS game_rooms (
                id VARCHAR(255) PRIMARY KEY,
                room_name VARCHAR(255) NOT NULL,
                grid_size INT DEFAULT 10,
                is_ai TINYINT DEFAULT 0,
                is_private TINYINT DEFAULT 0,
                host_name VARCHAR(255),
                host_id VARCHAR(255),
                host_user_id INT,
                host_score INT DEFAULT 1200,
                opponent_name VARCHAR(255),
                opponent_id VARCHAR(255),
                opponent_user_id INT,
                opponent_score INT DEFAULT 1200,
                status VARCHAR(50) DEFAULT 'Waiting',
                winner_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // make sure winner_name exists in case it was added later
        try { await db.query("ALTER TABLE game_rooms ADD COLUMN IF NOT EXISTS winner_name VARCHAR(255)"); } catch (e) {}

        // lobby_chats stores all the messages sent in the global lobby chat
        await db.query(`
            CREATE TABLE IF NOT EXISTS lobby_chats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                time VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log("✅ MySQL Database tables initialized successfully.");
    } catch (err) {
        console.error("❌ Database initialization error:", err);
    }
}
initDatabase();

// in-memory arrays to track active rooms and chat during the server session
let activeRooms = [];
let lobbyChat = [];
const reconnectTimers = {}; // tracks disconnected player timers so they can reconnect

// --- LOGIN API ---
// player enters a name; if it's taken they get John 2, John 3, etc.
app.post('/api/login', async (req, res) => {
    let { username } = req.body;
    if (!username || username.trim() === '') {
        return res.status(400).json({ error: 'Name cannot be empty!' });
    }
    username = username.trim();

    try {
        // get all existing usernames to figure out if this name is taken
        const [allUsers] = await db.query('SELECT username FROM users');
        const baseName = username.toLowerCase();

        // find users who have the same base name (e.g. "john", "john 2", "john 3")
        const similar = allUsers.filter(u => {
            const base = u.username.replace(/ \d+$/, '').toLowerCase();
            return base === baseName;
        });

        // if name is free, use it as-is; otherwise find the next available number
        let finalName = username;
        if (similar.length > 0) {
            let nextNum = 2;
            similar.forEach(u => {
                const numMatch = u.username.match(/ (\d+)$/);
                if (numMatch) {
                    const n = parseInt(numMatch[1]);
                    if (n >= nextNum) nextNum = n + 1;
                }
            });
            finalName = `${username} ${nextNum}`;
        }

        // insert the new user and return their generated ID and name
        const [result] = await db.query(
            'INSERT INTO users (username, score) VALUES (?, ?)',
            [finalName, 1200]
        );

        res.json({ success: true, userId: result.insertId, username: finalName, score: 1200 });
    } catch (err) {
        console.error("Login API error:", err);
        res.status(500).json({ error: 'Database error during login.' });
    }
});

// --- USER STATS API ---
// lobby fetches this to show Games Played / Wins / Losses on the scoreboard
app.get('/api/user-stats', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        return res.status(400).json({ error: 'Username is required!' });
    }

    try {
        const [rows] = await db.query(
            'SELECT score, games_played, wins, losses FROM users WHERE username = ?',
            [username]
        );

        if (rows.length === 0) {
            // user not found yet, return default values
            return res.json({ success: true, stats: { score: 1200, games_played: 0, wins: 0, losses: 0 } });
        }

        res.json({ success: true, stats: rows[0] });
    } catch (err) {
        console.error("User stats API error:", err);
        res.status(500).json({ error: 'Database error fetching stats.' });
    }
});

// --- BOT FLEET GENERATOR ---
// randomly places the AI's ships on the grid so it can play against a real player
function generateBotFleet(gridSize, shipsConfig) {
    const shipSizes = { carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 };
    const config = shipsConfig || { carrier: 1, battleship: 1, cruiser: 1, submarine: 1, destroyer: 1 };

    // build a flat list of ships to place based on config counts
    const shipList = [];
    for (let type in config) {
        const count = parseInt(config[type]) || 0;
        const size = shipSizes[type] || 3;
        for (let i = 0; i < count; i++) shipList.push({ type, size });
    }

    // fallback to default fleet if config somehow ended up empty
    if (shipList.length === 0) {
        shipList.push(
            { type: 'carrier', size: 5 },
            { type: 'battleship', size: 4 },
            { type: 'cruiser', size: 3 },
            { type: 'submarine', size: 3 },
            { type: 'destroyer', size: 2 }
        );
    }

    const fleet = [];
    const board = Array(gridSize).fill(null).map(() => Array(gridSize).fill(false));

    for (let { type, size } of shipList) {
        let placed = false;
        let attempts = 0;

        // try random positions until the ship fits without overlapping
        while (!placed && attempts < 300) {
            attempts++;
            const horizontal = Math.random() > 0.5;
            const r = Math.floor(Math.random() * gridSize);
            const c = Math.floor(Math.random() * gridSize);

            if (horizontal && c + size > gridSize) continue;
            if (!horizontal && r + size > gridSize) continue;

            let overlap = false;
            const coords = [];
            for (let i = 0; i < size; i++) {
                const row = horizontal ? r : r + i;
                const col = horizontal ? c + i : c;
                if (board[row][col]) { overlap = true; break; }
                coords.push({ r: row, c: col });
            }

            if (!overlap) {
                coords.forEach(p => { board[p.r][p.c] = true; });
                fleet.push({ name: `${type}_bot`, coords });
                placed = true;
            }
        }
    }

    return fleet;
}

// --- SOCKET.IO CONNECTION HANDLER ---
io.on('connection', (socket) => {
    const username = socket.handshake.auth.username || 'Anonymous';
    const userId = parseInt(socket.handshake.auth.userId) || 0;

    // when a player connects, send them the last 50 chat messages and the room list
    db.query('SELECT username, message, time FROM lobby_chats ORDER BY id DESC LIMIT 50')
        .then(([rows]) => socket.emit('chat_history', rows.reverse()))
        .catch(() => socket.emit('chat_history', lobbyChat.slice(-50)));

    socket.emit('update_rooms', activeRooms);

    // --- LOBBY CHAT ---
    socket.on('send_message', (data) => {
        const msg = {
            username: data.username || username,
            message: data.message,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        // save to DB so chat history survives server restarts
        db.query('INSERT INTO lobby_chats (username, message, time) VALUES (?, ?, ?)',
            [msg.username, msg.message, msg.time])
            .catch(err => console.error("Chat save error:", err));

        // keep a small in-memory copy too
        lobbyChat.push(msg);
        if (lobbyChat.length > 200) lobbyChat.shift();

        io.emit('receive_message', msg);
    });

    // --- CREATE ROOM ---
    socket.on('create_room', async (data) => {
        const sizeStr = data.gridSize || '10x10';
        const sizeVal = parseInt(sizeStr.split('x')[0]) || 10;
        const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        // look up the host's current score from the DB
        const hostUserId = parseInt(data.userId) || userId;
        let hostScore = 1200;
        try {
            const [rows] = await db.query('SELECT score FROM users WHERE id = ?', [hostUserId]);
            if (rows.length > 0) hostScore = rows[0].score;
        } catch (err) {
            console.error("Error fetching host score:", err);
        }

        const newRoom = {
            id: roomId,
            roomName: (data.roomName || data.hostName || 'Player') + "'s Match",
            gridSize: sizeVal,
            isAI: !!data.isAI,
            isPrivate: !!data.isPrivate,
            shipsConfig: data.shipsConfig || { carrier: 1, battleship: 1, cruiser: 1, submarine: 1, destroyer: 1 },
            hostId: socket.id,
            hostName: data.hostName || username,
            hostUserId: hostUserId,
            hostScore: hostScore,
            opponentId: null,
            opponentName: null,
            opponentUserId: null,
            opponentScore: 1200,
            status: 'Waiting',
            hostReady: false,
            opponentReady: false,
            hostFleet: [],
            opponentFleet: [],
            hostHits: [],
            opponentHits: [],
            currentTurnId: null
        };

        // if vs AI, set up the bot immediately as opponent
        if (data.isAI) {
            newRoom.opponentId = 'computer_bot';
            newRoom.opponentName = 'Computer (AI)';
            newRoom.opponentScore = 1200;
            newRoom.status = 'Playing';
            newRoom.opponentReady = true;
            newRoom.opponentFleet = generateBotFleet(sizeVal, newRoom.shipsConfig);
        }

        activeRooms.push(newRoom);
        io.emit('update_rooms', activeRooms);

        // save the room to DB for match history tracking
        db.query(`
            INSERT INTO game_rooms (id, room_name, grid_size, is_ai, is_private, host_name, host_id, host_user_id, host_score, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            newRoom.id, newRoom.roomName, newRoom.gridSize,
            newRoom.isAI ? 1 : 0, newRoom.isPrivate ? 1 : 0,
            newRoom.hostName, newRoom.hostId, newRoom.hostUserId, newRoom.hostScore,
            newRoom.status
        ]).catch(err => console.error("Room insert DB error:", err));

        socket.emit('room_created', newRoom.id);

        // AI game goes straight to the game page
        if (data.isAI) socket.emit('start_game_redirect', newRoom);
    });

    // --- JOIN ROOM (from lobby via room code) ---
    socket.on('join_room', async (data) => {
        const code = (data.roomId || '').toLowerCase().trim();
        const room = activeRooms.find(r =>
            r.id.toLowerCase() === code || r.id.toLowerCase().endsWith(code)
        );

        if (!room) {
            socket.emit('join_error', 'Battle room not found! Please check the code.');
            return;
        }
        if (room.hostUserId == data.userId) {
            socket.emit('join_error', 'You cannot join your own hosted room!');
            return;
        }
        if (room.status !== 'Waiting') {
            socket.emit('join_error', 'Battle has already started in this room!');
            return;
        }

        // get the opponent's current score from DB
        const oppUserId = parseInt(data.userId) || userId;
        let oppScore = 1200;
        try {
            const [rows] = await db.query('SELECT score FROM users WHERE id = ?', [oppUserId]);
            if (rows.length > 0) oppScore = rows[0].score;
        } catch (err) {
            console.error("Error fetching opponent score:", err);
        }

        room.opponentId = socket.id;
        room.opponentName = data.playerName || username;
        room.opponentUserId = oppUserId;
        room.opponentScore = oppScore;
        room.status = 'Playing';

        // update the room record in DB with opponent info
        db.query(`
            UPDATE game_rooms
            SET opponent_name = ?, opponent_id = ?, opponent_user_id = ?, opponent_score = ?, status = 'Playing'
            WHERE id = ?
        `, [room.opponentName, room.opponentId, room.opponentUserId, room.opponentScore, room.id])
        .catch(err => console.error("Room update DB error:", err));

        io.emit('update_rooms', activeRooms);

        // send opponent to the game page
        socket.emit('start_game_redirect', room);

        // let the host know someone joined
        io.to(room.hostId).emit('opponent_joined', {
            opponentName: room.opponentName,
            opponentScore: room.opponentScore
        });
    });

    // --- JOIN GAME SESSION (from game.html on page load or reconnect) ---
    socket.on('join_game_session', (data) => {
        const room = activeRooms.find(r => r.id === data.roomId);
        if (!room) {
            socket.emit('game_error', 'Battle room not found!');
            return;
        }

        // prevent the host from joining as opponent
        if (data.role === 'opponent' && room.hostUserId == data.userId) {
            socket.emit('game_error', 'You cannot join your own hosted room as an opponent!');
            return;
        }

        // prevent a third player from sneaking into a full room
        if (data.role === 'opponent' && room.opponentUserId && room.opponentUserId != data.userId) {
            socket.emit('game_error', 'This game session is already full!');
            return;
        }

        socket.join(data.roomId);
        socket.page = 'game';
        socket.roomId = data.roomId;
        socket.role = data.role;

        // cancel the reconnect timeout if the player came back in time
        const timerKey = data.roomId + '_' + data.role;
        const waitingKey = data.roomId + '_host_waiting';
        [timerKey, waitingKey].forEach(key => {
            if (reconnectTimers[key]) {
                clearTimeout(reconnectTimers[key]);
                delete reconnectTimers[key];
            }
        });

        if (room.status === 'Playing') {
            io.to(data.roomId).emit('player_reconnected', { role: data.role });
        }

        // update socket ID in the room since it changes on reconnect
        if (data.role === 'host' || room.hostUserId == data.userId) {
            room.hostId = socket.id;
        } else if (data.role === 'opponent' || room.opponentUserId == data.userId) {
            room.opponentId = socket.id;

            // if opponent joined directly via URL (bypassed lobby join), set them up now
            if (!room.opponentUserId) {
                room.opponentUserId = parseInt(data.userId) || userId;
                room.opponentName = data.username || username;
                room.status = 'Playing';

                db.query('SELECT score FROM users WHERE id = ?', [room.opponentUserId])
                    .then(([rows]) => {
                        if (rows.length > 0) room.opponentScore = rows[0].score;
                        return db.query(`
                            UPDATE game_rooms
                            SET opponent_name = ?, opponent_id = ?, opponent_user_id = ?, opponent_score = ?, status = 'Playing'
                            WHERE id = ?
                        `, [room.opponentName, room.opponentId, room.opponentUserId, room.opponentScore, room.id]);
                    })
                    .catch(err => console.error("Bypass join DB error:", err));

                io.emit('update_rooms', activeRooms);
                io.to(room.hostId).emit('opponent_joined', {
                    opponentName: room.opponentName,
                    opponentScore: room.opponentScore
                });
            }
        }

        // send the current game state to whoever just connected
        socket.emit('init_game', {
            gridSize: room.gridSize,
            hostName: room.hostName,
            opponentName: room.opponentName,
            hostScore: room.hostScore,
            opponentScore: room.opponentScore,
            shipsConfig: room.shipsConfig,
            isAI: room.isAI,
            hostUserId: room.hostUserId,
            opponentUserId: room.opponentUserId
        });

        // if both players were already in battle, re-send the start signal
        if (room.hostReady && room.opponentReady && room.currentTurnId) {
            socket.emit('start_battle', { startPlayer: room.currentTurnId });
        }
    });

    // --- PLAYER READY (ships have been placed) ---
    socket.on('player_ready', (data) => {
        const room = activeRooms.find(r => r.id === data.roomId);
        if (!room) return;

        if (socket.id === room.hostId) {
            room.hostReady = true;
            room.hostFleet = data.fleet;
        } else if (socket.id === room.opponentId) {
            room.opponentReady = true;
            room.opponentFleet = data.fleet;
        }

        // once both players have placed ships, the battle begins
        if (room.hostReady && room.opponentReady) {
            room.currentTurnId = room.hostId;
            io.to(room.id).emit('start_battle', { startPlayer: room.currentTurnId });
        }
    });

    // check if a shot hit any ship coordinate in a fleet
    function checkHit(fleet, r, c) {
        for (let ship of fleet) {
            for (let coord of ship.coords) {
                if (coord.r === r && coord.c === c) {
                    coord.hit = true;
                    return true;
                }
            }
        }
        return false;
    }

    // returns true if every cell in every ship is hit (fleet is destroyed)
    function isFleetSunk(fleet) {
        return fleet.every(ship => ship.coords.every(c => c.hit));
    }

    // --- FIRE SHOT (player attacks a cell) ---
    socket.on('fire_shot', (data) => {
        const room = activeRooms.find(r => r.id === data.roomId);
        if (!room || room.currentTurnId !== socket.id) return;

        const isHost = socket.id === room.hostId;
        const targetId = isHost ? room.opponentId : room.hostId;
        const targetFleet = isHost ? room.opponentFleet : room.hostFleet;
        const shooterName = isHost ? room.hostName : room.opponentName;

        const isHit = checkHit(targetFleet, data.row, data.col);

        // if it's a hit, the same player gets another turn
        const nextTurn = isHit ? socket.id : targetId;
        room.currentTurnId = nextTurn;

        io.to(room.id).emit('shot_result', {
            row: data.row, col: data.col,
            isHit, nextTurn, targetId, shooterName
        });

        if (isFleetSunk(targetFleet)) {
            handleGameOver(room, socket.id);
        } else if (room.isAI && nextTurn === 'computer_bot') {
            setTimeout(() => botFireShot(room), 1000);
        }
    });

    // --- BOT FIRES A SHOT (random cell the bot hasn't hit yet) ---
    function botFireShot(room) {
        if (room.currentTurnId !== 'computer_bot') return;

        const gs = room.gridSize;
        let r, c, tries = 0;
        do {
            r = Math.floor(Math.random() * gs);
            c = Math.floor(Math.random() * gs);
            tries++;
        } while (room.opponentHits.some(h => h.r === r && h.c === c) && tries < 200);

        room.opponentHits.push({ r, c });

        const isHit = checkHit(room.hostFleet, r, c);
        const nextTurn = isHit ? 'computer_bot' : room.hostId;
        room.currentTurnId = nextTurn;

        io.to(room.id).emit('shot_result', {
            row: r, col: c, isHit,
            nextTurn, targetId: room.hostId,
            shooterName: 'Computer (AI)'
        });

        if (isFleetSunk(room.hostFleet)) {
            handleGameOver(room, 'computer_bot');
        } else if (nextTurn === 'computer_bot') {
            setTimeout(() => botFireShot(room), 1000);
        }
    }

    // --- SURRENDER ---
    socket.on('surrender', (data) => {
        const room = activeRooms.find(r => r.id === data.roomId);
        if (!room) return;

        // whoever surrendered loses — the other player wins
        const surrenderUserId = parseInt(data.userId);
        const winnerId = surrenderUserId === room.hostUserId ? room.opponentId : room.hostId;

        if (!winnerId) return;
        handleGameOver(room, winnerId);
    });

    // --- GAME OVER ---
    // called when a fleet is sunk or someone surrenders
    function handleGameOver(room, winnerId) {
        room.status = 'Finished';

        const hostWon = winnerId === room.hostId;

        // update scores: winner gets +25, loser gets -15 (minimum 100)
        room.hostScore = Math.max(100, room.hostScore + (hostWon ? 25 : -15));
        room.opponentScore = Math.max(100, room.opponentScore + (hostWon ? -15 : 25));

        const winnerName = hostWon ? room.hostName : room.opponentName;

        // save host's updated score, win/loss count to DB
        db.query(`
            UPDATE users SET score = ?, games_played = games_played + 1,
            wins = wins + ?, losses = losses + ?
            WHERE id = ?
        `, [room.hostScore, hostWon ? 1 : 0, hostWon ? 0 : 1, room.hostUserId])
        .catch(err => console.error("Host stats DB error:", err));

        // save opponent's stats too (skip if it's an AI game)
        if (!room.isAI && room.opponentUserId) {
            db.query(`
                UPDATE users SET score = ?, games_played = games_played + 1,
                wins = wins + ?, losses = losses + ?
                WHERE id = ?
            `, [room.opponentScore, hostWon ? 0 : 1, hostWon ? 1 : 0, room.opponentUserId])
            .catch(err => console.error("Opponent stats DB error:", err));
        }

        // mark the game room as finished with the winner's name
        db.query(`
            UPDATE game_rooms SET status = 'Finished', winner_name = ? WHERE id = ?
        `, [winnerName, room.id])
        .catch(err => console.error("Room finish DB error:", err));

        const finalScores = {};
        finalScores[room.hostName] = room.hostScore;
        if (room.opponentName) finalScores[room.opponentName] = room.opponentScore;

        io.to(room.id).emit('game_over', { winnerId, winnerName, finalScores });

        // remove the room from the active list after 5 seconds
        setTimeout(() => {
            activeRooms = activeRooms.filter(r => r.id !== room.id);
            io.emit('update_rooms', activeRooms);
        }, 5000);
    }

    // --- LEAVE GAME (player pressed the lobby button mid-game) ---
    socket.on('leave_game', (data) => {
        const room = activeRooms.find(r => r.id === data.roomId);
        if (!room) return;

        // clear any reconnect timers for this room
        ['host', 'opponent', 'host_waiting'].forEach(role => {
            const key = data.roomId + '_' + role;
            if (reconnectTimers[key]) {
                clearTimeout(reconnectTimers[key]);
                delete reconnectTimers[key];
            }
        });

        activeRooms = activeRooms.filter(r => r.id !== data.roomId);
        io.emit('update_rooms', activeRooms);

        // notify remaining player that the other person left
        if (room.status === 'Playing') {
            const leaverIsHost = parseInt(data.userId) === room.hostUserId;
            const who = leaverIsHost ? 'Host' : 'Opponent';
            io.to(data.roomId).emit('game_error', `${who} left the game.`);
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        if (socket.page === 'game' && socket.roomId) {
            const room = activeRooms.find(r => r.id === socket.roomId);

            if (room && room.status === 'Playing') {
                // give the player 15 seconds to come back before closing the room
                const timerKey = socket.roomId + '_' + socket.role;
                if (reconnectTimers[timerKey]) clearTimeout(reconnectTimers[timerKey]);

                io.to(socket.roomId).emit('opponent_disconnected', { role: socket.role });

                reconnectTimers[timerKey] = setTimeout(() => {
                    delete reconnectTimers[timerKey];
                    const stillExists = activeRooms.find(r => r.id === socket.roomId);
                    if (stillExists) {
                        activeRooms = activeRooms.filter(r => r.id !== socket.roomId);
                        const who = socket.role === 'host' ? 'Host' : 'Opponent';
                        io.to(socket.roomId).emit('game_error', `${who} left the game. Room closed.`);
                        io.emit('update_rooms', activeRooms);
                    }
                }, 15000);

            } else if (room && room.status === 'Waiting') {
                // host left before anyone joined — remove room right away
                if (socket.role === 'host' || room.hostUserId == userId) {
                    activeRooms = activeRooms.filter(r => r.id !== socket.roomId);
                    io.emit('update_rooms', activeRooms);
                }
            }
        } else {
            // player was in the lobby — clean up any waiting room they created
            const waitingRoom = activeRooms.find(r => r.hostId === socket.id && r.status === 'Waiting');
            if (waitingRoom) {
                setTimeout(() => {
                    const stillWaiting = activeRooms.find(r => r.id === waitingRoom.id);
                    if (stillWaiting && stillWaiting.hostId === socket.id && stillWaiting.status === 'Waiting') {
                        activeRooms = activeRooms.filter(r => r.id !== waitingRoom.id);
                        io.emit('update_rooms', activeRooms);
                    }
                }, 5000);
            }
        }
    });
});

const PORT = process.env.PORT || 5050;
server.listen(PORT, () => console.log(`✅ Battleship server running on port ${PORT}`));