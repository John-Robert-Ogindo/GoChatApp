        let ws;
        let currentUsername = '';
        const chat = document.getElementById('chat');
        const form = document.getElementById('form');
        const msgInput = document.getElementById('msg');
        const nameInput = document.getElementById('name');
        const connectBtn = document.getElementById('connect');
        const disconnectBtn = document.getElementById('disconnect');
        const onlineUsersList = document.getElementById('onlineUsersList');
        const fileInput = document.getElementById('fileInput');
        const profilePictureInput = document.getElementById('profilePicture');
        const profilePreview = document.getElementById('profilePreview');
        const messageStatusMap = new Map(); // Track message status: messageID -> {status, readBy}
        let currentProfilePicture = null;

        function getStatusIcon(status, readBy, sender, messageID) {
            const statusDiv = document.createElement('span');
            statusDiv.className = 'message-status';
            statusDiv.setAttribute('data-message-id', messageID || '');
            
            // Only show status for messages sent by current user
            if (sender !== currentUsername || !messageID) {
                return statusDiv; // Empty status for messages not sent by current user
            }
            
            let icon = '';
            let className = '';
            
            // Get list of online users (excluding sender)
            const onlineUserElements = onlineUsersList.querySelectorAll('.user-item');
            const onlineUsers = Array.from(onlineUserElements).map(el => {
                // Get text content, skipping the status indicator span
                const clone = el.cloneNode(true);
                const indicator = clone.querySelector('.status-indicator');
                if (indicator) indicator.remove();
                return clone.textContent.trim();
            }).filter(u => u && u !== sender);
            
            if (status === 'read' || (readBy && readBy.length > 0)) {
                // Check if all online users (except sender) have read it
                if (onlineUsers.length === 0) {
                    // No other users online, show as delivered
                    icon = '✓✓';
                    className = 'tick-double-grey';
                } else {
                    const allRead = onlineUsers.every(u => readBy && readBy.includes(u));
                    if (allRead) {
                        icon = '✓✓';
                        className = 'tick-double-blue';
                    } else {
                        icon = '✓✓';
                        className = 'tick-double-grey';
                    }
                }
            } else if (status === 'delivered') {
                icon = '✓✓';
                className = 'tick-double-grey';
            } else {
                // sent status
                icon = '✓';
                className = 'tick-single';
            }
            
            statusDiv.textContent = icon;
            statusDiv.className = 'message-status ' + className;
            return statusDiv;
        }

        function updateMessageStatus(messageID, status, readBy) {
            if (!messageID) return;
            
            messageStatusMap.set(messageID, { status, readBy });
            
            // Update the status icon in the DOM
            const statusElement = chat.querySelector(`[data-message-id="${messageID}"]`);
            if (statusElement && statusElement.parentElement) {
                const messageDiv = statusElement.closest('.message');
                if (messageDiv) {
                    const oldStatus = messageDiv.querySelector('.message-status');
                    if (oldStatus) {
                        const messageData = messageStatusMap.get(messageID);
                        const sender = messageDiv.querySelector('.message-sender')?.textContent.split(' – ')[1]?.split(':')[0] || '';
                        const newStatus = getStatusIcon(
                            messageData?.status || status,
                            messageData?.readBy || readBy,
                            sender,
                            messageID
                        );
                        oldStatus.replaceWith(newStatus);
                    }
                }
            }
        }

        function createMessageActions(messageID, sender, isDeleted) {
            if (sender !== currentUsername || isDeleted) {
                return null;
            }
            
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'message-actions';
            
            const editBtn = document.createElement('button');
            editBtn.className = 'message-action-btn';
            editBtn.textContent = '✏️ Edit';
            editBtn.onclick = () => editMessage(messageID);
            actionsDiv.appendChild(editBtn);
            
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'message-action-btn';
            deleteBtn.textContent = '🗑️ Delete';
            deleteBtn.onclick = () => deleteMessage(messageID);
            actionsDiv.appendChild(deleteBtn);
            
            return actionsDiv;
        }

        function editMessage(messageID) {
            const messageDiv = chat.querySelector(`[data-msg-id="${messageID}"]`);
            if (!messageDiv) return;
            
            const contentWrapper = messageDiv.querySelector('.message-content-wrapper');
            if (!contentWrapper) return;
            
            const textDiv = contentWrapper.querySelector('div:not(.message-sender):not(.edited-badge)');
            if (!textDiv) return;
            
            // Extract just the message part (after the colon)
            const fullText = textDiv.textContent.trim();
            const colonIndex = fullText.indexOf(':');
            const originalText = colonIndex >= 0 ? fullText.substring(colonIndex + 1).trim() : fullText;
            const prefix = colonIndex >= 0 ? fullText.substring(0, colonIndex + 1) : '';
            
            const editInput = document.createElement('input');
            editInput.type = 'text';
            editInput.className = 'edit-input';
            editInput.value = originalText;
            
            const saveBtn = document.createElement('button');
            saveBtn.textContent = 'Save';
            saveBtn.className = 'message-action-btn';
            
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.className = 'message-action-btn';
            
            const actionsContainer = document.createElement('div');
            actionsContainer.style.display = 'flex';
            actionsContainer.style.gap = '5px';
            actionsContainer.style.marginTop = '5px';
            actionsContainer.appendChild(saveBtn);
            actionsContainer.appendChild(cancelBtn);
            
            saveBtn.onclick = () => {
                const newText = editInput.value.trim();
                if (newText && newText !== originalText) {
                    sendEditMessage(messageID, newText);
                    // The message will be updated via the edit event from server
                    // For now, update locally
                    textDiv.textContent = prefix + ' ' + newText;
                } else {
                    // Restore original
                    textDiv.textContent = fullText;
                }
                // Restore text div
                editInput.replaceWith(textDiv);
                actionsContainer.remove();
            };
            
            cancelBtn.onclick = () => {
                // Restore original text
                textDiv.textContent = fullText;
                editInput.replaceWith(textDiv);
                actionsContainer.remove();
            };
            
            textDiv.replaceWith(editInput);
            contentWrapper.appendChild(actionsContainer);
            editInput.focus();
            editInput.select();
            
            editInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    saveBtn.click();
                } else if (e.key === 'Escape') {
                    cancelBtn.click();
                }
            });
        }

        function deleteMessage(messageID) {
            if (confirm('Are you sure you want to delete this message?')) {
                sendDeleteMessage(messageID);
            }
        }

        function sendEditMessage(messageID, newText) {
            if (!ws || ws.readyState !== WebSocket.OPEN || !messageID) return;
            
            const editMsg = {
                type: 'edit',
                messageId: messageID,
                message: newText,
                sender: currentUsername
            };
            ws.send(JSON.stringify(editMsg));
        }

        function sendDeleteMessage(messageID) {
            if (!ws || ws.readyState !== WebSocket.OPEN || !messageID) return;
            
            const deleteMsg = {
                type: 'delete',
                messageId: messageID,
                sender: currentUsername
            };
            ws.send(JSON.stringify(deleteMsg));
        }

        function updateMessageInChat(messageID, newText, isDeleted) {
            const messageDiv = chat.querySelector(`[data-msg-id="${messageID}"]`);
            if (!messageDiv) return;
            
            const contentWrapper = messageDiv.querySelector('.message-content-wrapper');
            if (!contentWrapper) return;
            
            if (isDeleted) {
                messageDiv.className += ' message-deleted';
                // Find the text div (first div that's not sender or badge)
                const children = Array.from(contentWrapper.children);
                const textDiv = children.find(el => 
                    !el.classList.contains('message-sender') && 
                    !el.classList.contains('edited-badge') &&
                    el.tagName === 'DIV'
                );
                if (textDiv) {
                    textDiv.textContent = 'This message was deleted';
                    textDiv.style.fontStyle = 'italic';
                    textDiv.style.color = '#888';
                }
                // Remove action buttons
                const actions = messageDiv.querySelector('.message-actions');
                if (actions) actions.remove();
            } else if (newText) {
                // Find the text div
                const children = Array.from(contentWrapper.children);
                const textDiv = children.find(el => 
                    !el.classList.contains('message-sender') && 
                    !el.classList.contains('edited-badge') &&
                    el.tagName === 'DIV'
                );
                if (textDiv) {
                    // Extract just the message part (remove timestamp and sender)
                    const parts = textDiv.textContent.split(':');
                    if (parts.length > 1) {
                        const senderPart = parts[0];
                        textDiv.textContent = senderPart + ': ' + newText;
                    } else {
                        textDiv.textContent = newText;
                    }
                }
                // Add edited badge if not present
                if (!messageDiv.querySelector('.edited-badge')) {
                    const editedBadge = document.createElement('span');
                    editedBadge.className = 'edited-badge';
                    editedBadge.textContent = '(edited)';
                    contentWrapper.appendChild(editedBadge);
                }
            }
        }

        function appendMessage(text, isSystem = false, data = null) {
            const div = document.createElement('div');
            div.className = 'message' + (isSystem ? ' system-message' : '');
            
            // Check if message is deleted
            if (data && data.isDeleted) {
                div.className += ' message-deleted';
            }
            
            const wrapper = document.createElement('div');
            wrapper.className = 'message-wrapper';
            const contentWrapper = document.createElement('div');
            contentWrapper.className = 'message-content-wrapper';
            
            // Extract message ID and sender
            let messageID = null;
            let sender = '';
            if (data && data.messageId) {
                messageID = data.messageId;
                sender = data.sender || '';
                div.setAttribute('data-msg-id', messageID);
            }
            
            if (data && (data.type === 'image' || data.type === 'file')) {
                const contentDiv = document.createElement('div');
                contentDiv.className = 'message-content';
                
                // Create message header with profile picture
                const messageHeader = document.createElement('div');
                messageHeader.className = 'message-header';
                
                // Add profile picture if available
                if (data.profilePicture) {
                    const profilePic = document.createElement('img');
                    profilePic.src = data.profilePicture;
                    profilePic.className = 'message-profile-pic';
                    profilePic.alt = data.sender || 'User';
                    messageHeader.appendChild(profilePic);
                }
                
                const when = new Date().toLocaleTimeString();
                const senderDiv = document.createElement('div');
                senderDiv.className = 'message-sender';
                senderDiv.textContent = `${when} – ${data.sender}:`;
                messageHeader.appendChild(senderDiv);
                contentDiv.appendChild(messageHeader);
                
                if (data.type === 'image') {
                    const img = document.createElement('img');
                    img.src = 'data:' + data.fileType + ';base64,' + data.fileData;
                    img.className = 'message-image';
                    img.alt = data.fileName || 'Image';
                    img.onclick = () => {
                        const newWindow = window.open();
                        newWindow.document.write(`<img src="${img.src}" style="max-width: 100%; height: auto;">`);
                    };
                    contentDiv.appendChild(img);
                    if (data.fileName) {
                        const fileNameDiv = document.createElement('div');
                        fileNameDiv.className = 'file-info';
                        fileNameDiv.textContent = data.fileName;
                        contentDiv.appendChild(fileNameDiv);
                    }
                } else if (data.type === 'file') {
                    const fileDiv = document.createElement('div');
                    fileDiv.className = 'message-file';
                    const link = document.createElement('a');
                    link.href = 'data:' + data.fileType + ';base64,' + data.fileData;
                    link.download = data.fileName || 'file';
                    link.className = 'file-link';
                    link.textContent = '📄 ' + (data.fileName || 'Download File');
                    fileDiv.appendChild(link);
                    if (data.message) {
                        const msgDiv = document.createElement('div');
                        msgDiv.className = 'file-info';
                        msgDiv.textContent = data.message;
                        fileDiv.appendChild(msgDiv);
                    }
                    contentDiv.appendChild(fileDiv);
                }
                
                contentWrapper.appendChild(contentDiv);
                
                // Add status indicator
                if (data.messageId) {
                    const statusIcon = getStatusIcon(data.status || 'sent', data.readBy || [], data.sender, data.messageId);
                    wrapper.appendChild(contentWrapper);
                    wrapper.appendChild(statusIcon);
                    messageStatusMap.set(data.messageId, { status: data.status || 'sent', readBy: data.readBy || [] });
                } else {
                    wrapper.appendChild(contentWrapper);
                }
                
                div.appendChild(wrapper);
            } else {
                // Create message header with profile picture
                const messageHeader = document.createElement('div');
                messageHeader.className = 'message-header';
                
                // Add profile picture if available
                if (data && data.profilePicture) {
                    const profilePic = document.createElement('img');
                    profilePic.src = data.profilePicture;
                    profilePic.className = 'message-profile-pic';
                    profilePic.alt = data.sender || 'User';
                    messageHeader.appendChild(profilePic);
                }
                
                const textDiv = document.createElement('div');
                if (data && data.isDeleted) {
                    textDiv.textContent = 'This message was deleted';
                    textDiv.style.fontStyle = 'italic';
                    textDiv.style.color = '#888';
                } else {
                    textDiv.textContent = text;
                }
                messageHeader.appendChild(textDiv);
                contentWrapper.appendChild(messageHeader);
                
                // Add edited badge if message was edited
                if (data && data.isEdited && !data.isDeleted) {
                    const editedBadge = document.createElement('span');
                    editedBadge.className = 'edited-badge';
                    editedBadge.textContent = '(edited)';
                    contentWrapper.appendChild(editedBadge);
                }
                
                let status = 'sent';
                let readBy = [];
                
                if (data && data.messageId) {
                    status = data.status || 'sent';
                    readBy = data.readBy || [];
                    messageStatusMap.set(messageID, { status, readBy });
                }
                
                // Add status indicator if this is a message with ID
                if (messageID) {
                    const statusIcon = getStatusIcon(status, readBy, sender, messageID);
                    wrapper.appendChild(contentWrapper);
                    wrapper.appendChild(statusIcon);
                } else {
                    wrapper.appendChild(contentWrapper);
                }
                
                // Add edit/delete buttons for user's own messages
                if (messageID && sender === currentUsername && !data?.isDeleted) {
                    const actions = createMessageActions(messageID, sender, data?.isDeleted);
                    if (actions) {
                        wrapper.appendChild(actions);
                    }
                }
                
                div.appendChild(wrapper);
            }
            
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
            
            // Send read receipt if this is not our message and we haven't read it yet
            if (data && data.messageId && data.sender !== currentUsername && !data.isDeleted) {
                setTimeout(() => {
                    sendReadReceipt(data.messageId);
                }, 500); // Small delay to ensure message is displayed
            }
        }

        function sendReadReceipt(messageID) {
            if (!ws || ws.readyState !== WebSocket.OPEN || !messageID) return;
            
            const receipt = {
                type: 'read_receipt',
                messageId: messageID,
                sender: currentUsername
            };
            ws.send(JSON.stringify(receipt));
        }

        function updateOnlineUsers(users) {
            onlineUsersList.innerHTML = '';
            if (users.length === 0) {
                onlineUsersList.innerHTML = '<div style="color: #999;">No users online</div>';
                return;
            }
            users.forEach(username => {
                const userDiv = document.createElement('div');
                userDiv.className = 'user-item';
                const indicator = document.createElement('span');
                indicator.className = 'status-indicator';
                indicator.title = 'Online';
                userDiv.appendChild(indicator);
                userDiv.appendChild(document.createTextNode(username));
                onlineUsersList.appendChild(userDiv);
            });
        }

        // Handle profile picture upload
        profilePictureInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            if (!file.type.startsWith('image/')) {
                alert('Please select an image file.');
                profilePictureInput.value = '';
                return;
            }
            
            const reader = new FileReader();
            reader.onload = (event) => {
                currentProfilePicture = event.target.result;
                profilePreview.src = currentProfilePicture;
            };
            reader.onerror = () => {
                alert('Error reading image file.');
                profilePictureInput.value = '';
            };
            reader.readAsDataURL(file);
        });

        // Connect button
        connectBtn.onclick = () => {
            if (ws && ws.readyState === WebSocket.OPEN) return;

            const name = nameInput.value.trim();
            if (!name) {
                alert('Please enter your name.');
                return;
            }
            
            if (!currentProfilePicture) {
                alert('Please upload a profile picture before connecting.');
                return;
            }

            const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
            ws = new WebSocket(url);

            ws.onopen = () => {
                currentUsername = nameInput.value.trim() || 'Anonymous';
                
                // Send profile picture and username to server
                const profileData = {
                    type: 'register',
                    sender: currentUsername,
                    profilePicture: currentProfilePicture
                };
                ws.send(JSON.stringify(profileData));
                
                connectBtn.disabled = true;
                disconnectBtn.disabled = false;
            };

            ws.onmessage = (evt) => {
                try {
                    const data = JSON.parse(evt.data);
                    
                    // Handle different message types
                    if (data.type === 'user_list') {
                        updateOnlineUsers(data.users || []);
                    } else if (data.type === 'user_joined') {
                        if (data.sender === currentUsername) {
                            // Show welcome message for the user who just joined
                            const welcomeDiv = document.createElement('div');
                            welcomeDiv.className = 'welcome-message';
                            welcomeDiv.textContent = `Hello ${currentUsername}, welcome to our chat section!`;
                            chat.appendChild(welcomeDiv);
                            chat.scrollTop = chat.scrollHeight;
                        } else {
                            appendMessage(`[System] ${data.message}`, true);
                        }
                    } else if (data.type === 'user_left') {
                        appendMessage(`[System] ${data.message}`, true);
                    } else if (data.type === 'read_receipt') {
                        // Update message status when read receipt is received
                        updateMessageStatus(data.messageId, data.status, data.readBy);
                    } else if (data.type === 'edit') {
                        // Handle message edit
                        const when = new Date().toLocaleTimeString();
                        updateMessageInChat(data.messageId, data.message, false);
                    } else if (data.type === 'delete') {
                        // Handle message delete
                        updateMessageInChat(data.messageId, null, true);
                    } else if (data.type === 'message' || !data.type) {
                        // Regular chat message
                        const when = new Date().toLocaleTimeString();
                        appendMessage(`${when} – ${data.sender}: ${data.message}`, false, data);
                    } else if (data.type === 'image' || data.type === 'file') {
                        // File or image message
                        appendMessage('', false, data);
                    }
                } catch {
                    appendMessage(evt.data);
                }
            };

            ws.onclose = () => {
                appendMessage('[System] Disconnected', true);
                connectBtn.disabled = false;
                disconnectBtn.disabled = true;
                updateOnlineUsers([]);
                currentUsername = '';
                currentProfilePicture = null;
                profilePreview.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%23333'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23888' font-size='12'%3EAdd Photo%3C/text%3E%3C/svg%3E";
                profilePictureInput.value = '';
            };

            ws.onerror = (err) => {
                console.error("WebSocket error:", err);
                ws.close();
            };
        };

        // Disconnect button
        disconnectBtn.onclick = () => {
            if (ws) {
                ws.close();
                ws = null;
            }
        };

        // Send message
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('WebSocket not connected.');
                return;
            }

            const name = nameInput.value.trim() || 'Anonymous';
            const msg = msgInput.value.trim();
            if (!msg) return;

            const payload = JSON.stringify({ 
                type: 'message',
                sender: name, 
                message: msg 
            });
            ws.send(payload);
            msgInput.value = '';
        });

        // Handle file input
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('WebSocket not connected.');
                fileInput.value = '';
                return;
            }

            const name = nameInput.value.trim() || 'Anonymous';
            const reader = new FileReader();
            
            reader.onload = (event) => {
                const result = event.target.result;
                // Extract base64 data (remove data:type;base64, prefix if present)
                const base64Data = result.includes(',') ? result.split(',')[1] : result;
                const fileType = file.type || 'application/octet-stream';
                const isImage = fileType.startsWith('image/');
                
                const payload = {
                    type: isImage ? 'image' : 'file',
                    sender: name,
                    fileName: file.name,
                    fileType: fileType,
                    fileData: base64Data,
                    message: isImage ? '' : `Sent file: ${file.name} (${formatFileSize(file.size)})`,
                    status: 'sent'
                };
                
                ws.send(JSON.stringify(payload));
                fileInput.value = '';
            };
            
            reader.onerror = () => {
                alert('Error reading file.');
                fileInput.value = '';
            };
            
            // Check file size (10MB limit)
            const maxSize = 10 * 1024 * 1024; // 10MB
            if (file.size > maxSize) {
                alert('File size exceeds 10MB limit.');
                fileInput.value = '';
                return;
            }
            
            reader.readAsDataURL(file);
        });

        function formatFileSize(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
        }