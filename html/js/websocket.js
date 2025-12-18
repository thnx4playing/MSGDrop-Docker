// ============================================================================
// WEBSOCKET.JS - FIXED with Comprehensive Logging
// ============================================================================

var WebSocketManager = {
  ws: null,
  dropId: null,
  userLabel: null,
  lastTypingSent: 0,
  typingState: new Map(),
  typingTimeouts: new Map(),
  onUpdateCallback: null,
  onTypingCallback: null,
  onGameCallback: null,
  onGameListCallback: null,
  onStreakCallback: null,
  presenceState: new Map(),
  presenceTimeouts: new Map(),
  heartbeatInterval: null,

  getCookie: function(name) {
    var matches = document.cookie.match(new RegExp(
      '(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'
    ));
    return matches ? decodeURIComponent(matches[1]) : null;
  },

  connect: function(dropId, userLabel){
    if(!CONFIG.USE_WS) return;
    
    this.dropId = dropId;
    this.userLabel = userLabel;
    
    var sessionToken = this.getCookie('session-ok');
    
    if(!sessionToken) {
      console.error('[WS] No session token found - user not authenticated');
      var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = '/unlock/?next=' + returnUrl;
      return;
    }
    
    if(sessionToken === 'true') {
      console.error('[WS] session-ok has old format - need to re-login');
      var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = '/unlock/?next=' + returnUrl;
      return;
    }
    
    var url = CONFIG.WS_URL 
      + '?sessionToken=' + encodeURIComponent(sessionToken)
      + '&dropId=' + encodeURIComponent(dropId) 
      + '&user=' + encodeURIComponent(userLabel);
    
    console.log('[WS] Connecting to:', CONFIG.WS_URL, 'as user:', userLabel);
    
    try {
      this.ws = new WebSocket(url);
      
      this.ws.onopen = function(){
        console.log('[WS] ✓ Connection established');
        if(UI.setLive) UI.setLive('Connected (Live)');
        
        this.updatePresence(this.userLabel, true);
        
        if(this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(function(){
          this.sendHeartbeat();
        }.bind(this), 30000);
        
        this.sendHeartbeat();
        
        setTimeout(function(){
          this.requestPresence();
        }.bind(this), 500);
        
        setTimeout(function(){
          WebSocketManager.requestGameList();
        }, 200);
      }.bind(this);
      
      this.ws.onmessage = function(ev){
        try {
          var msg = JSON.parse(ev.data || '{}');
          
          // Special logging for receipt events
          if(msg.type === 'read_receipt') {
            console.log('[WS] *** READ_RECEIPT RECEIVED ***', JSON.stringify(msg.data));
          } else if(msg.type === 'delivery_receipt') {
            console.log('[WS] *** DELIVERY_RECEIPT RECEIVED ***', JSON.stringify(msg.data));
          } else {
            console.log('[WS] Message:', msg.type);
          }
          
          if(msg.type === 'update'){
            if(msg.data){
              console.log('[WS] Update with data, version:', msg.data.version);
              if(this.onUpdateCallback) this.onUpdateCallback(msg.data);
            } else {
              console.log('[WS] Update without data, fetching via HTTP...');
              if(this.onUpdateCallback && typeof API !== 'undefined'){
                API.fetchDrop(this.dropId).then(function(data){
                  if(this.onUpdateCallback) this.onUpdateCallback(data);
                }.bind(this)).catch(function(e){
                  console.error('[WS] Failed to fetch drop after update:', e);
                });
              }
            }
          } else if(msg.type === 'typing' && msg.payload){
            if(this.onTypingCallback) this.onTypingCallback(msg.payload);
          } else if(msg.type === 'presence' && msg.data){
            this.handlePresence(msg.data);
          } else if(msg.type === 'presence_request' && msg.data){
            this.sendHeartbeat();
          } else if(msg.type === 'game' && msg.payload){
            if(this.onGameCallback) this.onGameCallback(msg.payload);
          } else if(msg.type === 'game_list' && msg.data){
            if(this.onGameListCallback) this.onGameListCallback(msg.data);
          } else if(msg.type === 'streak' && msg.data){
            if(this.onStreakCallback) this.onStreakCallback(msg.data);
          } else if(msg.type === 'delivery_receipt' && msg.data){
            if(typeof Messages !== 'undefined' && Messages.handleDeliveryReceipt){
              Messages.handleDeliveryReceipt(msg.data);
            } else {
              console.error('[WS] Messages.handleDeliveryReceipt not found!');
            }
          } else if(msg.type === 'read_receipt' && msg.data){
            if(typeof Messages !== 'undefined' && Messages.handleReadReceipt){
              console.log('[WS] Calling Messages.handleReadReceipt...');
              Messages.handleReadReceipt(msg.data);
            } else {
              console.error('[WS] Messages.handleReadReceipt not found!');
            }
          } else if(msg.type === 'error'){
            console.error('[WS] Server error:', msg.message);
            alert('Error: ' + (msg.message || 'Unknown error'));
          }
        } catch(e){
          console.error('[WS] Parse error:', e);
        }
      }.bind(this);
      
      this.ws.onclose = function(event){
        console.log('[WS] Connection closed:', event.code, event.reason);
        
        if(UI.setLive) UI.setLive('Connected (Polling)');
        
        if(this.heartbeatInterval){
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        
        if(event.code === 1008 || event.code === 1006){
          console.warn('[WS] Authentication may have failed - check session');
          var sessionToken = this.getCookie('session-ok');
          if(!sessionToken || sessionToken === 'true'){
            console.error('[WS] Session lost or invalid - redirecting to login');
            var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = '/unlock/?next=' + returnUrl;
          }
        }
      }.bind(this);
      
      this.ws.onerror = function(e){
        console.error('[WS] Connection error:', e);
        var sessionToken = this.getCookie('session-ok');
        if(!sessionToken || sessionToken === 'true'){
          var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = '/unlock/?next=' + returnUrl;
        }
      }.bind(this);
      
    } catch(e){
      console.error('[WS] Init failed:', e);
    }
  },

  sendTyping: function(){
    if(!this.ws || this.ws.readyState !== 1) return;
    
    var now = Date.now();
    if(now - this.lastTypingSent < 1200) return;
    
    this.lastTypingSent = now;
    
    try {
      this.ws.send(JSON.stringify({
        action: 'typing',
        payload: { state: 'start', ts: now }
      }));
    } catch(e){
      console.error('[WS] Send typing failed:', e);
    }
  },

  sendReadReceipt: function(upToSeq, reader){
    if(!this.ws) {
      console.error('[WS] sendReadReceipt FAILED: ws is null');
      return false;
    }
    if(this.ws.readyState !== 1) {
      console.error('[WS] sendReadReceipt FAILED: ws.readyState=' + this.ws.readyState);
      return false;
    }
    
    try {
      var payload = {
        action: 'read',
        payload: {
          upToSeq: upToSeq,
          reader: reader
        }
      };
      console.log('[WS] *** SENDING READ RECEIPT ***', JSON.stringify(payload));
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch(e){
      console.error('[WS] sendReadReceipt FAILED:', e);
      return false;
    }
  },

  sendGameAction: function(payload){
    if(!this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify({
        action: 'game',
        type: 'game',
        payload: payload
      }));
    } catch(e){
      console.error('[WS] Failed to send game action:', e);
    }
  },

  requestGameList: function(){
    this.sendGameAction({ op: 'request_game_list' });
  },

  startGame: function(gameType, gameData){
    this.sendGameAction({ op: 'start', gameType: gameType, gameData: gameData });
  },

  joinGame: function(gameId){
    this.sendGameAction({ op: 'join_game', gameId: gameId });
  },

  sendMove: function(gameId, moveData){
    this.sendGameAction({ op: 'move', gameId: gameId, moveData: moveData });
  },

  endGame: function(gameId, result){
    this.sendGameAction({ op: 'end_game', gameId: gameId, result: result });
  },

  sendHeartbeat: function(){
    if(!this.ws || this.ws.readyState !== 1) return;
    
    try {
      this.ws.send(JSON.stringify({
        action: 'presence',
        payload: { 
          user: this.userLabel,
          state: 'active',
          ts: Date.now()
        }
      }));
    } catch(e){
      console.error('[WS] Send heartbeat failed:', e);
    }
  },

  sendMessage: function(text, user, clientId, replyToSeq){
    if(!this.ws || this.ws.readyState !== 1) return false;
    
    try {
      var payload = {
        text: text,
        user: user,
        clientId: clientId
      };
      
      if(replyToSeq){
        payload.replyToSeq = replyToSeq;
      }
      
      this.ws.send(JSON.stringify({
        action: 'chat',
        payload: payload
      }));
      return true;
    } catch(e){
      console.error('[WS] Send message failed:', e);
      return false;
    }
  },

  sendGIF: function(gifData, user, clientId){
    if(!this.ws || this.ws.readyState !== 1) return false;
    
    try {
      this.ws.send(JSON.stringify({
        action: 'gif',
        payload: {
          gifUrl: gifData.fullUrl,
          gifPreview: gifData.previewUrl,
          gifWidth: gifData.width,
          gifHeight: gifData.height,
          title: gifData.title,
          user: user,
          clientId: clientId
        }
      }));
      return true;
    } catch(e){
      console.error('[WS] Send GIF failed:', e);
      return false;
    }
  },

  requestPresence: function(){
    if(!this.ws || this.ws.readyState !== 1) return;
    
    try {
      this.ws.send(JSON.stringify({
        action: 'presence_request',
        payload: { ts: Date.now() }
      }));
    } catch(e){
      console.error('[WS] Request presence failed:', e);
    }
  },

  handlePresence: function(data){
    var user = data.user;
    var state = data.state;
    var ts = data.ts || Date.now();
    
    console.log('[WS] Presence:', user, state);
    
    if(!user) return;
    
    if(this.presenceTimeouts.has(user)){
      clearTimeout(this.presenceTimeouts.get(user));
      this.presenceTimeouts.delete(user);
    }
    
    this.presenceState.set(user, { state: state, ts: ts });
    this.updatePresence(user, state === 'active');
    
    if(state === 'active'){
      var timeout = setTimeout(function(){
        this.updatePresence(user, false);
        this.presenceTimeouts.delete(user);
      }.bind(this), 60000);
      this.presenceTimeouts.set(user, timeout);
    }
  },

  updatePresence: function(role, isActive){
    if(UI && UI.updatePresence){
      UI.updatePresence(role, isActive);
    }
  },

  disconnect: function(){
    if(this.heartbeatInterval){
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if(this.ws){
      try {
        this.ws.close();
      } catch(e){
        console.error('[WS] Error closing connection:', e);
      }
      this.ws = null;
    }
    
    console.log('[WS] Disconnected');
  }
};
