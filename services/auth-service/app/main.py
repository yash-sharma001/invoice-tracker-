"""auth-service — Postgres-backed company/role bookkeeping + a thin Keycloak
admin-API proxy for provisioning, issuing Hasura-shaped JWTs.

  POST /register         {company_name, username, email, password} -> TokenResponse (new company + admin)
  POST /refresh          Authorization: Bearer ..  -> a fresh token (while the old one is still valid)
  GET  /me               Authorization: Bearer ..  -> decoded claims
  GET  /users            Authorization: Bearer ..  -> this admin's company's users
  POST /users            Authorization: Bearer ..  -> create a user directly, in this admin's company
  POST /invites          Authorization: Bearer ..  -> invite a teammate by email (admin only)
  POST /invites/accept   {token, username, password} -> TokenResponse (joins the inviting company)
  GET  /users/lookup     X-Internal-Token          -> {company_id, role} for a Keycloak-verified username
  GET  /health

Sign-in itself is Keycloak's job now (apps/web/auth.ts redirects there) —
this service no longer checks a password anywhere. Every route above that
creates an account (register / create_user / accept_invite) also provisions
the matching Keycloak account (see app/keycloak_admin.py), and /users/lookup
is how the BFF turns "Keycloak says this is user X" into this app's
company_id/role for that user.

The token carries the `https://hasura.io/jwt/claims` block Hasura expects
(now including `x-hasura-company-id`); send it as `Authorization: Bearer
<token>` to Hasura (or set NEXT_PUBLIC_HASURA_JWT in the web app).
"""

from __future__ import annotations

import logging
import os

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from shared_types.auth import require_internal_token
from shared_types.logging import configure_logging
from shared_types.secrets_check import assert_production_secrets_configured
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from shared_types.jwt import decode_hasura_jwt, mint_hasura_jwt

from .email import send_invite_email
from .users import (
    User,
    accept_invite,
    bootstrap_super_admin,
    create_invite,
    create_user,
    delete_user,
    list_users,
    lookup_user,
    platform_companies,
    platform_company_users,
    platform_overview,
    register_company,
    set_company_status,
    set_user_active,
    transfer_admin,
)

TTL_SECONDS = int(os.getenv("AUTH_TOKEN_TTL_SECONDS", "3600"))

# Hasura's role literally named "admin" is a reserved super-role that bypasses
# every permission check (including company_id filtering) regardless of what
# permissions are or aren't configured for it — so the app's own "admin"
# business role must never be minted as Hasura role "admin", or every admin
# account (which is exactly what every company's registration creates) would
# see every other company's data. "company_admin" is a normal, permissioned
# Hasura role (see hasura/metadata) scoped by company_id like any other.
_HASURA_ROLE = {"admin": "company_admin"}

configure_logging("auth-service")
assert_production_secrets_configured(
    "HASURA_GRAPHQL_JWT_SECRET", "INTERNAL_SERVICE_TOKEN", "KEYCLOAK_ADMIN_CLIENT_SECRET",
)
app = FastAPI(title="auth-service", version="0.3.0")


@app.on_event("startup")
def _seed_super_admin() -> None:
    # First platform owner comes from env (no credentials in the realm export).
    # Idempotent: does nothing once any super_admin exists.
    u, e, p = (os.getenv(k, "") for k in ("SUPER_ADMIN_USERNAME", "SUPER_ADMIN_EMAIL", "SUPER_ADMIN_PASSWORD"))
    if u and e and p:
        try:
            bootstrap_super_admin(u, e, p)
        except Exception:  # e.g. email already used by another account — never block startup on this
            logging.getLogger("auth-service").exception("super admin seeding failed — fix SUPER_ADMIN_* and restart")

# Called from the browser (register / invite-accept pages — login itself is a
# redirect to Keycloak now, not a call here). Deny-by-default: an unset
# AUTH_CORS_ORIGINS in prod fails closed instead of falling back to "*".
_cors_origins = [o for o in os.getenv("AUTH_CORS_ORIGINS", "").split(",") if o]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Keycloak has its own brute-force protection on the credentials themselves
# (see infra/keycloak/realm-export.json's bruteForceProtected) — this limiter
# instead caps the account-creation endpoints, which have no such built-in
# protection of their own.
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


class RegisterRequest(BaseModel):
    company_name: str
    username: str
    email: str
    password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str
    email: str = ""


class SetActiveRequest(BaseModel):
    active: bool


class InviteRequest(BaseModel):
    email: str
    role: str


class AcceptInviteRequest(BaseModel):
    token: str
    username: str
    password: str


class UserResponse(BaseModel):
    username: str
    role: str
    email: str = ""


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    expires_in: int
    role: str


class InviteResponse(BaseModel):
    email: str
    role: str
    invite_link: str


def _mint(user: User) -> TokenResponse:
    hasura_role = _HASURA_ROLE.get(user.role, user.role)
    token = mint_hasura_jwt(
        hasura_role,
        user.username,
        ttl_seconds=TTL_SECONDS,
        extra_claims={"app_role": user.role},
        extra_hasura_claims={"x-hasura-company-id": user.company_id},
    )
    return TokenResponse(access_token=token, expires_in=TTL_SECONDS, role=user.role)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/register", response_model=TokenResponse)
@limiter.limit("5/minute")
def register(request: Request, req: RegisterRequest) -> TokenResponse:
    try:
        _company, user = register_company(req.company_name, req.username, req.password, req.email)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _mint(user)


@app.get("/users/lookup")
def users_lookup(username: str, _: None = Depends(require_internal_token)) -> dict:
    user = lookup_user(username)
    if user is None:
        raise HTTPException(404, "unknown user")
    return {"company_id": user.company_id, "role": user.role}


