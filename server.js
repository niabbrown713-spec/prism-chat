const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

let io;
try {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
} catch (e) {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
}

const DB_FILE = process.env.RENDER ? '/data/database.json' : path.join(__dirname, 'database.json');
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], servers: [], globalMessages: {}, privateMessages: {} }, null, 2));
}

function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

app.use(express.static(path.join(__dirname, 'public')));
app.get('/socket.io.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist', 'socket.io.js'));
});

const activeSockets = {}; 

// HARDCODED OWNER CONFIGURATION - Change this string to your target username
const ADMIN_OWNER_USERNAME = "YourUsername"; 

io.on('connection', (socket) => {
    
    socket.on('register', (data, callback) => {
        const db = readDB();
        const userExists = db.users.find(u => u.username.toLowerCase() === data.username.toLowerCase());
        
        if (userExists) return callback({ success: false, message: "Username taken" });

        // Force Owner system role assignment if matching config identity
        const assignedRole = (data.username.toLowerCase() === ADMIN_OWNER_USERNAME.toLowerCase()) ? "Owner" : "Member";

        const newUser = {
            username: data.username,
            password: data.password,
            id: String(db.users.length + 1001),
            avatarColor: data.avatarColor || '#5865f2',
            role: assignedRole,
            friends: [],
            customRooms: []
        };

        db.users.push(newUser);
        writeDB(db);
        callback({ success: true, user: newUser });
    });

    socket.on('login', (data, callback) => {
        const db = readDB();
        const user = db.users.find(u => u.username.toLowerCase() === data.username.toLowerCase() && u.password === data.password);
        
        if (!user) return callback({ success: false, message: "Invalid credentials" });

        // Double check enforcement check logic post registry lifecycle updates
        if (user.username.toLowerCase() === ADMIN_OWNER_USERNAME.toLowerCase() && user.role !== "Owner") {
            user.role = "Owner";
            writeDB(db);
        }

        activeSockets[user.id] = socket.id;
        socket.userId = user.id;
        callback({ success: true, user: user });
    });

    socket.on('update profile', (data, callback) => {
        if (!socket.userId) return;
        const db = readDB();
        const user = db.users.find(u => u.id === socket.userId);
        if (user) {
            user.avatarColor = data.avatarColor;
            if (user.username.toLowerCase() !== ADMIN_OWNER_USERNAME.toLowerCase()) {
                user.role = data.role || user.role; 
            }
            writeDB(db);
            callback({ success: true, user: user });
        }
    });

    socket.on('join channel', (channelName) => {
        Array.from(socket.rooms).forEach(room => { if (room !== socket.id) socket.leave(room); });
        socket.join(channelName);
    });

    socket.on('send channel message', (data) => {
        const db = readDB();
        if (!db.globalMessages[data.channel]) db.globalMessages[data.channel] = [];
        
        const payload = {
            user: data.user,
            userId: socket.userId,
            id: socket.id,
            role: data.role || "Member",
            text: data.text,
            replyTo: data.replyTo || null, // Stores parent message references
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            avatarColor: data.avatarColor
        };

        db.globalMessages[data.channel].push(payload);
        writeDB(db);
        io.to(data.channel).emit('receive channel message', payload);
    });

    socket.on('add friend', (friendId, callback) => {
        if (!socket.userId) return callback({ success: false, message: "Not authenticated" });
        const db = readDB();
        const currentUser = db.users.find(u => u.id === socket.userId);
        const targetUser = db.users.find(u => u.id === friendId);

        if (!targetUser) return callback({ success: false, message: "User not found" });
        if (currentUser.friends.includes(friendId)) return callback({ success: false, message: "Already friends" });

        currentUser.friends.push(friendId);
        targetUser.friends.push(socket.userId);
        writeDB(db);

        callback({ success: true, targetUser: targetUser });
        const targetSocketId = activeSockets[friendId];
        if (targetSocketId) io.to(targetSocketId).emit('friend sync update', currentUser);
    });

    socket.on('send direct message', (data, callback) => {
        if (!socket.userId) return;
        const db = readDB();
        const dmChannelKey = [socket.userId, data.targetId].sort().join('-');
        if (!db.privateMessages[dmChannelKey]) db.privateMessages[dmChannelKey] = [];

        const payload = {
            senderId: socket.userId,
            senderName: data.senderName,
            text: data.text,
            avatarColor: data.avatarColor,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        db.privateMessages[dmChannelKey].push(payload);
        writeDB(db);
        callback(payload);

        const recipientSocketId = activeSockets[data.targetId];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('receive direct message', { senderId: socket.userId, msg: payload });
        }
    });
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => console.log(`Server operating cleanly on port ${PORT}`));
