import os, json, hmac, hashlib, time, secrets, mimetypes, logging
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Request, HTTPException, Response
from fastapi.responses import JSONResponse, FileResponse
from fastapi.responses import RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
import aiofiles
from pathlib import Path

# --- Config / env ---
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8080")
DOMAIN          = os.environ.get("DOMAIN", "localhost")
COOKIE_DOMAIN   = os.environ.get("COOKIE_DOMAIN", "")
# Default to 5 minutes
SESSION_TTL     = int(os.environ.get("SESSION_TTL_SECONDS", "300"))
SESSION_COOKIE  = "msgdrop_sess"
UI_COOKIE       = "session-ok"
DATA_DIR        = Path(os.environ.get("DATA_DIR", "/data"))
BLOB_DIR        = DATA_DIR / "blob"
DB_PATH         = DATA_DIR / "messages.db"

# Internal-only by default: do not reach outside unless explicitly allowed
ALLOW_EXTERNAL_FETCH = os.environ.get("ALLOW_EXTERNAL_FETCH", "false").lower() == "true"

MSGDROP_SECRET_JSON = os.environ.get("MSGDROP_SECRET_JSON", "")
try:
    _cfg = json.loads(MSGDROP_SECRET_JSON) if MSGDROP_SECRET_JSON else {}
except Exception:
    _cfg = {}
# Twilio config
TWILIO_ACCOUNT_SID = _cfg.get("account_sid", "")
TWILIO_AUTH_TOKEN = _cfg.get("auth_token", "")
TWILIO_FROM_NUMBER = _cfg.get("from_number") or _cfg.get("from", "")
NOTIFY_NUMBERS = _cfg.get("notify_numbers") or _cfg.get("notify") or _cfg.get("to_numbers") or []
if isinstance(NOTIFY_NUMBERS, str):
    NOTIFY_NUMBERS = [NOTIFY_NUMBERS]
EDGE_AUTH_TOKEN = _cfg.get("edgeAuthToken", "")  # optional in mono mode

UNLOCK_CODE_HASH = os.environ.get("UNLOCK_CODE_HASH", "")
UNLOCK_CODE      = os.environ.get("UNLOCK_CODE", "")

# Secret to sign sessions; derive from env or generate stable file-based secret
SESSION_SIGN_KEY = os.environ.get("SESSION_SIGN_KEY")
if not SESSION_SIGN_KEY:
    keyfile = DATA_DIR / ".sesskey"
    keyfile.parent.mkdir(parents=True, exist_ok=True)
    if keyfile.exists():
        SESSION_SIGN_KEY = keyfile.read_text().strip()
    else:
        SESSION_SIGN_KEY = secrets.token_hex(32)
        keyfile.write_text(SESSION_SIGN_KEY)
SESSION_SIGN_KEY_BYTES = SESSION_SIGN_KEY.encode("utf-8")

# --- App & DB ---
app = FastAPI(title="msgdrop-mono")
engine: Engine = create_engine(f"sqlite:///{DB_PATH}", future=True)
BLOB_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def init_db():
    # Create parent dir
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with engine.begin() as conn:
        conn.exec_driver_sql("""
        create table if not exists messages(
            id text primary key,
            drop_id text not null,
            seq integer not null,
            ts integer not null,
            created_at integer not null,
            updated_at integer not null,
            user text,
            client_id text,
            message_type text default 'text',
            text text,
            blob_id text,
            mime text,
            reactions text default '{}',
            gif_url text,
            gif_preview text,
            gif_width integer default 0,
            gif_height integer default 0,
            image_url text,
            image_thumb text
        );
        """)
        conn.exec_driver_sql("""
        create table if not exists sessions(
            id text primary key,
            exp integer not null
        );
        """)

init_db()

# --- Twilio notifications ---
_last_notify: Dict[str, int] = {}

def _should_notify(kind: str, drop_id: str, window_sec: int = 60) -> bool:
    key = f"{kind}:{drop_id}"
    now = int(time.time())
    last = _last_notify.get(key, 0)
    if now - last < window_sec:
        return False
    _last_notify[key] = now
    return True

