from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel

from app.middleware.auth import Auth, StoreOnly

router = APIRouter()


@router.post("/dev-login")
async def dev_login(request: Request, response: Response, store: StoreOnly):
    """Create a local administrator session only while explicit LAN mode is active."""
    from app.core.config import settings

    if not settings.lan_mode:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    with store._connect() as connection:
        user = connection.execute(
            """
            SELECT u.id, u.display_name, u.email, m.organization_id, m.role
            FROM users u JOIN memberships m ON m.user_id = u.id
            WHERE u.id='local-admin' AND m.status='active' LIMIT 1
            """
        ).fetchone()
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No local administrator found")
    result = store._create_session(
        user,
        user["email"] or "admin@local.rackpilot",
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", ""),
    )
    store.audit(
        user["organization_id"],
        user["id"],
        user["role"],
        "dev_login",
        "session",
        None,
        "ok",
        request.client.host if request.client else None,
    )
    response.set_cookie("rp_session", result["token"], httponly=True, samesite="lax", max_age=72 * 3600)
    return {
        "token": result["token"],
        "role": result["role"],
        "userId": user["id"],
        "orgId": result["organizationId"],
        "name": user["display_name"],
        "email": user["email"],
    }


class LoginRequest(BaseModel):
    email: str
    password: str
    org: str | None = None


class LoginResponse(BaseModel):
    token: str
    role: str
    userId: str
    orgId: str
    mfaRequired: bool = False
    challengeToken: str | None = None


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, response: Response, store: StoreOnly):
    result = store.login(body.email, body.password, body.org)
    if not result:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if result.get("mfa_required"):
        return LoginResponse(
            token="", role="", userId="", orgId="",
            mfaRequired=True,
            challengeToken=result.get("challenge_token"),
        )

    token = result["token"]
    response.set_cookie("rp_session", token, httponly=True, samesite="lax", max_age=72 * 3600)
    return LoginResponse(
        token=token,
        role=result["role"],
        userId=result["user_id"],
        orgId=result["organization_id"],
    )


class MfaVerifyRequest(BaseModel):
    challengeToken: str
    code: str


@router.post("/mfa/verify", response_model=LoginResponse)
async def mfa_verify(body: MfaVerifyRequest, response: Response, store: StoreOnly):
    result = store.verify_mfa_challenge(body.challengeToken, body.code)
    if not result:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid MFA code")
    token = result["token"]
    response.set_cookie("rp_session", token, httponly=True, samesite="lax", max_age=72 * 3600)
    return LoginResponse(token=token, role=result["role"], userId=result["user_id"], orgId=result["organization_id"])


@router.post("/logout")
async def logout(ctx: Auth, response: Response):
    if ctx.token:
        ctx.store.logout_session(ctx.token)
    response.delete_cookie("rp_session")
    return {"ok": True}


@router.get("/me")
async def me(ctx: Auth):
    return {"userId": ctx.user_id, "role": ctx.role, "org": ctx.org}


@router.get("/mfa/status")
async def mfa_status(ctx: Auth):
    if not ctx.user_id:
        raise HTTPException(403, "Authenticated session required")
    return ctx.store.get_mfa_status(ctx.user_id)


class MfaEnrollRequest(BaseModel):
    pass


@router.post("/mfa/enroll")
async def mfa_enroll(ctx: Auth):
    if not ctx.user_id:
        raise HTTPException(403)
    email = ""  # TODO: fetch from user record
    return ctx.store.mfa_begin_enrollment(ctx.user_id, email)


class MfaConfirmRequest(BaseModel):
    code: str


@router.post("/mfa/confirm")
async def mfa_confirm(body: MfaConfirmRequest, ctx: Auth):
    if not ctx.user_id:
        raise HTTPException(403)
    backup_codes = ctx.store.mfa_confirm_enrollment(ctx.user_id, body.code)
    if backup_codes is None:
        raise HTTPException(400, "Invalid TOTP code")
    return {"backupCodes": backup_codes}


@router.post("/mfa/disable")
async def mfa_disable(ctx: Auth):
    if not ctx.user_id:
        raise HTTPException(403)
    ctx.store.mfa_disable(ctx.user_id)
    return {"ok": True}
