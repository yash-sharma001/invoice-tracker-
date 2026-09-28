"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Callout } from "@/components/ui/Callout";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { fmtDateTime } from "@/lib/format";

type Overview = {
  companies: { active: number; suspended: number; deleted: number };
  users: number;
  invoices: number;
  invoice_volume: number;
  signups_by_month: { month: string; n: number }[];
};
type Company = {
  id: string;
  name: string;
  status: "active" | "suspended" | "deleted";
  created_at: string;
  users: number;
  invoices: number;
  volume: number;
  last_activity: string | null;
  admin: string | null;
};
type CompanyUser = { username: string; email: string; role: string; active: boolean };

const num = (n: number) => n.toLocaleString("en-IN");

async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`/api/platform/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `Request failed (${res.status})`);
  return data;
}

export default function PlatformPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, c] = await Promise.all([api("overview"), api("companies")]);
      setOverview(o);
      setCompanies(c.companies);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load platform data");
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function run(fn: () => Promise<unknown>, reloadUsersFor?: string) {
    setError(null);
    try {
      await fn();
      await load();
      if (reloadUsersFor) setUsers((await api(`companies/${reloadUsersFor}/users`)).users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  }

  async function toggle(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id);
    setUsers([]);
    run(async () => setUsers((await api(`companies/${id}/users`)).users));
  }

  const tiles = overview && [
    ["Customers", num(overview.companies.active)],
    ["Suspended", num(overview.companies.suspended)],
    ["Active users", num(overview.users)],
    ["Invoices", num(overview.invoices)],
    ["Invoice volume", `₹${num(Math.round(overview.invoice_volume))}`],
  ];

  return (
    <>
      <PageHeader title="Platform" meta="All customers on the product. Only the super admin sees this." />
      {error && (
        <Callout tone="bad" className="mb-4 text-xs">
          {error}
        </Callout>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles?.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <div className="text-xs text-ink-muted">{label}</div>
            <div className="tabular mt-1 text-xl font-semibold text-ink">{value}</div>
          </div>
        ))}
      </div>

      <Panel title="Companies">
        <div className="overflow-x-auto rounded border border-line">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-ground text-ink-muted">
              <tr>
                {["Company", "Admin", "Users", "Invoices", "Volume", "Last activity", "Status", ""].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {companies.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-ink-muted">
                    No customers yet.
                  </td>
                </tr>
              )}
              {companies.map((c) => (
                <Fragment key={c.id}>
                  <tr className="border-t border-line">
                    <td className="px-3 py-2 font-medium text-ink">
                      <button type="button" onClick={() => toggle(c.id)} className="hover:underline">
                        {c.name}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-ink-muted">{c.admin ?? "—"}</td>
                    <td className="tabular px-3 py-2">{c.users}</td>
                    <td className="tabular px-3 py-2">{num(c.invoices)}</td>
                    <td className="tabular px-3 py-2">₹{num(Math.round(c.volume))}</td>
                    <td className="px-3 py-2 text-ink-muted">{c.last_activity ? fmtDateTime(c.last_activity) : "—"}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          c.status === "active" ? "bg-ok-bg text-ok-fg" : "bg-line text-ink-muted"
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="space-x-3 whitespace-nowrap px-3 py-2 text-right text-xs font-semibold">
                      {c.status === "deleted" ? (
                        <button className="text-accent hover:underline" onClick={() => run(() => api(`companies/${c.id}`, "PATCH", { status: "active" }))}>
                          Restore
                        </button>
                      ) : (
                        <>
                          <button
                            className="text-accent hover:underline"
                            onClick={() => run(() => api(`companies/${c.id}`, "PATCH", { status: c.status === "active" ? "suspended" : "active" }))}
                          >
                            {c.status === "active" ? "Suspend" : "Reactivate"}
                          </button>
                          <button
                            className="text-bad-fg hover:underline"
                            onClick={() =>
                              confirm(`Delete ${c.name}? Its users can no longer sign in. Data is kept and it can be restored.`) &&
                              run(() => api(`companies/${c.id}`, "DELETE"))
                            }
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {open === c.id && (
                    <tr className="bg-ground">
                      <td colSpan={8} className="px-3 py-3">
                        <ul className="divide-y divide-line text-sm">
                          {users.map((u) => (
                            <li key={u.username} className="flex flex-wrap items-center justify-between gap-2 py-2">
                              <span>
                                <span className="font-medium text-ink">{u.username}</span>{" "}
                                <span className="text-ink-muted">
                                  · {u.email} · {u.role}
                                  {u.active ? "" : " · deactivated"}
                                </span>
                              </span>
                              <span className="space-x-3 text-xs font-semibold">
                                {u.role !== "admin" && (
                                  <button
                                    className="text-accent hover:underline"
                                    onClick={() =>
                                      confirm(`Make ${u.username} the admin of ${c.name}? The current admin is deactivated.`) &&
                                      run(() => api(`companies/${c.id}/transfer-admin`, "POST", { username: u.username }), c.id)
                                    }
                                  >
                                    Make admin
                                  </button>
                                )}
                                <button
                                  className="text-bad-fg hover:underline"
                                  onClick={() =>
                                    confirm(`Permanently delete user ${u.username}? This can't be undone.`) &&
                                    run(() => api(`companies/${c.id}/users/${encodeURIComponent(u.username)}`, "DELETE"), c.id)
                                  }
                                >
                                  Delete user
                                </button>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
