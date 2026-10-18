    const socket = io();

        let userName = "Anonymous";

        const loginScreen = document.getElementById('loginScreen');
        const chatWindow = document.getElementById('chatWindow');
        const loginForm = document.getElementById('loginForm');
        const usernameInput = document.getElementById('usernameInput');
        const roomTitle = document.getElementById('roomTitle');

        const chatForm = document.getElementById('chatForm');
        const messageInput = document.getElementById('messageInput');
        const chatMessages = document.getElementById('chatMessages');

        // Handle joining the chat room via custom UI form
        loginForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const chosenName = usernameInput.value.trim();
            if (chosenName === '') return;
            
            userName = chosenName;
            roomTitle.textContent = `Chatting as: ${userName}`;
            
            // Swap screens natively inside the element views
            loginScreen.classList.add('hidden');
            chatWindow.classList.remove('hidden');
        });

        // Submit chat messages to the live server framework
        chatForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const messageText = messageInput.value.trim();
            if (messageText === '') return;

            socket.emit('chat message', {
                user: userName,
                text: messageText,
                id: socket.id
            });

            messageInput.value = '';
        });

        // Event listener syncing up incoming client distributions
        socket.on('chat message', function(data) {
            const messageDiv = document.createElement('div');
            
            if (data.id === socket.id) {
                messageDiv.classList.add('message', 'sent');
                messageDiv.innerHTML = `<span class="username">You:</span> ${escapeHtml(data.text)}`;
            } else {
                messageDiv.classList.add('message', 'received');
                messageDiv.innerHTML = `<span class="username">${escapeHtml(data.user)}:</span> ${escapeHtml(data.text)}`;
            }

            chatMessages.appendChild(messageDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });

        function escapeHtml(unsafe) {
            return unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }