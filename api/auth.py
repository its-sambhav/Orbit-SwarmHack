"""Minimal per-role access control - not a real user system (no per-person
accounts, no password reset, no refresh tokens). One shared password per
ROLE, not per entity: 543+ MPs and hundreds of districts/agencies makes
per-person credentials impractical to seed for a prototype. Picking a
specific entity (a state, a district, an MP, an agency) after the role
password issues a token scoped to exactly that one entity, and every
guarded endpoint actually checks a caller's token against the entity in
the URL - not just whether some token was presented.

Stdlib HMAC, not JWT: hmac+hashlib+base64+json+time cover the one real
guarantee needed here (tamper-evident, expiring, role+entity-scoped claim)
with no new dependency and none of JWT's algorithm-confusion surface.
"""
import base64
import hashlib
import hmac
import json
import os
import threading
import time
from collections import deque

import yaml
from dotenv import load_dotenv
from fastapi import Depends, Header, HTTPException

from engine.paths import CONFIG_DIR, ROOT

load_dotenv(ROOT / ".env")

AUTH_CONFIG_PATH = CONFIG_DIR / "auth.yaml"
TOKEN_TTL_SECONDS = 8 * 60 * 60  # one shift, no refresh flow
# a picker token proves the role password was right, but names no entity
# yet - it only unlocks the one list that role picks its entity from
PICKER_TTL_SECONDS = 10 * 60
# role -> the picker lists it may read (a district picks a state first)
PICKER_LISTS = {"state": {"states"}, "district": {"states", "districts"}, "mp": {"mps"}, "agency": {"agencies"}}

# failed logins per client and role inside the window before it locks
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 5 * 60

# the same sentence is a key in web/src/strings.js, so the frontend shows it
# in the reader's language
TOO_MANY_REQUESTS = "Too many requests. Wait a few minutes and try again."


def _secret() -> bytes:
    secret = os.environ.get("AUTH_SECRET")
    if not secret:
        raise RuntimeError(
            "AUTH_SECRET is not set - add it to .env (see .env.example). "
            "It signs every login token; the app refuses to start without it."
        )
    return secret.encode("utf-8")


