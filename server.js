const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require('crypto');

const app = express();
const server = http.createServer(app);

const { Server } = require('socket.io');
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

// Setup local JSON file database to remember accounts and ranks
const DB_FILE = process.env.DATABASE_FILE || (process.env.RENDER ? '/data/database.json' : path.join(__dirname, 'database.json'));
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], globalMessages: [], privateMessages: {} }, null, 2));
}

function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(data) {
    const temporaryFile = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2));
    fs.renameSync(temporaryFile, DB_FILE);
}
function isValidUploadedImage(image) {
    if (image === undefined || image === "") return true;
    if (typeof image !== "string") return false;
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    return Boolean(match) && Buffer.byteLength(match[1], "base64") <= 200 * 1024;
}
function isValidReply(reply) {
    return reply === undefined || reply === null || (
        typeof reply === "object" &&
        !Array.isArray(reply) &&
        typeof reply.user === "string" &&
        reply.user.trim().length > 0 &&
        reply.user.length <= 32 &&
        typeof reply.text === "string" &&
        reply.text.length <= 4000 &&
        isValidUploadedImage(reply.image) &&
        isValidUploadedImage(reply.avatarImage) &&
        (reply.userId === undefined || (typeof reply.userId === "string" && reply.userId.length <= 80)) &&
        (reply.messageId === undefined || (typeof reply.messageId === "string" && reply.messageId.length <= 80))
    );
}
function normalizeReply(reply) {
    if (!reply) return null;
    return {
        user: reply.user.trim(),
        userId: reply.userId || "",
        text: reply.text,
        image: reply.image || "",
        avatarImage: reply.avatarImage || "",
        messageId: reply.messageId || ""
    };
}

app.get('/version', (req, res) => {
    const hash = createHash('sha256');
    for (const file of ['package.json', 'server.js', 'public/index.html', 'public/style.css']) {
        hash.update(file);
        hash.update(fs.readFileSync(path.join(__dirname, file)));
    }
    res.set('Cache-Control', 'no-store');
    res.json({ version: hash.digest('hex') });
});

app.use(express.static(path.join(__dirname, 'public')));

const onlineUsers = {};
const globalMessages = new Map();
const recoveryCooldowns = new Map();
const passwordResetTokens = new Map();
const MESSAGE_FONTS = new Set(["system-ui", "Arial", "Georgia", "monospace", "cursive"]);
const MODERATION_ROLE_LEVEL = { Member: 1, Moderator: 2, Admin: 3, Owner: 4 };
const MAX_MODERATION_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

function parseModerationDuration(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d{2,}):([0-5]\d):([0-5]\d)$/.exec(value);
    if (!match) return null;
    const hours = Number(match[1]);
    const durationMs = ((hours * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000;
    return Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= MAX_MODERATION_DURATION_MS
        ? durationMs
        : null;
}

function hashSecretCode(secretCode, salt = randomBytes(16).toString("hex")) {
    return {
        salt,
        hash: scryptSync(secretCode, salt, 64).toString("hex")
    };
}

function isSecretCodeMatch(user, secretCode) {
    if (typeof user.secretCodeSalt !== "string" || !/^[a-f0-9]{32}$/i.test(user.secretCodeSalt) ||
        typeof user.secretCodeHash !== "string" ||
        !/^[a-f0-9]{128}$/i.test(user.secretCodeHash)) return false;
    const storedHash = Buffer.from(user.secretCodeHash, "hex");
    const enteredHash = scryptSync(secretCode, user.secretCodeSalt, storedHash.length);
    return timingSafeEqual(storedHash, enteredHash);
}

function clientAccount(user) {
    const { password, secretCodeSalt, secretCodeHash, ...account } = user;
    return {
        ...account,
        hasRecoveryCode: Boolean(secretCodeSalt && secretCodeHash)
    };
}

function privateConversationId(firstUserId, secondUserId) {
    return [String(firstUserId), String(secondUserId)].sort().join(":");
}

function emitUserJoined(user) {
    io.emit('user joined', { username: user.username });
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        createdAt: typeof user.createdAt === "string" ? user.createdAt : "",
        displayName: user.displayName || "Prism",
        nameColor: user.nameColor || "#202124",
        avatarColor: user.avatarColor || "#98caff",
        avatarImage: user.avatarImage || user.avatarUrl || "",
        pronouns: user.pronouns || "",
        bio: user.bio || "",
        bannerColor: user.bannerColor || "#84c5d0",
        bannerImage: user.bannerImage || "",
        role: user.role || "Member"
    };
}

