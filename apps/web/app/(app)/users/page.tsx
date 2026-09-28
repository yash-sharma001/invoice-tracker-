"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { useRole } from "@/lib/role";

const ROLE_OPTIONS = [
  { value: "finance_user", label: "Financial team" },
  { value: "approver", label: "Approver" },
  { value: "admin", label: "Admin" },
] as const;

const SEAT_LIMITS: Record<string, number> = { admin: 1, finance_user: 2, approver: 2 };

type UserRecord = { username: string; role: string; email?: string; active?: boolean };

export default function UsersPage() {
  const { session } = useRole();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [togglingUser, setTogglingUser] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] =
    useState<(typeof ROLE_OPTIONS)[number]["value"]>("finance_user");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] =
    useState<(typeof ROLE_OPTIONS)[number]["value"]>("finance_user");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  useEffect(() => {
    void loadUsers();
  }, [session?.role]);

  async function loadUsers() {
    if (session?.role !== "admin") {
      setUsers([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/users");
      if (!res.ok) {
        throw new Error(`Couldn’t load users (${res.status})`);
      }
      const data = await res.json();
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t load users");
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (session?.role !== "admin") {
      setError("You need to be signed in as admin to create users.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, email, password, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || `Couldn’t create user (${res.status})`);
      }

      setUsername("");
      setEmail("");
      setPassword("");
      setRole("finance_user");
      setSuccess(`Created ${data.username || username}.`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t create user");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(user: UserRecord) {
    setTogglingUser(user.username);
    setToggleError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.username)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !(user.active ?? true) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.detail || `Couldn't update ${user.username}`);
      await loadUsers();
    } catch (err) {
      setToggleError(err instanceof Error ? err.message : "Couldn't update that user");
    } finally {
      setTogglingUser(null);
    }
  }

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    setInviteLink(null);

    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Couldn't create the invite (${res.status})`);
      }
      setInviteLink(data.invite_link);
      setInviteEmail("");
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Couldn't create the invite");
    } finally {
      setInviting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="User management"
        meta="Create and assign access scopes for finance team members, approvers, and admins."
      />

      <Panel title="Invite teammate" className="mb-6">
        <form onSubmit={submitInvite} className="grid gap-4 md:grid-cols-3">
          <Field label="Email" className="md:col-span-2">
            <TextInput
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="e.g. rina.patel@acme.com"
            />
          </Field>
          <Field label="Scope">
            <Select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as (typeof ROLE_OPTIONS)[number]["value"])}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="md:col-span-3 flex items-center justify-end">
            <Button type="submit" variant="primary" disabled={inviting || !inviteEmail}>
              {inviting ? "Sending…" : "Send invite"}
            </Button>
          </div>
        </form>
        {inviteError && (
          <Callout tone="bad" className="mt-4 text-xs">
            {inviteError}
          </Callout>
        )}
        {inviteLink && (
          <Callout tone="ok" className="mt-4 text-xs">
            Invite sent — link (in case email isn&apos;t configured yet): <span className="break-all font-mono">{inviteLink}</span>
          </Callout>
        )}
      </Panel>

      <Panel title="Create user directly" className="mb-6">
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-3">
          <Field label="Username">
            <TextInput
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. rina.patel"
            />
          </Field>

          <Field label="Email">
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. rina.patel@acme.com"
            />
          </Field>

          <Field label="Password">
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Initial password"
            />
          </Field>

          <Field label="Scope">
            <Select
              value={role}
              onChange={(e) =>
                setRole(
                  e.target.value as (typeof ROLE_OPTIONS)[number]["value"],
                )
              }
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>

          <div className="md:col-span-3 flex items-center justify-end">
            <Button
              type="submit"
              variant="primary"
              disabled={saving || !username || !password}
            >
              {saving ? "Creating…" : "Create user"}
            </Button>
          </div>
        </form>

        {error && (
          <Callout tone="bad" className="mt-4 text-xs">
            {error}
          </Callout>
        )}
        {success && (
          <Callout tone="ok" className="mt-4 text-xs">
            {success}
          </Callout>
        )}
      </Panel>

      <Panel title="Existing users">
        <p className="mb-3 text-xs text-ink-muted">
          Seats used:{" "}
          {ROLE_OPTIONS.map((o) => {
            const used = users.filter((u) => u.role === o.value && (u.active ?? true)).length;
            return `${o.label} ${used}/${SEAT_LIMITS[o.value]}`;
          }).join(" · ")}
          . Deactivating a user frees their seat.
        </p>
        {toggleError && (
          <Callout tone="bad" className="mb-3 text-xs">
            {toggleError}
          </Callout>
        )}
        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="h-9 animate-pulse rounded bg-line/60"
              />
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded border border-line">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-ground text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Username</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Scope</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-4 text-center text-ink-muted"
                    >
                      No users yet.
                    </td>
                  </tr>
                ) : (
                  users.map((user) => {
                    const active = user.active ?? true;
                    const isSelf = user.username === session?.user;
                    return (
                      <tr key={user.username} className="border-t border-line">
                        <td className="px-3 py-2 font-medium text-ink">
                          {user.username}
                        </td>
                        <td className="px-3 py-2 text-ink-muted">
                          {user.email || "—"}
                        </td>
                        <td className="px-3 py-2 text-ink-muted">
                          {ROLE_OPTIONS.find(
                            (option) => option.value === user.role,
                          )?.label ?? user.role}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              active ? "bg-ok-bg text-ok-fg" : "bg-line text-ink-muted"
                            }`}
                          >
                            {active ? "Active" : "Deactivated"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => toggleActive(user)}
                            disabled={togglingUser === user.username || isSelf}
                            title={isSelf ? "You can't deactivate your own account" : undefined}
                            className="text-xs font-semibold text-accent hover:underline disabled:cursor-not-allowed disabled:text-ink-muted disabled:no-underline"
                          >
                            {togglingUser === user.username ? "Working…" : active ? "Deactivate" : "Activate"}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
