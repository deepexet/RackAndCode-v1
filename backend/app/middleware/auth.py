"""FastAPI dependency that resolves the current session and organization."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, status

from app.core.config import settings
from app.store import ROLE_POLICIES, WorkspaceStore, role_can


# ── Shared store singleton ────────────────────────────────────────────────

_store: WorkspaceStore | None = None


def get_store() -> WorkspaceStore:
    global _store
    if _store is None:
        _store = WorkspaceStore(settings.db_path)
    return _store


# ── Session context ───────────────────────────────────────────────────────

@dataclass
class SessionContext:
    org: str
    user_id: str | None
    role: str
    token: str | None
    store: WorkspaceStore
    role_preview: bool = False


async def get_session(
    store: WorkspaceStore = Depends(get_store),
    x_rackpilot_role: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
    rp_session: str | None = Cookie(default=None),
) -> SessionContext:
    """Resolve session from cookie or Authorization header."""
    # --- token from Authorization header or cookie ---
    token: str | None = None
    auth_header = authorization or ""
    if auth_header.startswith("Bearer "):
        token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        token = rp_session

    org = settings.default_org
    user_id: str | None = None
    role = "Technician"
    role_preview = False

    if token:
        session = store.validate_session(token)
        if not session:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired or invalid")
        org = session.get("organizationId", org)
        user_id = session.get("userId")
        role = session.get("role", "Technician")
    elif settings.lan_mode and x_rackpilot_role:
        # Dev-mode role preview header (LAN only)
        role = x_rackpilot_role
        role_preview = True

    return SessionContext(
        org=org,
        user_id=user_id,
        role=role,
        token=token,
        store=store,
        role_preview=role_preview,
    )


Auth = Annotated[SessionContext, Depends(get_session)]
StoreOnly = Annotated[WorkspaceStore, Depends(get_store)]


def require_permission(ctx: SessionContext, permission: str) -> None:
    """Enforce the shared legacy/FastAPI role policy during migration."""
    if not ctx.user_id and not (settings.lan_mode and ctx.role_preview):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "authentication_required"},
        )
    if ctx.role not in ROLE_POLICIES or not role_can(ctx.role, permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "permission": permission},
        )
