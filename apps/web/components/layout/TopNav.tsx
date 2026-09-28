"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { roleLabel as fmtRole, useRole, type Capability } from "@/lib/role";
import { useAsk } from "@/components/ask/AskContext";
import { IconAsk } from "@/components/ui/icons";
import { QlensMark } from "@/components/brand/QlensMark";

const NAV: {
  href: string;
  label: string;
  exact?: boolean;
  cap?: Capability;
}[] = [
  { href: "/dashboard", label: "Dashboard", exact: true, cap: "viewDashboard" },
  { href: "/invoices", label: "Payables" },
  { href: "/receivables", label: "Receivables" },
  { href: "/vendors", label: "Vendors" },
  { href: "/customers", label: "Customers" },
  { href: "/vendor-history", label: "Vendor history", cap: "viewDashboard" },
  { href: "/forecast", label: "Forecast", cap: "viewDashboard" },
  { href: "/upload", label: "Upload", cap: "addInvoices" },
  { href: "/users", label: "Users", cap: "manageUsers" },
  { href: "/platform", label: "Platform", cap: "platform" },
  { href: "/demo-requests", label: "Leads", cap: "platform" },
  { href: "/settings", label: "Settings", cap: "manageSettings" },
];

/** Horizontal top bar: wordmark, section tabs, Ask, signed-in user. */
export function TopNav() {
  const pathname = usePathname();
  const { can, user, role, logout, landingPath } = useRole();
  const { setOpen } = useAsk();
  const isSuper = role === "super_admin";
  // Platform owner sees only platform tabs; everyone else never sees them.
  const nav = NAV.filter((n) => (n.cap === "platform" ? isSuper : !isSuper && (!n.cap || can(n.cap))));
  const roleLabel = fmtRole(role);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 sm:gap-6 sm:px-6">
      <Link href={landingPath} className="flex shrink-0 items-center gap-2">
        <QlensMark size={22} />
        <span className="font-display text-[17px] font-extrabold tracking-tight text-ink">Qlens</span>
      </Link>

      {/* min-w-0 + overflow-x-auto: the tabs scroll on a phone instead of
          setting a min-width that stretches every page in the shell. */}
      <nav className="flex h-full min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
        {nav.map(({ href, label, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "inline-flex shrink-0 items-center whitespace-nowrap border-b-2 px-3 text-sm transition-colors",
                active
                  ? "border-accent font-medium text-ink"
                  : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-3">
        {!isSuper && <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-genai/40 bg-genai-tint px-3.5 text-sm font-medium text-genai hover:bg-genai/10"
        >
          <IconAsk width={15} height={15} />
          Ask
        </button>}
        <span className="hidden text-sm text-ink-muted sm:inline">
          <span className="tabular text-ink">{user}</span>
          {roleLabel ? ` · ${roleLabel}` : ""}
        </span>
        <button
          type="button"
          onClick={logout}
          className="text-sm text-accent hover:underline"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
