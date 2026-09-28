"""Hasura access for the overdue sweep. Runs as `notifier` — a self-minted,
deliberately cross-tenant role (the sweep runs across every company), narrowed
to just the invoices/vendor columns it reads/writes (see hasura/metadata's
notifier permissions), not the admin secret.
"""

from __future__ import annotations

import os

import httpx

from shared_types.jwt import bearer, mint_hasura_jwt

ENDPOINT = (
    os.getenv("HASURA_ENDPOINT")
    or os.getenv("HASURA_GRAPHQL_ENDPOINT")
    or "http://localhost:8088/v1/graphql"
)
NOTIFIER_ROLE = "notifier"
NOTIFIER_USER_ID = "notification-service"


class HasuraError(RuntimeError):
    pass


def _headers() -> dict[str, str]:
    # No x-hasura-company-id claim needed — the notifier role's permissions
    # don't reference it (see hasura/metadata/.../public_invoices.yaml).
    token = mint_hasura_jwt(NOTIFIER_ROLE, NOTIFIER_USER_ID, ttl_seconds=300)
    return {**bearer(token), "x-hasura-role": NOTIFIER_ROLE}


async def _gql(query: str, variables: dict) -> dict:
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            ENDPOINT,
            json={"query": query, "variables": variables},
            headers=_headers(),
        )
    resp.raise_for_status()
    body = resp.json()
    if body.get("errors"):
        raise HasuraError(body["errors"][0].get("message", "GraphQL error"))
    return body["data"]


_FIND = """
query PastDue($today: date!) {
  invoices(where: {payment_status: {_eq: "unpaid"}, due_date: {_lt: $today}}) {
    id company_id invoice_number due_date amount department direction
    vendor { name email }
  }
}
"""

_MARK = """
mutation MarkOverdue($ids: [uuid!]!) {
  update_invoices(where: {id: {_in: $ids}}, _set: {payment_status: "overdue"}) {
    affected_rows
  }
}
"""


async def find_past_due(today: str) -> list[dict]:
    return (await _gql(_FIND, {"today": today}))["invoices"]


_COMPANIES = """
query Companies($ids: [uuid!]!) {
  companies(where: {id: {_in: $ids}}) { id name digest_emails }
}
"""


async def find_companies(ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    rows = (await _gql(_COMPANIES, {"ids": ids}))["companies"]
    return {r["id"]: r for r in rows}


async def mark_overdue(ids: list[str]) -> int:
    if not ids:
        return 0
    return (await _gql(_MARK, {"ids": ids}))["update_invoices"]["affected_rows"]


_DUE_REMINDERS = """
query DueReminders($today: date!, $cutoff: date!) {
  invoices(where: {
    direction: {_eq: "receivable"},
    payment_status: {_in: ["unpaid", "overdue"]},
    due_date: {_lt: $today},
    _or: [{last_reminder_on: {_is_null: true}}, {last_reminder_on: {_lte: $cutoff}}]
  }) {
    id company_id invoice_number due_date amount tax_amount reminder_count
    customer { name email }
  }
}
"""

_MARK_REMINDED = """
mutation MarkReminded($id: uuid!, $today: date!, $n: Int!) {
  update_invoices(where: {id: {_eq: $id}}, _set: {last_reminder_on: $today, reminder_count: $n}) {
    affected_rows
  }
}
"""


async def find_due_reminders(today: str, cutoff: str) -> list[dict]:
    return (await _gql(_DUE_REMINDERS, {"today": today, "cutoff": cutoff}))["invoices"]


async def mark_reminded(invoice_id: str, today: str, count: int) -> None:
    await _gql(_MARK_REMINDED, {"id": invoice_id, "today": today, "n": count})
