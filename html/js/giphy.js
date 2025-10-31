// GIPHY Picker for MSGDrop
// API Key: mrWcrFYs1lvhwbxxNNM3hmb9hUkFfbk4 (public, family-friendly)

var GiphyPicker = (function(){
  'use strict';
  
  function GiphyPicker(apiKey){
    console.log('GiphyPicker constructor called with apiKey:', apiKey);
    this.apiKey = apiKey;
    this.callback = null;
    this.createModal();
    console.log('GiphyPicker created, modal:', this.modal);
  }
  
  GiphyPicker.prototype.createModal = function(){
    console.log('createModal() called');
    
    // Create modal HTML structure
    var modal = document.createElement('div');
    modal.className = 'giphy-modal';
    modal.id = 'giphy-modal';
    modal.innerHTML = 
      '<div class="giphy-container">' +
        '<button class="modal-close-badge" type="button" aria-label="Close">&times;</button>' +
        '<div class="giphy-search">' +
          '<input type="text" placeholder="Search GIPHY..." id="giphy-search-input" />' +
        '</div>' +
        '<div class="giphy-results" id="giphy-results">' +
          '<div class="giphy-loading">Search for GIFs above...</div>' +
        '</div>' +
        '<div class="giphy-footer">' +
          '<span>Powered by GIPHY</span>' +
        '</div>' +
      '</div>';
    
    console.log('Modal created, appending to body');
    document.body.appendChild(modal);
    console.log('Modal appended, searching for elements');
    
    this.modal = modal;
    this.searchInput = document.getElementById('giphy-search-input');
    this.resultsContainer = document.getElementById('giphy-results');
    
    console.log('Modal element:', this.modal);
    console.log('Search input:', this.searchInput);
    console.log('Results container:', this.resultsContainer);
    
    // Event listeners
    var self = this;
    
    // Close button
    modal.querySelector('.modal-close-badge').addEventListener('click', function(){
      self.hide();
    });
    
    // Click outside to close
    modal.addEventListener('click', function(e){
      if(e.target === modal){
        self.hide();
      }
    });
    
    // ESC key to close
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape' && self.modal.classList.contains('show')){
        self.hide();
      }
    });
    
    // Search with debounce
    var searchTimeout;
    this.searchInput.addEventListener('input', function(){
      clearTimeout(searchTimeout);
      var query = self.searchInput.value.trim();
      
      if(query.length === 0){
        self.loadTrending();
      } else if(query.length >= 2){
        searchTimeout = setTimeout(function(){
          self.search(query);
        }, 300);
      }
    });
  };
  
  GiphyPicker.prototype.show = function(callback){
    console.log('GiphyPicker.show() called');
    console.log('Modal element:', this.modal);
    console.log('Modal classes before:', this.modal.className);
    
    this.callback = callback;
    
    // FIX: Lock scrolling on multiple levels
    document.body.classList.add('no-scroll');
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.position = 'fixed';
    document.documentElement.style.width = '100%';
    document.documentElement.style.height = '100%';
    
    // Lock the main app
    var appRoot = document.getElementById('appRoot');
    if(appRoot){
      appRoot.style.overflow = 'hidden';
      appRoot.style.position = 'fixed';
      appRoot.style.width = '100%';
      appRoot.style.height = '100%';
    }
    
    this.modal.classList.add('show');
    
    console.log('Modal classes after:', this.modal.className);
    console.log('Modal computed display:', window.getComputedStyle(this.modal).display);
    console.log('Modal computed visibility:', window.getComputedStyle(this.modal).visibility);
    console.log('Modal computed opacity:', window.getComputedStyle(this.modal).opacity);
    
    this.searchInput.focus();
    this.searchInput.value = '';
    this.loadTrending();
  };
  
  GiphyPicker.prototype.hide = function(){
    this.modal.classList.remove('show');
    
    // FIX: Unlock scrolling on all levels
    document.body.classList.remove('no-scroll');
    document.documentElement.style.overflow = '';
    document.documentElement.style.position = '';
    document.documentElement.style.width = '';
    document.documentElement.style.height = '';
    
    // Unlock the main app
    var appRoot = document.getElementById('appRoot');
    if(appRoot){
      appRoot.style.overflow = '';
      appRoot.style.position = '';
      appRoot.style.width = '';
      appRoot.style.height = '';
    }
    
    this.callback = null;
  };
  
  GiphyPicker.prototype.loadTrending = function(){
    var self = this;
    this.resultsContainer.innerHTML = '<div class="giphy-loading">Loading trending GIFs...</div>';
    
    var url = 'https://api.giphy.com/v1/gifs/trending?api_key=' + this.apiKey + '&limit=24&rating=g';
    
    fetch(url)
      .then(function(res){ return res.json(); })
      .then(function(data){
        self.renderResults(data.data);
      })
      .catch(function(err){
        console.error('GIPHY trending error:', err);
        self.resultsContainer.innerHTML = '<div class="giphy-empty"><div class="giphy-empty-icon">😔</div><div class="giphy-empty-text">Failed to load GIFs</div></div>';
      });
  };
  
  GiphyPicker.prototype.search = function(query){
    var self = this;
    
    this.resultsContainer.innerHTML = '<div class="giphy-loading">Searching...</div>';
    
    var url = 'https://api.giphy.com/v1/gifs/search?api_key=' + this.apiKey + 
              '&q=' + encodeURIComponent(query) + '&limit=24&rating=g';
    
    fetch(url)
      .then(function(res){ return res.json(); })
      .then(function(data){
        if(data.data && data.data.length > 0){
          self.renderResults(data.data);
        } else {
          self.resultsContainer.innerHTML = '<div class="giphy-empty"><div class="giphy-empty-icon">🔍</div><div class="giphy-empty-text">No GIFs found.<br>Try a different search!</div></div>';
        }
      })
      .catch(function(err){
        console.error('GIPHY search error:', err);
        self.resultsContainer.innerHTML = '<div class="giphy-empty"><div class="giphy-empty-icon">😔</div><div class="giphy-empty-text">Search failed</div></div>';
      });
  };
  
  GiphyPicker.prototype.renderResults = function(gifs){
    var self = this;
    this.resultsContainer.innerHTML = '';
    
    gifs.forEach(function(gif){
      var item = document.createElement('div');
      item.className = 'giphy-item';
      
      var img = document.createElement('img');
      // Use fixed_height_small for uniform grid (all GIFs are 100px tall)
      img.src = gif.images.fixed_height_small.url;
      img.alt = gif.title || 'GIF';
      img.loading = 'lazy';
      
      item.appendChild(img);
      
      item.addEventListener('click', function(){
        if(self.callback){
          // Return both preview and full URL with dimensions
          self.callback({
            fullUrl: gif.images.fixed_width.url || gif.images.original.url,
            previewUrl: gif.images.fixed_width.url,
            width: parseInt(gif.images.fixed_width.width) || 200,
            height: parseInt(gif.images.fixed_width.height) || 200,
            title: gif.title || 'GIF'
          });
        }
        self.hide();
      });
      
      self.resultsContainer.appendChild(item);
    });
  };
  
  return GiphyPicker;
})();
