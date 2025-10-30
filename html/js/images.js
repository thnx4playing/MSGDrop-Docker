// Image handling
var Images = {
  list: [],

  fetch: async function(dropId, force){
    try{
      var data = await API.fetchImages(dropId, force);
      if(!data) return;
      var raw = (data && data.images) || [];
      this.list = raw.map(function(im){
        return {
          id: im.imageId,
          urls: { thumb: im.thumbUrl, original: im.originalUrl },
          uploadedAt: im.uploadedAt
        };
      });
      this.render();
    }catch(e){
      console.error('fetchImages error:', e);
    }
  },

  render: function(){
    var thumbContainer = document.getElementById('thumbStrip');
    if(!thumbContainer) return;
    
    this.updateBadge();
    
    if(this.list.length === 0){
      if(UI.els.thumbEmpty) UI.els.thumbEmpty.classList.add('show');
      thumbContainer.innerHTML = '';
      return;
    }
    
    if(UI.els.thumbEmpty) UI.els.thumbEmpty.classList.remove('show');
    
    var frag = document.createDocumentFragment();
    this.list.forEach(function(im){
      var div=document.createElement('div');
      div.className='thumb-item';
      
      var thumbUrl = im.urls && im.urls.thumb;
      if(thumbUrl){
        thumbUrl += '?t=' + Date.now();
        div.style.backgroundImage = "url('" + thumbUrl + "')";
      }
      
      div.setAttribute('role','button');
      div.setAttribute('tabindex','0');
      div.setAttribute('aria-label','Open image');

      var trash=document.createElement('button');
      trash.type='button';
      trash.className='thumb-delete';
      trash.setAttribute('aria-label','Delete image');
      trash.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      div.appendChild(trash);

      div.addEventListener('click', function(e){
        if(e.target===trash || trash.contains(e.target)) return;
        var originalUrl = (im.urls && im.urls.original) || (im.urls && im.urls.thumb) || '';
        if(originalUrl){
          originalUrl += '?t=' + Date.now();
        }
        UI.openLightbox(originalUrl);
      });
      
      trash.addEventListener('click', function(e){
        e.stopPropagation();
        e.preventDefault();
        if(confirm('Delete this image?')) {
          this.delete(im.id);
        }
      }.bind(this));

      frag.appendChild(div);
    }.bind(this));
    thumbContainer.innerHTML='';
    thumbContainer.appendChild(frag);
  },

  updateBadge: function(){
    if(!UI.els.imageCountBadge) return;
    var count = this.list.length;
    if(count > 0){
      UI.els.imageCountBadge.textContent = count;
    } else {
      UI.els.imageCountBadge.textContent = '';
    }
  },

  delete: async function(imageId){
    var dropId = encodeURIComponent(App.dropId);
    try{
      var res = await API.deleteImage(dropId, imageId);
      if(!res.ok){ alert('Delete failed: '+res.status); return; }
      var data = await res.json().catch(function(){ return null; });
      if (data && Array.isArray(data.images)) {
        this.list = data.images.map(function(im){
          return {
            id: im.imageId,
            urls: { thumb: im.thumbUrl, original: im.originalUrl },
            uploadedAt: im.uploadedAt
          };
        });
        this.render();
      } else {
        setTimeout(function(){ this.fetch(dropId).catch(function(){}); }.bind(this), 250);
      }
    }catch(e){ alert('Delete failed (network)'); }
  },

  upload: async function(file){
    // Show upload status
    this.showUploadStatus('Uploading image...');
    
    try{
      var thumbBlob=await this.makeThumb(file,512);
      
      var dropId=encodeURIComponent(App.dropId);
      var up = await API.uploadImage(dropId, file);
      
      var origRes = await fetch(up.original.putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'image/jpeg' },
        body: file
      });
      if(!origRes.ok){ 
        throw new Error('Failed to upload original image to S3: ' + origRes.status); 
      }
      
      var thumbRes = await fetch(up.thumb.putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: thumbBlob
      });
      
      if(!thumbRes.ok){ 
        throw new Error('Failed to upload thumbnail to S3: ' + thumbRes.status); 
      }
      
      await this.fetch(dropId, true);
      
      // Update status
      this.showUploadStatus('Sending...', false);
      
      // Send image as message (like GIF)
      await this.postImageMessage(up.original.url, up.thumb.url);
      
      // Hide status after success
      this.hideUploadStatus();
      
    }catch(err){ 
      console.error('Upload error:', err);
      this.showUploadStatus('Upload failed', true);
      setTimeout(function(){ this.hideUploadStatus(); }.bind(this), 3000);
      alert('Upload failed: ' + (err.message || err)); 
    }
  },

  showUploadStatus: function(message, isError){
    var toast = document.getElementById('uploadToast');
    if(!toast){
      // Create toast element if it doesn't exist
      toast = document.createElement('div');
      toast.id = 'uploadToast';
      toast.className = 'upload-toast';
      document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.className = 'upload-toast show' + (isError ? ' error' : '');
  },

  hideUploadStatus: function(){
    var toast = document.getElementById('uploadToast');
    if(toast){
      toast.classList.remove('show');
    }
  },

  postImageMessage: async function(originalUrl, thumbUrl){
    // Post image as a message in the chat
    var payload = {
      text: '[Image]',
      prevVersion: Messages.currentVersion,
      user: App.myRole,
      clientId: App.myClientId,
      // Image-specific fields
      imageUrl: originalUrl,
      imageThumb: thumbUrl,
      messageType: 'image'
    };
    
    try {
      var res = await fetch(CONFIG.API_BASE_URL + '/chat/' + App.dropId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      
      if(!res.ok){
        if(res.status === 409){
          console.log('Version conflict, retrying...');
          await Messages.fetch();
          await this.postImageMessage(originalUrl, thumbUrl);
        } else {
          throw new Error('Failed to post image message: ' + res.status);
        }
        return;
      }
      
      // Parse response and update messages (THIS WAS MISSING!)
      var data = await res.json();
      Messages.applyDrop(data);
      
      // Force scroll to bottom for our own image upload
      // (Unlike GIFs which are instant, images take time to upload,
      //  so user may not be "at bottom" anymore by the time this runs)
      setTimeout(function(){
        if(UI.els.chatContainer){
          UI.els.chatContainer.scrollTop = UI.els.chatContainer.scrollHeight;
        }
      }, 100);
      
      console.log('Image message sent successfully');
      
    } catch(err){
      console.error('Error posting image message:', err);
      // Don't alert - image is already uploaded to library
    }
  },

  makeThumb: function(file, max){ 
    return new Promise(function(resolve,reject){ 
      var url=URL.createObjectURL(file); 
      var img=new Image();
      img.onload=function(){ 
        var s=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight)); 
        var w=Math.max(1,Math.round(img.naturalWidth*s));
        var h=Math.max(1,Math.round(img.naturalHeight*s));
        
        var c=document.createElement('canvas'); 
        c.width=w; 
        c.height=h; 
        var ctx=c.getContext('2d', { alpha: false }); 
        
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img,0,0,w,h);
        
        URL.revokeObjectURL(url);
        
        c.toBlob(function(b){ 
          if(b){
            resolve(b);
          } else {
            reject(new Error('Thumb toBlob failed'));
          }
        }, 'image/jpeg', 0.92); 
      };
      img.onerror=function(e){ 
        URL.revokeObjectURL(url);
        reject(e); 
      }; 
      img.src=url; 
    }); 
  }
};
