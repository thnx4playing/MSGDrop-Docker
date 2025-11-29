// Streak tracking - Simplified Design
var Streak = {
  currentStreak: 0,
  bothPostedToday: false,
  mPostedToday: false,
  ePostedToday: false,
  lastFetchTime: 0,

  // Storage key for this drop
  getStorageKey: function(){
    var dropId = 'default';
    try {
      dropId = new URL(window.location.href).searchParams.get('drop') || 'default';
    } catch(e){}
    return 'streak_' + dropId;
  },

  // Get last known state from localStorage
  getStoredState: function(){
    try {
      var stored = localStorage.getItem(this.getStorageKey());
      if(stored){
        return JSON.parse(stored);
      }
    } catch(e){}
    return null;
  },

  // Save current state to localStorage
  saveState: function(){
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify({
        streak: this.currentStreak,
        date: new Date().toISOString().split('T')[0]
      }));
    } catch(e){}
  },

  // Mark that we've shown the broken animation
  markBrokenAnimationShown: function(){
    try {
      var state = this.getStoredState() || {};
      state.brokenAnimationShown = true;
      localStorage.setItem(this.getStorageKey(), JSON.stringify(state));
    } catch(e){}
  },

  // Check if broken animation was already shown
  wasBrokenAnimationShown: function(){
    var state = this.getStoredState();
    return state && state.brokenAnimationShown === true;
  },

  // Clear broken animation flag (when streak increases)
  clearBrokenAnimationFlag: function(){
    try {
      var state = this.getStoredState() || {};
      delete state.brokenAnimationShown;
      localStorage.setItem(this.getStorageKey(), JSON.stringify(state));
    } catch(e){}
  },

  fetch: async function(dropId){
    try {
      var data = await API.fetchStreak(dropId);
      
      if(!data) {
        console.warn('[Streak] No data received');
        return;
      }
      
      this.handleUpdate(data, true);
      this.lastFetchTime = Date.now();
    } catch(e){
      console.error('[Streak] Fetch error:', e);
    }
  },

  handleWebSocketUpdate: function(data){
    console.log('[Streak] WebSocket update:', data);
    this.handleUpdate(data, false);
  },

  handleUpdate: function(data, isInitialLoad){
    var storedState = this.getStoredState();
    var oldStreak = storedState ? storedState.streak : 0;
    var serverStreak = data.streak || 0;
    
    console.log('[Streak] Update - Stored:', oldStreak, 'Server:', serverStreak, 'Initial:', isInitialLoad);
    
    // Update local state
    this.currentStreak = serverStreak;
    this.bothPostedToday = data.bothPostedToday || false;
    this.mPostedToday = data.mPostedToday || false;
    this.ePostedToday = data.ePostedToday || false;
    
    // Render first
    this.render();
    
    // Handle animations
    
    // Case 1: Server says streak broke (from API response)
    if(data.brokeStreak && data.previousStreak > 0){
      console.log('[Streak] Server indicated streak broke from', data.previousStreak);
      this.showBroken(data.previousStreak);
      this.saveState();
      return;
    }
    
    // Case 2: On initial load, compare stored vs server
    if(isInitialLoad && storedState){
      // Streak broke while we were away
      if(serverStreak === 0 && oldStreak > 0 && !this.wasBrokenAnimationShown()){
        console.log('[Streak] Detected broken streak on load:', oldStreak, '→ 0');
        this.showBroken(oldStreak);
        this.markBrokenAnimationShown();
        this.saveState();
        return;
      }
      
      // Streak increased while we were away (unlikely but possible)
      if(serverStreak > oldStreak && oldStreak > 0){
        console.log('[Streak] Streak increased while away:', oldStreak, '→', serverStreak);
        this.celebrate();
        this.clearBrokenAnimationFlag();
      }
    }
    
    // Case 3: Live update - streak increased
    if(!isInitialLoad && serverStreak > oldStreak){
      console.log('[Streak] Live streak increase:', oldStreak, '→', serverStreak);
      this.celebrate();
      this.clearBrokenAnimationFlag();
    }
    
    // Save current state
    this.saveState();
  },

  render: function(){
    var countEl = document.getElementById('streakCount');
    if(!countEl) return;
    
    countEl.textContent = this.currentStreak;
    
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    // Pulse effect when both posted today
    if(this.bothPostedToday && this.currentStreak > 0){
      display.classList.add('streak-complete');
    } else {
      display.classList.remove('streak-complete');
    }
  },

  celebrate: function(){
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    if(this.celebrateTimeout) clearTimeout(this.celebrateTimeout);
    
    display.classList.remove('streak-celebrate', 'streak-complete', 'streak-bounce', 'streak-broken');
    void display.offsetWidth; // Force reflow
    
    display.classList.add('streak-celebrate');
    console.log('[Streak] 🎉 Celebration animation!');
    
    this.celebrateTimeout = setTimeout(function(){
      display.classList.remove('streak-celebrate');
    }, 1000);
  },

  showBroken: function(lostStreak){
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    if(this.brokenTimeout) clearTimeout(this.brokenTimeout);
    
    display.classList.remove('streak-celebrate', 'streak-complete', 'streak-bounce', 'streak-broken');
    void display.offsetWidth; // Force reflow
    
    display.classList.add('streak-broken');
    console.log('[Streak] 💔 Broken animation! Lost', lostStreak, 'day streak');
    
    this.brokenTimeout = setTimeout(function(){
      display.classList.remove('streak-broken');
    }, 1500);
  },

  refresh: async function(dropId){
    var now = Date.now();
    if(now - this.lastFetchTime < 5000) {
      console.log('[Streak] Throttled refresh');
      return;
    }
    await this.fetch(dropId);
  }
};
