// Message handling
var Messages = {
  history: [],
  currentVersion: 0,
  editingSeq: null,
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
      return 'Today ' + timeStr;
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
          // ✨ GIF support
          messageType: msg.messageType || 'text',
          gifUrl: msg.gifUrl || null,
          gifPreview: msg.gifPreview || null,
          gifWidth: msg.gifWidth || null,
          gifHeight: msg.gifHeight || null,
          // ✨ Image support
          imageUrl: msg.imageUrl || null,
          imageThumb: msg.imageThumb || null
        };
      });
      this.render();
    }
    
    if(UI.setLive) UI.setLive('Connected');
  },

  render: function(){
    if(!UI.els.chatContainer) return;
    
    // Store scroll position
    var wasAtBottom = UI.els.chatContainer.scrollHeight - UI.els.chatContainer.scrollTop <= UI.els.chatContainer.clientHeight + 50;
    
    // Clear all messages but keep typing indicator
    var existingMessages = UI.els.chatContainer.querySelectorAll('.message-group');
    existingMessages.forEach(function(el){ el.remove(); });
    
    this.history.forEach(function(msg){
      if(!msg || !msg.message) return;
      
      var bubbleClass = this.bubbleClassFor(msg);
      
      var group = document.createElement('div');
      group.className = 'message-group ' + bubbleClass;
      group.setAttribute('data-seq', msg.seq || msg.version);
      
      var bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      
      // ✨ NEW: Check if message is an image
      if(msg.messageType === 'image' && msg.imageUrl){
        bubble.classList.add('image-message');
        
        // Create image container
        var imageContainer = document.createElement('div');
        imageContainer.className = 'image-container';
        
        // Create image element
        var img = document.createElement('img');
        img.src = msg.imageThumb || msg.imageUrl;
        img.alt = msg.message || 'Image';
        img.className = 'image-thumbnail';
        img.loading = 'lazy';
        
        // FIXED: Set explicit dimensions like GIFs (prevents layout shift)
        // All devices show 200x200px for consistency
        var maxWidth = 200;
        var maxHeight = 200;
        
        // Set both width AND height so browser reserves space immediately
        img.style.width = maxWidth + 'px';
        img.style.height = maxHeight + 'px';
        img.style.objectFit = 'cover'; // Crop to fit dimensions nicely
        img.style.cursor = 'pointer';
        
        // Add click handler to open full-size image in lightbox
        img.addEventListener('click', function(e){
          e.stopPropagation();
          var fullUrl = msg.imageUrl || msg.imageThumb;
          if(fullUrl && UI.openLightbox){
            UI.openLightbox(fullUrl + '?t=' + Date.now());
          }
        });
        
        imageContainer.appendChild(img);
        bubble.appendChild(imageContainer);
        
        // Add optional caption below image
        if(msg.message && msg.message !== '[Image]'){
          var caption = document.createElement('div');
          caption.className = 'image-caption';
          caption.textContent = msg.message;
          bubble.appendChild(caption);
        }
      }
      // ✨ NEW: Check if message is a GIF
      else if(msg.messageType === 'gif' && msg.gifUrl){
        bubble.classList.add('gif-message');
        
        // Create GIF container
        var gifContainer = document.createElement('div');
        gifContainer.className = 'gif-container';
        
        // Calculate display dimensions (max 300px width, maintain aspect ratio)
        var maxWidth = 300;
        var displayWidth = msg.gifWidth || maxWidth;
        var displayHeight = msg.gifHeight || 200;
        
        if(displayWidth > maxWidth){
          var ratio = maxWidth / displayWidth;
          displayWidth = maxWidth;
          displayHeight = Math.round(displayHeight * ratio);
        }
        
        // Create image element
        var img = document.createElement('img');
        img.src = msg.gifPreview || msg.gifUrl;
        img.alt = msg.message || 'GIF';
        img.className = 'gif-image';
        img.style.width = displayWidth + 'px';
        img.style.height = displayHeight + 'px';
        img.loading = 'lazy';
        
        // Add click handler to open full-size GIF in lightbox
        img.addEventListener('click', function(e){
          e.stopPropagation();
          if(UI.showLightbox){
            UI.showLightbox(msg.gifUrl);
          }
        });
        
        gifContainer.appendChild(img);
        bubble.appendChild(gifContainer);
        
        // Add optional caption below GIF
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
      timeText.textContent = this.formatMessageTime(msg.createdAt || msg.updatedAt);
      meta.appendChild(timeText);
      
      if(this.isMessageEdited(msg)){
        var editedLabel = document.createElement('span');
        editedLabel.textContent = '(edited)';
        editedLabel.style.fontSize = '10px';
        editedLabel.style.opacity = '0.7';
        meta.appendChild(editedLabel);
      }
      
      // Only show edit button for text messages (not GIF or image)
      if(msg.messageType !== 'gif' && msg.messageType !== 'image'){
        var editBtn = document.createElement('button');
        editBtn.className = 'edit-btn';
        editBtn.textContent = 'Edit';
        editBtn.type = 'button';
        editBtn.setAttribute('data-seq', msg.seq || msg.version);
        editBtn.addEventListener('click', function(e){
          e.stopPropagation();
          this.enterEditMode(msg.seq || msg.version, msg.message);
        }.bind(this));
        meta.appendChild(editBtn);
      }
      
      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-btn';
      deleteBtn.textContent = 'Del';
      deleteBtn.type = 'button';
      deleteBtn.setAttribute('data-seq', msg.seq || msg.version);
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
      if(e.target.classList.contains('edit-btn') || e.target.classList.contains('delete-btn')) return;
      if(e.target.closest('.msg-reactions')) return;
      // Don't open reaction picker when clicking GIF or image
      if(e.target.classList.contains('gif-image') || e.target.classList.contains('image-thumbnail')) return;
      if(e.target.closest('.gif-container') || e.target.closest('.image-container')) return;
      
      var group = msgEl.closest('.message-group');
      if(group && Reactions && Reactions.openPicker) {
        Reactions.openPicker(msgEl);
      }
    });
  },

  enterEditMode: function(seq, currentText){
    this.editingSeq = seq;
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
    
    // Only show typing indicator if it's from the OTHER user
    if(!user || user === this.myRole) {
      return;
    }
    
    // Clear existing timeout for this user
    if(WebSocketManager.typingTimeouts.has(user)){
      clearTimeout(WebSocketManager.typingTimeouts.get(user));
    }
    
    // Update typing state
    WebSocketManager.typingState.set(user, ts);
    
    // Set timeout to remove after 5 seconds
    var timeout = setTimeout(function(){
      WebSocketManager.typingState.delete(user);
      WebSocketManager.typingTimeouts.delete(user);
      this.renderTypingIndicator();
    }.bind(this), 5000);
    
    WebSocketManager.typingTimeouts.set(user, timeout);
    
    // Render the indicator
    this.renderTypingIndicator();
  },

  renderTypingIndicator: function(){
    if(!UI.els.typingIndicator) return;
    
    var now = Date.now();
    var activeUsers = [];
    
    // Clean up old entries and filter for opposite user only
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
        // Only show if it's the OTHER user
        activeUsers.push(user);
      }
    }
    
    if(activeUsers.length > 0){
      UI.els.typingIndicator.classList.add('show');
      // Auto-scroll to show typing indicator
      if(UI.els.chatContainer){
        UI.els.chatContainer.scrollTop = UI.els.chatContainer.scrollHeight;
      }
    } else {
      UI.els.typingIndicator.classList.remove('show');
    }
  }
};
