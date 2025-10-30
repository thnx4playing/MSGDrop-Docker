MSGDrop Monolith (offline, single image)

Quick start

1) Build

   docker build -t msgdrop-mono .

2) Run with persistent data and HTTPS port (5‑minute session, PIN 1234)

   docker run --rm -p 443:443 \
     -e PUBLIC_BASE_URL=https://localhost \
     -e DOMAIN=localhost \
     -e SESSION_TTL_SECONDS=300 \
     -e UNLOCK_CODE=1234 \
     -e PORT=443 \
     -v C:/MSGDropData:/data \
     msgdrop-mono

   Notes:
   - Map a dedicated host folder to /data (e.g., C:/MSGDropData) to persist DB, blobs, and keys across upgrades.
   - If 443 is already in use, change host mapping (e.g., -p 8443:443) or set PORT to another value and map accordingly.

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

Replace the UI

- Build your existing web app and place the files under ./static, or mount them:

   docker run ... -v ${PWD}/web-dist:/app/static msgdrop-mono

Notes

- For multiple replicas, add a shared pub/sub (e.g., Redis) to fan out WS events.
- Presence and typing are broadcast events; tailor the client to display appropriately.