def notify(text: str):
    """Send SMS notification via Twilio"""
    logger.info(f"[notify] {text}")
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN or not TWILIO_FROM_NUMBER:
        logger.warning("[notify] Twilio not configured, skipping SMS")
        return
    if not NOTIFY_NUMBERS:
        logger.warning("[notify] No notify numbers configured")
        return
    try:
        from twilio.rest import Client
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        for to_number in NOTIFY_NUMBERS:
            try:
                message = client.messages.create(
                    body=text,
                    from_=TWILIO_FROM_NUMBER,
                    to=to_number
                )
                logger.info(f"[notify] SMS sent to {to_number}: {message.sid}")
            except Exception as e:
                logger.error(f"[notify] Failed to send SMS to {to_number}: {e}")
    except Exception as e:
        logger.error(f"[notify] Twilio error: {e}")

# --- Cookies / session ---
def b64url(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

def sign(payload: bytes) -> bytes:
    return hmac.new(SESSION_SIGN_KEY_BYTES, payload, hashlib.sha256).digest()

def _generate_token() -> str:
    exp = int(time.time()) + SESSION_TTL
    payload = json.dumps({"exp": exp}, separators=(",", ":")).encode("utf-8")
    sig = sign(payload)
    return b64url(payload + b"." + sig)

def issue_cookies() -> List[str]:
    token = _generate_token()
    parts = [f'{SESSION_COOKIE}="{token}"', "HttpOnly", "Secure", "Path=/", "SameSite=Lax"]
    if COOKIE_DOMAIN: parts.append(f"Domain={COOKIE_DOMAIN}")
    sess_cookie = "; ".join(parts)

    # JS-readable cookie with the same token for WebSocket auth
    ui_parts = [f"{UI_COOKIE}={token}", "Secure", "Path=/", "SameSite=Lax"]
    if COOKIE_DOMAIN: ui_parts.append(f"Domain={COOKIE_DOMAIN}")
    ui_cookie = "; ".join(ui_parts)
    return [sess_cookie, ui_cookie]

def _verify_token(token: str) -> bool:
    import base64
    try:
        raw = token + "==="
        blob = base64.urlsafe_b64decode(raw)
        dot = blob.find(b".")
        if dot <= 0:
            return False
        payload, mac = blob[:dot], blob[dot+1:]
        if not hmac.compare_digest(sign(payload), mac):
            return False
        data = json.loads(payload.decode("utf-8"))
        exp_time = int(data.get("exp", 0))
        current_time = int(time.time())
        logger.debug(f"Token check: exp={exp_time}, now={current_time}, diff={exp_time - current_time}")
        if current_time > exp_time:
            return False
        return True
    except Exception as e:
        logger.debug(f"Token verification error: {e}")
        return False

def require_session(req: Request):
    c = req.cookies.get(SESSION_COOKIE)
    if not c: raise HTTPException(401, "no session")
    if not _verify_token(c):
        raise HTTPException(401, "bad session")

# --- Simple generic rate limiter (per-IP window)
from collections import defaultdict
request_counts = defaultdict(list)

def rate_limit(req: Request, max_requests: int = 30, window: int = 60):
    client_ip = req.client.host if getattr(req, "client", None) else "unknown"
    now = int(time.time())
    lst = request_counts[client_ip]
    lst[:] = [t for t in lst if now - t < window]
    if len(lst) >= max_requests:
        raise HTTPException(429, "Rate limit exceeded")
    lst.append(now)

# --- Health ---
@app.get("/api/health")
def health():
    return {"ok": True, "service": "msgdrop-rest"}

# --- Unlock ---
class UnlockBody(BaseModel):
    code: str

def verify_code(code: str) -> bool:
    if UNLOCK_CODE_HASH:
        got = hashlib.sha256(code.encode("utf-8")).hexdigest()
        return hmac.compare_digest(got, UNLOCK_CODE_HASH)
    if UNLOCK_CODE:
        return hmac.compare_digest(code, UNLOCK_CODE)
    return False

unlock_attempts: Dict[str, List[int]] = {}

def _set_session_cookies(response: Response, token: str):
    # Set HttpOnly session cookie
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        domain=(COOKIE_DOMAIN or None),
        path="/",
    )
    # Set JS-readable cookie for WS
    response.set_cookie(
        key=UI_COOKIE,
        value=token,
        httponly=False,
        secure=True,
        samesite="lax",
        domain=(COOKIE_DOMAIN or None),
        path="/",
    )

