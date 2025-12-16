// Camera/Webcam viewer for Frigate stream
var Camera = {
  streamUrl: 'https://cam.efive.org/api/reolink_e1_zoom',
  modal: null,
  stream: null,
  loading: null,
  closeBtn: null,
  isOpen: false,
  initialized: false,

  init: function() {
    if (this.initialized) return true;
    
    this.modal = document.getElementById('cameraModal');
    this.stream = document.getElementById('cameraStream');
    this.loading = document.getElementById('cameraLoading');
    this.closeBtn = document.getElementById('cameraCloseBtn');

    if (!this.modal || !this.stream) {
      console.warn('Camera: elements not found');
      return false;
    }

    var self = this;

    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', function() { self.hide(); });
    }

    this.modal.addEventListener('click', function(e) {
      if (e.target === self.modal) self.hide();
    });

    this.stream.addEventListener('load', function() {
      if (self.loading) self.loading.classList.add('hidden');
    });

    this.stream.addEventListener('error', function() {
      if (self.loading) self.loading.classList.add('hidden');
      console.error('Camera: stream failed to load');
    });

    this.initialized = true;
    console.log('✓ Camera initialized');
    return true;
  },

  show: function() {
    // Always try to init first
    if (!this.initialized) {
      this.init();
    }

    if (!this.modal || !this.stream) {
      console.error('Camera: cannot show, elements missing');
      return;
    }

    if (this.loading) this.loading.classList.remove('hidden');
    this.stream.src = this.streamUrl + '?t=' + Date.now();
    this.modal.classList.add('show');
    document.body.classList.add('no-scroll');
    this.isOpen = true;
  },

  hide: function() {
    if (!this.modal) return;
    if (this.stream) this.stream.src = '';
    this.modal.classList.remove('show');
    document.body.classList.remove('no-scroll');
    this.isOpen = false;
  }
};

// Auto-initialize when DOM is ready
(function() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { Camera.init(); });
  } else {
    Camera.init();
  }
})();