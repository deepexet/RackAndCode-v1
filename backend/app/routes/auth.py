from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel

from app.middleware.auth import Auth, StoreOnly

router = APIRouter()


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
