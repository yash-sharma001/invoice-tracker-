"""Outbound email + digest formatting. Every recipient is explicit: a company's
digest goes to that company's own `digest_emails`, the platform's leads mail to
PLATFORM_EMAIL_TO. There is no global recipient list.

  SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... SMTP_STARTTLS=1 EMAIL_FROM=...
"""

from __future__ import annotations

import logging
import os
import smtplib
from email.message import EmailMessage
from pathlib import Path

log = logging.getLogger("notification-service")


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



def send_direct_email(
    to: str,
    subject: str,
    body: str,
    attachment: tuple[str, bytes, str] | None = None,
) -> bool:
    """One-off email to an explicit recipient (a vendor, a customer) — separate
    Uses the SMTP_* env vars; logs and returns False when unconfigured. Returns whether it sent.

    `attachment`, when given, is (filename, bytes, content_type) — e.g.
    ("invoice.pdf", pdf_bytes, "application/pdf")."""
    if not to:
        return False
    _load_env_fallback()
    host = os.getenv("SMTP_HOST", "")
    if not host:
        log.warning(
            "SMTP_HOST unset — email to %s not sent (subject: %s%s)",
            to,
            subject,
            f", attachment: {attachment[0]}" if attachment else "",
        )
        return False
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.getenv("EMAIL_FROM", os.getenv("SMTP_USER", "") or "ap-bot@localhost")
    msg["To"] = to
    msg.set_content(body)
    if attachment:
        filename, data, content_type = attachment
        maintype, _, subtype = content_type.partition("/")
        msg.add_attachment(data, maintype=maintype or "application", subtype=subtype or "octet-stream", filename=filename)
    try:
        with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", "587")), timeout=5) as s:
            if os.getenv("SMTP_STARTTLS", "1") not in ("0", "false", ""):
                s.starttls()
            user = os.getenv("SMTP_USER", "")
            if user:
                s.login(user, os.getenv("SMTP_PASSWORD", ""))
            s.send_message(msg)
        return True
    except (smtplib.SMTPException, OSError) as exc:
        log.error("Email to %s failed (%s):\n%s\n%s", to, exc, subject, body)
        return False


def format_digest(rows: list[dict]) -> tuple[str, str]:
    if not rows:
        return "Overdue sweep: nothing overdue", "All invoices are within terms."
    by_vendor: dict[str, list[dict]] = {}
    for r in rows:
        by_vendor.setdefault(r["vendor"]["name"], []).append(r)
    total = sum(float(r["amount"]) for r in rows)
    lines = [f"{len(rows)} invoices newly overdue — ₹{total:,.0f} total", ""]
    for vendor, items in sorted(by_vendor.items(), key=lambda kv: -sum(float(i["amount"]) for i in kv[1])):
        vt = sum(float(i["amount"]) for i in items)
        lines.append(f"  {vendor}: {len(items)} invoice(s), ₹{vt:,.0f}")
        for i in items:
            lines.append(f"    - {i['invoice_number']} due {i['due_date']} · ₹{float(i['amount']):,.0f}")
    return f"Overdue sweep: {len(rows)} invoices flagged", "\n".join(lines)
