"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Session + role. Sign-in itself now goes through Keycloak (see ../auth.ts,
 * ../app/login/page.tsx) — this hook only reads the resulting session back
 * via /api/session, which still reads the same httpOnly it_session cookie it
 * always has; page JS never sees the token itself, only {user, role, exp}.
 * `setRole` still lets you preview another role within the session without
 * re-authenticating.
 */
export type Role = "finance_user" | "approver" | "admin" | "super_admin" | "genai_readonly";

export const ROLES: { value: Role; label: string }[] = [
  { value: "finance_user", label: "Finance team" },
  { value: "approver", label: "Approver" },
  { value: "admin", label: "Admin" },
];
export const roleLabel = (r: Role | null) => (r === "super_admin" ? "Super admin" : ROLES.find((x) => x.value === r)?.label ?? r);

/**
 * What each role can do. The BFF enforces the same split server-side on every
 * mutation (apps/web/server/auth.ts); this is the UI half — which pages and
 * controls to show.
 *
 *   finance_user  dashboard + record payments + add/import invoices
 *   approver      approve / reject only (no dashboard, no payments, no upload)
 *   admin         dashboard, approve, payments, user management + the admin
 *                 stats block — but NOT invoice upload (that's finance_user's job)
 */
export type Capability =
  | "viewDashboard"
  | "approve"
  | "recordPayment"
  | "addInvoices"
  | "viewAdminStats"
  | "manageUsers"
  | "manageSettings"
  | "deleteInvoice"
  | "platform";

const ROLE_CAPS: Record<Role, Capability[]> = {
  finance_user: ["viewDashboard", "recordPayment", "addInvoices", "deleteInvoice", "manageSettings"],
  approver: ["approve"],
  admin: [
    "viewDashboard",
    "approve",
    "recordPayment",
    "viewAdminStats",
    "manageUsers",
    "manageSettings",
    "deleteInvoice",
  ],
  // Platform owner: sees ONLY the /platform area + leads, no tenant data.
  super_admin: ["platform"],
  genai_readonly: [],
};

export interface Session {
  user: string;
  role: Role;
  /** ms epoch the session expires at. */
  exp: number;
}

interface RoleContextValue {
  ready: boolean;
  session: Session | null;
  user: string | null;
  role: Role | null;
  can: (c: Capability) => boolean;
  /** Where this role should land after login (approver has no dashboard). */
  landingPath: string;
  setRole: (r: Role) => void;
  register: (
    companyName: string,
    username: string,
    email: string,
    password: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; offline?: boolean }>;
  acceptInvite: (
    token: string,
    username: string,
    password: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; offline?: boolean }>;
  logout: () => void;
}

const RoleContext = createContext<RoleContextValue | null>(null);

export function RoleProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  // On load: ask the server what the httpOnly cookie says (JS can't read it
  // directly).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/session");
        const data = await res.json();
        setSession(data.session ?? null);
      } catch {
        setSession(null); // auth route unreachable — treat as signed out
      }
      setReady(true);
    })();
  }, []);

  const register = useCallback<RoleContextValue["register"]>(async (companyName, username, email, password) => {
    let res: Response;
    try {
      res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyName, username, email, password }),
      });
    } catch {
      return { ok: false, error: "Can't reach the auth service", offline: true };
    }
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error ?? `Auth service error (${res.status})`, offline: data.offline };
    }
    setSession({ user: data.user, role: data.role as Role, exp: data.exp });
    return { ok: true };
  }, []);

  const acceptInvite = useCallback<RoleContextValue["acceptInvite"]>(async (token, username, password) => {
    let res: Response;
    try {
      res = await fetch("/api/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, username, password }),
      });
    } catch {
      return { ok: false, error: "Can't reach the auth service", offline: true };
    }
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error ?? `Auth service error (${res.status})`, offline: data.offline };
    }
    setSession({ user: data.user, role: data.role as Role, exp: data.exp });
    return { ok: true };
  }, []);

  const logout = useCallback(() => {
    setSession(null);
    // Full navigation, not fire-and-forget: ending Keycloak's own SSO
    // session requires the browser to actually visit Keycloak's logout
    // endpoint (it clears Keycloak's cookie, then bounces back to /login).
    // Without this, the next "log in" click silently re-authenticates
    // whoever Keycloak still remembers instead of prompting fresh.
    fetch("/api/logout", { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        window.location.href = data.keycloakLogoutUrl ?? "/login";
      })
      .catch(() => {
        window.location.href = "/login";
      });
  }, []);

  // Silent refresh: swap in a fresh cookie ~5 min before the current one expires.
  // A tab left closed past expiry can't refresh -> next API call 401s -> /login.
  useEffect(() => {
    const exp = session?.exp;
    if (!exp) return;
    const delay = Math.max(0, exp - Date.now() - 5 * 60_000);
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/refresh", { method: "POST" });
        const data = await res.json();
        if (!res.ok || !data.session) {
          setSession(null);
          return;
        }
        setSession((s) => (s ? { ...s, role: data.session.role, exp: data.session.exp } : s));
      } catch {
        /* offline — keep the session, the effect retries on the next change */
      }
    }, delay);
    return () => clearTimeout(t);
  }, [session?.exp]);

  const value = useMemo<RoleContextValue>(
    () => ({
      ready,
      session,
      user: session?.user ?? null,
      role: session?.role ?? null,
      can: (c) => {
        const role = session?.role;
        return role ? ROLE_CAPS[role].includes(c) : false;
      },
      landingPath:
        session?.role === "super_admin"
          ? "/platform"
          : session?.role && ROLE_CAPS[session.role].includes("viewDashboard")
            ? "/dashboard"
            : "/invoices",
      setRole: (r) => session && setSession({ ...session, role: r }),
      register,
      acceptInvite,
      logout,
    }),
    [ready, session, register, acceptInvite, logout],
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used inside <RoleProvider>");
  return ctx;
}
