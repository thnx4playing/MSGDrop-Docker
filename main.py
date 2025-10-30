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
    with engine.begin() as conn:
        conn.exec_driver_sql("""
        create table if not exists messages(
            id text primary key,
            drop_id text not null,
            ts integer not null,
            user text,
            text text,
            blob_id text,
            mime text
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

    ui_parts = [f"{UI_COOKIE}=true", "Secure", "Path=/", "SameSite=Lax"]
    if COOKIE_DOMAIN: ui_parts.append(f"Domain={COOKIE_DOMAIN}")
    ui_cookie = "; ".join(ui_parts)
    return [sess_cookie, ui_cookie]

def require_session(req: Request):
    c = req.cookies.get(SESSION_COOKIE)
    if not c: raise HTTPException(401, "no session")
    import base64
    try:
        raw = c + "==="  # restore padding best-effort
        blob = base64.urlsafe_b64decode(raw)
        dot = blob.find(b".")
        if dot <= 0: raise ValueError("bad token")
        payload, mac = blob[:dot], blob[dot+1:]
        if not hmac.compare_digest(sign(payload), mac): raise ValueError("bad sig")
        data = json.loads(payload.decode("utf-8"))
        if int(time.time()) > int(data.get("exp", 0)): raise ValueError("expired")
    except Exception:
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

@app.post("/api/unlock")
def unlock(body: UnlockBody, req: Request):
    code = (body.code or "").strip()
    if not (len(code) == 4 and code.isdigit()):
        raise HTTPException(400, "PIN must be 4 digits")
    if not verify_code(code):
        raise HTTPException(401, "invalid code")
    cookies = issue_cookies()
    headers = {"Set-Cookie": ", ".join(cookies)}
    return JSONResponse({"success": True}, headers=headers)

# --- Chat APIs ---
@app.get("/api/chat/{drop_id}")
def list_messages(drop_id: str, limit: int = 10, before: Optional[int] = None, req: Request = None):
    require_session(req)
    sql = "select * from messages where drop_id=:d"
    params = {"d": drop_id}
    if before:
        sql += " and ts < :b"; params["b"] = before
    sql += " order by ts desc limit :n"; params["n"] = max(1, min(200, limit))
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
        conn.execute(text("""
          insert into messages(id,drop_id,ts,user,text,blob_id,mime)
          values(:id,:d,:ts,:u,:tx,:b,:m)
        """), {"id": msg_id, "d": drop_id, "ts": ts, "u": user, "tx": text_, "b": blob_id, "m": mime})

    await hub.broadcast(drop_id, {
        "type": "update",
        "message": {
            "id": msg_id, "drop_id": drop_id, "ts": ts, "user": user, "text": text_,
            "blob_id": blob_id, "mime": mime, "img": (f"/blob/{blob_id}" if blob_id else None)
        }
    })
    return {"ok": True, "id": msg_id, "ts": ts}

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
    drop = params.get("drop") or "default"
    # optional strictness
    edge = params.get("edge")
    if EDGE_AUTH_TOKEN and edge != EDGE_AUTH_TOKEN:
        await ws.close(code=4401)
        return

    await hub.join(drop, ws)
    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("type")
            if t == "typing":
                await hub.broadcast(drop, msg)
            elif t == "ping":
                await ws.send_json({"type": "pong", "ts": int(time.time()*1000)})
            elif t == "notify":
                notify(f"{msg}")
            else:
                pass
    except WebSocketDisconnect:
        await hub.leave(drop, ws)

# --- Static UI: serve /msgdrop
app.mount("/msgdrop", StaticFiles(directory="html", html=True), name="msgdrop")


