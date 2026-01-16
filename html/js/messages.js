// Path: html/js/messages.js
// Uploaded: 2026-01-16T01:07:13.472Z

// ============================================================================
// MESSAGES.JS - Production Version with Read Receipts
// ============================================================================

var Messages = {
  history: [],
  currentVersion: 0,
  editingSeq: null,
  replyingToSeq: null,
  replyingToMessage: null,
  myRole: null,
  lastReadReceiptSent: 0,
  lastReadReceiptSeq: 0,

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
      return timeStr;
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

  getReceiptStatus: function(msg){
    if(!this.myRole || msg.user !== this.myRole) return null;
    
    if(msg.readAt){
      return 'read';
    } else if(msg.deliveredAt){
      return 'delivered';
    } else {
      return 'sent';
    }
  },

  findMessageBySeq: function(seq){
    return this.history.find(function(m){ return m.seq === seq; });
  },

  enterReplyMode: function(seq){
    var msg = this.findMessageBySeq(seq);
    if(!msg) return;
    
    this.replyingToSeq = seq;
    this.replyingToMessage = msg;
    
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
    
    if(UI.els.reply) UI.els.reply.focus();
  },

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
          replyToSeq: msg.replyToSeq || null,
          deliveredAt: msg.deliveredAt || null,
          readAt: msg.readAt || null
        };
      });
      this.render();
      this.sendReadReceipts();
    }
    
    if(UI.setLive) UI.setLive('Connected');
  },

  sendReadReceipts: function(){
    if(!this.myRole) return;
    
    var maxUnreadSeq = 0;
    
    this.history.forEach(function(msg){
      if(msg.user && msg.user !== this.myRole && !msg.readAt && msg.seq > maxUnreadSeq){
        maxUnreadSeq = msg.seq;
      }
    }.bind(this));
    
    var now = Date.now();
    if(maxUnreadSeq === this.lastReadReceiptSeq && now - this.lastReadReceiptSent < 1000) {
      return;
    }
    
    if(maxUnreadSeq > 0 && WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
      this.lastReadReceiptSent = now;
      this.lastReadReceiptSeq = maxUnreadSeq;
      WebSocketManager.sendReadReceipt(maxUnreadSeq, this.myRole);
    }
  },

  handleDeliveryReceipt: function(data){
    var seq = data.seq;
    var deliveredAt = data.deliveredAt;
    
    var msg = this.findMessageBySeq(seq);
    if(msg){
      msg.deliveredAt = deliveredAt;
      this.render();
    }
  },

  handleReadReceipt: function(data){
    var upToSeq = data.upToSeq;
    var reader = data.reader;
    var readAt = data.readAt;
    
    if(!upToSeq || !reader || !readAt) return;
    
    var updated = false;
    
    this.history.forEach(function(msg){
      if(msg.seq <= upToSeq && msg.user && msg.user !== reader && !msg.readAt){
        msg.readAt = readAt;
        updated = true;
      }
    });
    
    if(updated) {
      this.render();
    }
  },

  render: function(){
    if(!UI.els.chatContainer) return;
    
    var wasAtBottom = UI.els.chatContainer.scrollHeight - UI.els.chatContainer.scrollTop <= UI.els.chatContainer.clientHeight + 50;
    
    var existingMessages = UI.els.chatContainer.querySelectorAll('.message-group');
    existingMessages.forEach(function(el){ el.remove(); });
    
    this.history.forEach(function(msg, index){
      if(!msg || !msg.message) return;
      
      var bubbleClass = this.bubbleClassFor(msg);
      var isOwnMessage = bubbleClass === 'right';
      
      var group = document.createElement('div');
      group.className = 'message-group ' + bubbleClass;
      group.setAttribute('data-seq', msg.seq || msg.version);
      
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
      
      if(msg.messageType === 'image' && msg.imageUrl){
        bubble.classList.add('image-message');
        
        var imageContainer = document.createElement('div');
        imageContainer.className = 'image-container';
        
        var img = document.createElement('img');
        img.src = msg.imageThumb || msg.imageUrl;
        img.alt = msg.message || 'Image';
        img.className = 'image-thumbnail';
        img.loading = 'lazy';
        
        // Store the full URL for lightbox
        var originalUrl = msg.imageUrl || msg.imageThumb || '';
        
        // Scroll to bottom when image loads (fixes partial visibility)
        img.addEventListener('load', function(){
          if(UI.els.chatContainer){
            var atBottom = UI.els.chatContainer.scrollHeight - UI.els.chatContainer.scrollTop <= UI.els.chatContainer.clientHeight + 100;
            if(atBottom){
              UI.els.chatContainer.scrollTop = UI.els.chatContainer.scrollHeight;
            }
          }
        });
        
        // ============================================================
        // IMAGE TAP BEHAVIOR:
        // - Single tap = Open fullscreen lightbox
        // - Long press = Open actions modal (reactions, reply, delete)
        // ============================================================
        
        (function(imgEl, fullUrl, bubbleEl){
          var longPressTimer = null;
          var longPressTriggered = false;
          var touchHandled = false; // Track if touch already handled this interaction
          var touchStartX = 0;
          var touchStartY = 0;
          var LONG_PRESS_DURATION = 500; // ms
          var MOVE_THRESHOLD = 10; // px - cancel if finger moves too much
          
          function openLightbox(){
            if(fullUrl && UI.openLightbox){
              UI.openLightbox(fullUrl + '?t=' + Date.now());
            }
          }
          
          function openActionsModal(){
            var group = bubbleEl.closest('.message-group');
            if(group && Reactions && Reactions.openPicker){
              Reactions.openPicker(bubbleEl);
            }
          }
          
          function clearLongPress(){
            if(longPressTimer){
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
          }
          
          // Touch events for mobile
          imgEl.addEventListener('touchstart', function(e){
            longPressTriggered = false;
            touchHandled = false;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            
            longPressTimer = setTimeout(function(){
              longPressTriggered = true;
              touchHandled = true;
              // Haptic feedback if available
              if(navigator.vibrate){
                navigator.vibrate(50);
              }
              openActionsModal();
            }, LONG_PRESS_DURATION);
          }, { passive: true });
          
          imgEl.addEventListener('touchmove', function(e){
            // Cancel long press if finger moves too much
            var dx = Math.abs(e.touches[0].clientX - touchStartX);
            var dy = Math.abs(e.touches[0].clientY - touchStartY);
            if(dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD){
              clearLongPress();
            }
          }, { passive: true });
          
          imgEl.addEventListener('touchend', function(e){
            clearLongPress();
            
            // If long press wasn't triggered, treat as tap = open lightbox
            if(!longPressTriggered){
              touchHandled = true;
              e.preventDefault();
              e.stopPropagation();
              openLightbox();
            }
            longPressTriggered = false;
          });
          
          imgEl.addEventListener('touchcancel', function(){
            clearLongPress();
            longPressTriggered = false;
            touchHandled = false;
          });
          
          // Mouse events for desktop (and synthetic click after touch)
          imgEl.addEventListener('click', function(e){
            e.stopPropagation();
            e.preventDefault();
            
            // Skip if this click follows a touch we already handled
            if(touchHandled){
              touchHandled = false;
              return;
            }
            
            // On desktop, single click opens lightbox
            openLightbox();
          });
          
          // Right-click on desktop opens actions modal
          imgEl.addEventListener('contextmenu', function(e){
            e.preventDefault();
            e.stopPropagation();
            openActionsModal();
          });
          
        })(img, originalUrl, bubble);
        
        imageContainer.appendChild(img);
        bubble.appendChild(imageContainer);
        
        if(msg.message && msg.message !== '[Image]'){
          var caption = document.createElement('div');
          caption.className = 'image-caption';
          caption.textContent = msg.message;
          bubble.appendChild(caption);
        }
      }
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
        
        // Store the full URL for lightbox
        var gifFullUrl = msg.gifUrl;
        
        // ============================================================
        // GIF TAP BEHAVIOR (same as images):
        // - Single tap = Open fullscreen lightbox
        // - Long press = Open actions modal
        // ============================================================
        
        (function(imgEl, fullUrl, bubbleEl){
          var longPressTimer = null;
          var longPressTriggered = false;
          var touchHandled = false; // Track if touch already handled this interaction
          var touchStartX = 0;
          var touchStartY = 0;
          var LONG_PRESS_DURATION = 500;
          var MOVE_THRESHOLD = 10;
          
          function openLightbox(){
            if(fullUrl && UI.openLightbox){
              UI.openLightbox(fullUrl + '?t=' + Date.now());
            }
          }
          
          function openActionsModal(){
            var group = bubbleEl.closest('.message-group');
            if(group && Reactions && Reactions.openPicker){
              Reactions.openPicker(bubbleEl);
            }
          }
          
          function clearLongPress(){
            if(longPressTimer){
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
          }
          
          imgEl.addEventListener('touchstart', function(e){
            longPressTriggered = false;
            touchHandled = false;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            
            longPressTimer = setTimeout(function(){
              longPressTriggered = true;
              touchHandled = true;
              if(navigator.vibrate){
                navigator.vibrate(50);
              }
              openActionsModal();
            }, LONG_PRESS_DURATION);
          }, { passive: true });
          
          imgEl.addEventListener('touchmove', function(e){
            var dx = Math.abs(e.touches[0].clientX - touchStartX);
            var dy = Math.abs(e.touches[0].clientY - touchStartY);
            if(dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD){
              clearLongPress();
            }
          }, { passive: true });
          
          imgEl.addEventListener('touchend', function(e){
            clearLongPress();
            if(!longPressTriggered){
              touchHandled = true;
              e.preventDefault();
              e.stopPropagation();
              openLightbox();
            }
            longPressTriggered = false;
          });
          
          imgEl.addEventListener('touchcancel', function(){
            clearLongPress();
            longPressTriggered = false;
            touchHandled = false;
          });
          
          imgEl.addEventListener('click', function(e){
            e.stopPropagation();
            e.preventDefault();
            
            // Skip if this click follows a touch we already handled
            if(touchHandled){
              touchHandled = false;
              return;
            }
            
            openLightbox();
          });
          
          imgEl.addEventListener('contextmenu', function(e){
            e.preventDefault();
            e.stopPropagation();
            openActionsModal();
          });
          
        })(img, gifFullUrl, bubble);
        
        gifContainer.appendChild(img);
        bubble.appendChild(gifContainer);
        
        if(msg.message && msg.message !== '[GIF]' && !msg.message.startsWith('[GIF:')){
          var caption = document.createElement('div');
          caption.className = 'gif-caption';
          caption.textContent = msg.message;
          bubble.appendChild(caption);
        }
      } else {
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
      
      group.appendChild(meta);
      
      if(UI.els.typingIndicator){
        UI.els.chatContainer.insertBefore(group, UI.els.typingIndicator);
      } else {
        UI.els.chatContainer.appendChild(group);
      }
      
      this.attachMessageClick(bubble);
    }.bind(this));
    
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
      if(e.target.closest('.msg-reactions')) return;
      if(e.target.closest('.reply-bubble')) return;
      
      // Images and GIFs have their own click handlers that open lightbox
      // Check if click was on the image/gif OR within the image/gif container
      if(e.target.classList.contains('image-thumbnail') || e.target.classList.contains('gif-image')){
        return; // Let the image's own handler deal with it
      }
      if(e.target.closest('.image-container') || e.target.closest('.gif-container')){
        return; // Click was in image area - don't open modal
      }
      
      var group = msgEl.closest('.message-group');
      if(group && Reactions && Reactions.openPicker) {
        Reactions.openPicker(msgEl);
      }
    });
  },

  enterEditMode: function(seq, currentText){
    this.editingSeq = seq;
    this.exitReplyMode();
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
    
    if(!user || user === this.myRole) return;
    
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