@app.post("/api/unlock")
def unlock(body: UnlockBody, req: Request, response: Response):
    client_ip = req.client.host if getattr(req, "client", None) else "unknown"
    now = int(time.time())

    attempts = unlock_attempts.get(client_ip, [])
    attempts = [t for t in attempts if now - t < 300]
    if len(attempts) >= 5:
        raise HTTPException(429, "Too many attempts. Try again in 5 minutes.")

    code = (body.code or "").strip()
    if not (len(code) == 4 and code.isdigit()):
        attempts.append(now)
        unlock_attempts[client_ip] = attempts
        raise HTTPException(400, "PIN must be 4 digits")
    if not verify_code(code):
        attempts.append(now)
        unlock_attempts[client_ip] = attempts
        raise HTTPException(401, "invalid code")

    # Success - clear attempts and issue dual cookies
    unlock_attempts.pop(client_ip, None)
    token = _generate_token()
    _set_session_cookies(response, token)
    return {"success": True}

# --- Chat APIs ---
@app.get("/api/chat/{drop_id}")
def list_messages(drop_id: str, limit: int = 200, before: Optional[int] = None, req: Request = None):
    require_session(req)
    rate_limit(req, 60, 60)
    sql = "select * from messages where drop_id=:d"
    params = {"d": drop_id}
    if before:
        sql += " and ts < :b"; params["b"] = before
    sql += " order by seq desc limit :n"; params["n"] = max(1, min(500, limit))
    with engine.begin() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
        max_seq = conn.execute(text("select coalesce(max(seq),0) as v from messages where drop_id=:d"), {"d": drop_id}).scalar()
    rows = list(reversed(rows))
    out = []
    images = []
    for r in rows:
        o = dict(r)
        # Transform DB fields (snake_case) to frontend format (camelCase)
        msg = {
            "message": o.get("text"),
            "seq": o.get("seq"),
            "createdAt": o.get("created_at"),
            "updatedAt": o.get("updated_at"),
            "user": o.get("user"),
            "clientId": o.get("client_id"),
            "messageType": o.get("message_type"),
            "reactions": json.loads(o.get("reactions") or "{}"),
            "gifUrl": o.get("gif_url"),
            "gifPreview": o.get("gif_preview"),
            "gifWidth": o.get("gif_width"),
            "gifHeight": o.get("gif_height"),
            "imageUrl": o.get("image_url"),
            "imageThumb": o.get("image_thumb"),
        }
        if o.get("blob_id"):
            msg["img"] = f"/blob/{o['blob_id']}"
            images.append({
                "imageId": o["blob_id"],
                "mime": o.get("mime"),
                "originalUrl": msg["img"],
                "thumbUrl": msg["img"],
                "uploadedAt": o.get("ts"),
            })
        out.append(msg)
    return {"dropId": drop_id, "version": int(max_seq or 0), "messages": out, "images": images}

