// Streak tracking - redesigned for reliability
var Streak = {
  currentStreak: 0,
  bothPostedToday: false,
  mPostedToday: false,
  ePostedToday: false,
  lastFetchTime: 0,
  initialized: false,  // NEW: Track if we've loaded initial data
  celebrateTimeout: null,  // NEW: Track animation timeout

  fetch: async function(dropId){
    try {
      var data = await API.fetchStreak(dropId);
      
      if(!data) {
        console.warn('[Streak] No data received');
        return;
      }
      
      // Mark as initialized after first fetch
      this.updateData(data, false);  // false = don't animate on initial load
      this.initialized = true;
      this.lastFetchTime = Date.now();
    } catch(e){
      console.error('[Streak] Fetch error:', e);
    }
  },

  updateData: function(data, allowAnimation){
    // allowAnimation defaults to true for WebSocket updates
    if(allowAnimation === undefined) allowAnimation = true;
    
    var oldStreak = this.currentStreak;
    
    this.currentStreak = data.streak || 0;
    this.bothPostedToday = data.bothPostedToday || false;
    this.mPostedToday = data.mPostedToday || false;
    this.ePostedToday = data.ePostedToday || false;
    
    this.render();
    
    // Show celebration if streak increased AND we're initialized AND animation allowed
    if(this.currentStreak > oldStreak && this.initialized && allowAnimation){
      console.log('[Streak] Celebrating increase from', oldStreak, 'to', this.currentStreak);
      this.celebrate();
    }
  },

  render: function(){
    var countEl = document.getElementById('streakCount');
    if(!countEl) return;
    
    countEl.textContent = this.currentStreak;
    
    // Update visual indicator
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    // Add subtle pulse when both posted today
    if(this.bothPostedToday && this.currentStreak > 0){
      display.classList.add('streak-complete');
    } else {
      display.classList.remove('streak-complete');
    }
  },

  handleWebSocketUpdate: function(data){
    console.log('[Streak] WebSocket update:', data);
    // WebSocket updates should animate (allowAnimation = true)
    this.updateData(data, true);
  },

  celebrate: function(){
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    // Clear any existing animation timeout
    if(this.celebrateTimeout){
      clearTimeout(this.celebrateTimeout);
      this.celebrateTimeout = null;
    }
    
    // Remove any existing animation classes
    display.classList.remove('streak-celebrate');
    
    // Force reflow to restart animation
    void display.offsetWidth;
    
    // Add celebration animation
    display.classList.add('streak-celebrate');
    console.log('[Streak] Animation started');
    
    // Remove after animation completes
    var self = this;
    this.celebrateTimeout = setTimeout(function(){
      display.classList.remove('streak-celebrate');
      console.log('[Streak] Animation ended');
      self.celebrateTimeout = null;
    }, 1000);
  },

  // Refresh streak data (throttled to once per 5 seconds)
  refresh: async function(dropId){
    var now = Date.now();
    if(now - this.lastFetchTime < 5000) {
      console.log('[Streak] Throttled refresh (too soon)');
      return;
    }
    
    await this.fetch(dropId);
  }
};