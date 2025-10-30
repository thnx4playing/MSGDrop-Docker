MSGDrop Monolith (offline, single image)

Quick start

1) Build

   docker build -t msgdrop-mono .

2) Run on Ubuntu (persistent data + HTTPS port)

   sudo mkdir -p /srv/msgdrop-data
   sudo chown 1000:1000 /srv/msgdrop-data || true

   docker run -d --name msgdrop \
     --restart unless-stopped \
     -p 443:443 \
     -e PUBLIC_BASE_URL=https://your.domain \
     -e DOMAIN=your.domain \
     -e SESSION_TTL_SECONDS=300 \
     -e UNLOCK_CODE=1234 \
     -e PORT=443 \
     -v /srv/msgdrop-data:/data \
     msgdrop-mono

   Notes:
   - Persist data by binding /srv/msgdrop-data to /data (DB, blobs, signing key).
   - For real TLS, put Nginx/Traefik in front with a cert and proxy pass to the container on port 443 (or run the app on an internal port and terminate TLS at the proxy). Example Nginx shown below.
   - If you prefer a different host port, map e.g. -p 8443:443 and keep PORT=443.

3) Open

   http://localhost:8080/msgdrop

What’s included

- FastAPI app with:
  - /api/unlock (4‑digit PIN) issues HttpOnly cookie that expires after 5 minutes
  - /api/chat/{drop} list & post messages (text + images)
  - /blob/{id} serves uploaded images (requires session)
  - /ws WebSocket with broadcast, typing, and presence (online count)
- Local SQLite (stored in /data/messages.db)
- Blob storage on local filesystem (/data/blob)
- Session signing key persisted under /data/.sesskey
- Static UI placeholder under /msgdrop (replace with your SPA build)

Security & offline

- By default the image does not make external HTTP requests.
- To allow external fetches (e.g., pulling GIFs by URL) set:

   -e ALLOW_EXTERNAL_FETCH=true

Config (env vars)

- PUBLIC_BASE_URL: external base URL (affects absolute links)
- DOMAIN, COOKIE_DOMAIN: cookie scoping (COOKIE_DOMAIN often empty for localhost)
- SESSION_TTL_SECONDS: cookie TTL in seconds (defaults to 300)
- UNLOCK_CODE or UNLOCK_CODE_HASH: choose one
- MSGDROP_SECRET_JSON: optional JSON with {"edgeAuthToken":"...","notify_numbers":[...]}
- SESSION_SIGN_KEY: optional fixed key; otherwise generated and saved to /data/.sesskey
- DATA_DIR: path inside container where all persistent data is stored (default: /data)

Reverse proxy (Nginx) on Ubuntu

   server {
     listen 443 ssl http2;
     server_name your.domain;
     ssl_certificate /etc/letsencrypt/live/your.domain/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/your.domain/privkey.pem;

     location / {
       proxy_pass http://127.0.0.1:443; # container published on 443
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Host $host;
     }
   }

Alternatively, publish the container on a non-privileged port (e.g., -p 8080:443) and set proxy_pass to http://127.0.0.1:8080.

Replace the UI

- Build your existing web app and place the files under ./static, or mount them:

   docker run ... -v ${PWD}/web-dist:/app/static msgdrop-mono

Notes

- For multiple replicas, add a shared pub/sub (e.g., Redis) to fan out WS events.
- Presence and typing are broadcast events; tailor the client to display appropriately.

Deploy/update from GitHub on Ubuntu

1) First time clone

   sudo mkdir -p /srv/msgdrop && cd /srv/msgdrop
   git clone https://github.com/thnx4playing/MSGDrop-Docker.git .
   docker compose up -d --build

2) Subsequent updates (always pull latest then rebuild)

   cd /srv/msgdrop
   ./deploy.sh

   # or manually:
   git pull --rebase && docker compose up -d --build --remove-orphans

Ensure your docker-compose.yml contains your production env and mounts /srv/msgdrop-data:/data.

