"""FastAPI dependency that resolves the current session and organization."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from app.core.config import settings
from app.store import WorkspaceStore


# ── Shared store singleton ────────────────────────────────────────────────

_store: WorkspaceStore | None = None


def get_store() -> WorkspaceStore:
    global _store
    if _store is None:
        _store = WorkspaceStore(str(settings.db_path))
    return _store


# ── Session context ───────────────────────────────────────────────────────

@dataclass
class SessionContext:
    org: str
    user_id: str | None
    role: str
    token: str | None
    store: WorkspaceStore


async def get_session(
    request: Request,
    store: WorkspaceStore = Depends(get_store),
    x_rackpilot_role: str | None = Header(default=None),
) -> SessionContext:
    """Resolve session from cookie or Authorization header."""
    # --- token from Authorization header or cookie ---
    token: str | None = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        token = request.cookies.get("rp_session")

    org = settings.default_org
    user_id: str | None = None
    role = "Administrator"  # fallback dev-mode default

    if token:
        session = store.validate_session(token)
        if not session:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired or invalid")
        org = session.get("organization_id", org)
        user_id = session.get("user_id")
        role = session.get("role", "Technician")
    elif settings.lan_mode and x_rackpilot_role:
        # Dev-mode role preview header (LAN only)
        role = x_rackpilot_role

    return SessionContext(org=org, user_id=user_id, role=role, token=token, store=store)


Auth = Annotated[SessionContext, Depends(get_session)]
StoreOnly = Annotated[WorkspaceStore, Depends(get_store)]
