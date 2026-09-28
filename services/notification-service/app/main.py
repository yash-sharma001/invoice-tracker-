"""notification-service — target of the `overdue_sweep_daily` Hasura cron trigger.

  POST /customer-reminders -> email customers overdue receivables, every 2 days until paid
  POST /overdue-sweep   -> mark unpaid past-due invoices `overdue`, send a digest
  GET  /health
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from datetime import date, datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel
from shared_types.auth import require_internal_token
from shared_types.logging import configure_logging
from shared_types.secrets_check import assert_production_secrets_configured

from . import queue as outbound_queue
from .hasura import HasuraError, find_companies, find_due_reminders, find_past_due, mark_overdue, mark_reminded
from .notify import format_digest, send_direct_email

configure_logging("notification-service")
log = logging.getLogger("notification-service")
assert_production_secrets_configured("HASURA_GRAPHQL_JWT_SECRET", "INTERNAL_SERVICE_TOKEN")
app = FastAPI(title="notification-service", version="0.1.0")


@app.on_event("startup")
async def _start_outbound_consumer() -> None:
    asyncio.create_task(outbound_queue.start_consumer())


class PaymentReceivedRequest(BaseModel):
    customer_email: str
    customer_name: str
    invoice_number: str
    amount: float
    paid_at: str


class SendInvoiceRequest(BaseModel):
    customer_email: str
    customer_name: str
    invoice_number: str
    pdf_base64: str


class DemoRequest(BaseModel):
    company_name: str
    contact_name: str
    work_email: str
    company_size: str | None = None
    message: str | None = None


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


REMINDER_EVERY_DAYS = int(os.getenv("CUSTOMER_REMINDER_EVERY_DAYS", "2"))


@app.post("/customer-reminders", dependencies=[Depends(require_internal_token)])
async def customer_reminders() -> dict:
    """Email customers about overdue receivables; repeats every
    REMINDER_EVERY_DAYS until the invoice is paid (paid rows drop out of the query)."""
    today = date.today()
    try:
        rows = await find_due_reminders(
            today.isoformat(), (today - timedelta(days=REMINDER_EVERY_DAYS)).isoformat()
        )
    except HasuraError as exc:
        raise HTTPException(502, f"Hasura error: {exc}")
    try:
        companies = await find_companies(list({r["company_id"] for r in rows}))
    except HasuraError as exc:
        raise HTTPException(502, f"Hasura error: {exc}")
    sent = skipped = 0
    for r in rows:
        cust = r.get("customer") or {}
        company_name = (companies.get(r["company_id"]) or {}).get("name") or "your supplier"
        if not cust.get("email"):
            skipped += 1
            continue
        days = (today - date.fromisoformat(r["due_date"])).days
        ok = await asyncio.to_thread(
            send_direct_email,
            cust["email"],
            f"Reminder: invoice {r['invoice_number']} is overdue — {company_name}",
            (
                f"Hi {cust.get('name', 'there')},\n\n"
                f"{company_name} is following up: invoice {r['invoice_number']} (amount {r['amount']}) was due on "
                f"{r['due_date']} and is now {days} day(s) overdue. "
                "Please arrange payment at your earliest convenience. "
                "If you've already paid, please ignore this message.\n"
            ),
        )
        if not ok:
            skipped += 1
            continue
        await mark_reminded(r["id"], today.isoformat(), (r.get("reminder_count") or 0) + 1)
        sent += 1
    return {"eligible": len(rows), "sent": sent, "skipped": skipped}


@app.post("/overdue-sweep", dependencies=[Depends(require_internal_token)])
async def overdue_sweep() -> dict:
    today = date.today().isoformat()
    try:
        rows = await find_past_due(today)
        swept = await mark_overdue([r["id"] for r in rows])
    except HasuraError as exc:
        raise HTTPException(502, f"Hasura error during sweep: {exc}")

    # One digest per company, to that company's own recipients only — never a
    # single global inbox (that would mail one tenant's invoices to another).
    by_company: dict[str, list[dict]] = {}
    for r in rows:
        by_company.setdefault(r["company_id"], []).append(r)
    try:
        companies = await find_companies(list(by_company))
    except HasuraError as exc:
        raise HTTPException(502, f"Hasura error loading companies: {exc}")
    digests_sent = 0
    for cid, company_rows in by_company.items():
        recipients = (companies.get(cid) or {}).get("digest_emails") or []
        if not recipients:
            log.warning("company %s has no digest recipients — digest not sent", cid)
            continue
        digest_subject, digest_body = format_digest(company_rows)
        for addr in recipients:
            digests_sent += int(await asyncio.to_thread(send_direct_email, addr, digest_subject, digest_body))
    subject = f"Overdue sweep: {len(rows)} invoices flagged" if rows else "Overdue sweep: nothing overdue"

    # Payables only — this is telling the vendor *we* haven't paid *them* yet,
    # which only makes sense for money we owe, not money owed to us.
    vendor_notified = 0
    for r in rows:
        if r.get("direction") != "payable":
            continue
        vendor = r.get("vendor") or {}
        if not vendor.get("email"):
            continue
        company_name = (companies.get(r["company_id"]) or {}).get("name") or "us"
        sent = send_direct_email(
            vendor["email"],
            f"Invoice {r['invoice_number']} is now overdue — {company_name}",
            (
                f"Hi {vendor.get('name', 'there')},\n\n"
                f"{company_name}'s records show invoice {r['invoice_number']} "
                f"(due {r['due_date']}, amount {r['amount']}) is now overdue on our end. "
                "We're working on getting this paid — thanks for your patience.\n"
            ),
        )
        vendor_notified += int(sent)

    return {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "as_of": today,
        "swept": swept,
        "invoice_ids": [r["id"] for r in rows],
        "digest_subject": subject,
        "digests_sent": digests_sent,
        "vendor_notified": vendor_notified,
    }


@app.post("/notify/payment-received", dependencies=[Depends(require_internal_token)])
async def notify_payment_received(req: PaymentReceivedRequest) -> dict:
    """Best-effort receipt confirmation to a customer once their payment on a
    receivable invoice is recorded. Called synchronously from the web BFF's
    recordPayment mutation — never blocks or fails that mutation, so this
    endpoint always returns 200 even when the email itself didn't send."""
    sent = send_direct_email(
        req.customer_email,
        f"Payment received — invoice {req.invoice_number}",
        (
            f"Hi {req.customer_name},\n\n"
            f"We've received your payment of {req.amount} for invoice {req.invoice_number} "
            f"on {req.paid_at}. Thank you!\n"
        ),
    )
    return {"sent": sent}


