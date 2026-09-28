"""Companies, users and invites — backed by Postgres (the `companies`,
`users`, `invites` tables from hasura/migrations/default/1730000000011_multi_tenant).

Credentials and brute-force lockout are owned by Keycloak (app/keycloak_admin.py)
— this module only tracks company_id/role bookkeeping and provisions the
matching Keycloak account whenever it creates a user, so the two stores never
drift apart. No password is ever stored here.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from psycopg.errors import CheckViolation, UniqueViolation

from . import keycloak_admin
from .db import get_conn

_ALLOWED_ROLES = {"finance_user", "approver", "admin"}
# Active seats per company — also enforced by the users_seat_limit trigger
# (migration 1730000000030); this copy exists for friendly errors + invites.
SEAT_LIMITS = {"admin": 1, "finance_user": 2, "approver": 2}
PLATFORM_COMPANY_ID = "00000000-0000-0000-0000-0000000000ff"
_SEAT_MSG = "no free {role} seat — deactivate an existing {role} first"
INVITE_TTL_DAYS = 7
MIN_PASSWORD_LENGTH = 8


@dataclass(frozen=True)
class User:
    id: str
    company_id: str
    username: str
    email: str
    role: str


@dataclass(frozen=True)
class Company:
    id: str
    name: str


@dataclass(frozen=True)
class Invite:
    id: str
    company_id: str
    email: str
    role: str
    token: str
    company_name: str


def _row_to_user(row: dict) -> User:
    return User(str(row["id"]), str(row["company_id"]), row["username"], row["email"], row["role"])


def lookup_user(username: str) -> User | None:
    """By username only — used to attach company_id/role to a session after
    Keycloak has already verified the person's identity (see apps/web/auth.ts's
    signIn callback, which calls GET /users/lookup)."""
    with get_conn() as conn:
        row = conn.execute(
            """SELECT u.* FROM users u JOIN companies c ON c.id = u.company_id
               WHERE u.username = %s AND u.is_active AND c.status = 'active' LIMIT 1""",
            (username,),
        ).fetchone()
    return _row_to_user(row) if row else None


def list_users(company_id: str) -> list[dict[str, str | bool]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT username, email, role, is_active FROM users WHERE company_id = %s ORDER BY created_at",
            (company_id,),
        ).fetchall()
    return [
        {"username": r["username"], "email": r["email"], "role": r["role"], "active": r["is_active"]}
        for r in rows
    ]


def set_user_active(company_id: str, username: str, active: bool) -> dict[str, str | bool]:
    with get_conn() as conn:
        try:
            row = conn.execute(
                "UPDATE users SET is_active = %s WHERE company_id = %s AND username = %s AND role <> 'super_admin' RETURNING username, email, role, is_active",
                (active, company_id, username),
            ).fetchone()
        except CheckViolation:
            raise ValueError("that role's seats are full — deactivate another user of the same role first") from None
    if row is None:
        raise ValueError(f"user '{username}' not found")
    return {"username": row["username"], "email": row["email"], "role": row["role"], "active": row["is_active"]}


def create_user(company_id: str, username: str, password: str, role: str, email: str) -> User:
    normalized_username = (username or "").strip()
    normalized_email = (email or "").strip().lower()
    if not normalized_username:
        raise ValueError("username is required")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"password must be at least {MIN_PASSWORD_LENGTH} characters")
    if role not in _ALLOWED_ROLES:
        raise ValueError(f"unsupported role: {role}")
    if not normalized_email or "@" not in normalized_email:
        raise ValueError("email is not valid")

    with get_conn() as conn:
        exists = conn.execute(
            "SELECT 1 FROM users WHERE company_id = %s AND username = %s",
            (company_id, normalized_username),
        ).fetchone()
        if exists:
            raise ValueError(f"user '{normalized_username}' already exists")
        try:
            row = conn.execute(
                """INSERT INTO users (company_id, username, email, role)
                   VALUES (%s, %s, %s, %s) RETURNING *""",
                (company_id, normalized_username, normalized_email, role),
            ).fetchone()
        except UniqueViolation:
            raise ValueError(f"email '{normalized_email}' already has an account") from None
        except CheckViolation:
            raise ValueError(_SEAT_MSG.format(role=role)) from None

        try:
            keycloak_admin.create_user(normalized_username, normalized_email, password)
        except keycloak_admin.KeycloakError:
            # Keep the two stores in sync — a user that only exists in
            # Postgres could never actually sign in.
            conn.execute("DELETE FROM users WHERE id = %s", (row["id"],))
            raise
    return _row_to_user(row)


def register_company(company_name: str, username: str, password: str, email: str) -> tuple[Company, User]:
    """Sign-up: a brand-new company plus its first (admin) user."""
    normalized_company = (company_name or "").strip()
    if not normalized_company:
        raise ValueError("company name is required")
    with get_conn() as conn:
        company_row = conn.execute(
            "INSERT INTO companies (name) VALUES (%s) RETURNING *",
            (normalized_company,),
        ).fetchone()
    company = Company(str(company_row["id"]), company_row["name"])
    user = create_user(company.id, username, password, "admin", email)
    return company, user


def create_invite(company_id: str, invited_by: str, email: str, role: str) -> Invite:
    normalized_email = (email or "").strip().lower()
    if not normalized_email or "@" not in normalized_email:
        raise ValueError("email is not valid")
    if role not in _ALLOWED_ROLES:
        raise ValueError(f"unsupported role: {role}")

    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(days=INVITE_TTL_DAYS)
    with get_conn() as conn:
        # Pending invites hold a seat too, else 5 invites could all be accepted
        # and the later ones would fail at sign-up instead of at invite time.
        taken = conn.execute(
            """SELECT (SELECT count(*) FROM users WHERE company_id = %(c)s AND role = %(r)s AND is_active)
                    + (SELECT count(*) FROM invites WHERE company_id = %(c)s AND role = %(r)s
                         AND accepted_at IS NULL AND expires_at > now()) AS n""",
            {"c": company_id, "r": role},
        ).fetchone()["n"]
        if taken >= SEAT_LIMITS[role]:
            raise ValueError(_SEAT_MSG.format(role=role))
        row = conn.execute(
            """INSERT INTO invites (company_id, email, role, token, invited_by, expires_at)
               VALUES (%s, %s, %s, %s, %s, %s) RETURNING *""",
            (company_id, normalized_email, role, token, invited_by, expires_at),
        ).fetchone()
        company = conn.execute("SELECT name FROM companies WHERE id = %s", (company_id,)).fetchone()
    return Invite(
        str(row["id"]), str(row["company_id"]), row["email"], row["role"], row["token"], company["name"]
    )


def accept_invite(token: str, username: str, password: str) -> User:
    with get_conn() as conn:
        invite = conn.execute(
            "SELECT * FROM invites WHERE token = %s",
            (token,),
        ).fetchone()
        if invite is None:
            raise ValueError("invite not found")
        if invite["accepted_at"] is not None:
            raise ValueError("invite already used")
        expires_at = invite["expires_at"]
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            raise ValueError("invite has expired")

        user = create_user(str(invite["company_id"]), username, password, invite["role"], invite["email"])
        conn.execute("UPDATE invites SET accepted_at = now() WHERE id = %s", (invite["id"],))
    return user


# --- platform (super_admin) -------------------------------------------------


def bootstrap_super_admin(username: str, email: str, password: str) -> None:
    """Idempotent: creates the first super admin (from env) if none exists."""
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM users WHERE role = 'super_admin' LIMIT 1").fetchone():
            return
        row = conn.execute(
            "INSERT INTO users (company_id, username, email, role) VALUES (%s, %s, %s, 'super_admin') RETURNING id",
            (PLATFORM_COMPANY_ID, username, email.lower()),
        ).fetchone()
        try:
            keycloak_admin.create_user(username, email, password)
        except keycloak_admin.KeycloakError:
            conn.execute("DELETE FROM users WHERE id = %s", (row["id"],))
            raise


def platform_overview() -> dict:
    with get_conn() as conn:
        c = conn.execute(
            """SELECT count(*) FILTER (WHERE status = 'active') AS active,
                      count(*) FILTER (WHERE status = 'suspended') AS suspended,
                      count(*) FILTER (WHERE status = 'deleted') AS deleted
               FROM companies WHERE id <> %s""",
            (PLATFORM_COMPANY_ID,),
        ).fetchone()
        u = conn.execute(
            "SELECT count(*) AS n FROM users WHERE is_active AND role <> 'super_admin'"
        ).fetchone()
        i = conn.execute("SELECT count(*) AS n, COALESCE(sum(amount), 0) AS total FROM invoices").fetchone()
        signups = conn.execute(
            """SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, count(*) AS n
               FROM companies WHERE id <> %s GROUP BY 1 ORDER BY 1 DESC LIMIT 12""",
            (PLATFORM_COMPANY_ID,),
        ).fetchall()
    return {
        "companies": dict(c),
        "users": u["n"],
        "invoices": i["n"],
        "invoice_volume": float(i["total"]),
        "signups_by_month": list(reversed([dict(s) for s in signups])),
    }


def platform_companies() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT c.id, c.name, c.status, c.created_at,
                      (SELECT count(*) FROM users u WHERE u.company_id = c.id AND u.is_active) AS users,
                      (SELECT count(*) FROM invoices i WHERE i.company_id = c.id) AS invoices,
                      (SELECT COALESCE(sum(amount), 0) FROM invoices i WHERE i.company_id = c.id) AS volume,
                      (SELECT max(created_at) FROM invoices i WHERE i.company_id = c.id) AS last_activity,
                      (SELECT username FROM users u WHERE u.company_id = c.id AND u.role = 'admin' AND u.is_active LIMIT 1) AS admin
               FROM companies c WHERE c.id <> %s ORDER BY c.created_at DESC""",
            (PLATFORM_COMPANY_ID,),
        ).fetchall()
    return [
        {**r, "id": str(r["id"]), "volume": float(r["volume"]),
         "created_at": r["created_at"].isoformat(),
         "last_activity": r["last_activity"].isoformat() if r["last_activity"] else None}
        for r in rows
    ]


