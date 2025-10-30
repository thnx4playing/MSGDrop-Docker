// WebSocket manager with session-ok cookie authentication
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

  /**
   * Helper function to get cookie value by name
   * @param {string} name - Cookie name
   * @returns {string|null} - Cookie value or null if not found
   */
  getCookie: function(name) {
    var matches = document.cookie.match(new RegExp(
      '(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'
    ));
    return matches ? decodeURIComponent(matches[1]) : null;
  },

  /**
   * Connect to WebSocket with session token authentication
   * @param {string} dropId - Drop ID to connect to
   * @param {string} userLabel - User role/label (E or M)
   */
  connect: function(dropId, userLabel){
    if(!CONFIG.USE_WS) return;
    
    this.dropId = dropId;
    this.userLabel = userLabel;
    
    // ✅ CLEAN FIX: Read session-ok cookie instead of msgdrop_sess
    // session-ok contains the same signed token, but is NOT HttpOnly
    var sessionToken = this.getCookie('session-ok');
    
    if(!sessionToken) {
      console.error('[WS] No session token found - user not authenticated');
      
      // Redirect to unlock page with return URL
      var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = '/unlock/?next=' + returnUrl;
      return;
    }
    
    // Check if token is just "true" (old format)
    if(sessionToken === 'true') {
      console.error('[WS] session-ok has old format - need to re-login');
      var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = '/unlock/?next=' + returnUrl;
      return;
    }
    
    // ✅ Include session token in WebSocket URL
    var url = CONFIG.WS_URL 
      + '?sessionToken=' + encodeURIComponent(sessionToken)
      + '&dropId=' + encodeURIComponent(dropId) 
      + '&role=' + encodeURIComponent(userLabel);
    
    console.log('[WS] Connecting to:', CONFIG.WS_URL);
    console.log('[WS] Using session-ok token for authentication');
    
    try {
      this.ws = new WebSocket(url);
      
      this.ws.onopen = function(){
        console.log('[WS] Connection established');
        if(UI.setLive) UI.setLive('Connected (Live)');
        
        // Mark self as active immediately
        this.updatePresence(this.userLabel, true);
        
        // Send heartbeat every 30 seconds to maintain presence
        if(this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(function(){
          this.sendHeartbeat();
        }.bind(this), 30000);
        
        // Send initial heartbeat immediately
        this.sendHeartbeat();
        
        // Request other users to announce their presence immediately
        setTimeout(function(){
          this.requestPresence();
        }.bind(this), 100);
        
        // Request game list immediately on connect
        setTimeout(function(){
          WebSocketManager.requestGameList();
        }, 200);
      }.bind(this);
      
      this.ws.onmessage = function(ev){
        try {
          var msg = JSON.parse(ev.data || '{}');
          
          if(msg.type === 'update' && msg.data){
            if(this.onUpdateCallback) this.onUpdateCallback(msg.data);
          } else if(msg.type === 'typing' && msg.data){
            if(this.onTypingCallback) this.onTypingCallback(msg.data);
          } else if(msg.type === 'presence' && msg.data){
            this.handlePresence(msg.data);
          } else if(msg.type === 'presence_request' && msg.data){
            this.sendHeartbeat();
          } else if(msg.type === 'game' && msg.data){
            if(this.onGameCallback) this.onGameCallback(msg.data);
          } else if(msg.type === 'game_list' && msg.data){
            if(this.onGameListCallback) this.onGameListCallback(msg.data);
          } else if(msg.type === 'streak' && msg.data){
            if(this.onStreakCallback) this.onStreakCallback(msg.data);
          }
        } catch(e){
          console.error('[WS] Parse error:', e);
        }
      }.bind(this);
      
      this.ws.onclose = function(event){
        console.log('[WS] Connection closed:', event.code, event.reason);
        
        if(UI.setLive) UI.setLive('Connected (Polling)');
        
        // Clear heartbeat interval
        if(this.heartbeatInterval){
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        
        // ✅ Handle authentication failures
        // Code 1008 = Policy Violation (used by API Gateway for 401/403)
        // Code 1006 = Abnormal Closure (connection failed during handshake)
        if(event.code === 1008 || event.code === 1006){
          console.warn('[WS] Authentication may have failed - check session');
          
          // Check if session cookie still exists
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
        
        // Check if this might be an authentication issue
        var sessionToken = this.getCookie('session-ok');
        if(!sessionToken){
          console.error('[WS] Session token missing during connection error');
        } else if(sessionToken === 'true'){
          console.error('[WS] Session token has old format - need to re-login');
        }
      }.bind(this);
      
    } catch(e){
      console.error('[WS] Init failed:', e);
    }
  },

  /**
   * Send typing indicator to other users
   */
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

  /**
   * Send game action message
   */
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

  /**
   * Request list of active games
   */
  requestGameList: function(){
    this.sendGameAction({ op: 'request_game_list' });
  },

  /**
   * Start a new game
   */
  startGame: function(gameType, gameData){
    this.sendGameAction({ op: 'start', gameType: gameType, gameData: gameData });
  },

  /**
   * Join an existing game
   */
  joinGame: function(gameId){
    this.sendGameAction({ op: 'join_game', gameId: gameId });
  },

  /**
   * Send a game move
   */
  sendMove: function(gameId, moveData){
    this.sendGameAction({ op: 'move', gameId: gameId, moveData: moveData });
  },

  /**
   * End a game
   */
  endGame: function(gameId, result){
    this.sendGameAction({ op: 'end_game', gameId: gameId, result: result });
  },

  /**
   * Send heartbeat to maintain connection and presence
   */
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

  /**
   * Request presence information from all connected users
   */
  requestPresence: function(){
    if(!this.ws || this.ws.readyState !== 1) return;
    
    try {
      this.ws.send(JSON.stringify({
        action: 'presence_request',
        payload: {
          ts: Date.now()
        }
      }));
    } catch(e){
      console.error('[WS] Request presence failed:', e);
    }
  },

  /**
   * Handle incoming presence updates
   */
  handlePresence: function(data){
    var user = data.user;
    var state = data.state;
    var ts = data.ts || Date.now();
    
    if(!user) return;
    
    // Update presence state
    this.presenceState.set(user, { state: state, ts: ts });
    
    // Clear existing timeout
    if(this.presenceTimeouts.has(user)){
      clearTimeout(this.presenceTimeouts.get(user));
    }
    
    // Set timeout to mark as away after 60 seconds of no heartbeat
    var timeout = setTimeout(function(){
      this.updatePresence(user, false);
      this.presenceTimeouts.delete(user);
    }.bind(this), 60000);
    
    this.presenceTimeouts.set(user, timeout);
    
    // Update UI
    this.updatePresence(user, state === 'active');
  },

  /**
   * Update UI presence indicator
   */
  updatePresence: function(role, isActive){
    if(UI && UI.updatePresence){
      UI.updatePresence(role, isActive);
    }
  },

  /**
   * Disconnect WebSocket connection
   */
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
