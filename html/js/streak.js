// Streak tracking - redesigned for reliability
var Streak = {
  currentStreak: 0,
  bothPostedToday: false,
  mPostedToday: false,
  ePostedToday: false,
  lastFetchTime: 0,
  hasShownBrokenAnimation: false,

  // Get the storage key for the current drop
  getStorageKey: function(){
    var dropId = 'default';
    try {
      dropId = new URL(window.location.href).searchParams.get('drop') || 'default';
    } catch(e){}
    return 'streak_last_' + dropId;
  },

  // Get last known streak from localStorage
  getLastKnownStreak: function(){
    try {
      var stored = localStorage.getItem(this.getStorageKey());
      if(stored){
        var data = JSON.parse(stored);
        return data.streak || 0;
      }
    } catch(e){
      console.warn('[Streak] Failed to read localStorage:', e);
    }
    return 0;
  },

  // Save current streak to localStorage
  saveStreak: function(){
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify({
        streak: this.currentStreak,
        timestamp: Date.now()
      }));
    } catch(e){
      console.warn('[Streak] Failed to save to localStorage:', e);
    }
  },

  // Clear the "shown broken" flag (call this after animation plays)
  clearBrokenFlag: function(){
    try {
      localStorage.removeItem(this.getStorageKey() + '_broken_shown');
    } catch(e){}
  },

  // Check if we already showed the broken animation for this reset
  hasBrokenBeenShown: function(){
    try {
      return localStorage.getItem(this.getStorageKey() + '_broken_shown') === 'true';
    } catch(e){
      return false;
    }
  },

  // Mark that we showed the broken animation
  markBrokenShown: function(){
    try {
      localStorage.setItem(this.getStorageKey() + '_broken_shown', 'true');
    } catch(e){}
  },

  fetch: async function(dropId){
    try {
      var data = await API.fetchStreak(dropId);
      
      if(!data) {
        console.warn('[Streak] No data received');
        return;
      }
      
      this.updateData(data, true); // true = this is initial fetch
      this.lastFetchTime = Date.now();
    } catch(e){
      console.error('[Streak] Fetch error:', e);
    }
  },

  updateData: function(data, isInitialFetch){
    var lastKnownStreak = this.getLastKnownStreak();
    var oldStreak = this.currentStreak;
    
    // Use last known streak for comparison on initial fetch
    var compareStreak = isInitialFetch ? lastKnownStreak : oldStreak;
    
    this.currentStreak = data.streak || 0;
    this.bothPostedToday = data.bothPostedToday || false;
    this.mPostedToday = data.mPostedToday || false;
    this.ePostedToday = data.ePostedToday || false;
    
    console.log('[Streak] Update - Last known:', lastKnownStreak, 'Old:', oldStreak, 'New:', this.currentStreak, 'Initial:', isInitialFetch);
    
    this.render();
    
    // Streak BROKE - compare against last known (for login) or old (for live updates)
    if(this.currentStreak === 0 && compareStreak > 0){
      // Only show broken animation once per reset
      if(!this.hasBrokenBeenShown()){
        this.showBroken(compareStreak);
        this.markBrokenShown();
      } else {
        console.log('[Streak] Broken animation already shown for this reset');
      }
      // Save the new (0) streak
      this.saveStreak();
      return;
    }
    
    // Streak INCREASED - show celebration
    if(this.currentStreak > compareStreak){
      this.celebrate();
      // Clear the broken flag since we have a new streak
      this.clearBrokenFlag();
    }
    
    // Save current streak
    this.saveStreak();
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
    this.updateData(data, false); // false = not initial fetch
  },

  celebrate: function(){
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    // Clear any existing timeout to prevent overlapping animations
    if(this.celebrateTimeout){
      clearTimeout(this.celebrateTimeout);
    }
    
    // Remove all animation classes
    display.classList.remove('streak-celebrate', 'streak-complete', 'streak-bounce', 'streak-broken');
    
    // Force reflow to restart animation
    void display.offsetWidth;
    
    // Add celebration animation
    display.classList.add('streak-celebrate');
    
    console.log('[Streak] 🎉 Celebrating! Streak increased to', this.currentStreak);
    
    // Remove after 1 second (animation duration)
    this.celebrateTimeout = setTimeout(function(){
      display.classList.remove('streak-celebrate');
    }, 1000);
  },

  showBroken: function(lostStreak){
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    // Clear any existing timeout
    if(this.brokenTimeout){
      clearTimeout(this.brokenTimeout);
    }
    
    // Remove all animation classes
    display.classList.remove('streak-celebrate', 'streak-complete', 'streak-bounce', 'streak-broken');
    
    // Force reflow to restart animation
    void display.offsetWidth;
    
    // Add broken animation
    display.classList.add('streak-broken');
    
    console.log('[Streak] 💔 Streak broken! Lost ' + lostStreak + ' day streak');
    
    // Remove animation class after it completes
    this.brokenTimeout = setTimeout(function(){
      display.classList.remove('streak-broken');
    }, 1500);
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
