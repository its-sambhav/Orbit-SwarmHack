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
import time

import yaml
from dotenv import load_dotenv
from fastapi import Depends, Header, HTTPException

from engine.paths import CONFIG_DIR, ROOT

load_dotenv(ROOT / ".env")

AUTH_CONFIG_PATH = CONFIG_DIR / "auth.yaml"
TOKEN_TTL_SECONDS = 8 * 60 * 60  # one shift, no refresh flow


def _secret() -> bytes:
    secret = os.environ.get("AUTH_SECRET")
    if not secret:
        raise RuntimeError(
            "AUTH_SECRET is not set - add it to .env (see .env.example). "
            "It signs every login token; the app refuses to start without it."
        )
    return secret.encode("utf-8")


def load_role_passwords() -> dict[str, str]:
    with open(AUTH_CONFIG_PATH, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return cfg["roles"]


def verify_password(role: str, password: str) -> bool:
    expected = load_role_passwords().get(role)
    if expected is None:
        return False
    return hmac.compare_digest(expected, password)


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def issue_token(role: str, entity: str | None) -> str:
    payload = {"role": role, "entity": entity, "exp": int(time.time()) + TOKEN_TTL_SECONDS}
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


def get_current_claims(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "sign in required")
    return _decode_token(authorization[len("Bearer "):])


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