@app.post("/api/chat/{drop_id}")
async def post_message(drop_id: str,
                       text_: Optional[str] = Form(default=None),
                       user: Optional[str] = Form(default=None),
                       file: Optional[UploadFile] = File(default=None),
                       req: Request = None):
    require_session(req)
    rate_limit(req, 30, 60)
    logger.info(f"[POST] drop={drop_id} user={user}")
    ts = int(time.time() * 1000)
    msg_id = secrets.token_hex(8)
    blob_id, mime = None, None
    gif_url = None
    image_url = None
    message_type = "text"

    # If JSON body provided (GIF/image URL style)
    ctype = (req.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype == "application/json":
        body = await req.json()
        text_ = body.get("text")
        user = body.get("user") or user
        gif_url = body.get("gifUrl")
        image_url = body.get("imageUrl")
        if gif_url:
            message_type = "gif"
        elif image_url:
            message_type = "image"

    if file:
        suffix = Path(file.filename or "").suffix.lower()
        blob_id = secrets.token_hex(12) + suffix
        dest = BLOB_DIR / blob_id
        async with aiofiles.open(dest, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk: break
                await f.write(chunk)
        mime = file.content_type or mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
        message_type = "image"
        # Set image URLs for display in chat
        image_url = f"/blob/{blob_id}"
        image_thumb = f"/blob/{blob_id}"
        if not text_:
            text_ = "[Image]"

    with engine.begin() as conn:
        # allocate next seq per drop
        row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop_id}).mappings().first()
        next_seq = int(row["next"]) if row else 1
        now_ms = ts
        conn.execute(text("""
          insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,blob_id,mime,reactions,gif_url,image_url,image_thumb)
          values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:b,:m,:rx,:gurl,:iurl,:ithumb)
        """), {"id": msg_id, "d": drop_id, "seq": next_seq, "ts": ts, "ca": now_ms, "ua": now_ms,
                "u": user, "cid": None, "mt": message_type, "tx": text_, "b": blob_id, "m": mime, "rx": "{}",
                "gurl": gif_url, "iurl": image_url, "ithumb": image_thumb})

    await hub.broadcast(drop_id, {
        "type": "update",
        "message": {
            "id": msg_id, "drop_id": drop_id, "seq": next_seq, "ts": ts, "user": user, "text": text_,
            "blob_id": blob_id, "mime": mime, "img": (f"/blob/{blob_id}" if blob_id else None)
        }
    })
    # Notify only when E posts a new message, debounce 60s to avoid spam
    if (user or "").upper() == "E" and _should_notify("msg", drop_id, 60):
        notify("E posted a new message")
    # Return fresh list to match frontend expectations
    return list_messages(drop_id, req=req)

# --- Message edit/delete/react and image delete ---
from fastapi import Body

