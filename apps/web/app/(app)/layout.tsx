"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useRole, type Capability } from "@/lib/role";
import { AppShell } from "@/components/layout/AppShell";

/** Pages that need a capability beyond "signed in". Everything else is open to any role. */
const GATED: { prefix: string; cap: Capability }[] = [
  { prefix: "/upload", cap: "addInvoices" },
  { prefix: "/users", cap: "manageUsers" },
  { prefix: "/demo-requests", cap: "platform" },
  { prefix: "/platform", cap: "platform" },
  { prefix: "/forecast", cap: "viewDashboard" },
  { prefix: "/dashboard", cap: "viewDashboard" },
];

/** Everything under here needs a session; unauthenticated -> /login. A role that
 *  can't see the requested page is bounced to /invoices (visible to every role). */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { ready, session, can } = useRole();
  const router = useRouter();
  const pathname = usePathname();

  // super_admin has no tenant data: anything outside the platform area bounces to /platform.
  const isSuper = session?.role === "super_admin";
  const inPlatform = pathname.startsWith("/platform") || pathname.startsWith("/demo-requests");
  const blocked =
    ready && session
      ? isSuper
        ? !inPlatform
        : GATED.some(({ prefix, cap }) => pathname.startsWith(prefix) && !can(cap))
      : false;

  useEffect(() => {
    if (ready && !session) router.replace("/login");
    else if (blocked) router.replace(isSuper ? "/platform" : "/invoices");
  }, [ready, session, blocked, isSuper, router]);

  if (!ready || !session || blocked) return null;
  return <AppShell>{children}</AppShell>;
}
