const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with cross-origin rights
let io;
try {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
} catch (e) {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
}

// FAILSAFE LAYOUT ROUTE: Explicitly maps paths to find index.html
app.get('/', (req, res) => {
    const pathsToTry = [
        path.join(__dirname, 'public', 'index.html'),
        path.join(__dirname, 'index.html'),
        path.join(__dirname, '..', 'public', 'index.html')
    ];

    for (const targetPath of pathsToTry) {
        if (fs.existsSync(targetPath)) {
            return res.sendFile(targetPath);
        }
    }
    res.status(404).send("Error: index.html could not be found anywhere in your project structure!");
});

// Fallback logic for serving asset directories safely
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Emergency route serving local connection dependency
app.get('/socket.io.js', (req, res) => {
    let localPath = path.join(__dirname, 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');
    if (!fs.existsSync(localPath)) {
        localPath = path.join(__dirname, 'node_modules', 'socket.io-client', 'dist', 'socket.io.js');
    }
    res.sendFile(localPath);
});

io.on('connection', (socket) => {
    socket.on('chat message', (data) => {
        io.emit('chat message', data);
    });
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => {
    console.log(`Server executing successfully on port ${PORT}`);
});
