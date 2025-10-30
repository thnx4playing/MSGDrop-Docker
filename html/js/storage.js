// Storage utilities for localStorage and cookies
var Storage = {
  setCookie: function(name, value, maxAgeSec){
    maxAgeSec = maxAgeSec || 31536000;
    document.cookie = name + '=' + encodeURIComponent(value) + '; Max-Age=' + maxAgeSec + '; Path=/; Secure; SameSite=Lax';
  },

  getCookie: function(name){
    var matches = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\\/+^])/g, '\\$1') + '=([^;]*)'));
    return matches ? decodeURIComponent(matches[1]) : null;
  },
  
  // Check if user is authenticated via session cookie
  isLoggedIn: function(){
    return !!this.getCookie('session-ok');
  },
  
  // Redirect to unlock page if not authenticated
  requireAuth: function(){
    if(!this.isLoggedIn()){
      var nextUrl = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = '/unlock/?next=' + nextUrl;
    }
  },

  getRole: function(dropId){
    var k = 'cd.userRole.' + dropId;
    var v = null;
    try {
      v = localStorage.getItem(k);
    } catch(e){}
    if(!v){
      v = this.getCookie('cd_userRole_' + dropId);
      if(v){
        try {
          localStorage.setItem(k, v);
        } catch(e){}
      }
    }
    
    // If no role is set, default to 'E'
    if(!v){
      v = 'E';
      this.setRole(dropId, v);
    }
    
    return v;
  },

  setRole: function(dropId, role){
    var k = 'cd.userRole.' + dropId;
    try {
      localStorage.setItem(k, role);
    } catch(e){}
    this.setCookie('cd_userRole_' + dropId, role);
  },

  getClientId: function(){
    var id = null;
    try {
      id = localStorage.getItem('cd.clientId');
    } catch(e){}
    
    if(!id){
      id = this.getCookie('cd_clientId');
    }
    
    if(!id){
      if(crypto && crypto.randomUUID){
        id = crypto.randomUUID();
      } else {
        id = Date.now().toString(36) + Math.random().toString(36).slice(2,10);
      }
      this.setCookie('cd_clientId', id);
      try {
        localStorage.setItem('cd.clientId', id);
      } catch(e){}
    } else {
      try {
        if(!localStorage.getItem('cd.clientId')){
          localStorage.setItem('cd.clientId', id);
        }
      } catch(e){}
    }
    
    return id;
  },

  getTheme: function(){ 
    return document.documentElement.getAttribute('data-theme') || 'light'; 
  },
  
  setTheme: function(t){
    document.documentElement.setAttribute('data-theme', t);
    try{ sessionStorage.setItem('theme', t); }catch(e){}
  },
  
  toggleTheme: function(){ 
    this.setTheme(this.getTheme()==='dark' ? 'light' : 'dark'); 
  }
};