@app.patch("/api/chat/{drop_id}")
async def edit_message(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
    rate_limit(req, 60, 60)
    seq = body.get("seq")
    text_val = body.get("text")
    if seq is None or text_val is None:
        raise HTTPException(400, "seq and text required")
    now_ms = int(time.time() * 1000)
    with engine.begin() as conn:
        conn.execute(text("update messages set text=:t, updated_at=:u where drop_id=:d and seq=:s"),
                     {"t": text_val, "u": now_ms, "d": drop_id, "s": seq})
    await hub.broadcast(drop_id, {"type": "update"})
    return list_messages(drop_id, req=req)

@app.delete("/api/chat/{drop_id}")
async def delete_message(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
    rate_limit(req, 60, 60)
    seq = body.get("seq")
    if seq is None:
        raise HTTPException(400, "seq required")
    # Try to remove blob if tied to this message
    with engine.begin() as conn:
        row = conn.execute(text("select blob_id from messages where drop_id=:d and seq=:s"),
                           {"d": drop_id, "s": seq}).mappings().first()
        if row and row.get("blob_id"):
            try:
                (BLOB_DIR / row["blob_id"]).unlink(missing_ok=True)
            except Exception:
                pass
        conn.execute(text("delete from messages where drop_id=:d and seq=:s"), {"d": drop_id, "s": seq})
    await hub.broadcast(drop_id, {"type": "update"})
    return list_messages(drop_id, req=req)

@app.post("/api/chat/{drop_id}/react")
async def react_message(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
    rate_limit(req, 120, 60)
    seq = body.get("seq")
    emoji = body.get("emoji")
    op = (body.get("op") or "add").lower()
    if seq is None or not emoji:
        raise HTTPException(400, "seq and emoji required")
    with engine.begin() as conn:
        row = conn.execute(text("select reactions from messages where drop_id=:d and seq=:s"),
                           {"d": drop_id, "s": seq}).mappings().first()
        if not row:
            raise HTTPException(404, "message not found")
        try:
            rx = json.loads(row["reactions"] or "{}")
        except Exception:
            rx = {}
        cur = int(rx.get(emoji, 0))
        if op == "add":
            rx[emoji] = cur + 1
        elif op == "remove":
            rx[emoji] = max(0, cur - 1)
        else:
            raise HTTPException(400, "op must be add/remove")
        conn.execute(text("update messages set reactions=:r where drop_id=:d and seq=:s"),
                     {"r": json.dumps(rx, separators=(",", ":")), "d": drop_id, "s": seq})
    await hub.broadcast(drop_id, {"type": "update"})
    return list_messages(drop_id, req=req)

@app.delete("/api/chat/{drop_id}/images/{image_id}")
async def delete_image(drop_id: str, image_id: str, req: Request = None):
    require_session(req)
    rate_limit(req, 30, 60)
    # Delete any messages that reference this blob in this drop
    with engine.begin() as conn:
        conn.execute(text("delete from messages where drop_id=:d and blob_id=:b"), {"d": drop_id, "b": image_id})
    try:
        (BLOB_DIR / image_id).unlink(missing_ok=True)
    except Exception:
        pass
    await hub.broadcast(drop_id, {"type": "update"})
    return list_messages(drop_id, req=req)

# --- Streaks (EST midnight window; both users must post each day) ---
from zoneinfo import ZoneInfo

NY_TZ = ZoneInfo("America/New_York")

def ts_to_est_date(ts_ms: int) -> str:
    dt = time.gmtime(ts_ms / 1000.0)
    # Convert via epoch -> aware datetime in UTC then to NY; avoid external deps
    import datetime as _dt
    utc_dt = _dt.datetime.fromtimestamp(ts_ms / 1000.0, _dt.timezone.utc)
    ny_dt = utc_dt.astimezone(NY_TZ)
    return ny_dt.strftime("%Y-%m-%d")

def compute_streak(drop_id: str):
    # Pull recent 90 days to be safe
    with engine.begin() as conn:
        rows = conn.execute(text(
            "select user, ts from messages where drop_id=:d order by ts desc limit 5000"
        ), {"d": drop_id}).mappings().all()
    if not rows:
        return {"streak": 0, "streakDays": 0, "users": [], "today": {"both": False}, "days": []}
    # Determine the two users by recency of appearance
    seen = []
    for r in rows:
        u = (r["user"] or "").strip() or "user"
        if u not in seen:
            seen.append(u)
        if len(seen) == 2:
            break
    users = seen[:2]
    # Build per-day presence map
    per_day: Dict[str, set] = {}
    for r in rows:
        u = (r["user"] or "").strip() or users[0] if users else "user"
        day = ts_to_est_date(int(r["ts"]))
        per_day.setdefault(day, set()).add(u)
    # Walk back from today (EST) counting consecutive days with both users
    import datetime as _dt
    today_est = _dt.datetime.now(NY_TZ).date()
    streak = 0
    days_detail = []
    # Ensure we have two usernames
    if len(users) < 2:
        return {"streak": 0, "streakDays": 0, "users": users, "today": {"both": False}, "days": []}
    u1, u2 = users[0], users[1]
    i = 0
    while True:
        day = today_est - _dt.timedelta(days=i)
        key = day.strftime("%Y-%m-%d")
        s = per_day.get(key, set())
        both = (u1 in s) and (u2 in s)
        days_detail.append({"date": key, "u1": u1 in s, "u2": u2 in s, "both": both})
        if i == 0:
            today_both = both
        if both:
            streak += 1
            i += 1
            # Cap to 365 to avoid infinite
            if i > 365:
                break
        else:
            break
    return {"streak": streak, "streakDays": streak, "users": users, "today": {"both": today_both}, "days": days_detail}

@app.get("/api/chat/{drop_id}/streak")
def get_streak(drop_id: str, req: Request = None):
    require_session(req)
    return compute_streak(drop_id)

@app.post("/api/chat/{drop_id}/streak")
def post_streak(drop_id: str, req: Request = None):
    # Idempotent: recompute based on messages; no write required
    require_session(req)
    return compute_streak(drop_id)

# --- Blob serving ---
@app.get("/blob/{blob_id}")
def get_blob(blob_id: str, req: Request):
    require_session(req)
    path = BLOB_DIR / blob_id
    if not path.exists(): raise HTTPException(404)
    return FileResponse(path)

# --- WebSocket Hub with presence ---
class Hub:
    def __init__(self):
        self.rooms: Dict[str, Dict[WebSocket, str]] = {}

    async def join(self, drop_id: str, ws: WebSocket, user: str = "anon"):
        await ws.accept()
        self.rooms.setdefault(drop_id, {})[ws] = user
        
        # Send current presence state to the NEW connection only
        # Tell them who's already online (excluding themselves)
        existing_users = {}
        for conn, u in self.rooms.get(drop_id, {}).items():
            if conn != ws and u != user:  # Don't send their own presence
                existing_users[u] = True
        
        # Send initial presence of existing users to the new connection
        for existing_user in existing_users.keys():
            await ws.send_json({
                "type": "presence",
                "data": {"user": existing_user, "state": "active", "ts": int(time.time() * 1000)},
                "online": len(self.rooms.get(drop_id, {}))
            })
        
        # Then broadcast this user's join to OTHERS (not self)
        await self.broadcast_to_others(drop_id, ws, {
            "type": "presence",
            "data": {"user": user, "state": "active", "ts": int(time.time() * 1000)},
            "online": len(self.rooms.get(drop_id, {}))
        })

    async def leave(self, drop_id: str, ws: WebSocket):
        # Get user before removal
        user_label = self.rooms.get(drop_id, {}).get(ws, "anon")
        logger.info(f"[Hub.leave] User '{user_label}' disconnecting from drop '{drop_id}'")
        
        try:
            del self.rooms.get(drop_id, {})[ws]
            if not self.rooms.get(drop_id): 
                self.rooms.pop(drop_id, None)
        except KeyError:
            pass
        
        # Broadcast user's offline state
        logger.info(f"[Hub.leave] Broadcasting offline state for user '{user_label}'")
        await self.broadcast(drop_id, {
            "type": "presence",
            "data": {"user": user_label, "state": "offline", "ts": int(time.time() * 1000)},
            "online": self._online(drop_id)
        })

    def _online(self, drop_id: str) -> int:
        return len(self.rooms.get(drop_id, {}))

    async def broadcast(self, drop_id: str, payload: Dict[str, Any]):
        conns = list(self.rooms.get(drop_id, {}).keys())
        dead = []
        for ws in conns:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.leave(drop_id, ws)

    async def broadcast_to_others(self, drop_id: str, sender_ws: WebSocket, payload: Dict[str, Any]):
        """Broadcast to all connections in room EXCEPT sender"""
        conns = list(self.rooms.get(drop_id, {}).keys())
        dead = []
        for ws in conns:
            if ws == sender_ws:
                continue
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.leave(drop_id, ws)

hub = Hub()

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    params = dict(ws.query_params)
    # verify session token from query
    session_token = params.get("sessionToken") or params.get("sess")
    logger.info(f"[WS] Session token received: {session_token[:20] if session_token else 'None'}...")
    if not session_token or not _verify_token(session_token):
        logger.warning(f"[WS] Invalid session token, closing connection")
        await ws.close(code=1008)
        return

    drop = params.get("drop") or params.get("dropId") or "default"
    # optional strictness via edge token
    edge = params.get("edge")
    if EDGE_AUTH_TOKEN and edge != EDGE_AUTH_TOKEN:
        await ws.close(code=4401)
        return

    user = params.get("user") or params.get("role") or "anon"
    logger.info(f"[WS] WebSocket connecting: user={user}, drop={drop}")
    await hub.join(drop, ws, user)
    try:
        while True:
            msg = await ws.receive_json()
            # Support both type/action styles
            t = msg.get("type") or msg.get("action")
            payload = msg.get("payload") or msg
            if t == "typing":
                # Add user to typing payload so recipient knows WHO is typing
                typing_payload = dict(payload or {})
                typing_payload["user"] = user
                await hub.broadcast(drop, {"type": "typing", "payload": typing_payload})
            elif t == "ping":
                await ws.send_json({"type": "pong", "ts": int(time.time()*1000)})
            elif t == "notify":
                notify(f"{msg}")
            elif t == "presence":
                # Ephemeral presence - broadcast only, no DB persistence
                try:
                    presence_payload = {
                        "user": (payload or {}).get("user") or user,
                        "state": (payload or {}).get("state", "active"),
                        "ts": (payload or {}).get("ts", int(time.time() * 1000)),
                    }
                except Exception:
                    presence_payload = {"user": user, "state": "active", "ts": int(time.time()*1000)}
                # Broadcast to all OTHER connections (not sender) - presence is ephemeral
                await hub.broadcast_to_others(drop, ws, {"type": "presence", "data": presence_payload, "online": hub._online(drop)})
            elif t == "presence_request":
                await hub.broadcast(drop, {"type": "presence_request", "data": {"ts": int(time.time() * 1000)}})
            elif t == "chat":
                # Text message via WebSocket
                text_val = (payload or {}).get("text") or ""
                msg_user = (payload or {}).get("user") or user
                client_id = (payload or {}).get("clientId")
                
                if not text_val:
                    await ws.send_json({"type": "error", "error": "text required"})
                    continue
                
                # Insert into DB
                ts = int(time.time() * 1000)
                msg_id = secrets.token_hex(8)
                
                with engine.begin() as conn:
                    row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop}).mappings().first()
                    next_seq = int(row["next"]) if row else 1
                    
                    conn.execute(text("""
                        insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,reactions)
                        values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:rx)
                    """), {
                        "id": msg_id, "d": drop, "seq": next_seq, "ts": ts,
                        "ca": ts, "ua": ts, "u": msg_user, "cid": client_id,
                        "mt": "text", "tx": text_val, "rx": "{}"
                    })
                
                # Build the drop payload manually instead of calling list_messages()
                # (list_messages requires req parameter for session validation)
                with engine.begin() as conn:
                    rows = conn.execute(text("select * from messages where drop_id=:d order by seq"), {"d": drop}).mappings().all()
                
                out = []
                images = []
                for r in rows:
                    o = dict(r)
                    msg = {
                        "message": o.get("text"),
                        "seq": o.get("seq"),
                        "createdAt": o.get("created_at"),
                        "updatedAt": o.get("updated_at"),
                        "user": o.get("user"),
                        "clientId": o.get("client_id"),
                        "messageType": o.get("message_type"),
                        "reactions": json.loads(o.get("reactions") or "{}"),
                        "gifUrl": o.get("gif_url"),
                        "gifPreview": o.get("gif_preview"),
                        "gifWidth": o.get("gif_width"),
                        "gifHeight": o.get("gif_height"),
                        "imageUrl": o.get("image_url"),
                        "imageThumb": o.get("image_thumb"),
                    }
                    if o.get("blob_id"):
                        msg["img"] = f"/blob/{o['blob_id']}"
                        images.append({
                            "imageId": o["blob_id"],
                            "mime": o.get("mime"),
                            "originalUrl": msg["img"],
                            "thumbUrl": msg["img"],
                            "uploadedAt": o.get("ts"),
                        })
                    out.append(msg)
                
                full_drop = {"dropId": drop, "version": int(next_seq), "messages": out, "images": images}
                
                # Broadcast update to all connections (including sender)
                await hub.broadcast(drop, {"type": "update"})
                
                # Notify if E posts, debounced
                if (msg_user or "").upper() == "E" and _should_notify("msg", drop, 60):
                    notify("E posted a new message")
                
                # Also send full data to sender
                await ws.send_json({"type": "update", "data": full_drop})
            elif t == "gif":
                # GIF message via WebSocket
                gif_url = (payload or {}).get("gifUrl")
                gif_preview = (payload or {}).get("gifPreview")
                gif_width = (payload or {}).get("gifWidth", 0)
                gif_height = (payload or {}).get("gifHeight", 0)
                title = (payload or {}).get("title") or "[GIF]"
                msg_user = (payload or {}).get("user") or user
                client_id = (payload or {}).get("clientId")
                
                if not gif_url:
                    await ws.send_json({"type": "error", "error": "gifUrl required"})
                    continue
                
                # Insert into DB
                ts = int(time.time() * 1000)
                msg_id = secrets.token_hex(8)
                
                with engine.begin() as conn:
                    row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop}).mappings().first()
                    next_seq = int(row["next"]) if row else 1
                    
                    conn.execute(text("""
                        insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,reactions,gif_url,gif_preview,gif_width,gif_height)
                        values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:rx,:gurl,:gprev,:gw,:gh)
                    """), {
                        "id": msg_id, "d": drop, "seq": next_seq, "ts": ts,
                        "ca": ts, "ua": ts, "u": msg_user, "cid": client_id,
                        "mt": "gif", "tx": f"[GIF: {title}]", "rx": "{}",
                        "gurl": gif_url, "gprev": gif_preview, "gw": gif_width, "gh": gif_height
                    })
                
                # Build the drop payload manually instead of calling list_messages()
                # (list_messages requires req parameter for session validation)
                with engine.begin() as conn:
                    rows = conn.execute(text("select * from messages where drop_id=:d order by seq"), {"d": drop}).mappings().all()
                
                out = []
                images = []
                for r in rows:
                    o = dict(r)
                    msg = {
                        "message": o.get("text"),
                        "seq": o.get("seq"),
                        "createdAt": o.get("created_at"),
                        "updatedAt": o.get("updated_at"),
                        "user": o.get("user"),
                        "clientId": o.get("client_id"),
                        "messageType": o.get("message_type"),
                        "reactions": json.loads(o.get("reactions") or "{}"),
                        "gifUrl": o.get("gif_url"),
                        "gifPreview": o.get("gif_preview"),
                        "gifWidth": o.get("gif_width"),
                        "gifHeight": o.get("gif_height"),
                        "imageUrl": o.get("image_url"),
                        "imageThumb": o.get("image_thumb"),
                    }
                    if o.get("blob_id"):
                        msg["img"] = f"/blob/{o['blob_id']}"
                        images.append({
                            "imageId": o["blob_id"],
                            "mime": o.get("mime"),
                            "originalUrl": msg["img"],
                            "thumbUrl": msg["img"],
                            "uploadedAt": o.get("ts"),
                        })
                    out.append(msg)
                
                full_drop = {"dropId": drop, "version": int(next_seq), "messages": out, "images": images}
                
                # Broadcast update to all connections (including sender)
                await hub.broadcast(drop, {"type": "update"})
                
                # Notify if E posts, debounced
                if (msg_user or "").upper() == "E" and _should_notify("gif", drop, 60):
                    notify("E sent a GIF")
                
                # Also send full data to sender
                await ws.send_json({"type": "update", "data": full_drop})
            elif t == "game":
                # passthrough game events for now
                await hub.broadcast(drop, {"type": "game", "payload": payload})
                # Notify when E starts a game, debounced
                try:
                    op = (payload or {}).get("op")
                    who = (payload or {}).get("user") or user
                    if op == "start" and (who or "").upper() == "E" and _should_notify("game", drop, 60):
                        notify("E started a game")
                except Exception:
                    pass
            else:
                # Unrecognized events are ignored
                pass
    except WebSocketDisconnect:
        await hub.leave(drop, ws)

