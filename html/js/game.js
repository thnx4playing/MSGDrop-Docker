// Tic-Tac-Toe Game - Updated for pk/sk database format
var Game = {
  state: {
    board: [[null,null,null],[null,null,null],[null,null,null]],
    starter: null,
    seed: null,
    nextStarter: null,
    currentTurn: null,
    gameOver: false,
    myMarker: null,
    theirMarker: null,
    winner: null,
    otherPlayerHasGameOpen: false
  },
  currentGameId: null,
  activeGames: [],

  init: function(seed, starter){
    this.state.seed = seed;
    this.state.starter = starter;
    this.state.currentTurn = starter;
    this.state.board = [[null,null,null],[null,null,null],[null,null,null]];
    this.state.gameOver = false;
    this.state.winner = null;
    
    // Determine markers - starter always gets X
    this.state.myMarker = (Messages.myRole === starter) ? 'X' : 'O';
    this.state.theirMarker = (Messages.myRole === starter) ? 'O' : 'X';
    
    console.log('[Game] Initialized - My role:', Messages.myRole, 'Starter:', starter, 'My marker:', this.state.myMarker);
    
    this.renderBoard();
    this.updateStatus();
  },

  renderBoard: function(){
    var cells = document.querySelectorAll('.game-cell');
    cells.forEach(function(cell){
      var r = parseInt(cell.getAttribute('data-row'), 10);
      var c = parseInt(cell.getAttribute('data-col'), 10);
      var val = this.state.board[r][c];
      
      cell.textContent = val || '';
      cell.classList.remove('filled', 'game-cell-x', 'game-cell-o', 'winning');
      
      if(val){
        cell.classList.add('filled');
        if(val === 'X') cell.classList.add('game-cell-x');
        if(val === 'O') cell.classList.add('game-cell-o');
      }
    }.bind(this));
  },

  updateStatus: function(){
    var statusEl = UI.els.gameStatus;
    if(!statusEl) return;
    
    statusEl.classList.remove('highlight', 'win');
    
    if(this.state.gameOver){
      var result = this.checkWinner();
      if(result && result.winner){
        var winnerRole = (result.winner === this.state.myMarker) ? 'You' : 'They';
        statusEl.innerHTML = '<span class="status-main">' + winnerRole + ' win!</span>';
        statusEl.classList.add('win');
        this.highlightWinningLine(result.line);
      } else {
        statusEl.innerHTML = '<span class="status-main">It\'s a draw!</span>';
        statusEl.classList.add('highlight');
      }
    } else {
      var turnRole = (this.state.currentTurn === Messages.myRole) ? 'Your' : 'Their';
      var marker = (this.state.currentTurn === Messages.myRole) ? this.state.myMarker : this.state.theirMarker;
      
      // Build main status
      var mainStatus = '<span class="status-main">' + turnRole + ' turn (' + marker + ')</span>';
      
      // Determine other player's name
      var otherPlayer = (Messages.myRole === 'E') ? 'M' : 'E';
      
      // Build player presence indicator with player name
      var presenceClass = this.state.otherPlayerHasGameOpen ? 'status-active' : 'status-away';
      var presenceIcon = this.state.otherPlayerHasGameOpen ? '●' : '○';
      var presenceText = otherPlayer + ' is ' + (this.state.otherPlayerHasGameOpen ? 'active' : 'away');
      
      var presenceStatus = '<span class="status-presence ' + presenceClass + '">' + 
                          '<span class="status-dot">' + presenceIcon + '</span> ' + presenceText + 
                          '</span>';
      
      statusEl.innerHTML = mainStatus + presenceStatus;
      
      if(this.state.currentTurn === Messages.myRole){
        statusEl.classList.add('highlight');
      }
    }
  },

  makeMove: function(r, c){
    console.log('[Game] makeMove called - r:', r, 'c:', c);
    console.log('[Game] Game state:', {
      gameOver: this.state.gameOver,
      currentTurn: this.state.currentTurn,
      myRole: Messages.myRole,
      cellValue: this.state.board[r][c]
    });
    
    if(this.state.gameOver){
      console.log('[Game] Cannot move - game is over');
      return;
    }
    
    if(this.state.currentTurn !== Messages.myRole){
      console.log('[Game] Cannot move - not your turn. Current turn:', this.state.currentTurn, 'Your role:', Messages.myRole);
      return;
    }
    
    if(this.state.board[r][c] !== null){
      console.log('[Game] Cannot move - cell already occupied');
      return;
    }
    
    if(!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1){
      console.error('[Game] WebSocket not connected');
      return;
    }
    
    // ✅ Calculate marker and next turn BEFORE sending
    var marker = this.state.myMarker;
    var nextTurn = (this.state.currentTurn === 'E') ? 'M' : 'E';
    
    console.log('[Game] Sending move with:', {
      r: r,
      c: c,
      by: Messages.myRole,
      marker: marker,
      nextTurn: nextTurn
    });
    
    try {
      WebSocketManager.ws.send(JSON.stringify({
        action: 'game',
        payload: {
          op: 'move',
          gameId: this.currentGameId,
          moveData: { 
            r: r, 
            c: c,
            by: Messages.myRole,
            marker: marker,      // ← MUST INCLUDE THIS
            nextTurn: nextTurn   // ← MUST INCLUDE THIS
          }
        }
      }));
      console.log('[Game] Move sent successfully');
    } catch(e){
      console.error('[Game] Failed to send move:', e);
    }
  },

  applyMove: function(data){
    var r = data.r;
    var c = data.c;
    var marker = data.marker;
    
    console.log('[Game] Applying move to board:', {
      r: r,
      c: c,
      marker: marker,
      nextTurn: data.nextTurn,
      beforeBoard: JSON.parse(JSON.stringify(this.state.board))
    });
    
    this.state.board[r][c] = marker;
    this.state.currentTurn = data.nextTurn;
    
    var result = this.checkWinner();
    if(result){
      this.state.gameOver = true;
      this.state.winner = result.winner;
    } else if(this.isBoardFull()){
      this.state.gameOver = true;
      this.state.winner = null;
    }
    
    console.log('[Game] After move - board:', JSON.parse(JSON.stringify(this.state.board)), 'currentTurn:', this.state.currentTurn, 'gameOver:', this.state.gameOver);
    
    this.renderBoard();
    this.updateStatus();
  },

  checkWinner: function(){
    var b = this.state.board;
    
    // Check rows
    for(var r = 0; r < 3; r++){
      if(b[r][0] && b[r][0] === b[r][1] && b[r][1] === b[r][2]){
        return { winner: b[r][0], line: [[r,0],[r,1],[r,2]] };
      }
    }
    
    // Check columns
    for(var c = 0; c < 3; c++){
      if(b[0][c] && b[0][c] === b[1][c] && b[1][c] === b[2][c]){
        return { winner: b[0][c], line: [[0,c],[1,c],[2,c]] };
      }
    }
    
    // Check diagonals
    if(b[0][0] && b[0][0] === b[1][1] && b[1][1] === b[2][2]){
      return { winner: b[0][0], line: [[0,0],[1,1],[2,2]] };
    }
    if(b[0][2] && b[0][2] === b[1][1] && b[1][1] === b[2][0]){
      return { winner: b[0][2], line: [[0,2],[1,1],[2,0]] };
    }
    
    return null;
  },

  isBoardFull: function(){
    for(var r = 0; r < 3; r++){
      for(var c = 0; c < 3; c++){
        if(this.state.board[r][c] === null) return false;
      }
    }
    return true;
  },

  highlightWinningLine: function(line){
    if(!line) return;
    var cells = document.querySelectorAll('.game-cell');
    line.forEach(function(pos){
      var r = pos[0];
      var c = pos[1];
      cells.forEach(function(cell){
        var cr = parseInt(cell.getAttribute('data-row'), 10);
        var cc = parseInt(cell.getAttribute('data-col'), 10);
        if(cr === r && cc === c){
          cell.classList.add('winning');
        }
      });
    });
  },

  handleGameList: function(data){
    if(!data || !data.games) return;
    this.activeGames = data.games.filter(function(g){ 
      return g.gameType === 't3' && !g.ended; 
    });
    this.updateActiveGamesList();
    this.updateGamesBadge();
  },

  updateGamesBadge: function(){
    var badge = document.getElementById('activeGamesBadge');
    if(!badge) return;
    
    var count = this.activeGames.length;
    
    if(count > 0){
      badge.textContent = count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  },

  updateActiveGamesList: function(){
    var activeList = UI.els.activeGamesList;
    var activeTitle = UI.els.activeGamesTitle;
    if(!activeList || !activeTitle) return;
    
    if(this.activeGames.length === 0){
      activeTitle.style.display = 'none';
      activeList.innerHTML = '';
      return;
    }
    
    activeTitle.style.display = 'block';
    activeList.innerHTML = '';
    
    this.activeGames.forEach(function(game){
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'game-item';
      item.innerHTML = '<span class="game-item-icon">🎮</span><span class="game-item-name">Tic-Tac-Toe</span>';
      item.addEventListener('click', function(){
        this.joinGame(game.gameId);
        UI.hideGamesMenu();
      }.bind(this));
      activeList.appendChild(item);
    }.bind(this));
  },

  startNewGame: function(){
    if(!Messages.myRole){ 
      alert('Please select your role first'); 
      return; 
    }
    
    if(!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1){
      alert('Not connected to server');
      return;
    }
    
    var seed = Date.now();
    
    try {
      WebSocketManager.ws.send(JSON.stringify({
        action: 'game',
        payload: {
          op: 'start',
          gameType: 't3',
          gameData: {
            starter: Messages.myRole,
            seed: seed
          }
        }
      }));
      console.log('[Game] Started new game with seed:', seed);
    } catch(e){
      console.error('[Game] Failed to start game:', e);
      alert('Failed to start game');
    }
    
    UI.hideGamesMenu();
  },

  joinGame: function(gameId){
    console.log('[Game] ========== JOIN GAME CALLED ==========');
    console.log('[Game] Attempting to join gameId:', gameId);
    console.log('[Game] Current game ID in memory:', this.currentGameId);
    console.log('[Game] Current board state:', JSON.parse(JSON.stringify(this.state.board)));
    
    if(!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1){
      console.error('[Game] Cannot join - WebSocket not connected');
      alert('Not connected to server');
      return;
    }
    
    // If this is the same game we're currently in AND we have game state, just reopen the modal
    var hasGameState = this.state.board.some(function(row){
      return row.some(function(cell){ return cell !== null; });
    });
    
    if(this.currentGameId === gameId && hasGameState){
      console.log('[Game] Reopening current game with existing state');
      UI.showGameModal();
      
      // Notify other player that we reopened the game
      try {
        WebSocketManager.ws.send(JSON.stringify({
          action: 'game',
          payload: {
            op: 'player_opened',
            gameId: gameId,
            player: Messages.myRole
          }
        }));
        console.log('[Game] Notified other player that you opened the game');
      } catch(e){
        console.error('[Game] Failed to notify open:', e);
      }
      
      return;
    }
    
    // Otherwise, join the game (will load state from server)
    console.log('[Game] Sending join request to server...');
    try {
      WebSocketManager.ws.send(JSON.stringify({
        action: 'game',
        payload: {
          op: 'join',
          gameId: gameId
        }
      }));
      console.log('[Game] Join request sent for game:', gameId);
    } catch(e){
      console.error('[Game] Failed to join game:', e);
      alert('Failed to join game');
    }
  },

  requestGameList: function(){
    if(!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1){
      console.warn('[Game] Cannot request game list - not connected');
      return;
    }
    
    try {
      WebSocketManager.ws.send(JSON.stringify({
        action: 'game',
        payload: {
          op: 'request_game_list'
        }
      }));
      console.log('[Game] Requested game list');
    } catch(e){
      console.warn('[Game] Failed to request game list:', e);
    }
  },

  applyGame: function(data){
    if(!data) return;
    
    console.log('[Game] Full game message received:', JSON.stringify(data, null, 2));
    console.log('[Game] Applying game operation:', data.op);
    
    if(data.op === 'started'){
      // Game started - initialize for ALL players (starter and others)
      this.currentGameId = data.gameId;
      var gameData = data.gameData || {};
      this.init(gameData.seed, gameData.starter);
      
      // Mark that other player has game open (they just started it)
      this.state.otherPlayerHasGameOpen = true;
      
      UI.showGameModal();
      console.log('[Game] Game started:', this.currentGameId);
      
      // Notify other players that we have the game open
      if(WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
        try {
          WebSocketManager.ws.send(JSON.stringify({
            action: 'game',
            payload: {
              op: 'player_opened',
              gameId: this.currentGameId,
              player: Messages.myRole
            }
          }));
          console.log('[Game] Notified that we opened the game');
        } catch(e){
          console.error('[Game] Failed to notify open:', e);
        }
      }
    } else if(data.op === 'joined'){
      console.log('[Game] ========== JOINED EVENT RECEIVED ==========');
      console.log('[Game] Full joined data:', JSON.stringify(data, null, 2));
      
      // Joined existing game
      this.currentGameId = data.gameId;
      var gameData = data.gameData || {};
      
      console.log('[Game] gameData.board:', gameData.board);
      console.log('[Game] gameData.currentTurn:', gameData.currentTurn);
      console.log('[Game] gameData.starter:', gameData.starter);
      
      // ✅ RESTORE STATE DIRECTLY - Don't call init() which resets everything
      this.state.seed = gameData.seed;
      this.state.starter = gameData.starter;
      
      // Restore board and turn (or use defaults if not in gameData yet)
      if(gameData.board && Array.isArray(gameData.board)){
        console.log('[Game] Restoring board from server:', gameData.board);
        this.state.board = gameData.board;
      } else {
        console.log('[Game] No board in gameData, using empty board');
        this.state.board = [[null,null,null],[null,null,null],[null,null,null]];
      }
      
      this.state.currentTurn = gameData.currentTurn || gameData.starter;
      this.state.gameOver = false;
      this.state.winner = null;
      
      // Determine markers - starter always gets X
      this.state.myMarker = (Messages.myRole === this.state.starter) ? 'X' : 'O';
      this.state.theirMarker = (Messages.myRole === this.state.starter) ? 'O' : 'X';
      
      console.log('[Game] Restored game state:');
      console.log('  - My role:', Messages.myRole);
      console.log('  - Starter:', this.state.starter);
      console.log('  - My marker:', this.state.myMarker);
      console.log('  - Board state:', JSON.parse(JSON.stringify(this.state.board)));
      console.log('  - Current turn:', this.state.currentTurn);
      
      // Mark that other player has game open (they're joining)
      this.state.otherPlayerHasGameOpen = true;
      
      // Check if game is over
      var result = this.checkWinner();
      if(result){
        this.state.gameOver = true;
        this.state.winner = result.winner;
        console.log('[Game] Game is over - winner:', result.winner);
      } else if(this.isBoardFull()){
        this.state.gameOver = true;
        this.state.winner = null;
        console.log('[Game] Game is over - draw');
      }
      
      // Render the restored state
      this.renderBoard();
      this.updateStatus();
      
      UI.showGameModal();
      console.log('[Game] Successfully joined and opened game:', this.currentGameId);
      
      // Notify other players that we have the game open
      if(WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
        try {
          WebSocketManager.ws.send(JSON.stringify({
            action: 'game',
            payload: {
              op: 'player_opened',
              gameId: this.currentGameId,
              player: Messages.myRole
            }
          }));
          console.log('[Game] Notified that we joined the game');
        } catch(e){
          console.error('[Game] Failed to notify open:', e);
        }
      }
    } else if(data.op === 'move'){
      // Move was made
      console.log('[Game] ======= MOVE RECEIVED =======');
      console.log('[Game] moveData:', data.moveData);
      console.log('[Game] gameData:', data.gameData);
      console.log('[Game] Current state:', {
        currentTurn: this.state.currentTurn,
        starter: this.state.starter,
        myRole: Messages.myRole
      });
      
      if(data.moveData){
        var moveData = data.moveData;
        
        // Determine who made the move - use moveData.by if available, otherwise use current turn
        var mover = moveData.by || this.state.currentTurn;
        var marker = (mover === this.state.starter) ? 'X' : 'O';
        
        // Get next turn from server or calculate it by swapping from the mover
        var nextTurn = data.gameData && data.gameData.currentTurn 
          ? data.gameData.currentTurn 
          : (mover === 'E' ? 'M' : 'E');
        
        console.log('[Game] Calculated move:', {
          mover: mover,
          marker: marker,
          nextTurn: nextTurn,
          position: [moveData.r, moveData.c]
        });
        
        this.applyMove({
          r: moveData.r,
          c: moveData.c,
          marker: marker,
          nextTurn: nextTurn
        });
      }
    } else if(data.op === 'player_closed'){
      // Other player closed their game window
      var player = data.player;
      var playerName = (player === 'E') ? 'E' : 'M';
      
      // Only process if it's the OTHER player, not ourselves
      if(player !== Messages.myRole){
        console.log('[Game] Player', playerName, 'closed their game window');
        this.state.otherPlayerHasGameOpen = false;
        this.updateStatus();
      }
    } else if(data.op === 'player_opened'){
      // Other player opened/rejoined the game window
      var player = data.player;
      var playerName = (player === 'E') ? 'E' : 'M';
      
      // Only process if it's the OTHER player, not ourselves
      if(player !== Messages.myRole){
        console.log('[Game] Player', playerName, 'opened the game window');
        this.state.otherPlayerHasGameOpen = true;
        this.updateStatus();
      }
    } else if(data.op === 'ended' || data.op === 'game_ended'){
      // Game ended - check if WE ended it or the other player did
      var endedByMe = data.endedBy === Messages.myRole;
      
      console.log('[Game] Game ended', endedByMe ? '(by you)' : '(by other player)');
      console.log('[Game] Result:', data.result);
      
      // Determine the message to display
      var result = data.result || {};
      var message = 'Game ended';
      
      if(result.winner){
        var winnerRole = result.winner === 'X' ? 
          (this.state.starter === 'E' ? 'E' : 'M') : 
          (this.state.starter === 'E' ? 'M' : 'E');
        
        if(winnerRole === Messages.myRole){
          message = '🎉 You won!';
        } else {
          message = '😔 You lost!';
        }
      } else if(result.reason === 'forfeit'){
        message = endedByMe ? 'You forfeited the game' : 'The other player forfeited';
      } else {
        message = "🤝 It's a draw!";
      }
      
      // ✅ Show message in the game status area instead of alert
      var statusEl = UI.els.gameStatus;
      if(statusEl){
        statusEl.innerHTML = '<span class="status-main game-end-message">' + message + '</span>';
        statusEl.classList.remove('highlight');
        statusEl.classList.add('win');
      }
      
      // ✅ Auto-close the game after 3 seconds
      setTimeout(function(){
        this.currentGameId = null;
        UI.hideGameModal();
        this.requestGameList();
      }.bind(this), 3000);
    }
  },

  endGame: function(){
    if(!this.currentGameId) return;
    
    if(!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1){
      console.warn('[Game] Cannot end game - not connected');
      this.currentGameId = null;
      UI.hideGameModal();
      return;
    }
    
    var result = { 
      winner: this.state.winner || null, 
      reason: this.state.gameOver && this.state.winner ? 'win' : 'forfeit' 
    };
    
    try {
      WebSocketManager.ws.send(JSON.stringify({
        action: 'game',
        payload: {
          op: 'end_game',
          gameId: this.currentGameId,
          result: result,
          endedBy: Messages.myRole
        }
      }));
      console.log('[Game] Ending game:', this.currentGameId);
    } catch(e){
      console.error('[Game] Failed to end game:', e);
    }
    
    this.currentGameId = null;
    UI.hideGameModal();
  },

  closeGame: function(){
    // Close the modal without ending the game (game continues in background)
    console.log('[Game] ========== CLOSE GAME CALLED ==========');
    console.log('[Game] Closing game modal (game continues in background)');
    console.log('[Game] Current game ID:', this.currentGameId);
    
    // Notify other player that you closed the game
    if(this.currentGameId && WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
      try {
        WebSocketManager.ws.send(JSON.stringify({
          action: 'game',
          payload: {
            op: 'player_closed',
            gameId: this.currentGameId,
            player: Messages.myRole
          }
        }));
        console.log('[Game] Notified other player that you closed the game');
      } catch(e){
        console.error('[Game] Failed to notify close:', e);
      }
    }
    
    // Don't clear currentGameId - we need it to resume the game
    UI.hideGameModal();
    // Request updated game list to show this game as active
    this.requestGameList();
  }
};