io.on('connection', (socket) => {
    console.log(`Socket synchronized: ${socket.id}`);
    socket.emit('update user lists', onlineUsers);

    socket.on('typing status', data => {
        const sender = onlineUsers[socket.id];
        if (!sender || !data || typeof data.isTyping !== "boolean") return;
        const typingUpdate = {
            userId: String(sender.id),
            username: sender.username,
            isTyping: data.isTyping
        };
        if (data.mode === "global") {
            socket.broadcast.emit('typing status', { ...typingUpdate, mode: "global" });
            return;
        }
        if (data.mode !== "private" || typeof data.targetId !== "string") return;
        const targetId = data.targetId.trim();
        if (!targetId || targetId.length > 80 || targetId === String(sender.id)) return;
        socket.to(`user:${targetId}`).emit('typing status', { ...typingUpdate, mode: "private" });
    });

    socket.on('moderation command', (data, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};
        const requester = onlineUsers[socket.id];
        if (!requester || !data || typeof data.command !== "string" || data.command.length > 200) {
            return reply({ success: false, message: "Invalid moderation command." });
        }
        if ((MODERATION_ROLE_LEVEL[requester.role] || 0) < MODERATION_ROLE_LEVEL.Moderator) {
            return reply({ success: false, message: "Only moderators and above can use moderation commands." });
        }

        const command = data.command.trim();
        const match = /^\/kick\s+(\S+)\s+(\d{2,}:\d{2}:\d{2})$/i.exec(command) ||
            /^\/tem\s+ban\s+(\S+)\s+(\d{2,}:\d{2}:\d{2})$/i.exec(command);
        if (!match) {
            return reply({ success: false, message: "Use /kick username HH:MM:SS or /tem ban username HH:MM:SS." });
        }
        const durationMs = parseModerationDuration(match[2]);
        if (!durationMs) {
            return reply({ success: false, message: "Enter a duration greater than zero, up to 365 days, in HH:MM:SS format." });
        }
        const isBan = /^\/tem\s+ban\b/i.test(command);
        let db;
        try {
            db = readDB();
        } catch (error) {
            console.error("Could not read account data for moderation command:", error);
            return reply({ success: false, message: "Account data could not be loaded. Try again later." });
        }
        if (!db || !Array.isArray(db.users)) {
            return reply({ success: false, message: "Account data is unavailable." });
        }
        const target = db.users.find(account =>
            account && typeof account.username === "string" &&
            account.username.toLowerCase() === match[1].toLowerCase()
        );
        if (!target) return reply({ success: false, message: `No account named "${match[1]}" was found.` });
        if (String(target.id) === String(requester.id)) {
            return reply({ success: false, message: "You cannot moderate your own account." });
        }
        if ((MODERATION_ROLE_LEVEL[target.role] || 0) >= (MODERATION_ROLE_LEVEL[requester.role] || 0)) {
            return reply({ success: false, message: "You can only moderate users with a lower role than yours." });
        }

        const moderationUntil = Date.now() + durationMs;
        target.moderationUntil = moderationUntil;
        target.moderationType = isBan ? "ban" : "kick";
        try {
            writeDB(db);
        } catch (error) {
            console.error("Could not save moderation command:", error);
            return reply({ success: false, message: "The moderation action could not be saved." });
        }

        const durationLabel = match[2];
        const actionLabel = isBan ? "temporarily banned" : "kicked";
        const message = `Your account has been ${actionLabel} for ${durationLabel}. You can sign in again after ${new Date(moderationUntil).toLocaleString()}.`;
        for (const [sessionId, activeUser] of Object.entries(onlineUsers)) {
            if (String(activeUser.id) !== String(target.id)) continue;
            const targetSocket = io.sockets.sockets.get(sessionId);
            if (!targetSocket) continue;
            targetSocket.emit('moderation session ended', { message });
            setTimeout(() => targetSocket.disconnect(true), 100);
        }
        io.emit('moderation notice', {
            text: `@${target.username} was ${actionLabel} by @${requester.username} for ${durationLabel}.`
        });
        reply({ success: true, message: `@${target.username} was ${actionLabel} for ${durationLabel}.` });
    });

    // ACCOUNT REGISTRATION
    socket.on('register user', (data, callback) => {
        const db = readDB();
        if (!data || typeof data.username !== "string" || !data.username.trim() ||
            typeof data.password !== "string" || !data.password) {
            return callback({ success: false, message: "Enter a username and password." });
        }
        if (typeof data.secretCode !== "string" || data.secretCode.trim().length < 4 || data.secretCode.length > 128) {
            return callback({ success: false, message: "Choose a secret code with at least 4 characters." });
        }
        const userExists = db.users.find(u => u.username.toLowerCase() === data.username.toLowerCase());
        
        if (userExists) {
            return callback({ success: false, message: "Username is already taken!" });
        }

        // Generate sequential IDs starting at 1001
        const assignedId = String(db.users.length + 1001);
        
        // CRITICAL CHECK: Force ID 1002 to always be the Owner rank
        const assignedRole = (assignedId === "1002") ? "Owner" : "Member";
        const secretCode = hashSecretCode(data.secretCode.trim());

        const newUser = {
            username: data.username,
            password: data.password,
            id: assignedId,
            createdAt: new Date().toISOString(),
            role: assignedRole,
            avatarColor: "#98caff",
            avatarImage: "",
            displayName: "Prism",
            pronouns: "",
            bio: "",
            bannerColor: "#84c5d0",
            bannerImage: "",
            friends: [],
            friendRequestsSent: [],
            friendRequestsReceived: [],
            messageColor: "#202124",
            nameColor: "#202124",
            messageFont: "system-ui",
            secretCodeSalt: secretCode.salt,
            secretCodeHash: secretCode.hash
        };

        db.users.push(newUser);
        writeDB(db);

        onlineUsers[socket.id] = {
            username: newUser.username,
            id: newUser.id,
            createdAt: newUser.createdAt,
            role: newUser.role,
            avatarColor: newUser.avatarColor,
            avatarImage: newUser.avatarImage,
            displayName: newUser.displayName,
            nameColor: newUser.nameColor,
            pronouns: newUser.pronouns,
            bio: newUser.bio,
            bannerColor: newUser.bannerColor,
            bannerImage: newUser.bannerImage,
            messageColor: newUser.messageColor,
            messageFont: newUser.messageFont
        };
        socket.join(`user:${newUser.id}`);
        callback({ success: true, user: clientAccount(newUser), socketId: socket.id });
        io.emit('update user lists', onlineUsers);
        emitUserJoined(newUser);
    });

    // ACCOUNT LOGIN
    socket.on('login user', (data, callback) => {
        if (typeof callback !== "function") return;
        if (!data || typeof data.username !== "string" || !data.username.trim() ||
            typeof data.password !== "string" || !data.password) {
            return callback({ success: false, message: "Enter your username and password." });
        }
        let db;
        try {
            db = readDB();
        } catch (error) {
            console.error("Could not read account data during login:", error);
            return callback({ success: false, message: "Your account data could not be loaded. Please try again later." });
        }
        if (!db || !Array.isArray(db.users)) {
            console.error("Account data is invalid: expected a users array.");
            return callback({ success: false, message: "Account data is unavailable. Please contact the chat owner." });
        }
        const user = db.users.find(account =>
            account && typeof account.username === "string" &&
            account.username.toLowerCase() === data.username.trim().toLowerCase() &&
            account.password === data.password
        );

        if (!user) {
            return callback({ success: false, message: "Invalid username or password!" });
        }
        const now = Date.now();
        if (typeof user.moderationUntil === "number" && user.moderationUntil > now) {
            const remainingSeconds = Math.ceil((user.moderationUntil - now) / 1000);
            return callback({
                success: false,
                message: `Your account is temporarily ${user.moderationType === "ban" ? "banned" : "kicked"} until ${new Date(user.moderationUntil).toLocaleString()}. Try again in ${Math.ceil(remainingSeconds / 60)} minute(s).`
            });
        }

        // CRITICAL ENFORCEMENT: Force check on login to guarantee 1002 is Owner
        let accountUpdated = false;
        if (user.moderationUntil !== undefined) {
            delete user.moderationUntil;
            delete user.moderationType;
            accountUpdated = true;
        }
        if (user.id === "1002" && user.role !== "Owner") {
            user.role = "Owner";
            accountUpdated = true;
        }
        for (const [field, defaultValue] of [
            ["displayName", "Prism"],
            ["avatarColor", "#98caff"],
            ["avatarImage", user.avatarUrl || ""],
            ["pronouns", ""],
            ["bio", ""],
            ["bannerColor", "#84c5d0"],
            ["bannerImage", ""],
            ["friends", []],
            ["friendRequestsSent", []],
            ["friendRequestsReceived", []],
            ["messageColor", "#202124"],
            ["nameColor", "#202124"],
            ["messageFont", "system-ui"]
        ]) {
            if (!user[field]) {
                user[field] = defaultValue;
                accountUpdated = true;
            }
        }
        if (!/^#[0-9a-f]{6}$/i.test(user.messageColor) || !MESSAGE_FONTS.has(user.messageFont)) {
            user.messageColor = "#202124";
            user.messageFont = "system-ui";
            accountUpdated = true;
        }
        if (typeof user.nameColor !== "string" || !/^#[0-9a-f]{6}$/i.test(user.nameColor)) {
            user.nameColor = "#202124";
            accountUpdated = true;
        }
        if (accountUpdated) {
            try {
                writeDB(db);
            } catch (error) {
                console.error("Could not save account updates during login:", error);
                return callback({ success: false, message: "Your account could not be updated in storage. Please try again later." });
            }
        }

        onlineUsers[socket.id] = {
            username: user.username,
            id: user.id,
            createdAt: typeof user.createdAt === "string" ? user.createdAt : "",
            role: user.role,
            avatarColor: user.avatarColor || "#98caff",
            avatarImage: user.avatarImage || user.avatarUrl || "",
            displayName: user.displayName || "",
            pronouns: user.pronouns || "",
            bio: user.bio || "",
            bannerColor: user.bannerColor || "#84c5d0",
            bannerImage: user.bannerImage || "",
            messageColor: user.messageColor || "#202124",
            nameColor: user.nameColor || "#202124",
            messageFont: user.messageFont || "system-ui",
            friends: Array.isArray(user.friends) ? user.friends : [],
            friendRequestsSent: Array.isArray(user.friendRequestsSent) ? user.friendRequestsSent : [],
            friendRequestsReceived: Array.isArray(user.friendRequestsReceived) ? user.friendRequestsReceived : []
        };
        socket.join(`user:${user.id}`);
        callback({ success: true, user: clientAccount(user), socketId: socket.id });
        io.emit('update user lists', onlineUsers);
        emitUserJoined(user);
    });

    socket.on('verify recovery code', (data, callback) => {
        if (!data || typeof data.username !== "string" || !data.username.trim() ||
            typeof data.secretCode !== "string" || !data.secretCode.trim() || data.secretCode.length > 128) {
            return callback({ success: false, message: "Enter your username and secret code." });
        }
        const username = data.username.trim();
        const recoveryKey = username.toLowerCase();
        const now = Date.now();
        const retryAt = recoveryCooldowns.get(recoveryKey) || 0;
        if (retryAt > now) {
            return callback({
                success: false,
                retryAfter: Math.ceil((retryAt - now) / 1000),
                message: `Please try again in ${Math.ceil((retryAt - now) / 1000)} seconds.`
            });
        }

        const db = readDB();
        const user = db.users.find(account => account.username.toLowerCase() === recoveryKey);
        if (!user || !user.secretCodeSalt || !user.secretCodeHash) {
            recoveryCooldowns.set(recoveryKey, now + 60_000);
            return callback({
                success: false,
                retryAfter: 60,
                message: "The account or secret code is incorrect. Please try again in 1 minute. Older accounts may need to set a recovery code after signing in."
            });
        }
        if (!isSecretCodeMatch(user, data.secretCode.trim())) {
            recoveryCooldowns.set(recoveryKey, now + 60_000);
            return callback({
                success: false,
                retryAfter: 60,
                message: "That secret code is incorrect. Please try again in 1 minute."
            });
        }

        recoveryCooldowns.delete(recoveryKey);
        const resetToken = randomBytes(32).toString("hex");
        passwordResetTokens.set(resetToken, { userId: user.id, expiresAt: now + 10 * 60_000 });
        callback({ success: true, resetToken });
    });

    socket.on('update recovery code', (data, callback) => {
        const requester = onlineUsers[socket.id];
        if (!requester) return callback({ success: false, message: "Please sign in again." });
        if (!data || typeof data.secretCode !== "string" ||
            data.secretCode.trim().length < 4 || data.secretCode.length > 128) {
            return callback({ success: false, message: "Choose a secret code with 4 to 128 characters." });
        }
        const db = readDB();
        const user = db.users.find(account => account.id === requester.id);
        if (!user) return callback({ success: false, message: "Your account could not be found." });
        const secretCode = hashSecretCode(data.secretCode.trim());
        user.secretCodeSalt = secretCode.salt;
        user.secretCodeHash = secretCode.hash;
        try {
            writeDB(db);
        } catch {
            return callback({ success: false, message: "Your recovery code could not be saved." });
        }
        recoveryCooldowns.delete(user.username.toLowerCase());
        for (const [token, session] of passwordResetTokens) {
            if (session.userId === user.id) passwordResetTokens.delete(token);
        }
        callback({ success: true });
    });

    socket.on('reset account password', (data, callback) => {
        if (!data || typeof data.resetToken !== "string" || typeof data.password !== "string" ||
            data.password.length < 10 || data.password.length > 128) {
            return callback({ success: false, message: "Your new password must be between 10 and 128 characters." });
        }
        const resetSession = passwordResetTokens.get(data.resetToken);
        if (!resetSession || resetSession.expiresAt <= Date.now()) {
            passwordResetTokens.delete(data.resetToken);
            return callback({ success: false, message: "This password reset has expired. Verify your secret code again." });
        }

        const db = readDB();
        const user = db.users.find(account => account.id === resetSession.userId);
        if (!user) {
            passwordResetTokens.delete(data.resetToken);
            return callback({ success: false, message: "That account could not be found." });
        }
        user.password = data.password;
        try {
            writeDB(db);
        } catch {
            return callback({ success: false, message: "Your new password could not be saved. Please try again." });
        }
        for (const [token, session] of passwordResetTokens) {
            if (session.userId === user.id) passwordResetTokens.delete(token);
        }
        callback({ success: true, username: user.username });
    });

    socket.on('get private conversations', callback => {
        const requester = onlineUsers[socket.id];
        if (!requester) return callback({ success: false, message: "Please sign in again." });
        const db = readDB();
        const conversations = db.privateMessages && typeof db.privateMessages === "object"
            ? db.privateMessages
            : {};
        const results = [];
        for (const [conversationId, messages] of Object.entries(conversations)) {
            const participantIds = conversationId.split(":");
            if (!participantIds.includes(String(requester.id)) || !Array.isArray(messages)) continue;
            const peerId = participantIds.find(id => id !== String(requester.id));
            const peer = db.users.find(account => account.id === peerId);
            if (!peer) continue;
            results.push({
                user: publicUser(peer),
                messages: messages.filter(message => message && typeof message === "object")
            });
        }
        callback({ success: true, conversations: results });
    });

    socket.on('update profile parameters', (data, callback) => {
        const onlineUser = onlineUsers[socket.id];
        if (!onlineUser) {
            return callback({ success: false, message: "Please log in again before updating your profile." });
        }
        if (!data || typeof data !== "object") {
            return callback({ success: false, message: "Invalid profile details." });
        }

        const db = readDB();
        const user = db.users.find(account => account.id === onlineUser.id);
        if (!user) {
            return callback({ success: false, message: "Could not find your account. Please log in again." });
        }

        for (const [field, label] of [["avatarImage", "Profile picture"], ["bannerImage", "Banner image"]]) {
            const imageData = data[field];
            if (imageData === undefined || imageData === "") continue;
            if (!isValidUploadedImage(imageData)) {
                return callback({ success: false, message: `${label} is invalid or too large. Please choose another image.` });
            }
        }

        for (const [field, maxLength] of [["displayName", 32], ["pronouns", 40], ["bio", 160]]) {
            if (data[field] !== undefined && (typeof data[field] !== "string" || data[field].trim().length > maxLength)) {
                return callback({ success: false, message: `Please keep ${field === "displayName" ? "your display name" : field} within ${maxLength} characters.` });
            }
        }
        if (data.messageColor !== undefined && (typeof data.messageColor !== "string" || !/^#[0-9a-f]{6}$/i.test(data.messageColor))) {
            return callback({ success: false, message: "Choose a valid message color." });
        }
        if (data.nameColor !== undefined && (typeof data.nameColor !== "string" || !/^#[0-9a-f]{6}$/i.test(data.nameColor))) {
            return callback({ success: false, message: "Choose a valid name color." });
        }
        if (data.avatarColor !== undefined && (typeof data.avatarColor !== "string" || !/^#[0-9a-f]{6}$/i.test(data.avatarColor))) {
            return callback({ success: false, message: "Choose a valid profile picture color." });
        }
        if (data.messageFont !== undefined && !MESSAGE_FONTS.has(data.messageFont)) {
            return callback({ success: false, message: "Choose a supported message font." });
        }

        const bannerColor = typeof data.bannerColor === "string" && /^#[0-9a-f]{6}$/i.test(data.bannerColor)
            ? data.bannerColor
            : (user.bannerColor || "#84c5d0");
        user.displayName = data.displayName === undefined ? (user.displayName || "Prism") : (data.displayName.trim() || "Prism");
        user.pronouns = data.pronouns === undefined ? (user.pronouns || "") : data.pronouns.trim();
        user.bio = data.bio === undefined ? (user.bio || "") : data.bio.trim();
        user.bannerColor = bannerColor;
        user.avatarColor = data.avatarColor === undefined
            ? (user.avatarColor || "#98caff")
            : data.avatarColor;
        user.avatarImage = data.avatarImage === undefined ? (user.avatarImage || user.avatarUrl || "") : data.avatarImage;
        user.avatarUrl = "";
        user.bannerImage = data.bannerImage === undefined ? (user.bannerImage || "") : data.bannerImage;
        user.messageColor = data.messageColor === undefined ? (user.messageColor || "#202124") : data.messageColor;
        user.nameColor = data.nameColor === undefined ? (user.nameColor || "#202124") : data.nameColor;
        user.messageFont = data.messageFont === undefined ? (user.messageFont || "system-ui") : data.messageFont;
        try {
            writeDB(db);
        } catch {
            return callback({ success: false, message: "Your profile could not be written to storage. Please check the server's database storage and try again." });
        }

        for (const activeUser of Object.values(onlineUsers)) {
            if (String(activeUser.id) !== String(user.id)) continue;
            activeUser.avatarColor = user.avatarColor;
            activeUser.avatarImage = user.avatarImage;
            activeUser.displayName = user.displayName;
            activeUser.pronouns = user.pronouns;
            activeUser.bio = user.bio;
            activeUser.bannerColor = user.bannerColor;
            activeUser.bannerImage = user.bannerImage;
            activeUser.messageColor = user.messageColor;
            activeUser.nameColor = user.nameColor;
            activeUser.messageFont = user.messageFont;
        }
        callback({ success: true, user: clientAccount(user) });
        io.emit('update user lists', onlineUsers);
    });

    socket.on('change user role', (data, callback) => {
        const requester = onlineUsers[socket.id];
        if (!requester || !data || typeof data.userId !== "string" || typeof data.role !== "string") {
            return callback({ success: false, message: "Invalid role change request." });
        }
        if (!["Owner", "Admin"].includes(requester.role)) {
            return callback({ success: false, message: "Only an owner or admin can change roles." });
        }
        if (data.userId === requester.id) {
            return callback({ success: false, message: "You cannot change your own role." });
        }
        const allowedRoles = requester.role === "Owner"
            ? ["Member", "Moderator", "Admin"]
            : ["Member", "Moderator"];
        if (!allowedRoles.includes(data.role)) {
            return callback({ success: false, message: "You cannot assign that role." });
        }

        const db = readDB();
        const target = db.users.find(account => account.id === data.userId);
        if (!target) {
            return callback({ success: false, message: "That account could not be found." });
        }
        if (target.role === "Owner" || (requester.role !== "Owner" && target.role === "Admin")) {
            return callback({ success: false, message: "You cannot change that user's role." });
        }

        target.role = data.role;
        try {
            writeDB(db);
        } catch {
            return callback({ success: false, message: "The role could not be saved." });
        }
        for (const activeUser of Object.values(onlineUsers)) {
            if (activeUser.id === target.id) activeUser.role = target.role;
        }
        io.emit('update user lists', onlineUsers);
        callback({ success: true, role: target.role });
    });

    socket.on('update friend', (data, callback) => {
        const onlineUser = onlineUsers[socket.id];
        if (!onlineUser || !data || typeof data.userId !== "string" || typeof data.add !== "boolean") {
            return callback({ success: false, message: "Could not update your friend list." });
        }
        const targetUserId = data.userId.trim();
        if (targetUserId === String(onlineUser.id)) {
            return callback({ success: false, message: "You cannot add yourself as a friend." });
        }
        const db = readDB();
        const user = db.users.find(account => String(account.id) === String(onlineUser.id));
        const friend = db.users.find(account => String(account.id) === targetUserId);
        if (!user || !friend) {
            return callback({ success: false, message: "That account could not be found." });
        }
        user.friends = Array.isArray(user.friends) ? user.friends : [];
        friend.friends = Array.isArray(friend.friends) ? friend.friends : [];
        user.friendRequestsSent = Array.isArray(user.friendRequestsSent) ? user.friendRequestsSent : [];
        user.friendRequestsReceived = Array.isArray(user.friendRequestsReceived) ? user.friendRequestsReceived : [];
        friend.friendRequestsSent = Array.isArray(friend.friendRequestsSent) ? friend.friendRequestsSent : [];
        friend.friendRequestsReceived = Array.isArray(friend.friendRequestsReceived) ? friend.friendRequestsReceived : [];
        if (data.add) {
            if (user.friends.some(id => String(id) === String(friend.id))) {
                return callback({ success: true, status: "friends", friends: user.friends, friend: publicUser(friend) });
            }
            if (user.friendRequestsSent.some(id => String(id) === String(friend.id))) {
                return callback({ success: true, status: "pending", friends: user.friends, friend: publicUser(friend) });
            }
            if (user.friendRequestsReceived.some(id => String(id) === String(friend.id))) {
                return callback({ success: false, status: "incoming", message: "This person already sent you a request. Accept it in your Friends list." });
            }
            user.friendRequestsSent.push(String(friend.id));
            friend.friendRequestsReceived.push(String(user.id));
        } else {
            user.friends = user.friends.filter(id => String(id) !== String(friend.id));
            friend.friends = friend.friends.filter(id => String(id) !== String(user.id));
        }
        try {
            writeDB(db);
        } catch {
            return callback({ success: false, message: data.add ? "Your friend request could not be sent." : "Your friend list could not be saved." });
        }
        onlineUser.friends = user.friends;
        onlineUser.friendRequestsSent = user.friendRequestsSent;
        onlineUser.friendRequestsReceived = user.friendRequestsReceived;
        if (data.add) {
            io.to(`user:${friend.id}`).emit('friend request received', { from: publicUser(user) });
        } else {
            io.to(`user:${friend.id}`).emit('friend list updated', { userId: friend.id, friends: friend.friends });
        }
        callback({
            success: true,
            friends: user.friends,
            friend: publicUser(friend),
            status: data.add ? "sent" : "removed",
            friendRequestsSent: user.friendRequestsSent,
            friendRequestsReceived: user.friendRequestsReceived
        });
    });

    socket.on('respond friend request', (data, callback) => {
        const onlineUser = onlineUsers[socket.id];
        if (!onlineUser || !data || typeof data.userId !== "string" || typeof data.accept !== "boolean") {
            return callback({ success: false, message: "Could not respond to that friend request." });
        }
        const db = readDB();
        const user = db.users.find(account => String(account.id) === String(onlineUser.id));
        const requester = db.users.find(account => String(account.id) === data.userId.trim());
        if (!user || !requester) return callback({ success: false, message: "That account could not be found." });
        user.friends = Array.isArray(user.friends) ? user.friends : [];
        requester.friends = Array.isArray(requester.friends) ? requester.friends : [];
        user.friendRequestsReceived = Array.isArray(user.friendRequestsReceived) ? user.friendRequestsReceived : [];
        user.friendRequestsSent = Array.isArray(user.friendRequestsSent) ? user.friendRequestsSent : [];
        requester.friendRequestsSent = Array.isArray(requester.friendRequestsSent) ? requester.friendRequestsSent : [];
        requester.friendRequestsReceived = Array.isArray(requester.friendRequestsReceived) ? requester.friendRequestsReceived : [];
        if (!user.friendRequestsReceived.some(id => String(id) === String(requester.id)) ||
            !requester.friendRequestsSent.some(id => String(id) === String(user.id))) {
            return callback({ success: false, message: "That friend request is no longer available." });
        }
        user.friendRequestsReceived = user.friendRequestsReceived.filter(id => String(id) !== String(requester.id));
        requester.friendRequestsSent = requester.friendRequestsSent.filter(id => String(id) !== String(user.id));
        if (data.accept) {
            if (!user.friends.some(id => String(id) === String(requester.id))) user.friends.push(String(requester.id));
            if (!requester.friends.some(id => String(id) === String(user.id))) requester.friends.push(String(user.id));
        }
        try {
            writeDB(db);
        } catch {
            return callback({ success: false, message: "Your response could not be saved." });
        }
        onlineUser.friends = user.friends;
        onlineUser.friendRequestsReceived = user.friendRequestsReceived;
        for (const [sessionId, activeUser] of Object.entries(onlineUsers)) {
            if (String(activeUser.id) === String(requester.id)) {
                activeUser.friends = requester.friends;
                activeUser.friendRequestsSent = requester.friendRequestsSent;
                io.to(sessionId).emit('friend list updated', { userId: requester.id, friends: requester.friends });
            }
        }
        io.to(`user:${user.id}`).emit('friend list updated', { userId: user.id, friends: user.friends });
        io.to(`user:${user.id}`).emit('friend request resolved', {
            userId: user.id,
            friendRequestsSent: user.friendRequestsSent,
            friendRequestsReceived: user.friendRequestsReceived
        });
        io.to(`user:${requester.id}`).emit('friend request resolved', {
            userId: requester.id,
            friendRequestsSent: requester.friendRequestsSent,
            friendRequestsReceived: requester.friendRequestsReceived
        });
        callback({ success: true, accepted: data.accept, friends: user.friends });
    });

    socket.on('get friends', callback => {
        const onlineUser = onlineUsers[socket.id];
        if (!onlineUser) return callback({ success: false, message: "Please sign in again." });
        const db = readDB();
        const user = db.users.find(account => account.id === onlineUser.id);
        if (!user) return callback({ success: false, message: "Your account could not be found." });
        user.friends = Array.isArray(user.friends) ? user.friends : [];
        user.friendRequestsSent = Array.isArray(user.friendRequestsSent) ? user.friendRequestsSent : [];
        user.friendRequestsReceived = Array.isArray(user.friendRequestsReceived) ? user.friendRequestsReceived : [];
        const findPublicAccounts = ids => ids
            .map(id => db.users.find(account => String(account.id) === String(id)))
            .filter(Boolean)
            .map(publicUser);
        const friends = user.friends
            .map(id => db.users.find(account => String(account.id) === String(id)))
            .filter(Boolean)
            .map(friend => ({
                ...publicUser(friend),
                sessionId: Object.entries(onlineUsers).find(([, active]) => String(active.id) === String(friend.id))?.[0] || ""
            }));
        callback({
            success: true,
            friends,
            incomingRequests: findPublicAccounts(user.friendRequestsReceived),
            outgoingRequests: findPublicAccounts(user.friendRequestsSent)
        });
    });

    socket.on('delete chat message', (data, callback) => {
        const requester = onlineUsers[socket.id];
        if (!requester || !data || typeof data.messageId !== "string") {
            return callback({ success: false, message: "You must be signed in to delete messages." });
        }
        const globalMessage = globalMessages.get(data.messageId);
        if (globalMessage) {
            if (String(requester.id) !== String(globalMessage.userId) && requester.role !== "Owner") {
                return callback({ success: false, message: "You can only delete your own messages." });
            }
            globalMessages.delete(data.messageId);
            io.emit('delete chat message', { messageId: data.messageId, mode: "global" });
            return callback({ success: true });
        }
        const db = readDB();
        for (const [conversationId, messages] of Object.entries(db.privateMessages || {})) {
            if (!Array.isArray(messages)) continue;
            const message = messages.find(item => item && item.messageId === data.messageId);
            if (!message) continue;
            if (String(requester.id) !== String(message.userId) && requester.role !== "Owner") {
                return callback({ success: false, message: "You can only delete your own messages." });
            }
            db.privateMessages[conversationId] = messages.filter(item => item && item.messageId !== data.messageId);
            try {
                writeDB(db);
            } catch {
                return callback({ success: false, message: "The message could not be deleted from storage." });
            }
            io.to(`user:${conversationId.split(":")[0]}`)
                .to(`user:${conversationId.split(":")[1]}`)
                .emit('delete chat message', { messageId: data.messageId, mode: "private" });
            return callback({ success: true });
        }
        return callback({ success: false, message: "That message is no longer available to delete." });
    });

    socket.on('edit chat message', (data, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};
        const requester = onlineUsers[socket.id];
        if (!requester || !data || typeof data.messageId !== "string" ||
            typeof data.text !== "string" || data.text.length > 4000) {
            return reply({ success: false, message: "The edited message is invalid or too long." });
        }
        const editedText = data.text.trim();
        if (!editedText) return reply({ success: false, message: "A message cannot be empty." });

        const globalMessage = globalMessages.get(data.messageId);
        if (globalMessage) {
            if (String(requester.id) !== String(globalMessage.userId) && requester.role !== "Owner") {
                return reply({ success: false, message: "You can only edit your own messages." });
            }
            globalMessage.text = editedText;
            globalMessage.editedAt = new Date().toISOString();
            io.emit('edit chat message', {
