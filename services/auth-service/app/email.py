"""Invite email delivery — same SMTP_*/EMAIL_* env vars and log-fallback
behavior as services/notification-service/app/notify.py's send_direct_email,
copied rather than imported since auth-service doesn't otherwise depend on
notification-service."""

from __future__ import annotations

import logging
import os
import smtplib
from email.message import EmailMessage
from pathlib import Path

log = logging.getLogger("auth-service")

WEB_URL = os.getenv("WEB_URL", "http://localhost:3000")


def _load_env_fallback() -> None:
    if os.getenv("SMTP_HOST"):
        return
    search_paths = [
        Path(__file__).resolve().parents[3] / "infra" / ".env",
        Path(__file__).resolve().parents[2] / "infra" / ".env",
        Path("/app/infra/.env"),
        Path("infra/.env"),
        Path(".env"),
    ]
    for p in search_paths:
        if p.is_file():
            try:
                for line in p.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        if k and k not in os.environ:
                            os.environ[k] = v.strip()
            except Exception:
                pass
            if os.getenv("SMTP_HOST"):
                break


def send_invite_email(to_email: str, token: str, company_name: str) -> str:
    link = f"{WEB_URL}/accept-invite?token={token}"
    subject = f"You're invited to {company_name} on Qlens"
    body = f"You've been invited to join {company_name} on Qlens.\n\nAccept your invite:\n{link}\n\nThis link expires in 7 days."

    _load_env_fallback()
    host = os.getenv("SMTP_HOST", "")
    if not host:
        log.warning("SMTP_HOST unset — invite not emailed, link: %s", link)
        return link

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.getenv("EMAIL_FROM", os.getenv("SMTP_USER", "invites@localhost"))
    msg["To"] = to_email
    msg.set_content(body)
    try:
        with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", "587")), timeout=15) as s:
            if os.getenv("SMTP_STARTTLS", "1") not in ("0", "false", ""):
                s.starttls()
            user = os.getenv("SMTP_USER", "")
            if user:
                s.login(user, os.getenv("SMTP_PASSWORD", ""))
            s.send_message(msg)
    except (smtplib.SMTPException, OSError) as exc:
        log.error("Invite email to %s failed (%s) — link: %s", to_email, exc, link)
    return link
