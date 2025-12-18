// ============================================================================
// MESSAGES.JS - Message handling with Reply/Receipt support
// ============================================================================
// Features:
// 1. Delivery/Read receipt display (iMessage style)
// 2. Reply-to message preview rendering (iMessage style)
// 3. Smaller edit/delete icon buttons (pencil and trashcan)
// 4. Reply mode functionality
// ============================================================================

// Message handling
var Messages = {
  history: [],
  currentVersion: 0,
  editingSeq: null,
  replyingToSeq: null,  // Track which message we're replying to
  replyingToMessage: null,  // The message content being replied to
  myRole: null,

  formatMessageTime: function(timestamp){
    if(!timestamp) return '';
    
    var msgDate = new Date(timestamp);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    var msgDay = new Date(msgDate.getFullYear(), msgDate.getMonth(), msgDate.getDate());
    
    var timeStr = msgDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
    
    if(msgDay.getTime() === today.getTime()){
      return timeStr;  // Just show time for today
    } else if(msgDay.getTime() === yesterday.getTime()){
      return 'Yesterday ' + timeStr;
    } else {
      var dateStr = (msgDate.getMonth() + 1) + '/' + msgDate.getDate();
      return dateStr + ' ' + timeStr;
    }
  },

  isMessageEdited: function(msg){
    if(!msg.createdAt || !msg.updatedAt) return false;
    var created = new Date(msg.createdAt).getTime();
    var updated = new Date(msg.updatedAt).getTime();
    return updated > created;
  },

  bubbleClassFor: function(msg){
    if(this.myRole && msg.user && msg.user === this.myRole){
      return 'right';
    }
    return 'left';
  },

  // Get the receipt status for a message
  getReceiptStatus: function(msg){
    // Only show receipts for messages sent by current user
    if(!this.myRole || msg.user !== this.myRole) return null;
    
    if(msg.readAt){
      return 'read';
    } else if(msg.deliveredAt){
      return 'delivered';
    } else {
      return 'sent';
    }
  },

  // Find a message by seq number
  findMessageBySeq: function(seq){
    return this.history.find(function(m){ return m.seq === seq; });
  },

  // Enter reply mode
  enterReplyMode: function(seq){
    var msg = this.findMessageBySeq(seq);
    if(!msg) return;
    
    this.replyingToSeq = seq;
    this.replyingToMessage = msg;
    
    // Show reply preview UI
    var replyPreview = document.getElementById('replyPreview');
    var replyPreviewText = document.getElementById('replyPreviewText');
    var replyPreviewUser = document.getElementById('replyPreviewUser');
    
    if(replyPreview && replyPreviewText){
      var previewText = msg.message || '';
      if(msg.messageType === 'gif') previewText = '🎬 GIF';
      if(msg.messageType === 'image') previewText = '📷 Photo';
      if(previewText.length > 50) previewText = previewText.substring(0, 50) + '...';
      
      replyPreviewText.textContent = previewText;
      if(replyPreviewUser) replyPreviewUser.textContent = msg.user || 'Unknown';
      replyPreview.classList.add('show');
    }
    
    // Focus the input
    if(UI.els.reply) UI.els.reply.focus();
  },

  // Exit reply mode
  exitReplyMode: function(){
    this.replyingToSeq = null;
    this.replyingToMessage = null;
    
    var replyPreview = document.getElementById('replyPreview');
    if(replyPreview) replyPreview.classList.remove('show');
  },

  applyDrop: function(data){
    if(!data) return;
    
    this.currentVersion = data.version || 0;
    
    if(data.messages && Array.isArray(data.messages)){
      this.history = data.messages.map(function(msg){
        return {
          message: msg.message || '',
          seq: msg.seq || 0,
          version: msg.seq || 0,
          createdAt: msg.createdAt || msg.updatedAt,
          updatedAt: msg.updatedAt,
          reactions: msg.reactions || {},
          user: msg.user || null,
          clientId: msg.clientId || null,
          messageType: msg.messageType || 'text',
          gifUrl: msg.gifUrl || null,
          gifPreview: msg.gifPreview || null,
          gifWidth: msg.gifWidth || null,
          gifHeight: msg.gifHeight || null,
          imageUrl: msg.imageUrl || null,
          imageThumb: msg.imageThumb || null,
          // Receipt and reply fields
          replyToSeq: msg.replyToSeq || null,
          deliveredAt: msg.deliveredAt || null,
          readAt: msg.readAt || null
        };
      });
      this.render();
      
      // Auto-send read receipts for messages from other user
      this.sendReadReceipts();
    }
    
    if(UI.setLive) UI.setLive('Connected');
  },

  // Send read receipts for unread messages
  sendReadReceipts: function(){
    if(!this.myRole) return;
    
    // Find the highest seq of unread messages from the other user
    var maxUnreadSeq = 0;
    this.history.forEach(function(msg){
      if(msg.user !== this.myRole && !msg.readAt && msg.seq > maxUnreadSeq){
        maxUnreadSeq = msg.seq;
      }
    }.bind(this));
    
    // Send read receipt via WebSocket
    if(maxUnreadSeq > 0 && WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
      WebSocketManager.sendReadReceipt(maxUnreadSeq, this.myRole);
    }
  },

  // Handle incoming delivery receipt
  handleDeliveryReceipt: function(data){
    var seq = data.seq;
    var deliveredAt = data.deliveredAt;
    
    var msg = this.findMessageBySeq(seq);
    if(msg){
      msg.deliveredAt = deliveredAt;
      this.render();
    }
  },

  // Handle incoming read receipt
  handleReadReceipt: function(data){
    var upToSeq = data.upToSeq;
    var readAt = data.readAt;
    
    // Mark all messages up to this seq as read
    this.history.forEach(function(msg){
      if(msg.seq <= upToSeq && !msg.readAt){
        msg.readAt = readAt;
      }
    });
    
    this.render();
  },

  render: function(){
    if(!UI.els.chatContainer) return;
    
    // Store scroll position
    var wasAtBottom = UI.els.chatContainer.scrollHeight - UI.els.chatContainer.scrollTop <= UI.els.chatContainer.clientHeight + 50;
    
    // Clear all messages but keep typing indicator
    var existingMessages = UI.els.chatContainer.querySelectorAll('.message-group');
    existingMessages.forEach(function(el){ el.remove(); });
    
    this.history.forEach(function(msg, index){
      if(!msg || !msg.message) return;
      
      var bubbleClass = this.bubbleClassFor(msg);
      var isOwnMessage = bubbleClass === 'right';
      
      var group = document.createElement('div');
      group.className = 'message-group ' + bubbleClass;
      group.setAttribute('data-seq', msg.seq || msg.version);
      
      // Render reply preview if this message is a reply
      if(msg.replyToSeq){
        var repliedMsg = this.findMessageBySeq(msg.replyToSeq);
        if(repliedMsg){
          var replyBubble = document.createElement('div');
          replyBubble.className = 'reply-bubble';
          
          var replyLine = document.createElement('div');
          replyLine.className = 'reply-line';
          
          var replyContent = document.createElement('div');
          replyContent.className = 'reply-content';
          
          var replyAuthor = document.createElement('span');
          replyAuthor.className = 'reply-author';
          replyAuthor.textContent = repliedMsg.user || 'Unknown';
          
          var replyText = document.createElement('span');
          replyText.className = 'reply-text';
          var replyTextContent = repliedMsg.message || '';
          if(repliedMsg.messageType === 'gif') replyTextContent = '🎬 GIF';
          if(repliedMsg.messageType === 'image') replyTextContent = '📷 Photo';
          if(replyTextContent.length > 40) replyTextContent = replyTextContent.substring(0, 40) + '...';
          replyText.textContent = replyTextContent;
          
          replyContent.appendChild(replyAuthor);
          replyContent.appendChild(replyText);
          replyBubble.appendChild(replyLine);
          replyBubble.appendChild(replyContent);
          
          // Make reply bubble clickable to scroll to original
          replyBubble.addEventListener('click', function(e){
            e.stopPropagation();
            var originalGroup = document.querySelector('.message-group[data-seq="' + msg.replyToSeq + '"]');
            if(originalGroup){
              originalGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
              originalGroup.classList.add('highlight-flash');
              setTimeout(function(){ originalGroup.classList.remove('highlight-flash'); }, 1500);
            }
          });
          
          group.appendChild(replyBubble);
        }
      }
      
      var bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      
      // Check if message is an image
      if(msg.messageType === 'image' && msg.imageUrl){
        bubble.classList.add('image-message');
        
        var imageContainer = document.createElement('div');
        imageContainer.className = 'image-container';
        
        var img = document.createElement('img');
        img.src = msg.imageThumb || msg.imageUrl;
        img.alt = msg.message || 'Image';
        img.className = 'image-thumbnail';
        img.loading = 'lazy';
        
        var maxWidth = 200;
        var maxHeight = 200;
        img.style.width = maxWidth + 'px';
        img.style.height = maxHeight + 'px';
        img.style.objectFit = 'cover';
        img.style.cursor = 'pointer';
        
        img.addEventListener('click', function(e){
          e.stopPropagation();
          var fullUrl = msg.imageUrl || msg.imageThumb;
          if(fullUrl && UI.openLightbox){
            UI.openLightbox(fullUrl + '?t=' + Date.now());
          }
        });
        
        imageContainer.appendChild(img);
        bubble.appendChild(imageContainer);
        
        if(msg.message && msg.message !== '[Image]'){
          var caption = document.createElement('div');
          caption.className = 'image-caption';
          caption.textContent = msg.message;
          bubble.appendChild(caption);
        }
      }
      // Check if message is a GIF
      else if(msg.messageType === 'gif' && msg.gifUrl){
        bubble.classList.add('gif-message');
        
        var gifContainer = document.createElement('div');
        gifContainer.className = 'gif-container';
        
        var maxWidth = 300;
        var displayWidth = msg.gifWidth || maxWidth;
        var displayHeight = msg.gifHeight || 200;
        
        if(displayWidth > maxWidth){
          var ratio = maxWidth / displayWidth;
          displayWidth = maxWidth;
          displayHeight = Math.round(displayHeight * ratio);
        }
        
        var img = document.createElement('img');
        img.src = msg.gifPreview || msg.gifUrl;
        img.alt = msg.message || 'GIF';
        img.className = 'gif-image';
        img.style.width = displayWidth + 'px';
        img.style.height = displayHeight + 'px';
        img.loading = 'lazy';
        
        img.addEventListener('click', function(e){
          e.stopPropagation();
          if(UI.showLightbox){
            UI.showLightbox(msg.gifUrl);
          }
        });
        
        gifContainer.appendChild(img);
        bubble.appendChild(gifContainer);
        
        if(msg.message && msg.message !== '[GIF]' && !msg.message.startsWith('[GIF:')){
          var caption = document.createElement('div');
          caption.className = 'gif-caption';
          caption.textContent = msg.message;
          bubble.appendChild(caption);
        }
      } else {
        // Regular text message
        bubble.textContent = msg.message;
      }
      
      var reactionsContainer = document.createElement('div');
      reactionsContainer.className = 'msg-reactions';
      if(Reactions && Reactions.render){
        Reactions.render(reactionsContainer, msg.reactions || {}, msg.seq || msg.version);
      }
      group.appendChild(reactionsContainer);
      
      group.appendChild(bubble);
      
      var meta = document.createElement('div');
      meta.className = 'message-meta';
      
      var timeText = document.createElement('span');
      timeText.className = 'meta-time';
      timeText.textContent = this.formatMessageTime(msg.createdAt || msg.updatedAt);
      meta.appendChild(timeText);
      
      if(this.isMessageEdited(msg)){
        var editedLabel = document.createElement('span');
        editedLabel.className = 'meta-edited';
        editedLabel.textContent = 'Edited';
        meta.appendChild(editedLabel);
      }
      
      // Show receipt status for own messages (iMessage style)
      if(isOwnMessage){
        var receiptStatus = this.getReceiptStatus(msg);
        if(receiptStatus){
          var receiptSpan = document.createElement('span');
          receiptSpan.className = 'meta-receipt receipt-' + receiptStatus;
          
          if(receiptStatus === 'read'){
            receiptSpan.textContent = 'Read';
          } else if(receiptStatus === 'delivered'){
            receiptSpan.textContent = 'Delivered';
          } else {
            receiptSpan.textContent = 'Sent';
          }
          meta.appendChild(receiptSpan);
        }
      }
      
      // Reply button (icon)
      var replyBtn = document.createElement('button');
      replyBtn.className = 'msg-action-btn reply-btn';
      replyBtn.type = 'button';
      replyBtn.setAttribute('data-seq', msg.seq || msg.version);
      replyBtn.setAttribute('aria-label', 'Reply');
      replyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>';
      replyBtn.addEventListener('click', function(e){
        e.stopPropagation();
        this.enterReplyMode(msg.seq || msg.version);
      }.bind(this));
      meta.appendChild(replyBtn);
      
      // Edit button (icon) - only for text messages
      if(msg.messageType !== 'gif' && msg.messageType !== 'image'){
        var editBtn = document.createElement('button');
        editBtn.className = 'msg-action-btn edit-btn';
        editBtn.type = 'button';
        editBtn.setAttribute('data-seq', msg.seq || msg.version);
        editBtn.setAttribute('aria-label', 'Edit');
        editBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
        editBtn.addEventListener('click', function(e){
          e.stopPropagation();
          this.enterEditMode(msg.seq || msg.version, msg.message);
        }.bind(this));
        meta.appendChild(editBtn);
      }
      
      // Delete button (icon)
      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'msg-action-btn delete-btn';
      deleteBtn.type = 'button';
      deleteBtn.setAttribute('data-seq', msg.seq || msg.version);
      deleteBtn.setAttribute('aria-label', 'Delete');
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
      meta.appendChild(deleteBtn);
      
      group.appendChild(meta);
      
      // Insert before typing indicator
      if(UI.els.typingIndicator){
        UI.els.chatContainer.insertBefore(group, UI.els.typingIndicator);
      } else {
        UI.els.chatContainer.appendChild(group);
      }
      
      this.attachMessageClick(bubble);
    }.bind(this));
    
    // Restore scroll position
    if(wasAtBottom){
      UI.els.chatContainer.scrollTop = UI.els.chatContainer.scrollHeight;
    }
  },

  attachMessageClick: function(msgEl){
    if(!msgEl || msgEl.__clickAttached) return;
    msgEl.__clickAttached = true;
    
    msgEl.addEventListener('click', function(e){
      e.stopPropagation();
      
      if(e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      if(e.target.classList.contains('reaction-chip') || e.target.closest('.reaction-chip')) return;
      if(e.target.classList.contains('msg-action-btn') || e.target.closest('.msg-action-btn')) return;
      if(e.target.closest('.msg-reactions')) return;
      if(e.target.classList.contains('gif-image') || e.target.classList.contains('image-thumbnail')) return;
      if(e.target.closest('.gif-container') || e.target.closest('.image-container')) return;
      if(e.target.closest('.reply-bubble')) return;
      
      var group = msgEl.closest('.message-group');
      if(group && Reactions && Reactions.openPicker) {
        Reactions.openPicker(msgEl);
      }
    });
  },

  enterEditMode: function(seq, currentText){
    this.editingSeq = seq;
    this.exitReplyMode();  // Exit reply mode if active
    UI.els.reply.value = currentText;
    UI.els.reply.style.height = 'auto';
    UI.els.reply.style.height = Math.min(UI.els.reply.scrollHeight, 100) + 'px';
    UI.els.composeSection.classList.add('editing');
    UI.els.editHeader.classList.add('show');
    UI.els.reply.focus();
  },

  exitEditMode: function(){
    this.editingSeq = null;
    UI.els.reply.value = '';
    UI.els.reply.style.height = 'auto';
    UI.els.composeSection.classList.remove('editing');
    UI.els.editHeader.classList.remove('show');
  },

  handleTyping: function(data){
    var user = data.user;
    var ts = data.ts || Date.now();
    
    if(!user || user === this.myRole) {
      return;
    }
    
    if(WebSocketManager.typingTimeouts.has(user)){
      clearTimeout(WebSocketManager.typingTimeouts.get(user));
    }
    
    WebSocketManager.typingState.set(user, ts);
    
    var timeout = setTimeout(function(){
      WebSocketManager.typingState.delete(user);
      WebSocketManager.typingTimeouts.delete(user);
      this.renderTypingIndicator();
    }.bind(this), 5000);
    
    WebSocketManager.typingTimeouts.set(user, timeout);
    
    this.renderTypingIndicator();
  },

  renderTypingIndicator: function(){
    if(!UI.els.typingIndicator) return;
    
    var now = Date.now();
    var activeUsers = [];
    
    for(var entry of Array.from(WebSocketManager.typingState.entries())){
      var user = entry[0];
      var ts = entry[1];
      
      if(now - ts > 5000){
        WebSocketManager.typingState.delete(user);
        if(WebSocketManager.typingTimeouts.has(user)){
          clearTimeout(WebSocketManager.typingTimeouts.get(user));
          WebSocketManager.typingTimeouts.delete(user);
        }
      } else if(user !== this.myRole){
        activeUsers.push(user);
      }
    }
    
    if(activeUsers.length > 0){
      UI.els.typingIndicator.classList.add('show');
      if(UI.els.chatContainer){
        UI.els.chatContainer.scrollTop = UI.els.chatContainer.scrollHeight;
      }
    } else {
      UI.els.typingIndicator.classList.remove('show');
    }
  }
};
