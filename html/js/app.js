// Main application
var App = {
  dropId: '',
  pollTimer: null,
  myClientId: null,
  myRole: null,

  init: function(){
    // Check if user is authenticated - if not, redirect to /unlock
    Storage.requireAuth();
    
    // Start periodic cookie expiration checks
    if(typeof CookieChecker !== 'undefined'){
      CookieChecker.init();
    }
    
    // Get drop ID from URL
    try {
      this.dropId = new URL(window.location.href).searchParams.get('drop') || 'default';
    } catch (e) {
      this.dropId = 'default';
    }

    // Initialize client ID and role
    this.myClientId = Storage.getClientId();
    this.myRole = Storage.getRole(this.dropId);
    Messages.myRole = this.myRole;

    // Initialize UI
    UI.init();

    // ✨ Initialize GIPHY picker BEFORE setting up event listeners
    this.initGiphy();

    // Setup all event listeners
    this.setupEventListeners();

    // Setup components
    Reactions.setup();
    this.setupEmoji();
    this.startCountdownTimer();

    // Load initial data and connect
    this.loadInitialData();

    // Periodic session validation (redirect if expired)
    this.startSessionChecks();
  },
  
  // ✨ NEW: Initialize GIPHY picker
  initGiphy: function(){
    var self = this;
    
    // Check if GiphyPicker is available
    if(typeof GiphyPicker === 'undefined'){
      console.warn('GiphyPicker not loaded - GIPHY functionality disabled');
      return;
    }
    
    // Initialize GIPHY picker with API key
    this.giphyPicker = new GiphyPicker('mrWcrFYs1lvhwbxxNNM3hmb9hUkFfbk4');
    
    console.log('✓ GIPHY picker initialized');
  },

  // Periodic session check via lightweight HEAD call
  startSessionChecks: function(){
    var self = this;
    setInterval(async function(){
      try{
        var url = CONFIG.API_BASE_URL.replace(/\/$/,'') + '/chat/' + encodeURIComponent(self.dropId);
        var res = await fetch(url, { method:'HEAD', credentials:'include' });
        if(res.status === 401 || res.status === 403){
          var nextUrl = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = '/unlock/?next=' + nextUrl;
        }
      }catch(e){ /* ignore network hiccups */ }
    }, 60000);
  },
  
  loadInitialData: async function(){
    try {
      // ⚡ OPTIMIZED: Fetch messages AND images in one call!
      var data = await API.fetchDrop(this.dropId);
      Messages.applyDrop(data);
      
      // ⚡ OPTIMIZED: Images already loaded from combined response
      if(data.images){
        Images.list = data.images.map(function(im){
          return {
            id: im.imageId,
            urls: { thumb: im.thumbUrl, original: im.originalUrl },
            uploadedAt: im.uploadedAt
          };
        });
        Images.render();
      }
      
      // Fetch streak (non-blocking - don't fail if endpoint doesn't exist)
      if(typeof Streak !== 'undefined'){
        Streak.fetch(this.dropId).catch(function(e){
          console.log('Streak fetch failed (endpoint may not exist yet):', e);
        });
      }
      
      // Setup WebSocket callbacks
      WebSocketManager.onUpdateCallback = function(data){ Messages.applyDrop(data); };
      WebSocketManager.onTypingCallback = function(data){ Messages.handleTyping(data); };
      WebSocketManager.onGameCallback = function(data){ Game.applyGame(data); };
      WebSocketManager.onGameListCallback = function(data){ Game.handleGameList(data); };
      WebSocketManager.onStreakCallback = function(data){ 
        if(typeof Streak !== 'undefined') Streak.handleWebSocketUpdate(data); 
      };
      
      // Connect WebSocket (no PIN needed - cookies sent automatically)
      WebSocketManager.connect(this.dropId, this.myRole);
      
      // Start polling as fallback
      if(CONFIG.USE_POLL){
        this.startPolling();
      }
      
      UI.setLive('Connected');
      
    } catch(e){
      console.error('Failed to load initial data:', e);
      if(e.message === 'AUTH_REQUIRED'){
        // Already redirected in API.fetchDrop
      } else {
        UI.setLive('Error loading data');
      }
    }
  },

  setupEventListeners: function(){
    var self = this;

    // File upload
    if(UI.els.fileInput) {
      UI.els.fileInput.addEventListener('change', function(e){
        var file=(e.target.files&&e.target.files[0]); 
        e.target.value='';
        if(!file) return;
        Images.upload(file);
      });
    }
    if(UI.els.uploadBtn) {
      UI.els.uploadBtn.addEventListener('click', function(){ 
        if(UI.els.fileInput) UI.els.fileInput.click(); 
      });
    }

    // ✨ NEW: GIF button
    var gifButton = document.getElementById('gif-button');
    console.log('Setting up GIF button:', gifButton, 'giphyPicker:', this.giphyPicker);
    if(gifButton && this.giphyPicker){
      gifButton.addEventListener('click', function(){
        console.log('GIF button clicked!');
        self.giphyPicker.show(function(gifData){
          console.log('GIF selected:', gifData);
          self.sendGifMessage(gifData);
        });
      });
      console.log('✓ GIF button event listener attached');
    } else if(gifButton){
      console.warn('GIF button found but GIPHY picker not initialized');
    } else {
      console.warn('GIF button not found in DOM');
    }

    // Library
    if(UI.els.libraryBtn) {
      UI.els.libraryBtn.addEventListener('click', async function(){
        await Images.fetch(self.dropId, true);
        UI.showThumbModal();
      });
    }
    if(UI.els.thumbCloseBtn) {
      UI.els.thumbCloseBtn.addEventListener('click', function(){ UI.hideThumbModal(); });
    }
    if(UI.els.thumbOverlay){
      UI.els.thumbOverlay.addEventListener('click', function(e){
        UI.hideThumbModal();
      });
    }

    // User role
    if(UI.els.userBtn) {
      UI.els.userBtn.addEventListener('click', function(){ UI.showUserRoleModal(); });
    }
    if(UI.els.roleE) {
      UI.els.roleE.addEventListener('click', function(){ self.selectUserRole('E'); });
    }
    if(UI.els.roleM) {
      UI.els.roleM.addEventListener('click', function(){ self.selectUserRole('M'); });
    }
    if(UI.els.userRoleModal){
      UI.els.userRoleModal.addEventListener('click', function(e){
        if(e.target === UI.els.userRoleModal){
          UI.hideUserRoleModal();
        }
      });
    }

    // Post message
    if(UI.els.postBtn) {
      UI.els.postBtn.addEventListener('click', function(e){
        e.preventDefault();
        if(Messages.editingSeq !== null){
          self.editMessage();
        } else {
          self.postMessage();
        }
      });
    }

    // Cancel edit
    if(UI.els.cancelEditBtn){
      UI.els.cancelEditBtn.addEventListener('click', function(e){
        e.preventDefault();
        Messages.exitEditMode();
      });
    }

    // Delete message
    if(UI.els.chatContainer){
      UI.els.chatContainer.addEventListener('click', async function(ev){
        var t = ev.target;
        if(t && t.classList && t.classList.contains('delete-btn')){
          var seq = parseInt(t.getAttribute('data-seq'), 10);
          if(isNaN(seq)) return;
          var ok = confirm('Delete this message?');
          if(!ok) return;
          await self.deleteMessage(seq);
        }
      });
    }

    // Lightbox
    if(UI.els.lbCloseCenter) {
      UI.els.lbCloseCenter.addEventListener('click', function(){ UI.hideLightbox(); });
    }
    if(UI.els.lightbox) {
      UI.els.lightbox.addEventListener('click',function(e){ 
        if (e.target===UI.els.lightbox) UI.hideLightbox(); 
      });
    }

    // Theme toggle
    if(UI.els.themeToggle) {
      UI.els.themeToggle.addEventListener('click', function(){ Storage.toggleTheme(); });
    }

    // Typing handler
    if(UI.els.reply){
      UI.els.reply.addEventListener('input', function(){
        WebSocketManager.sendTyping();
        // Auto-resize textarea
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 100) + 'px';
      });
    }

    // Games
    if(UI.els.gamesBtn){
      UI.els.gamesBtn.addEventListener('click', function(){
        WebSocketManager.requestGameList();
        UI.showGamesMenu();
      });
    }
    if(UI.els.ticTacToeBtn){
      UI.els.ticTacToeBtn.addEventListener('click', function(){
        Game.startNewGame();
      });
    }
    // Close button for games popover
    var gamesPopoverClose = document.getElementById('gamesPopoverClose');
    if(gamesPopoverClose){
      gamesPopoverClose.addEventListener('click', function(){
        UI.hideGamesMenu();
      });
    }
    if(UI.els.gameCloseBtn){
      UI.els.gameCloseBtn.addEventListener('click', function(){
        Game.closeGame();
      });
    }
    // Wire up the second close button (the "Close" button at bottom)
    var gameCloseBtn2 = document.getElementById('gameCloseBtn2');
    if(gameCloseBtn2){
      gameCloseBtn2.addEventListener('click', function(){
        Game.closeGame();
      });
    }
    if(UI.els.gameEndBtn){
      UI.els.gameEndBtn.addEventListener('click', function(){
        Game.endGame();
      });
    }
    if(UI.els.gamesPopover){
      UI.els.gamesPopover.addEventListener('click', function(e){
        if(e.target === UI.els.gamesPopover) UI.hideGamesMenu();
      });
    }

    // Game board clicks
    var gameCells = document.querySelectorAll('.game-cell');
    gameCells.forEach(function(cell){
      cell.addEventListener('click', function(){
        var r = parseInt(this.getAttribute('data-row'), 10);
        var c = parseInt(this.getAttribute('data-col'), 10);
        if(!isNaN(r) && !isNaN(c)) Game.makeMove(r, c);
      });
    });

    // Escape key
    window.addEventListener('keydown',function(e){ 
      if (e.key==='Escape'){
        UI.hideGamesMenu();
        UI.hideLightbox();
        UI.hideThumbModal();
        Reactions.closePicker();
        UI.hideUserRoleModal();
        // ✨ NEW: Close GIPHY modal on ESC
        if(self.giphyPicker && self.giphyPicker.modal && 
           self.giphyPicker.modal.style.display === 'flex'){
          self.giphyPicker.hide();
        }
      }
    });
  },

  setupEmoji: function(){
    if(!UI.els.emojiBtn || !UI.els.emojiPopover || !UI.els.emojiGrid) return;
    
    UI.els.emojiGrid.innerHTML = '';
    
    var curated = ["😀","😂","🥲","🙂","🙄","🤔","🤢","🤤","😣","😫","😴","🥶","😈","💩","🤡"];
    var frag = document.createDocumentFragment();
    curated.forEach(function(emoji){
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = emoji;
      b.className = 'emoji-btn';
      b.setAttribute('aria-label', emoji);
      b.addEventListener('click', function(){
        UI.insertAtCursor(UI.els.reply, emoji);
        UI.els.emojiPopover.style.display = 'none';
      });
      frag.appendChild(b);
    });
    UI.els.emojiGrid.appendChild(frag);
    
    UI.els.emojiBtn.onclick = function(){
      UI.els.emojiPopover.style.display = (UI.els.emojiPopover.style.display === 'block' ? 'none' : 'block');
    };
    
    document.addEventListener('click', function(ev){
      if(!UI.els.emojiPopover || !UI.els.emojiBtn) return;
      if(ev.target === UI.els.emojiBtn || UI.els.emojiBtn.contains(ev.target) || UI.els.emojiPopover.contains(ev.target)) return;
      UI.els.emojiPopover.style.display = 'none';
    });
  },

  startPolling: function(){
    if(!CONFIG.USE_POLL) return;
    if(this.pollTimer) clearInterval(this.pollTimer);
    var self = this;
    this.pollTimer=setInterval(async function(){ 
      try{
        // ⚡ OPTIMIZED: Get both messages and images in one call
        var data = await API.fetchDrop(self.dropId);
        Messages.applyDrop(data);
        
        // ⚡ OPTIMIZED: Update images from combined response
        if(data.images){
          Images.list = data.images.map(function(im){
            return {
              id: im.imageId,
              urls: { thumb: im.thumbUrl, original: im.originalUrl },
              uploadedAt: im.uploadedAt
            };
          });
          Images.render();
        }
      }catch(e){
        console.error('Poll error:', e);
      }
    }, CONFIG.POLL_MS);
  },

  startCountdownTimer: function(){
    if(!UI.els.composeTimer) return;
    var seconds = 298;
    if(UI.els.composeTimer) UI.els.composeTimer.textContent = seconds;
    
    setInterval(function(){
      seconds--;
      if(seconds < 0) seconds = 0;
      if(UI.els.composeTimer) UI.els.composeTimer.textContent = seconds;
      
      if(UI.els.composeTimer){
        if(seconds < 10){
          UI.els.composeTimer.classList.add('warning');
        } else {
          UI.els.composeTimer.classList.remove('warning');
        }
      }
    }, 1000);
  },

  selectUserRole: function(role){
    Storage.setRole(this.dropId, role);
    this.myRole = role;
    Messages.myRole = role;
    this.updateRoleSelection();
    UI.hideUserRoleModal();
    
    // Reconnect WebSocket with new role if already connected
    if(WebSocketManager.ws){
      WebSocketManager.ws.close();
      setTimeout(function(){
        WebSocketManager.connect(this.dropId, this.myRole);
      }.bind(this), 100);
    }
    
    Messages.render();
  },

  updateRoleSelection: function(){
    if(!UI.els.roleE || !UI.els.roleM) return;
    
    UI.els.roleE.classList.remove('selected');
    UI.els.roleM.classList.remove('selected');
    
    if(this.myRole === 'E'){
      UI.els.roleE.classList.add('selected');
    } else if(this.myRole === 'M'){
      UI.els.roleM.classList.add('selected');
    }
  },

  // ✨ NEW: Send GIF message
  sendGifMessage: async function(gifData){
    if(!gifData || !gifData.fullUrl){
      console.error('Invalid GIF data:', gifData);
      return;
    }
    
    console.log('Sending GIF:', gifData);
    
    // Try WebSocket first (faster, real-time)
    if(WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
      var sent = WebSocketManager.sendGIF(gifData, this.myRole, this.myClientId);
      if(sent){
        // GIF sent via WebSocket - response will come via onmessage handler
        // Update streak (non-blocking)
        if(typeof Streak !== 'undefined'){
          Streak.checkAndUpdate(this.dropId);
        }
        return;
      }
    }
    
    // Fallback to HTTP POST if WebSocket unavailable
    var payload = {
      text: '[GIF: ' + (gifData.title || 'GIF') + ']',
      prevVersion: Messages.currentVersion,
      user: this.myRole,
      clientId: this.myClientId,
      // GIF-specific fields
      gifUrl: gifData.fullUrl,
      gifPreview: gifData.previewUrl,
      gifWidth: gifData.width,
      gifHeight: gifData.height,
      messageType: 'gif'
    };
    
    try {
      var res = await fetch(CONFIG.API_BASE_URL + '/chat/' + this.dropId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      
      if(!res.ok){
        if(res.status === 409){
          // Conflict - refresh and retry
          var data = await API.fetchDrop(this.dropId);
          Messages.applyDrop(data);
          alert('Chat was updated. Please try sending the GIF again.');
        } else {
          throw new Error('HTTP ' + res.status);
        }
        return;
      }
      
      var data = await res.json();
      Messages.applyDrop(data);
      
      console.log('GIF message sent successfully');
      
      // Update streak (non-blocking)
      if(typeof Streak !== 'undefined'){
        Streak.checkAndUpdate(this.dropId);
      }
      
    } catch(e){
      console.error('Failed to send GIF:', e);
      alert('Failed to send GIF. Please try again.');
    }
  },

  postMessage: async function(){
    if(!UI.els.reply) return;
    var text = (UI.els.reply.value||"").trim();
    if (!text) return;
    
    if(UI.els.postBtn && UI.els.postBtn.disabled) return;
    
    if(UI.els.postBtn) UI.els.postBtn.disabled=true;
    
    try{
      console.log('Sending message:', text);
      
      // Try WebSocket first (faster, real-time)
      if(WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
        var sent = WebSocketManager.sendMessage(text, this.myRole, this.myClientId);
        if(sent){
          // Message sent via WebSocket - response will come via onmessage handler
          // Clear input immediately for better UX
          UI.els.reply.value='';
          UI.els.reply.style.height = 'auto';
          
          // Check and update streak after posting (non-blocking)
          if(typeof Streak !== 'undefined'){
            Streak.checkAndUpdate(this.dropId);
          }
          
          // Re-enable button
          setTimeout(function(){
            if(UI.els.postBtn) UI.els.postBtn.disabled=false;
          }, 500);
          return;
        }
      }
      
      // Fallback to HTTP POST if WebSocket unavailable
      var res = await API.postMessage(this.dropId, text, Messages.currentVersion, this.myRole, this.myClientId);
      if (!res.ok){ 
        if(res.status === 409){
          var data = await API.fetchDrop(this.dropId);
          Messages.applyDrop(data);
          alert('Message was updated by someone else. Please try again.');
        }
        return; 
      }
      var data = await res.json();
      Messages.applyDrop(data);
      
      UI.els.reply.value='';
      UI.els.reply.style.height = 'auto';
      
      // Check and update streak after posting (non-blocking)
      if(typeof Streak !== 'undefined'){
        Streak.checkAndUpdate(this.dropId);
      }
      
      // ⚡ OPTIMIZED: Single fetch gets both messages and images
      setTimeout(async function(){ 
        var data = await API.fetchDrop(this.dropId);
        Messages.applyDrop(data);
        
        // Update images from combined response
        if(data.images){
          Images.list = data.images.map(function(im){
            return {
              id: im.imageId,
              urls: { thumb: im.thumbUrl, original: im.originalUrl },
              uploadedAt: im.uploadedAt
            };
          });
          Images.render();
        }
      }.bind(this), 100);
      
    }catch(e){ 
      console.error('Post error:', e);
    }
    finally{ 
      setTimeout(function(){
        if(UI.els.postBtn) UI.els.postBtn.disabled=false;
      }, 500);
    }
  },

  editMessage: async function(){
    if(!UI.els.reply || Messages.editingSeq === null) return;
    var text = (UI.els.reply.value||"").trim();
    if (!text) return;
    
    if(UI.els.postBtn && UI.els.postBtn.disabled) return;
    
    if(UI.els.postBtn) UI.els.postBtn.disabled=true;
    
    try{
      var res = await API.editMessage(this.dropId, Messages.editingSeq, text);
      
      if (!res.ok){ 
        var errorData;
        try {
          errorData = await res.json();
        } catch(e) {}
        
        if(res.status === 404){
          alert('Message not found. It may have been replaced.');
          var data = await API.fetchDrop(this.dropId);
          Messages.applyDrop(data);
        } else {
          alert('Failed to edit message: ' + res.status);
        }
        return; 
      }
      
      var data = await res.json();
      Messages.applyDrop(data);
      Messages.exitEditMode();
    }catch(e){ 
      console.error('Edit error:', e);
      alert('Failed to edit message: ' + e.message);
    }
    finally{ 
      setTimeout(function(){
        if(UI.els.postBtn) UI.els.postBtn.disabled=false;
      }, 500);
    }
  },

  deleteMessage: async function(seq){
    try{
      var res = await API.deleteMessage(this.dropId, seq);
      if(!res.ok){
        if(res.status === 404){ 
          alert('That message was not found (it may already be gone).'); 
        } else { 
          alert('Delete failed: HTTP ' + res.status); 
        }
        var data = await API.fetchDrop(this.dropId);
        Messages.applyDrop(data);
        return;
      }
      var data = await res.json();
      Messages.applyDrop(data);
    }catch(e){
      console.error('Delete error:', e);
      alert('Network error while deleting.');
    }
  }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function(){ App.init(); });
} else {
  App.init();
}