# --- Static UI: serve /msgdrop
app.mount("/msgdrop", StaticFiles(directory="html", html=True), name="msgdrop")
# Also serve common asset roots for absolute paths the UI may use
app.mount("/images", StaticFiles(directory="html/images"), name="images")
app.mount("/css", StaticFiles(directory="html/css"), name="css")
app.mount("/js", StaticFiles(directory="html/js"), name="js")


@app.get("/")
def root_redirect():
    return RedirectResponse(url="/msgdrop", status_code=307)

@app.get("/unlock")
def unlock_page():
    index_path = Path("html/unlock.html")
    if index_path.exists():
        return FileResponse(index_path)
    return RedirectResponse(url="/msgdrop", status_code=302)

@app.get("/msgdrop/unlock")
def unlock_redirect():
    return RedirectResponse(url="/unlock", status_code=307)


if __name__ == "__main__":
    import uvicorn
    # SSL paths from environment
    ssl_cert = os.environ.get("SSL_CERT_PATH")
    ssl_key = os.environ.get("SSL_KEY_PATH")
    port = int(os.environ.get("PORT", "443"))

    try:
        cert_exists = ssl_cert and Path(ssl_cert).exists()
        key_exists = ssl_key and Path(ssl_key).exists()
    except Exception:
        cert_exists = key_exists = False

    if cert_exists and key_exists:
        logger.info(f"Starting with SSL on port {port}")
        uvicorn.run(
            app,
            host="0.0.0.0",
            port=port,
            ssl_certfile=ssl_cert,
            ssl_keyfile=ssl_key,
            proxy_headers=True,
        )
    else:
        logger.info(f"Starting without SSL on port {port}")
        uvicorn.run(app, host="0.0.0.0", port=port, proxy_headers=True)