@app.get("/users")
def users(authorization: str = Header(default="")) -> dict:
    company_id = _require_admin(authorization)
    return {"users": list_users(company_id)}


@app.post("/users", response_model=UserResponse)
def create_user_route(req: CreateUserRequest, authorization: str = Header(default="")) -> UserResponse:
    company_id = _require_admin(authorization)
    try:
        user = create_user(company_id, req.username, req.password, req.role, req.email)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return UserResponse(username=user.username, role=user.role, email=user.email)


@app.patch("/users/{username}")
def set_user_active_route(username: str, req: SetActiveRequest, authorization: str = Header(default="")) -> dict:
    company_id = _require_admin(authorization)
    claims = _claims_from(authorization)
    caller_username = claims.get("https://hasura.io/jwt/claims", {}).get("x-hasura-user-id", "")
    if not req.active and username == caller_username:
        raise HTTPException(400, "You can't deactivate your own account")
    try:
        return set_user_active(company_id, username, req.active)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post("/invites", response_model=InviteResponse)
def create_invite_route(req: InviteRequest, authorization: str = Header(default="")) -> InviteResponse:
    company_id = _require_admin(authorization)
    claims = _claims_from(authorization)
    invited_by_username = claims.get(
        "https://hasura.io/jwt/claims", {}
    ).get("x-hasura-user-id", "")
    try:
        invite = create_invite(company_id, invited_by_username, req.email, req.role)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    link = send_invite_email(invite.email, invite.token, company_name=invite.company_name)
    return InviteResponse(email=invite.email, role=invite.role, invite_link=link)


@app.post("/invites/accept", response_model=TokenResponse)
@limiter.limit("5/minute")
def accept_invite_route(request: Request, req: AcceptInviteRequest) -> TokenResponse:
    try:
        user = accept_invite(req.token, req.username, req.password)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _mint(user)


@app.get("/me")
def me(authorization: str = Header(default="")) -> dict:
    return _claims_from(authorization)


@app.post("/refresh", response_model=TokenResponse)
def refresh(authorization: str = Header(default="")) -> TokenResponse:
    """Re-issue a token while the current one is still valid. Once it has
    expired the client must log in again (no offline grace — keep it simple)."""
    claims = _claims_from(authorization)
    ns = claims.get("https://hasura.io/jwt/claims", {})
    hasura_role = ns.get("x-hasura-default-role", "")
    app_role = claims.get("app_role", hasura_role)  # older tokens predating app_role
    user_id = ns.get("x-hasura-user-id") or claims.get("sub", "")
    company_id = ns.get("x-hasura-company-id", "")
    if not (hasura_role and user_id and company_id):
        raise HTTPException(401, "token missing hasura claims")
    token = mint_hasura_jwt(
        hasura_role,
        user_id,
        ttl_seconds=TTL_SECONDS,
        extra_claims={"app_role": app_role},
        extra_hasura_claims={"x-hasura-company-id": company_id},
    )
    return TokenResponse(access_token=token, expires_in=TTL_SECONDS, role=app_role)


def _claims_from(authorization: str) -> dict:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing Bearer token")
    try:
        return decode_hasura_jwt(authorization.split(" ", 1)[1])
    except Exception as exc:  # expired / bad signature -> 401, not 500
        raise HTTPException(401, f"invalid token: {exc}")


def _require_admin(authorization: str) -> str:
    """Returns the caller's company_id if they're an admin, else 403s."""
    claims = _claims_from(authorization)
    if claims.get("app_role") != "admin":
        raise HTTPException(403, "admin role required")
    ns = claims.get("https://hasura.io/jwt/claims", {})
    company_id = ns.get("x-hasura-company-id")
    if not company_id:
        raise HTTPException(401, "token missing company")
    return company_id


def _require_super_admin(authorization: str) -> None:
    if _claims_from(authorization).get("app_role") != "super_admin":
        raise HTTPException(403, "super_admin role required")


class CompanyStatusRequest(BaseModel):
    status: str


class TransferAdminRequest(BaseModel):
    username: str


def _bad_request(fn, *args):
    try:
        return fn(*args)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/platform/overview")
def platform_overview_route(authorization: str = Header(default="")) -> dict:
    _require_super_admin(authorization)
    return platform_overview()


@app.get("/platform/companies")
def platform_companies_route(authorization: str = Header(default="")) -> dict:
    _require_super_admin(authorization)
    return {"companies": platform_companies()}


@app.get("/platform/companies/{company_id}/users")
def platform_company_users_route(company_id: str, authorization: str = Header(default="")) -> dict:
    _require_super_admin(authorization)
    return {"users": platform_company_users(company_id)}


@app.patch("/platform/companies/{company_id}")
def platform_company_status_route(company_id: str, req: CompanyStatusRequest, authorization: str = Header(default="")) -> dict:
    _require_super_admin(authorization)
    _bad_request(set_company_status, company_id, req.status)
    return {"ok": True}


@app.delete("/platform/companies/{company_id}")
def platform_delete_company_route(company_id: str, authorization: str = Header(default="")) -> dict:
    _require_super_admin(authorization)
    _bad_request(set_company_status, company_id, "deleted")  # soft delete
    return {"ok": True}


@app.delete("/platform/companies/{company_id}/users/{username}")
def platform_delete_user_route(company_id: str, username: str, authorization: str = Header(default="")) -> dict:
    _require_super_admin(authorization)
    _bad_request(delete_user, company_id, username)
    return {"ok": True}


@app.post("/platform/companies/{company_id}/transfer-admin")
def platform_transfer_admin_route(company_id: str, req: TransferAdminRequest, authorization: str = Header(default="")) -> dict:
    _require_super_admin(authorization)
    _bad_request(transfer_admin, company_id, req.username)
    return {"ok": True}
