// ============================================================================
// APP.JS - Updated for Unified Actions Modal
// ============================================================================
// Changes:
// - Removed delete button event delegation (now in reactions.js modal)
// - Removed cancelReplyBtn listener (keeping it - still needed)
// ============================================================================

var App = {
  dropId: '',
  pollTimer: null,
  myClientId: null,
  myRole: null,

  init: function(){
    Storage.requireAuth();
    
    if(typeof CookieChecker !== 'undefined'){
      CookieChecker.init();
    }
    
    try {
      this.dropId = new URL(window.location.href).searchParams.get('drop') || 'default';
    } catch (e) {
      this.dropId = 'default';
    }

    this.myClientId = Storage.getClientId();
    this.myRole = Storage.getRole(this.dropId);
    Messages.myRole = this.myRole;

    UI.init();
    this.initGiphy();

    if(typeof Camera !== 'undefined'){
      Camera.init();
    }

    this.setupEventListeners();
    Reactions.setup();
    this.setupEmoji();
    this.startCountdownTimer();
    this.loadInitialData();
    this.startSessionChecks();
  },
  
  initGiphy: function(){
    var self = this;
    
    if(typeof GiphyPicker === 'undefined'){
      console.warn('GiphyPicker not loaded - GIPHY functionality disabled');
      return;
    }
    
    this.giphyPicker = new GiphyPicker('mrWcrFYs1lvhwbxxNNM3hmb9hUkFfbk4');
    console.log('✓ GIPHY picker initialized');
  },

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
      var data = await API.fetchDrop(this.dropId);
      Messages.applyDrop(data);
      
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
      
      if(typeof Streak !== 'undefined'){
        Streak.fetch(this.dropId).catch(function(e){
          console.log('Streak fetch failed (endpoint may not exist yet):', e);
        });
      }
      
      WebSocketManager.onUpdateCallback = function(data){ Messages.applyDrop(data); };
      WebSocketManager.onTypingCallback = function(data){ Messages.handleTyping(data); };
      WebSocketManager.onGameCallback = function(data){ Game.applyGame(data); };
      WebSocketManager.onGameListCallback = function(data){ Game.handleGameList(data); };
      WebSocketManager.onStreakCallback = function(data){ 
        if(typeof Streak !== 'undefined') Streak.handleWebSocketUpdate(data); 
      };
      
      WebSocketManager.connect(this.dropId, this.myRole);
      
      if(CONFIG.USE_POLL){
        this.startPolling();
      }
      
      UI.setLive('Connected');
      
    } catch(e){
      console.error('Failed to load initial data:', e);
      if(e.message === 'AUTH_REQUIRED'){
        // Already redirected
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

    // GIF button
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

    // Camera button
    var cameraBtn = document.getElementById('cameraBtn');
    if(cameraBtn && typeof Camera !== 'undefined'){
      cameraBtn.addEventListener('click', function(){
        Camera.show();
      });
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

    // Cancel reply
    var cancelReplyBtn = document.getElementById('cancelReplyBtn');
    if(cancelReplyBtn){
      cancelReplyBtn.addEventListener('click', function(e){
        e.preventDefault();
        Messages.exitReplyMode();
      });
    }

    // NOTE: Delete button handling is now in reactions.js (unified modal)
    // No need for event delegation here anymore

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
        Messages.exitReplyMode();
        if(self.giphyPicker && self.giphyPicker.modal && 
           self.giphyPicker.modal.style.display === 'flex'){
          self.giphyPicker.hide();
        }
        if(typeof Camera !== 'undefined' && Camera.isOpen){
          Camera.hide();
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
        var data = await API.fetchDrop(self.dropId);
        Messages.applyDrop(data);
        
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

  sendGifMessage: function(gifData){
    console.log('Sending GIF:', gifData);
    
    if(WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
      var sent = WebSocketManager.sendGIF(gifData, this.myRole, this.myClientId);
      if(sent){
        console.log('GIF sent via WebSocket');
        return;
      }
    }
    
    console.log('WebSocket not available, using HTTP fallback');
    
    var payload = {
      gifUrl: gifData.fullUrl,
      gifPreview: gifData.previewUrl,
      gifWidth: gifData.width,
      gifHeight: gifData.height,
      title: gifData.title,
      user: this.myRole
    };
    
    fetch(CONFIG.API_BASE_URL + '/chat/' + this.dropId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    })
    .then(function(res){
      if(!res.ok){
        throw new Error('HTTP ' + res.status);
      }
      return res.json();
    })
    .then(function(data){
      Messages.applyDrop(data);
      console.log('GIF message sent successfully via HTTP');
    }.bind(this))
    .catch(function(e){
      console.error('Failed to send GIF:', e);
      alert('Failed to send GIF. Please try again.');
    });
  },

  postMessage: async function(){
    if(!UI.els.reply) return;
    var text = (UI.els.reply.value||"").trim();
    if (!text) return;
    
    if(UI.els.postBtn && UI.els.postBtn.disabled) return;
    
    if(UI.els.postBtn) UI.els.postBtn.disabled=true;
    
    var replyToSeq = Messages.replyingToSeq;
    
    try{
      console.log('Sending message:', text, replyToSeq ? '(reply to ' + replyToSeq + ')' : '');
      
      if(WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
        var sent = WebSocketManager.sendMessage(text, this.myRole, this.myClientId, replyToSeq);
        if(sent){
          UI.els.reply.value='';
          UI.els.reply.style.height = 'auto';
          Messages.exitReplyMode();
          
          setTimeout(function(){
            if(UI.els.postBtn) UI.els.postBtn.disabled=false;
          }, 500);
          return;
        }
      }
      
      var res = await API.postMessage(this.dropId, text, Messages.currentVersion, this.myRole, this.myClientId, replyToSeq);
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
      Messages.exitReplyMode();
      
      setTimeout(async function(){ 
        var data = await API.fetchDrop(this.dropId);
        Messages.applyDrop(data);
        
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function(){ App.init(); });
} else {
  App.init();
}
