// Streak tracking
var Streak = {
  currentStreak: 0,
  lastUpdateDate: null,

  fetch: async function(dropId){
    try {
      var data = await API.fetchStreak(dropId);
      
      if(!data) {
        console.warn('[Streak] No data received');
        return;
      }
      
      this.currentStreak = data.streak || 0;
      this.lastUpdateDate = data.lastUpdateDate || null;
      
      this.render();
    } catch(e){
      console.error('[Streak] Fetch error:', e);
    }
  },

  render: function(){
    var countEl = document.getElementById('streakCount');
    if(!countEl) return;
    
    countEl.textContent = this.currentStreak;
    
    // Add bounce animation on update
    var display = document.getElementById('streakDisplay');
    if(display && this.currentStreak > 0){
      display.classList.add('streak-bounce');
      setTimeout(function(){
        display.classList.remove('streak-bounce');
      }, 600);
    }
  },

  checkAndUpdate: async function(dropId){
    try {
      var userRole = App.myRole || Storage.getRole(dropId) || 'E';
      var res = await API.updateStreak(dropId, userRole);
      
      if(!res.ok){
        console.error('[Streak] Update failed:', res.status);
        return;
      }
      
      var data = await res.json();
      
      if(!data) {
        console.warn('[Streak] No data received from update');
        return;
      }
      
      var oldStreak = this.currentStreak;
      this.currentStreak = data.streak || 0;
      this.lastUpdateDate = data.lastUpdateDate || null;
      
      this.render();
      
      // Show celebration if streak increased
      if(data.streak > oldStreak){
        this.celebrate();
      }
    } catch(e){
      console.error('[Streak] Update error:', e);
    }
  },

  handleWebSocketUpdate: function(data){
    var oldStreak = this.currentStreak;
    this.currentStreak = data.streak || 0;
    this.lastUpdateDate = data.lastUpdateDate || null;
    
    this.render();
    
    // Show celebration if streak increased
    if(this.currentStreak > oldStreak){
      this.celebrate();
    }
  },

  celebrate: function(){
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    display.classList.add('streak-celebrate');
    setTimeout(function(){
      display.classList.remove('streak-celebrate');
    }, 1000);
  }
};