def set_company_status(company_id: str, status: str) -> None:
    """Soft lifecycle: 'suspended' / 'deleted' block every sign-in for the
    company (lookup_user checks status); nothing is removed."""
    if status not in {"active", "suspended", "deleted"}:
        raise ValueError("bad status")
    with get_conn() as conn:
        row = conn.execute(
            """UPDATE companies SET status = %s, deleted_at = CASE WHEN %s = 'deleted' THEN now() END
               WHERE id = %s AND id <> %s RETURNING id""",
            (status, status, company_id, PLATFORM_COMPANY_ID),
        ).fetchone()
    if row is None:
        raise ValueError("company not found")


def platform_company_users(company_id: str) -> list[dict]:
    return list_users(company_id)


def delete_user(company_id: str, username: str) -> None:
    """Hard-delete a user (row + Keycloak account). Super admins can't be deleted here."""
    with get_conn() as conn:
        row = conn.execute(
            "DELETE FROM users WHERE company_id = %s AND username = %s AND role <> 'super_admin' RETURNING username",
            (company_id, username),
        ).fetchone()
    if row is None:
        raise ValueError(f"user '{username}' not found")
    keycloak_admin.delete_user_by_username(username)


def transfer_admin(company_id: str, new_admin_username: str) -> None:
    """Move the single admin seat to an existing user of the same company; the
    old admin is deactivated (they left)."""
    with get_conn() as conn, conn.transaction():
        new = conn.execute(
            "SELECT id, role FROM users WHERE company_id = %s AND username = %s AND role <> 'super_admin'",
            (company_id, new_admin_username),
        ).fetchone()
        if new is None:
            raise ValueError(f"user '{new_admin_username}' not found")
        if new["role"] == "admin":
            raise ValueError("that user is already the admin")
        conn.execute(
            "UPDATE users SET is_active = false WHERE company_id = %s AND role = 'admin' AND is_active",
            (company_id,),
        )
        conn.execute("UPDATE users SET role = 'admin', is_active = true WHERE id = %s", (new["id"],))
