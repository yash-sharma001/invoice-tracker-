"""Runnable check:  python tests/test_notify.py"""

from app.notify import format_digest, send_direct_email

ROWS = [
    {"invoice_number": "A/1", "due_date": "2026-01-01", "amount": "100000", "vendor": {"name": "Acme"}},
    {"invoice_number": "A/2", "due_date": "2026-02-01", "amount": "50000", "vendor": {"name": "Acme"}},
    {"invoice_number": "B/1", "due_date": "2026-01-15", "amount": "300000", "vendor": {"name": "Globex"}},
]


def run() -> None:
    subject, body = format_digest(ROWS)
    assert "3 invoices flagged" in subject
    # Globex has the larger balance -> listed first
    assert body.index("Globex") < body.index("Acme")
    assert "₹450,000" in body and "A/1" in body

    empty_subject, _ = format_digest([])
    assert "nothing overdue" in empty_subject

    # unconfigured SMTP logs and returns False instead of raising
    assert send_direct_email("", "s", "b") is False

    print("notification-service: all checks passed")


if __name__ == "__main__":
    run()
