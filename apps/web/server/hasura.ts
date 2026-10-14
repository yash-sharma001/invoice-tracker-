/**
 * Server-only Hasura client for the /api/graphql BFF route. The browser only
 * ever talks to /api/graphql, which speaks the frontend's own schema
 * (graphql/schema.graphql) — Hasura itself is never reachable from it.
 *
 * Auth to Hasura, per request, always via a short-lived role-scoped JWT
 * (never the admin secret — every table now has real per-role permissions):
 *  - signed-in user, called from a /api/graphql resolver -> JWT carrying
 *    their real role, read ambiently from requestContext (server/auth.ts).
 *  - signed-in user, called from a plain API route that verified its own
 *    cookie (no requestContext) -> pass `{ claims }` explicitly.
 *  - no session at all (demo/offline, or a route with no user concept —
 *    public lead form, payment webhook) -> pass a fixed minimal-privilege
 *    Claims for a dedicated narrow role (see PUBLIC_LEAD_CLAIMS /
 *    PAYMENTS_WEBHOOK_CLAIMS below), or omit `claims` to fall back to the
 *    demo-company finance_user JWT.
 */
import { currentClaims } from "./auth";
import { signHS256, type Claims } from "./jwt";

const ENDPOINT = process.env.HASURA_ENDPOINT ?? "http://localhost:8088/v1/graphql";
const JWT_SECRET = process.env.HASURA_GRAPHQL_JWT_SECRET ?? "";

// Same seed tenant apps/web/app/api/{bulk-upload,ocr}/route.ts fall back to
// when there's no session — demo mode stays scoped to one company instead of
// reaching every tenant's data.
const DEMO_COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const DEMO_CLAIMS: Claims = { sub: "demo", iat: 0, exp: 0, role: "finance_user", user: "demo", companyId: DEMO_COMPANY_ID };

/** Anonymous "book a demo" form — insert-only, no company, no user. */
export const PUBLIC_LEAD_CLAIMS: Claims = {
  sub: "public-lead-form", iat: 0, exp: 0, role: "public_lead", user: "public-lead-form", companyId: DEMO_COMPANY_ID,
};
/** Razorpay webhook — no session; company_id is resolved per-call from the invoice. */
export const PAYMENTS_WEBHOOK_CLAIMS: Claims = {
  sub: "payments-webhook", iat: 0, exp: 0, role: "payments_webhook", user: "payments-webhook", companyId: DEMO_COMPANY_ID,
};

/** IRP registration — the only role that can read IRP credentials or write an
 * invoice's IRN. Scoped to one company per call. */
export const einvoiceClaims = (companyId: string): Claims => ({
  sub: "einvoice-service", iat: 0, exp: 0, role: "einvoice_service", user: "einvoice-service", companyId,
});

// Checked lazily (at first real request), not at module load — `next build`
// imports every route module to statically analyze it, with NODE_ENV forced
// to "production" regardless of the Dockerfile's runtime env, so a top-level
// throw here would fail the build itself rather than catch a real misconfigured
// deploy.
//
// Gated on REQUIRE_AUTH=1 as well as NODE_ENV, not NODE_ENV alone: every
// Next.js standalone build runs with NODE_ENV=production, including this
// repo's own local docker-compose stack (infra/docker-compose.yml), which
// intentionally uses the same devsecret/dev-internal-token every other
// service there does. infra/k8s/configmap.yaml is the one place that sets
// REQUIRE_AUTH=1 — that's the actual "this is a real deployment" signal.
function assertProductionSecretsConfigured(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (!/^(1|true|yes)$/i.test(process.env.REQUIRE_AUTH ?? "")) return;
  if (!process.env.HASURA_GRAPHQL_JWT_SECRET || process.env.HASURA_GRAPHQL_JWT_SECRET.includes("dev-jwt-signing-key")) {
    throw new Error("HASURA_GRAPHQL_JWT_SECRET must be set to a real secret in production");
  }
  if (!process.env.INTERNAL_SERVICE_TOKEN) {
    throw new Error("INTERNAL_SERVICE_TOKEN must be set in production");
  }
}

function authHeaders(explicitClaims?: Claims): Record<string, string> {
  if (!JWT_SECRET) throw new Error("HASURA_GRAPHQL_JWT_SECRET is not set");
  const claims = explicitClaims ?? currentClaims() ?? DEMO_CLAIMS;
  return { authorization: `Bearer ${signHS256(claims, JWT_SECRET)}` };
}

export async function hasura<T = any>(
  query: string,
  variables?: Record<string, unknown>,
  opts: { claims?: Claims } = {},
): Promise<T> {
  assertProductionSecretsConfigured();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(opts.claims) },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0]?.message ?? "Hasura error");
  return body.data as T;
}

export const GENAI_URL = process.env.GENAI_SERVICE_URL ?? "http://localhost:8093";
export const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? "http://localhost:8092";
export const NOTIFICATION_URL = process.env.NOTIFICATION_SERVICE_URL ?? "http://localhost:8094";

// Sent on every server-to-server call to ingestion/ml/genai/notification/ocr —
// those services trust the network boundary in dev, but require this shared
// secret in prod (see shared_types.auth.require_internal_token).
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
export function internalServiceHeaders(): Record<string, string> {
  return INTERNAL_SERVICE_TOKEN ? { "X-Internal-Token": INTERNAL_SERVICE_TOKEN } : {};
}
