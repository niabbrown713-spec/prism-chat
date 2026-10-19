// Establish client WebSocket network hook
const socket = io();
let userName = "Anonymous";

// DOM Elements Selection
const loginScreen = document.getElementById('loginScreen');
const appContainer = document.getElementById('appContainer');
const loginForm = document.getElementById('loginForm');
const usernameInput = document.getElementById('usernameInput');
const displayProfileName = document.getElementById('displayProfileName');
const userAvatar = document.getElementById('userAvatar');

const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const chatMessages = document.getElementById('chatMessages');

// Manage entering the interface state loop
loginForm.addEventListener('submit', function(e) {
    e.preventDefault();
    const chosenName = usernameInput.value.trim();
    if (chosenName === '') return;
    
    userName = chosenName;
    displayProfileName.textContent = userName;
    userAvatar.textContent = userName.charAt(0).toUpperCase();
    messageInput.placeholder = `Message #general`;
    
    loginScreen.classList.add('hidden');
    appContainer.classList.remove('hidden');
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Transmit input field configurations up to the server socket
chatForm.addEventListener('submit', function(e) {
    e.preventDefault();
    const messageText = messageInput.value.trim();
    if (messageText === '') return;

    const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    socket.emit('chat message', {
        user: userName,
        text: messageText,
        time: currentTime,
        id: socket.id
    });

    messageInput.value = '';
});

// Receive real-time server payloads and build structural layouts dynamically
socket.on('chat message', function(data) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('discord-message');
    
    const initial = data.user.charAt(0).toUpperCase();
    // Color shift your own user bubble vs external visitors 
    const avatarColor = (data.id === socket.id) ? '#5865f2' : '#72767d';

    messageDiv.innerHTML = `
        <div class="avatar" style="background-color: ${avatarColor};">${initial}</div>
        <div class="msg-content">
            <div class="msg-header">
                <span class="msg-username">${escapeHtml(data.user)}</span>
                <span class="msg-timestamp">${data.time || 'Just Now'}</span>
            </div>
            <div class="msg-text">${escapeHtml(data.text)}</div>
        </div>
    `;

    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Basic entity filter sanitizing user message string evaluations
function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
