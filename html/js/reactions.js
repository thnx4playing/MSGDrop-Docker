// Reaction system
var Reactions = {
  currentTarget: null,

  setup: function(){
    if(!UI.els.reactPicker) return;
    
    var grid = UI.els.reactPicker.querySelector('.react-picker-grid');
    if(!grid) return;
    
    grid.innerHTML = '';
    CONFIG.REACTION_EMOJIS.forEach(function(emoji){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.setAttribute('data-emoji', emoji);
      btn.addEventListener('click', function(){
        if(this.currentTarget){
          var seq = parseInt(this.currentTarget.getAttribute('data-seq'), 10);
          if(!isNaN(seq)){
            this.reactToMessage(seq, emoji, 'add');
          }
        }
        this.closePicker();
      }.bind(this));
      grid.appendChild(btn);
    }.bind(this));
    
    document.addEventListener('click', function(e){
      if(!UI.els.reactPicker) return;
      if(UI.els.reactPicker.contains(e.target)) return;
      this.closePicker();
    }.bind(this));
  },

  openPicker: function(msgEl){
    if(!UI.els.reactPicker || !msgEl) return;
    
    var group = msgEl.closest('.message-group');
    if(!group) return;
    
    this.currentTarget = group;
    
    var rect = msgEl.getBoundingClientRect();
    UI.els.reactPicker.classList.add('show');
    
    setTimeout(function(){
      var pickerWidth = UI.els.reactPicker.offsetWidth;
      var left = window.scrollX + rect.left + (rect.width / 2) - (pickerWidth / 2);
      var top = window.scrollY + rect.top - UI.els.reactPicker.offsetHeight - 8;
      
      if(left < 10) left = 10;
      if(left + pickerWidth > window.innerWidth - 10){
        left = window.innerWidth - pickerWidth - 10;
      }
      if(top < 10) top = rect.bottom + window.scrollY + 8;
      
      UI.els.reactPicker.style.left = left + 'px';
      UI.els.reactPicker.style.top = top + 'px';
    }, 10);
  },

  closePicker: function(){
    if(!UI.els.reactPicker) return;
    UI.els.reactPicker.classList.remove('show');
    this.currentTarget = null;
  },

  render: function(container, reactions, seq){
    if(!container) return;
    container.innerHTML = '';
    
    if(!reactions || typeof reactions !== 'object') return;
    
    var reactionKeys = Object.keys(reactions);
    
    reactionKeys.forEach(function(emoji){
      var count = reactions[emoji];
      if(!count || count <= 0) return;
      
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction-chip';
      
      if(count > 1){
        chip.textContent = emoji + ' ' + count;
        chip.style.minWidth = '36px';
        chip.style.paddingLeft = '6px';
        chip.style.paddingRight = '6px';
        chip.style.borderRadius = '12px';
      } else {
        chip.textContent = emoji;
      }
      
      chip.setAttribute('data-emoji', emoji);
      chip.setAttribute('data-seq', seq);
      chip.setAttribute('title', count > 1 ? 'Click to decrease (' + count + ')' : 'Click to remove');
      
      chip.addEventListener('click', function(e){
        e.stopPropagation();
        this.reactToMessage(seq, emoji, 'remove');
      }.bind(this));
      
      container.appendChild(chip);
    }.bind(this));
  },

  reactToMessage: async function(seq, emoji, op){
    if(!seq || !emoji) return;
    var dropId = encodeURIComponent(App.dropId);
    
    try{
      if(op === 'add'){
        var existingMsg = Messages.history.find(function(m){ return m.seq === seq; });
        if(existingMsg && existingMsg.reactions){
          var existingEmojis = Object.keys(existingMsg.reactions);
          for(var i = 0; i < existingEmojis.length; i++){
            var existing = existingEmojis[i];
            if(existing !== emoji && existingMsg.reactions[existing] > 0){
              await API.reactToMessage(dropId, seq, existing, 'remove');
            }
          }
        }
      }
      
      var res = await API.reactToMessage(dropId, seq, emoji, op);
      
      if(!res.ok){
        console.error('React failed:', res.status);
        return;
      }
      
      var data = await res.json();
      Messages.applyDrop(data);
      
    }catch(e){
      console.error('React error:', e);
    }
  }
};