@app.post("/notify/send-invoice", dependencies=[Depends(require_internal_token)])
async def notify_send_invoice(req: SendInvoiceRequest) -> dict:
    """Sends a generated invoice PDF to a customer. Called synchronously from
    the web BFF's generateAndSendInvoice mutation — never blocks or fails
    that mutation; the invoice is created and tracked either way, this is
    best-effort delivery on top of it."""
    try:
        pdf_bytes = base64.b64decode(req.pdf_base64)
    except (ValueError, TypeError):
        raise HTTPException(400, "pdf_base64 is not valid base64")
    sent = send_direct_email(
        req.customer_email,
        f"Invoice {req.invoice_number} from your supplier",
        f"Hi {req.customer_name},\n\nPlease find attached invoice {req.invoice_number}.\n\nThank you!\n",
        attachment=(f"{req.invoice_number}.pdf", pdf_bytes, "application/pdf"),
    )
    return {"sent": sent}


@app.post("/notify/demo-request", dependencies=[Depends(require_internal_token)])
async def notify_demo_request(req: DemoRequest) -> dict:
    """A prospect submitted the landing page's "Book a demo" form: notifies the
    super admin inbox (PLATFORM_EMAIL_TO — never a company's digest recipients)
    and sends the
    prospect a confirmation. Two independent best-effort sends — a bounce on
    one shouldn't hide whether the other got through."""
    to = [a.strip() for a in os.getenv("PLATFORM_EMAIL_TO", "").split(",") if a.strip()]
    sent_team = False
    if to:
        sent_team = send_direct_email(
            to[0],
            f"Demo request — {req.company_name}",
            (
                f"{req.contact_name} at {req.company_name} ({req.work_email}) asked for a demo.\n\n"
                f"Company size: {req.company_size or 'not given'}\n\n"
                f"Message:\n{req.message or '(none)'}\n"
            ),
        )
    else:
        log.warning("PLATFORM_EMAIL_TO unset — demo request from %s not forwarded to the team", req.work_email)

    sent_customer = send_direct_email(
        req.work_email,
        "We've got your request — Qlens demo",
        (
            f"Hi {req.contact_name},\n\n"
            f"Thanks for your interest in Qlens for {req.company_name}. Our team will get back to you "
            "within a business day to find a time that works.\n\n"
            "In the meantime, feel free to reply here with anything you'd like us to walk through.\n"
        ),
    )
    return {"sent": sent_team, "customer_notified": sent_customer}
