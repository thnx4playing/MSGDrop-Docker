// Streak tracking - redesigned for reliability
var Streak = {
  currentStreak: 0,
  bothPostedToday: false,
  mPostedToday: false,
  ePostedToday: false,
  lastFetchTime: 0,

  fetch: async function(dropId){
    try {
      var data = await API.fetchStreak(dropId);
      
      if(!data) {
        console.warn('[Streak] No data received');
        return;
      }
      
      this.updateData(data);
      this.lastFetchTime = Date.now();
    } catch(e){
      console.error('[Streak] Fetch error:', e);
    }
  },

  updateData: function(data){
    var oldStreak = this.currentStreak;
    
    this.currentStreak = data.streak || 0;
    this.bothPostedToday = data.bothPostedToday || false;
    this.mPostedToday = data.mPostedToday || false;
    this.ePostedToday = data.ePostedToday || false;
    
    this.render();
    
    // Show celebration ONLY if streak increased from non-zero
    // (prevents animation on page load when going from 0 to existing streak)
    if(this.currentStreak > oldStreak && oldStreak > 0){
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
    this.updateData(data);
  },

  celebrate: function(){
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    // Clear any existing timeout to prevent overlapping animations
    if(this.celebrateTimeout){
      clearTimeout(this.celebrateTimeout);
    }
    
    // Remove all animation classes
    display.classList.remove('streak-celebrate', 'streak-complete', 'streak-bounce');
    
    // Force reflow to restart animation
    void display.offsetWidth;
    
    // Add celebration animation
    display.classList.add('streak-celebrate');
    
    // Remove after 1 second (animation duration)
    this.celebrateTimeout = setTimeout(function(){
      display.classList.remove('streak-celebrate');
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