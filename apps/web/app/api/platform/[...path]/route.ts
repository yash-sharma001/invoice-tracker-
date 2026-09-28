import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/server/auth";
import { verifyHS256 } from "@/server/jwt";

/**
 * BFF: proxies /api/platform/* to auth-service's /platform/* (super_admin only).
 * auth-service re-checks the role itself; this gate just keeps the cookie
 * server-side and rejects everyone else early.
 */
const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL ?? "http://localhost:8095";
const JWT_SECRET = process.env.HASURA_GRAPHQL_JWT_SECRET ?? "";

export const dynamic = "force-dynamic";

const fail = (status: number, message: string) => Response.json({ error: message }, { status });

async function proxy(req: Request, props: { params: Promise<{ path: string[] }> }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return fail(401, "Sign in as super admin.");
  const claims = verifyHS256(token, JWT_SECRET);
  if (!claims) return fail(401, "Your session has expired — sign in again.");
  if (claims.role !== "super_admin") return fail(403, "Needs role: super_admin");

  const { path } = await props.params;
  const hasBody = req.method !== "GET" && req.method !== "DELETE";
  const res = await fetch(`${AUTH_URL}/platform/${path.map(encodeURIComponent).join("/")}`, {
    method: req.method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: hasBody ? await req.text() : undefined,
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return Response.json(body, { status: res.status });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
