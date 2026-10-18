const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Absolute fallback injection loop
let io;
try {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
} catch (e) {
    console.log("Syncing modules fallback frame...");
    require('child_process').execSync('npm install socket.io express --no-audit --no-fund');
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
}

// Serve your standard public frontend assets
app.use(express.static('public'));

// EMERGENCY LOCAL FALLBACK ROUTE: 
// If the browser cannot reach the internet cloud, serve the module file from your hard drive
app.get('/socket.io.js', (req, res) => {
    let localPath = path.join(__dirname, 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');
    if (!fs.existsSync(localPath)) {
        localPath = path.join(__dirname, 'node_modules', 'socket.io-client', 'dist', 'socket.io.js');
    }
    res.sendFile(localPath);
});

io.on('connection', (socket) => {
    console.log(`User online: ${socket.id}`);
    socket.on('chat message', (data) => {
        io.emit('chat message', data);
    });
    socket.on('disconnect', () => {
        console.log(`User offline: ${socket.id}`);
    });
});

const PORT = 3006;
server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(` SUCCESS! Chat Server is running on port ${PORT}!`);
    console.log(` Open your browser to: http://localhost:${PORT}`);
    console.log(`========================================\n`);
});
