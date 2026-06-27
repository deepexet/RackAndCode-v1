"""Session tokens, password hashing, permission helpers."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timezone, timedelta
from typing import Any

from app.core.config import settings


def generate_token(nbytes: int = 32) -> str:
    return secrets.token_hex(nbytes)


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return digest.hex(), salt


def verify_password(password: str, hashed: str, salt: str) -> bool:
    digest, _ = hash_password(password, salt)
    return hmac.compare_digest(digest, hashed)


def session_expires_at(ttl_hours: int | None = None) -> str:
    h = ttl_hours or settings.session_ttl_hours
    return (datetime.now(timezone.utc) + timedelta(hours=h)).isoformat()


def is_session_valid(expires_at: str) -> bool:
    try:
        exp = datetime.fromisoformat(expires_at)
        return datetime.now(timezone.utc) < exp
    except Exception:
        return False


# ── TOTP (RFC 6238) — no external dependency ──────────────────────────────

import base64
import struct
import time as _time


def _totp_generate(secret_b32: str, t: int | None = None, digits: int = 6, step: int = 30) -> str:
    t = t if t is not None else int(_time.time())
    counter = t // step
    key = base64.b32decode(secret_b32.upper() + "=" * (-len(secret_b32) % 8))
    msg = struct.pack(">Q", counter)
    h = hmac.new(key, msg, hashlib.sha1).digest()
    offset = h[-1] & 0x0F
    code = struct.unpack(">I", h[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10**digits)).zfill(digits)


def totp_verify(secret_b32: str, code: str, window: int = 1) -> bool:
    t = int(_time.time())
    step = 30
    for delta in range(-window, window + 1):
        if hmac.compare_digest(_totp_generate(secret_b32, t + delta * step), code):
            return True
    return False


def totp_new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
