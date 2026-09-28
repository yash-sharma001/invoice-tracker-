# Invoice Processing & Vendor Payment Tracker

An internal accounts-payable tool: ingest supplier invoices (manual entry, CSV, or PDF
text extraction), route them through approval, track payments and vendor exposure, and
layer on two **XGBoost** models — **duplicate detection** and a **late-payment
predictor** — plus an **LLM assistant** that answers plain-language questions over the
data. A Next.js frontend sits on top; a Hasura GraphQL API over Postgres sits underneath;
six small FastAPI services (including OCR extraction) do the ingestion, scoring,
explanation and alerting.

The whole thing runs from `docker compose up`.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Repo layout](#repo-layout)
- [Quickstart](#quickstart)
- [Services reference](#services-reference)
- [Data model](#data-model)
- [Hasura metadata](#hasura-metadata-roles-triggers-actions-cron)
- [Auth & JWTs](#auth--jwts)
- [The models](#the-models)
- [The GenAI service](#the-genai-service)
- [Frontend](#frontend)
- [Tests & CI](#tests--ci)
- [Configuration reference](#configuration-reference)
- [Not for production](#not-for-production)

---

## What it does

**Invoice lifecycle**

- Capture invoices from three sources: manual form, CSV upload (with a validated
  per-row preview before commit), and PDF upload (text-layer extraction to structured
  fields).
- Approval workflow — `pending → approved / rejected`, recorded as an approval timeline
  per invoice. Approve/reject is role-gated (`approver` / `admin`).
- Payments — record a payment against an invoice; payment status is `unpaid`, `paid`, or
  effective `overdue` (unpaid past due date).
- A daily cron sweeps unpaid past-due invoices to `overdue` and sends a vendor-grouped
  digest (log / Slack / email).

**Analytics & assistance**

- **Duplicate detection** — on every invoice insert/update, an XGBoost classifier
  scores the invoice against the same party's other invoices over pairwise features
  (amount/tax gaps, date proximity, fuzzy invoice-number similarity, shared PO,
  department) and writes a `duplicate_flags` row above a tuned probability threshold.
  Reviewers confirm or clear each flag — those decisions are the labels for the next
  retrain. A synchronous pre-insert check is also exposed as a Hasura action for the
  upload flow.
- **Late-payment prediction** — an XGBoost classifier (probability late) + regressor
  (days late) score each invoice; results land in `delay_predictions` and surface as a
  colour-coded risk dot with a plain-language note.
- Both models are **required**: if the trained `.pkl` is missing, ml-service returns
  **503** rather than falling back to a heuristic or rule check. The Docker image
  trains both at build time.
- **Ask panel** — a slide-over on every screen. Questions ("which invoices are overdue?",
  "high-risk invoices this month") are answered from live data: an LLM picks a query over
  a small whitelist, or an offline keyword router does when no LLM is configured.

**Dashboard**

- Pending / overdue counts and amounts, total vendor exposure, a click-to-filter
  vendor-exposure bar chart, and pending + overdue invoice tables. `admin` sees an extra
  block (approved-unpaid, paid-last-30, rejected count, avg days to pay).
- Per-vendor view: invoices, outstanding, average delay, on-time %.

---

## Architecture

```mermaid
flowchart TD
    subgraph Browser
        UI["Next.js app (Apollo Client)<br/>graphql/schema.graphql"]
    end

    UI -- "login / refresh" --> AUTH["auth-service<br/>:8095"]
    UI -- "POST /api/graphql (session JWT)" --> BFF["Next server route<br/>app/api/graphql + server/resolvers.ts"]

    BFF -- "role-scoped JWT for reads and mutations" --> HASURA["Hasura GraphQL Engine<br/>:8088"]
    BFF -- "ask()" --> GENAI["genai-service :8093<br/>(as genai_readonly)"]

    HASURA --> PG[("Postgres :5433<br/>8 tables + vendor_exposure view")]
    GENAI -- "whitelisted queries" --> HASURA

    HASURA -- "event trigger: invoices INSERT/UPDATE<br/>POST /score" --> ML["ml-service :8092"]
    HASURA -- "action: checkDuplicateSync<br/>POST /check-duplicate" --> ML
    ML -- "writes duplicate_flags + delay_predictions (admin)" --> HASURA

    HASURA -- "cron 02:00 UTC<br/>POST /overdue-sweep" --> NOTIFY["notification-service :8094"]
    NOTIFY -- "bulk mark overdue (admin)" --> HASURA
    NOTIFY -- "digest" --> CHAN["log / Slack / email"]

    INGEST["ingestion-service :8091"] -- "validate then insert (as finance_user)<br/>— each insert fires the event trigger" --> HASURA
```

**Request flow, in words:**

1. The browser only ever talks to two origins: the Next.js app itself and `auth-service`
   (login redirects to Keycloak). It never holds the Hasura admin secret. (The one
   remaining server-side use is `apps/web/server/audit.ts`, which writes the append-only
   `audit_logs` table with it — a known gap, not yet moved to a scoped role.)
2. Every operation POSTs to
   `/api/graphql`, a Next server route (BFF). It verifies the session JWT, then
   `server/resolvers.ts` runs the operation against Hasura: **reads** with a short-lived
   JWT re-minted for the signed-in user's role (Hasura's own row/column permissions
   apply), and **mutations** the same way — real per-role Hasura permissions, with a
   role gate in the resolver on top. The BFF
   also translates camelCase ⇄ snake_case and computes derived fields (`daysOverdue`,
   effective `OVERDUE`, the `*Stats` aggregates).
4. Hasura is the single writer to Postgres. Two Hasura hooks call `ml-service`
   (an async **event trigger** on `invoices` writes scores back; a synchronous **action**
   does a pre-insert duplicate check). A **cron trigger** calls `notification-service`
   daily.
5. `ingestion-service` is a standalone ingestion API (CSV / manual) — it validates and
   then inserts through Hasura as `finance_user`, so ingested invoices take the exact same
   permission + trigger path as anything else.

---

## Repo layout

```
apps/web/                      Next.js 14 (App Router) + TypeScript + Tailwind + Apollo Client
  app/                         routes: (app)/ dashboard, invoices, vendors, upload; /login; /api/graphql (BFF)
  graphql/schema.graphql       the GraphQL contract — codegen and the BFF resolvers share it
  server/                      BFF only: Hasura-backed resolvers, role-scoped JWT mint, HS256 verify, role gate
  lib/                         business logic (format, status colours, risk thresholds, CSV, validation)
  components/                  ui/ primitives, invoice/, upload/, layout/, ask/

hasura/
  migrations/default/          schema (one init migration: 9 tables/view + indexes)
  metadata/                    tracked tables, relationships, permissions, event trigger, action, cron
  seeds/default/               small demo dataset (fixed UUIDs, re-runnable)

services/
  auth-service/                mock login → Hasura-shaped HS256 JWTs (dev only)          host :8095
  ingestion-service/           CSV / manual invoice ingestion → Hasura as finance_user   host :8091
  ml-service/                  XGBoost duplicate detection + XGBoost delay prediction    host :8092
  genai-service/               LLM summaries / explanations / OCR, scoped to genai_readonly  host :8093
  notification-service/        daily overdue sweep + digest (log / slack / email)        host :8094

packages/shared-types/         Python enums/constants (match the SQL schema) + the Hasura JWT mint/verify helper

infra/
  docker-compose.yml           full stack: postgres + hasura + rabbitmq + seed + the FastAPI
                                services + the web frontend (see Quickstart Option D)
  postgres-init/                one-time init scripts (run only on an empty volume) that
                                create ocr_db/genai_db/ml_db — each service's private database
  .env.example                 copy to infra/.env
```

Each service and `apps/web` has its own `README.md` with the endpoint-level detail.

---

## Quickstart

### Option A — frontend only, no backend (fastest)

```bash
cd apps/web
npm install
npm run codegen        # generate typed GraphQL hooks
npm run dev            # http://localhost:3000
```

### Option B — full stack

```bash
cp infra/.env.example infra/.env
docker compose -f infra/docker-compose.yml up -d
```

First run builds the images; **`ml-service` trains both models at build time (~3 min)** so
`/score` works out of the box (it 503s without them). Migrations + metadata apply automatically
(`cli-migrations-v3` image); a one-shot `seed` container then loads
`hasura/seeds/default/` (truncate + reload — safe to re-run with
`docker compose -f infra/docker-compose.yml up -d seed`).

| Service | Host URL | Notes |
|---|---|---|
| Postgres | `localhost:5433` | container-internal `5432` |
| Hasura | `http://localhost:8088` | console open; `x-hasura-admin-secret: devsecret` |
| auth-service | `http://localhost:8095` | `POST /login {username,password}` |
| ingestion-service | `http://localhost:8091` | `/upload/csv`, `/upload/csv/commit`, `/upload/manual` |
| ml-service | `http://localhost:8092` | `/score`, `/check-duplicate` |
| genai-service | `http://localhost:8093` | `/summarize`, `/explain-duplicate`, `/extract-ocr` |
| notification-service | `http://localhost:8094` | `/overdue-sweep` |

Host ports are shifted off `5432` / `8080` / `8001–8005` to avoid clashes; container-internal
ports are `8001–8005` as in the brief. Tear down with
`docker compose -f infra/docker-compose.yml down` (add `-v` to drop the DB volume).

Smoke test the JWT path:

```bash
TOKEN=$(curl -s localhost:8095/login -d '{"username":"kavya","password":"kavya"}' \
  -H 'content-type: application/json' | jq -r .access_token)
curl -s localhost:8088/v1/graphql -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"{ invoices(limit:1){ invoice_number } }"}'
```

### Option C — frontend against the real backend

Bring up Option B, then run the frontend outside Docker for hot reload:

```bash
cd apps/web
cp .env.example .env.local          # fill in the Hasura/auth values
npm run dev
```

Relevant `.env.local` keys:

```
NEXT_PUBLIC_AUTH_URL=http://localhost:8095          # browser → auth-service
HASURA_ENDPOINT=http://localhost:8088/v1/graphql    # server-only from here down
HASURA_ADMIN_SECRET=devsecret
HASURA_GRAPHQL_JWT_SECRET={"type":"HS256","key":"…"} # same value Hasura + auth-service use
GENAI_SERVICE_URL=http://localhost:8093
REQUIRE_AUTH=                                        # set 1 to reject unauthenticated calls
```

Sign in at `/login`. Dev users below. The browser's Apollo client posts the frontend's
own operations to `/api/graphql`; no component, operation, or codegen output differs
between the two modes.

### Option D — everything in Docker, including the frontend

`infra/docker-compose.yml` also runs the frontend now (service `web`,
`apps/web/Dockerfile`) — a production Next.js build, not hot-reloading, meant to mirror
how the app would actually run deployed:

```bash
cp infra/.env.example infra/.env
docker compose -f infra/docker-compose.yml up -d
```

It's on host port **3002**, not 3000 — chosen to avoid clashing with a local `next dev`
(also on 3000) or other common local tools. Rebuild after any `apps/web` code change
(`docker compose -f infra/docker-compose.yml build web && docker compose -f infra/docker-compose.yml up -d web`); it does not hot-reload.

---

## Services reference

All five are FastAPI apps, Python 3.11, one `pyproject.toml` each, and all depend on
`packages/shared-types`. Every service has a `GET /health` and a `tests/test_*.py`
plain-assertion check script (no framework).

### auth-service — `:8095` → container `:8005`

Company / role / invite bookkeeping, plus provisioning the matching Keycloak account.
**It no longer checks passwords or has a `/login`** — sign-in is Keycloak's hosted page
(see `apps/web/auth.ts`). Register / invite-accept still return an HS256 Hasura-shaped
JWT signed with `HASURA_GRAPHQL_JWT_SECRET`.

| Method | Path | Auth | Returns |
|---|---|---|---|
| `POST` | `/register` | rate-limited 5/min/IP | creates company + admin user (+ Keycloak account), returns a token |
| `POST` | `/invites/accept` | rate-limited 5/min/IP | creates the invited user (+ Keycloak account), returns a token |
| `GET` | `/users/lookup?username=` | `X-Internal-Token` | `{company_id, role}` — called by the BFF after Keycloak confirms who signed in |
| `GET` / `POST` / `PATCH` | `/users`, `/users/{username}` | admin Bearer token | list / create / (de)activate users in the caller's company |
| `POST` | `/invites` | admin Bearer token | create an invite + email link |
| `GET` | `/me`, `POST` `/refresh` | Bearer token | decoded claims / a fresh token while the old one is valid |

Dev users (seeded in `infra/keycloak/realm-export.json` and the DB migrations):

| Username | Password | Role |
|---|---|---|
| `kavya` | `kavya` | `finance_user` |
| `priya.nair` | `priya` | `approver` |
| `rahul.menon` | `rahul` | `approver` |
| `anjali.rao` | `anjali` | `admin` |

### ingestion-service — `:8091` → container `:8001`

CSV / manual invoice ingestion. Validates rows, then commits through Hasura as
`finance_user` in one batched `insert_invoices` — so each ingested invoice fires the
`invoice_ml_score` event trigger like any other. Plain `csv` module, no pandas.

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/upload/csv` | multipart `file` (.csv) | `{summary, rows:[{row, valid, errors, data}]}` — **no commit** |
| `POST` | `/upload/csv/commit` | `{rows:[…], created_by}` | `{committed, invoices:[{id, invoice_number}]}` (re-validates; 422 if any row is invalid — nothing commits) |
| `POST` | `/upload/manual` | one invoice | `{committed, invoice}` |

CSV columns (header case / spacing / common synonyms tolerated):
`invoice_number, vendor, department, invoice_date, due_date, amount, tax_amount, source, po_number`.
`vendor` is a **name**, resolved to an id against Hasura; `po_number` optional.
Validation: required fields present, vendor + PO resolve, `department` in the known set,
dates `YYYY-MM-DD`, `due_date ≥ invoice_date`, amounts numeric and non-negative,
`source ∈ {manual, csv, ocr}`. Messages are human-readable, per row.

### ml-service — `:8092` → container `:8002`

| Method | Path | Caller | Returns |
|---|---|---|---|
| `POST` | `/score` | Hasura **event trigger** `invoice_ml_score` | runs both checks, writes `duplicate_flags` + `delay_predictions` back, returns what it wrote |
| `POST` | `/check-duplicate` | Hasura **action** `checkDuplicateSync` (synchronous, pre-insert) | `{isDuplicate, matchedInvoiceId, confidenceScore, method, reason}` |

See [The models](#the-models).

### genai-service — `:8093` → container `:8003`

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/summarize` | `{question}` | `{summary, invoice_ids, row_count, query}` |
| `POST` | `/explain-duplicate` | `{invoice_id}` | `{explanation, confidence_score, method, matched_invoice_id}` — explains the **existing** flag, never re-derives |
| `POST` | `/extract-ocr` | multipart PDF | `{status, source, fields:{name:{value, confidence}}}` — reads the PDF **text layer** (LLM or offline regex); scanned/image PDFs → `status: "pending_review"` |
| `GET` | `/health` | — | `{status, llm: "offline" \| "azure-openai"}` |

Authenticates to Hasura **only** as `genai_readonly` via a self-minted JWT (never the
admin secret), and only through the whitelist in `app/whitelist.py` — four tables, a
fixed field list, a fixed operator set. See [The GenAI service](#the-genai-service).

### notification-service — `:8094` → container `:8004`

| Method | Path | Returns |
|---|---|---|
| `POST` | `/overdue-sweep` | `{ran_at, as_of, swept, invoice_ids, digest_subject}` |

Finds `payment_status = 'unpaid' AND due_date < today`, sets them to `overdue` in one
bulk `update_invoices` (as admin), builds a vendor-grouped digest, and sends it.
Each company's digest is emailed (SMTP) to that company's own digest recipients, set by
its admin in Settings — never to a shared inbox. Unconfigured SMTP logs a warning
instead of raising.

---

## Data model

One migration: [`hasura/migrations/default/1730000000000_init/up.sql`](hasura/migrations/default/1730000000000_init/up.sql).
UUID PKs (`gen_random_uuid()`), `NUMERIC(14,2)` money, `TIMESTAMPTZ` timestamps.
Enum-like columns are plain `TEXT` with app-level values kept in
[`packages/shared-types`](packages/shared-types/shared_types/__init__.py).

| Table | Key columns | Notes |
|---|---|---|
| `vendors` | `name`, `tax_id`, `payment_terms_days` | |
| `purchase_orders` | `po_number`, `vendor_id →`, `amount`, `department`, `status` | status: `open` / `partial` / `closed` |
| `invoices` | `invoice_number`, `vendor_id →`, `po_id →?`, `invoice_date`, `due_date`, `amount`, `tax_amount`, `department`, `approval_status`, `payment_status`, `source`, `created_by` | approval: `pending`/`approved`/`rejected`; payment: `unpaid`/`paid`/`overdue`; source: `manual`/`csv`/`ocr` |
| `invoice_line_items` | `invoice_id →`, `description`, `quantity`, `unit_price`, `line_amount` | `ON DELETE CASCADE` |
| `approvals` | `invoice_id →`, `approver`, `level`, `status`, `acted_at` | one row per approval step |
| `payments` | `invoice_id →`, `paid_at`, `amount_paid` | |
| `vendor_exposure` *(view)* | `vendor_id`, `payment_status`, `SUM(amount)`, `COUNT(*)` | vendor-wise exposure, read by the dashboard |

Indexes cover the queries the dashboard, overdue sweep and ML lookups actually hit
(`invoices(vendor_id)`, `invoices(payment_status, due_date)`, `invoices(approval_status)`,
and `invoice_id` on each child table).

**Tracked relationships** (Hasura): `invoices.vendor`, `.purchaseOrder`,
`.approvals[]`, `.payments[]`, `.lineItems[]`; `vendor_exposure.vendor`; and the
inverse arrays on `vendors` / `purchase_orders`.

### Per-service private databases

`duplicate_flags`, `delay_predictions`, `ml_drift_reports`, and
`ml_retrain_events` are **not** in the shared `invoice_tracker` database —
they live in ml-service's own `ml_db`, reached directly over psycopg
(`services/ml-service/app/db.py`), never through Hasura's GraphQL API.
Likewise `invoice_embeddings` lives in genai-service's own `genai_db`
(`services/genai-service/app/db.py`). This mirrors `auth-service`'s existing
isolation of `users`/`companies`/`invites` — each of these datastores is
private to exactly one service, not shared through Hasura role permissions.

Both `genai_db` and `ml_db` are *also* registered as read-only Hasura sources
(`genai`, `ml` in the console's database list) purely for browsing —
no role has any permission on them, so they're visible with the admin secret
only, and genai-service/ml-service's own private connections remain the only
way to actually read or write them.

The one place this matters for the frontend: the invoice list/detail views
used to get `duplicateFlag`/`delayPrediction` as a single Hasura relationship
join. They still appear as the same GraphQL fields today, but the web app now
fetches them from ml-service in a second, batched call and stitches them onto
the invoice rows (`apps/web/server/predictions.ts`) — a deliberate tradeoff so
the invoice list keeps working (minus predictions) if ml-service is down,
rather than making it a hard dependency for every page load.

---

## Hasura metadata (roles, triggers, actions, cron)

Version 3 metadata, in `hasura/metadata/`. Applied automatically by the
`graphql-engine:*.cli-migrations-v3` image.

### Roles & permissions

| Role | Read | Write | Notes |
|---|---|---|---|
| `finance_user` | all tables + view | insert/update `invoices`; insert/update `payments` | column-scoped inserts; no deletes |
| `approver` | all tables + view | update only `status` / `acted_at` on **its own** `approvals` rows | row filter `approver = X-Hasura-User-Id` |
| `admin` | everything (built-in) | everything | used server-side by the BFF for mutations and by ml / notification services |
| `genai_readonly` | select-only, and only `invoices`, `vendors` | none | the guardrail for genai-service. Used to also cover `duplicate_flags`/`delay_predictions` directly — those moved to ml-service's private `ml_db` (see [Per-service private databases](#data-model)), so genai-service's "ask" feature can no longer answer questions that resolve to those two tables; it degrades to "I don't have that data" instead of erroring. |

**No role can delete anything.**

### Event trigger — `invoice_ml_score`

On `invoices` INSERT and on UPDATE of `amount` / `vendor_id` / `department`. Calls
`ML_SERVICE_SCORE_URL` (`POST /score`). 3 retries, fixed 15 s interval, 60 s timeout.

### Action — `checkDuplicateSync`

`checkDuplicateSync(invoice: InvoiceCheckInput!) → DuplicateCheckResult!` — synchronous,
`POST {{ML_SERVICE_URL}}/check-duplicate`, 15 s timeout, forwards client headers.
Permitted for `finance_user` + `admin`. Used by the pre-insert upload flow.

### Cron — `overdue_sweep_daily`

`0 2 * * *` (02:00 UTC) → `POST {{NOTIFICATION_SERVICE_URL}}/overdue-sweep`.
2 retries, 60 s apart, 6 h tolerance.

---

## Auth & JWTs

- **Login is Keycloak** ([`infra/keycloak/realm-export.json`](infra/keycloak/realm-export.json),
  [`apps/web/auth.ts`](apps/web/auth.ts)) — clicking "Log in" redirects to Keycloak's own
  hosted page (Authorization Code + PKCE via NextAuth); this app never sees a password.
  Once Keycloak confirms who signed in, the BFF looks up that username's company_id/role
  (still tracked locally — `auth-service`'s `GET /users/lookup`) and mints the same
  Hasura-shaped session JWT as before, so every resolver/route downstream is unchanged.
  Register and invite-accept are still this app's own forms (they do provisioning —
  creating a company, assigning a role — Keycloak's generic self-registration can't do),
  and both now also create the matching Keycloak account
  (`services/auth-service/app/keycloak_admin.py`) instead of hashing a password locally.
- **`auth-service`** signs HS256 tokens carrying the `https://hasura.io/jwt/claims`
  block (`x-hasura-default-role`, `x-hasura-allowed-roles`, `x-hasura-user-id`).
  `iat` is backdated 60 s to absorb clock skew. `POST /refresh` re-issues while a token
  is still valid; once expired, sign in again.
- **The single JWT helper** lives in
  [`packages/shared-types/shared_types/jwt.py`](packages/shared-types/shared_types/jwt.py) —
  used by `auth-service` (issues tokens for humans) and by `genai-service` (self-mints a
  300 s `genai_readonly` token for its own Hasura calls).
- **`ml-service`**, **`notification-service`** and **`ingestion-service`** each self-mint a
  short-lived role-scoped JWT (`ml_service`, `notifier`, `finance_user`) — none use the
  admin secret.
- **The web BFF** ([`apps/web/server/`](apps/web/server/)) verifies the browser's session
  JWT against `HASURA_GRAPHQL_JWT_SECRET`, then re-mints a short-lived role-scoped token
  for every call — reads *and* mutations — so Hasura's own per-role permissions apply
  throughout; the resolver's `requireRole(...)`/`requireCompanyId()` are a second,
  BFF-side gate on top, not a substitute for one. `REQUIRE_AUTH=1` rejects
  unauthenticated calls outright; unset keeps the demo permissive — but an
  unauthenticated read is still scoped to a single seed demo company via a role-scoped
  JWT, **never** the raw admin secret, so it can't cross-tenant scan
  (`apps/web/server/hasura.ts`'s `authHeaders()` — this was previously a real
  cross-tenant read leak, fixed and covered by `apps/web/server/hasura.test.ts`).
- **Audit log** — `audit_logs` (admin-only, no Hasura role permissions) records every
  invalid/expired session, every `REQUIRE_AUTH` rejection, and every forbidden-role
  attempt, from both the GraphQL BFF and the three REST routes (`bulk-upload`, `ocr`,
  `payments/create-link`) that gate on role inline instead of through `requireRole`.
- Frontend sessions refresh silently ~5 min before expiry; a tab left past expiry lands
  back on `/login`.

---

## The models

### Duplicate detection — XGBoost

[`services/ml-service/app/duplicates.py`](services/ml-service/app/duplicates.py) +
[`app/dup_features.py`](services/ml-service/app/dup_features.py). An `XGBClassifier`
scores the candidate against each of the same party's other invoices over 13 pairwise
features — amount/tax relative gaps and exact-match flags, day gap and same-month,
five `rapidfuzz` invoice-number similarities, shared/both-have PO, department match —
built by the **one funnel** `pair_features` (train and serve identical). The highest
`P(duplicate)` above the pickled threshold (synthetic model 0.75, retrained-from-Hasura model 0.6; a hard 60-day gap
limit also applies) becomes a `duplicate_flags` row with
`method="ml"`. Training data is synthetic pairs by default, or human-reviewed
`duplicate_flags` via `--from-hasura`. No `models/duplicate_model.pkl` → **503**.

### Late-payment prediction — XGBoost

[`services/ml-service/app/delay.py`](services/ml-service/app/delay.py) + [`ml/`](services/ml-service/ml/).
`XGBClassifier` (probability of paying late) + `XGBRegressor` (days late).

Features go through **one funnel** —
[`app/features.py::assemble_features`](services/ml-service/app/features.py) — used
identically at train and serve time, so there is no skew: vendor historical on-time rate,
`log1p(amount)`, approval-chain length, day-of-month, tax fraction, PO-matched flag, and
a department one-hot.

```bash
cd services/ml-service
python -m ml.generate_synthetic_training_data --rows 3000   # → data/synthetic_invoices.csv
python -m ml.train                                          # → models/delay_model.pkl
python -m ml.train --from-hasura                            # train on real paid invoices instead
python -m ml.predict '{"amount":250000,"tax_amount":45000,"department":"IT","invoice_date":"2026-09-28","po_id":null}' --vendor-ontime 0.5
python -m ml.generate_synthetic_duplicate_pairs --rows 6000 && python -m ml.train_duplicates  # → models/duplicate_model.pkl
```

No `models/delay_model.pkl` → `/score` returns **503** (`ModelUnavailable`) — no
heuristic fallback. The Docker image trains both models at build time. The frontend
renders the probability as a green/amber/red dot at thresholds `0.34` / `0.67`
([`apps/web/lib/risk.ts`](apps/web/lib/risk.ts)) with a one-line explanation.

---

## The GenAI service

Optional Azure OpenAI (`AZURE_OPENAI_ENDPOINT` / `_KEY` / `_DEPLOYMENT`); **unset ⇒ a
deterministic offline mode** so the whole stack is demoable with no credentials.

- **`/summarize`** — with an LLM: the model gets one `query_invoices` tool constrained to
  four whitelisted tables and picks table + `where` + `order_by`; the service builds and
  runs that query as `genai_readonly`, then the model summarises the rows. Offline: a
  keyword router picks the query (`overdue`, `duplicate`, `risk/late/delay`, `vendor`, …)
  and a template writes the summary. A query is **never** built from free text directly —
  only from a structured spec, validated against the whitelist
  ([`app/query_builder.py`](services/genai-service/app/query_builder.py),
  [`app/whitelist.py`](services/genai-service/app/whitelist.py)).
- **`/explain-duplicate`** — passes the stored confidence + matched fields and asks for a
  plain-language paragraph. Explains the existing flag only; does not assert a new match.
- **`/extract-ocr`** — `pypdf` pulls the text layer; the LLM (tool call) or, offline, a
  set of regexes map it to `{value, confidence}` per field. **No text layer (scanned
  image) → `pending_review`** with an empty skeleton — real image OCR needs a vision
  provider, plugged into the fallback branch in `app/main.py` (marked in the code).

---

## Frontend

[`apps/web/`](apps/web/) — Next.js 14 App Router, TypeScript, Tailwind, Apollo Client,
Recharts. GraphQL Codegen (`client-preset`) generates typed documents from
`graphql/schema.graphql`.

```bash
npm run dev         # http://localhost:3000
npm run codegen     # typed hooks (also runs on prebuild)
npm run test        # vitest — pure logic in lib/ and server/
npm run typecheck
npm run lint
```

### Screens

| Route | What |
|---|---|
| `/` | Dashboard — pending / overdue / exposure stats, click-to-filter vendor-exposure bar chart, pending + overdue tables; extra admin block |
| `/invoices` | Full list — URL-synced filters (vendor, department, date range, approval, payment, source, search), sort + pagination, row selection, bulk **approve** (role-gated) and **export selected to CSV** |
| `/invoices/[id]` | Detail — header + status badges, duplicate callout (confirm / clear), delay-risk panel with plain-language note, approval timeline, record-payment form |
| `/vendors`, `/vendors/[id]` | Vendor list (invoices, outstanding, avg delay, on-time %) and per-vendor dashboard + history |
| `/upload` | Manual-entry form and CSV upload with a validated preview (per-row errors inline) before commit |
| Ask panel | Slide-over on every screen — plain-language Q&A over current data, with a linked invoice table |
| `/login` | Session auth; the app redirects here when there's no session |

### One schema, one backend

`graphql/schema.graphql` is the single contract: `lib/apollo.ts` points every operation at
`HttpLink → /api/graphql`, and the BFF's `server/resolvers.ts` does the camelCase ⇄
snake_case / enum / computed-field translation so nothing downstream changes.

### Where the logic lives

Business rules are in `lib/`, not in pages:
[`format.ts`](apps/web/lib/format.ts) (money/date), [`status.ts`](apps/web/lib/status.ts)
(the one colour vocabulary — no hex literals in components; `dup` violet is deliberately
off the traffic-light scale), [`risk.ts`](apps/web/lib/risk.ts) (`RISK_THRESHOLDS`),
[`csv.ts`](apps/web/lib/csv.ts), and [`validateInvoice.ts`](apps/web/lib/validateInvoice.ts)
(shared by manual entry, CSV preview, and the import resolver).

---

## Tests & CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and PR:

- **web** — `npm ci` → `codegen` → `typecheck` → `lint` → `vitest`.
- **services** — `pip install -e` the shared package and every service, then run each
  `services/*/tests/test_*.py` check script.

Locally:

```bash
cd apps/web && npm test
cd services/<name> && PYTHONPATH=. python tests/test_*.py
```

The service tests are plain `assert` scripts with a `run()` / `__main__` — no framework,
no fixtures. They cover the parts that break silently: validation rules, the duplicate
matcher, the feature funnel, the query-builder whitelist, the OCR field contract, the
digest formatter, and JWT mint/verify/refresh.

---

## Configuration reference

### `infra/.env` (compose — loaded into every service)

| Var | Default | For |
|---|---|---|
| `POSTGRES_USER` / `_PASSWORD` / `_DB` | `postgres` / `postgrespassword` / `invoice_tracker` | Postgres |
| `PG_DATABASE_URL` / `HASURA_GRAPHQL_DATABASE_URL` | `postgres://…@postgres:5432/invoice_tracker` | Hasura + seed |
| `HASURA_GRAPHQL_ADMIN_SECRET` / `HASURA_ADMIN_SECRET` | `devsecret` | admin access |
| `HASURA_ENDPOINT` | `http://localhost:8088/v1/graphql` (compose overrides host → service name) | services → Hasura |
| `HASURA_GRAPHQL_JWT_SECRET` | `{"type":"HS256","key":"dev-…-min"}` | JWT sign/verify (Hasura + auth-service + genai + BFF) |
| `ML_SERVICE_URL` / `ML_SERVICE_SCORE_URL` / `NOTIFICATION_SERVICE_URL` / `GENAI_SERVICE_URL` / `OCR_SERVICE_URL` | compose service URLs | referenced by Hasura metadata and read directly by the web app's BFF |
| `NEXT_PUBLIC_AUTH_URL` | `http://auth-service:8005` in compose | read server-side only by the web app's `api/{login,register,refresh,users,invites}` routes — never sent to the browser despite the name. **Inlined at Next.js build time** — a runtime override alone does nothing; the web service's Docker build passes it as a build arg (`infra/docker-compose.yml`'s `web.build.args`). |
| `GENAI_PG_DATABASE_URL` / `ML_PG_DATABASE_URL` | `postgres://{genai,ml}_service:…@postgres:5432/{genai,ml}_db` | genai-service's/ml-service's own private databases — see [Per-service private databases](#data-model) |
| `RABBITMQ_URL` | `amqp://guest:guest@rabbitmq:5672/` (compose); host-mapped `5673` outside Docker | ocr-service's bulk upload queue and the web app's outbound notification queue (`apps/web/server/queue.ts`) |
| `INTERNAL_SERVICE_TOKEN` | `dev-internal-token-change-me` | shared secret sent as `X-Internal-Token` on every service-to-service call; each service's `require_internal_token` dependency fails closed if unset |
| `AZURE_OPENAI_ENDPOINT` / `_KEY` / `_DEPLOYMENT` / `_API_VERSION` | unset → offline / `2024-06-01` | genai-service LLM |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_STARTTLS` / `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_FROM` | — / `587` / `1` / … | all outbound email |
| `PLATFORM_EMAIL_TO` | — | demo-request (lead) emails to the super admin, comma-separated |
| `AUTH_TOKEN_TTL_SECONDS` | `3600` | auth-service token lifetime |

### `apps/web/.env.local`

| Var | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_AUTH_URL` | `http://localhost:8095` | **server-only** despite the name — see the note in the compose table above |
| `HASURA_ENDPOINT` | `http://localhost:8088/v1/graphql` | server-only (BFF) |
| `HASURA_ADMIN_SECRET` | `devsecret` | server-only; used only by `server/audit.ts` (audit-log writes) and codegen |
| `GENAI_SERVICE_URL` / `ML_SERVICE_URL` / `NOTIFICATION_SERVICE_URL` | `http://localhost:{8093,8092,8094}` | server-only |
| `INTERNAL_SERVICE_TOKEN` | must match `infra/.env`'s value | sent as `X-Internal-Token` on every call to ml/genai/notification/ocr-service |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5673/` | note the host-mapped port — `5673`, not RabbitMQ's default `5672` |
| `HASURA_GRAPHQL_JWT_SECRET` | *(match Hasura + auth-service)* | BFF verifies session JWTs / mints role-scoped read tokens |
| `REQUIRE_AUTH` | *(unset)* | `1` to reject missing/invalid session tokens outright |

---

## Not for production

Most of the deliberate shortcuts below have been closed out — see
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for the current state. What's left:

- **Real OIDC IdP (Keycloak)** — `auth-service` no longer stores or checks passwords;
  Keycloak does (see `infra/keycloak/realm-export.json`), and login is a redirect to
  Keycloak's own hosted page (`apps/web/auth.ts`, NextAuth). `auth-service` keeps
  company/role bookkeeping and provisions the matching Keycloak account whenever it
  creates a user (register / invite-accept / admin-created user).
- **Every backend service self-mints its own scoped Hasura JWT** (`ml_service`,
  `genai_readonly`/`genai_writer`, `notifier`, `ocr_service`, `finance_user`,
  `payments_webhook`, `public_lead`) — none of ingestion/ml/genai/notification/ocr/web
  use the raw admin secret anymore. Every table the web BFF writes to now has a real
  per-role Hasura permission (`company_admin` alongside `finance_user`/`approver`) —
  the `{admin: true}` bypass in `server/hasura.ts` is gone entirely.
- **`auth-service`'s CORS denies by default** — `AUTH_CORS_ORIGINS` unset means an
  empty allow-list, not a `"*"` fallback (no cookies cross this boundary either way).
  Set it to your real frontend origin(s) in a real deployment.
- **`/extract-ocr` handles PDF text layers only** — scanned/image documents return
  `pending_review`; wiring a vision provider is left as a marked extension point
  (the one deliberately deferred item from this pass).
- **Ports are shifted** off the brief's defaults to avoid clashes on the dev machine
  (`5433`, `8088`, `8091–8097`, `5673`/`15673` for RabbitMQ, `3002` for the dockerized
  frontend); container-internal ports match the brief.
- **Next.js is on the current major** (`next@16`); CI now runs `npm audit --omit=dev`
  and `pip-audit` on every push (dev/build-time transitive deps are excluded — see the
  comment in `.github/workflows/ci.yml`).