def load_role_passwords() -> dict[str, str]:
    """config/auth.yaml's demo passwords, each overridable by an
    AUTH_PASSWORD_<ROLE> environment variable - a deployment sets its own
    there instead of shipping the committed demo ones."""
    with open(AUTH_CONFIG_PATH, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return {role: os.environ.get(f"AUTH_PASSWORD_{role.upper()}") or pw for role, pw in cfg["roles"].items()}


def verify_password(role: str, password: str) -> bool:
    expected = load_role_passwords().get(role)
    if expected is None:
        return False
    return hmac.compare_digest(expected, password)


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


_failures: dict[tuple[str, str], deque] = {}
_failures_lock = threading.Lock()


def _recent_failures(key: tuple[str, str], now: float) -> deque:
    q = _failures.setdefault(key, deque())
    while q and q[0] <= now - LOGIN_WINDOW_SECONDS:
        q.popleft()
    return q


def check_login_allowed(client: str, role: str) -> None:
    """429 once a client has failed LOGIN_MAX_FAILURES times for a role in
    the window - the role passwords are short and shared, so unthrottled
    guessing is the cheapest way in."""
    now = time.time()
    with _failures_lock:
        q = _recent_failures((client, role), now)
        if len(q) >= LOGIN_MAX_FAILURES:
            retry = int(q[0] + LOGIN_WINDOW_SECONDS - now) + 1
            raise HTTPException(429, "too many failed sign-in attempts - try again later",
                                headers={"Retry-After": str(retry)})


def record_login_failure(client: str, role: str) -> None:
    with _failures_lock:
        _recent_failures((client, role), time.time()).append(time.time())


def clear_login_failures(client: str, role: str) -> None:
    with _failures_lock:
        _failures.pop((client, role), None)


_hits: dict[tuple[str, str], deque] = {}
_hits_lock = threading.Lock()


def check_rate(bucket: str, client: str, limit: int, window: int) -> None:
    """429 once a client has made `limit` calls to `bucket` within `window`
    seconds. Guards the endpoints that call the paid LLM API: the sign-in page
    lists the demo passwords, so anyone could otherwise run up the bill."""
    now = time.time()
    with _hits_lock:
        if len(_hits) > 10_000:  # forget clients whose window has passed
            for key in [k for k, q in _hits.items() if not q or q[-1] <= now - window]:
                del _hits[key]
        q = _hits.setdefault((bucket, client), deque())
        while q and q[0] <= now - window:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(429, TOO_MANY_REQUESTS,
                                headers={"Retry-After": str(int(q[0] + window - now) + 1)})
        q.append(now)


def issue_token(role: str, entity: str | None, purpose: str = "session") -> str:
    ttl = PICKER_TTL_SECONDS if purpose == "picker" else TOKEN_TTL_SECONDS
    payload = {"role": role, "entity": entity, "purpose": purpose, "exp": int(time.time()) + ttl}
    payload_b64 = _b64encode(json.dumps(payload).encode("utf-8"))
    sig = hmac.new(_secret(), payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def _decode_token(token: str) -> dict:
    try:
        payload_b64, sig = token.split(".", 1)
        expected_sig = hmac.new(_secret(), payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_sig, sig):
            raise ValueError("bad signature")
        payload = json.loads(_b64decode(payload_b64))
        if payload["exp"] < time.time():
            raise ValueError("expired")
        return payload
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "invalid or expired session - please sign in again")


def _bearer_claims(authorization: str | None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "sign in required")
    return _decode_token(authorization[len("Bearer "):])


def get_current_claims(authorization: str | None = Header(default=None)) -> dict:
    """A signed-in session: a picker token is refused here, and so is any
    non-MoSPI token that names no entity (there'd be nothing to scope it to)."""
    claims = _bearer_claims(authorization)
    if claims.get("purpose", "session") != "session":
        raise HTTPException(401, "sign in required")
    if claims["role"] != "mospi" and not claims.get("entity"):
        raise HTTPException(401, "sign in required")
    return claims


def require_mospi(claims: dict = Depends(get_current_claims)) -> dict:
    if claims["role"] != "mospi":
        raise HTTPException(403, "this endpoint requires the 'mospi' role")
    return claims


def is_picker(claims: dict) -> bool:
    return claims.get("purpose") == "picker"


def session_or_picker(list_name: str):
    """Dependency factory for the entity-picker lists: any signed-in session
    (the endpoint decides which roles it serves), or a picker token whose
    role picks its entity from this list."""
    def _dependency(authorization: str | None = Header(default=None)) -> dict:
        claims = _bearer_claims(authorization)
        if is_picker(claims):
            if list_name not in PICKER_LISTS.get(claims["role"], set()):
                raise HTTPException(403, "this sign-in step can't read that list")
            return claims
        return get_current_claims(authorization)
    return _dependency


def require_picker_or_mospi(claims: dict) -> None:
    if not is_picker(claims) and claims["role"] != "mospi":
        raise HTTPException(403, "this endpoint requires the 'mospi' role")


def require_role(role: str):
    """Dependency factory - passes if the caller's token role matches, or
    if the caller is the mospi bypass super-role. MoSPI's own India-wide
    drill-down hits these same routes (/api/state/{name} etc.) that each
    role's own dashboard hits, so a flat role-must-match guard would lock
    MoSPI out of its own national view - it may view any state/district/
    mp/agency, entity checks below are skipped entirely for it."""
    def _dependency(claims: dict = Depends(get_current_claims)) -> dict:
        if claims["role"] != role and claims["role"] != "mospi":
            raise HTTPException(403, f"this endpoint requires the '{role}' role")
        return claims
    return _dependency


def check_entity(claims: dict, expected: str) -> None:
    if claims["role"] == "mospi":
        return
    actual = (claims.get("entity") or "").strip().casefold()
    if actual != (expected or "").strip().casefold():
        raise HTTPException(403, "this token is not scoped to that entity")


def check_work_access(claims: dict, work: dict) -> None:
    role = claims["role"]
    if role == "mospi":
        return
    if role == "state":
        check_entity(claims, work.get("STATE_NAME") or "")
    elif role == "district":
        check_entity(claims, f"{work.get('STATE_NAME') or ''}|{work.get('DISTRICT') or ''}")
    elif role == "mp":
        check_entity(claims, work.get("MP_NAME") or "")
    elif role == "agency":
        check_entity(claims, work.get("exp_top_ia") or "")
    else:
        raise HTTPException(403, "unrecognised role")
