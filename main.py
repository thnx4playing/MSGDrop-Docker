import os, json, hmac, hashlib, time, secrets, mimetypes
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Request, HTTPException
from fastapi.responses import JSONResponse, FileResponse
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
EDGE_AUTH_TOKEN = _cfg.get("edgeAuthToken", "")  # optional in mono mode
NOTIFY_NUMBERS  = _cfg.get("notify_numbers", [])

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

# --- Simple notifications (console only in mono mode) ---
def notify(text: str):
    print(f"[notify] {text}")

# --- Cookies / session ---
def b64url(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

def sign(payload: bytes) -> bytes:
    return hmac.new(SESSION_SIGN_KEY_BYTES, payload, hashlib.sha256).digest()

def issue_cookies() -> List[str]:
    exp = int(time.time()) + SESSION_TTL
    payload = json.dumps({"exp": exp}, separators=(",", ":")).encode("utf-8")
    sig = sign(payload)
    token = b64url(payload + b"." + sig)
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
        if int(time.time()) > int(data.get("exp", 0)):
            return False
        return True
    except Exception:
        return False

def require_session(req: Request):
    c = req.cookies.get(SESSION_COOKIE)
    if not c: raise HTTPException(401, "no session")
    if not _verify_token(c):
        raise HTTPException(401, "bad session")

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

@app.post("/api/unlock")
def unlock(body: UnlockBody, req: Request):
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
    cookies = issue_cookies()
    headers = {"Set-Cookie": ", ".join(cookies)}
    return JSONResponse({"success": True}, headers=headers)

# --- Chat APIs ---
@app.get("/api/chat/{drop_id}")
def list_messages(drop_id: str, limit: int = 200, before: Optional[int] = None, req: Request = None):
    require_session(req)
    sql = "select * from messages where drop_id=:d"
    params = {"d": drop_id}
    if before:
        sql += " and ts < :b"; params["b"] = before
    sql += " order by seq desc limit :n"; params["n"] = max(1, min(500, limit))
    with engine.begin() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
    rows = list(reversed(rows))
    out = []
    images = []
    for r in rows:
        o = dict(r)
        if o.get("blob_id"):
            o["img"] = f"/blob/{o['blob_id']}"
            images.append({
                "id": o["blob_id"],
                "mime": o.get("mime"),
                "url": o["img"],
                "ts": o.get("ts")
            })
        out.append(o)
    return {"dropId": drop_id, "messages": out, "images": images}

@app.post("/api/chat/{drop_id}")
async def post_message(drop_id: str,
                       text_: Optional[str] = Form(default=None),
                       user: Optional[str] = Form(default=None),
                       file: Optional[UploadFile] = File(default=None),
                       req: Request = None):
    require_session(req)
    ts = int(time.time() * 1000)
    msg_id = secrets.token_hex(8)
    blob_id, mime = None, None

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

    with engine.begin() as conn:
        # allocate next seq per drop
        row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop_id}).mappings().first()
        next_seq = int(row["next"]) if row else 1
        now_ms = ts
        conn.execute(text("""
          insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,blob_id,mime,reactions)
          values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:b,:m,:rx)
        """), {"id": msg_id, "d": drop_id, "seq": next_seq, "ts": ts, "ca": now_ms, "ua": now_ms,
                "u": user, "cid": None, "mt": ("image" if blob_id else "text"), "tx": text_, "b": blob_id, "m": mime, "rx": "{}"})

    await hub.broadcast(drop_id, {
        "type": "update",
        "message": {
            "id": msg_id, "drop_id": drop_id, "seq": next_seq, "ts": ts, "user": user, "text": text_,
            "blob_id": blob_id, "mime": mime, "img": (f"/blob/{blob_id}" if blob_id else None)
        }
    })
    return {"ok": True, "id": msg_id, "seq": next_seq, "ts": ts}

# --- Message edit/delete/react and image delete ---
from fastapi import Body

@app.patch("/api/chat/{drop_id}")
async def edit_message(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
    seq = body.get("seq")
    text_val = body.get("text")
    if seq is None or text_val is None:
        raise HTTPException(400, "seq and text required")
    now_ms = int(time.time() * 1000)
    with engine.begin() as conn:
        conn.execute(text("update messages set text=:t, updated_at=:u where drop_id=:d and seq=:s"),
                     {"t": text_val, "u": now_ms, "d": drop_id, "s": seq})
    await hub.broadcast(drop_id, {"type": "update"})
    return {"ok": True}

@app.delete("/api/chat/{drop_id}")
async def delete_message(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
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
    return {"ok": True}

@app.post("/api/chat/{drop_id}/react")
async def react_message(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
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
    return {"ok": True}

@app.delete("/api/chat/{drop_id}/images/{image_id}")
async def delete_image(drop_id: str, image_id: str, req: Request = None):
    require_session(req)
    # Delete any messages that reference this blob in this drop
    with engine.begin() as conn:
        conn.execute(text("delete from messages where drop_id=:d and blob_id=:b"), {"d": drop_id, "b": image_id})
    try:
        (BLOB_DIR / image_id).unlink(missing_ok=True)
    except Exception:
        pass
    await hub.broadcast(drop_id, {"type": "update"})
    return {"ok": True}

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
        return {"streakDays": 0, "users": [], "today": {"both": False}, "days": []}
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
        return {"streakDays": 0, "users": users, "today": {"both": False}, "days": []}
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
    return {"streakDays": streak, "users": users, "today": {"both": today_both}, "days": days_detail}

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
        await self.broadcast(drop_id, {"type": "presence", "online": self._online(drop_id)})

    async def leave(self, drop_id: str, ws: WebSocket):
        try:
            del self.rooms.get(drop_id, {})[ws]
            if not self.rooms.get(drop_id): self.rooms.pop(drop_id, None)
        except KeyError:
            pass
        await self.broadcast(drop_id, {"type": "presence", "online": self._online(drop_id)})

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

hub = Hub()

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    params = dict(ws.query_params)
    # verify session token from query
    session_token = params.get("sessionToken") or params.get("sess")
    if not session_token or not _verify_token(session_token):
        await ws.close(code=1008)
        return

    drop = params.get("drop") or params.get("dropId") or "default"
    # optional strictness via edge token
    edge = params.get("edge")
    if EDGE_AUTH_TOKEN and edge != EDGE_AUTH_TOKEN:
        await ws.close(code=4401)
        return

    user = params.get("user") or "anon"
    await hub.join(drop, ws, user)
    try:
        while True:
            msg = await ws.receive_json()
            # Support both type/action styles
            t = msg.get("type") or msg.get("action")
            payload = msg.get("payload") or msg
            if t == "typing":
                await hub.broadcast(drop, {"type": "typing", "payload": payload})
            elif t == "ping":
                await ws.send_json({"type": "pong", "ts": int(time.time()*1000)})
            elif t == "notify":
                notify(f"{msg}")
            elif t == "presence" or t == "presence_request":
                await hub.broadcast(drop, {"type": t, "payload": payload, "online": hub._online(drop)})
            elif t == "game":
                # passthrough game events for now
                await hub.broadcast(drop, {"type": "game", "payload": payload})
            else:
                # Unrecognized events are ignored
                pass
    except WebSocketDisconnect:
        await hub.leave(drop, ws)

# --- Static UI: serve /msgdrop
app.mount("/msgdrop", StaticFiles(directory="html", html=True), name="msgdrop")


