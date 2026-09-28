"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@apollo/client";
import { CompanySettingsQuery } from "@/graphql/operations/queries";
import { UpdateCompanySettingsMutation, UpdateCompanyTaxDetailsMutation } from "@/graphql/operations/mutations";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field, TextInput } from "@/components/ui/Field";
import { ModelStatusPanel } from "@/components/admin/ModelStatusPanel";
import { ModelDriftPanel } from "@/components/admin/ModelDriftPanel";
import { RetrainHistoryPanel } from "@/components/admin/RetrainHistoryPanel";
import { SignaturePad } from "@/components/settings/SignaturePad";
import { LogoUpload } from "@/components/settings/LogoUpload";
import { useRole } from "@/lib/role";

type TaxField =
  | "gstin"
  | "pan"
  | "state"
  | "address"
  | "bankAccountName"
  | "bankName"
  | "bankAccountNumber"
  | "bankIfsc"
  | "bankSwift";

const TAX_FIELDS: { name: TaxField; label: string; placeholder?: string; bank?: boolean }[] = [
  { name: "gstin", label: "GSTIN", placeholder: "29ABCDE1234F1Z5" },
  { name: "pan", label: "PAN", placeholder: "ABCDE1234F" },
  { name: "state", label: "State", placeholder: "Maharashtra" },
  { name: "address", label: "Address", placeholder: "Street, city, PIN" },
  { name: "bankAccountName", label: "Account holder", bank: true },
  { name: "bankName", label: "Bank name", bank: true },
  { name: "bankAccountNumber", label: "Account number", bank: true },
  { name: "bankIfsc", label: "IFSC", bank: true },
  { name: "bankSwift", label: "SWIFT", bank: true },
];

export default function SettingsPage() {
  const { can } = useRole();
  const isAdmin = can("manageUsers");
  const { data, loading, refetch } = useQuery(CompanySettingsQuery);
  const [update, { loading: saving }] = useMutation(UpdateCompanySettingsMutation);
  const [updateTax, { loading: savingTax }] = useMutation(UpdateCompanyTaxDetailsMutation);

  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [digest, setDigest] = useState("");
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [tax, setTax] = useState<Record<TaxField, string>>(
    Object.fromEntries(TAX_FIELDS.map((f) => [f.name, ""])) as Record<TaxField, string>,
  );
  const set = (f: TaxField) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setTax((t) => ({ ...t, [f]: e.target.value }));
  const [taxOk, setTaxOk] = useState<string | null>(null);
  const [taxErr, setTaxErr] = useState<string | null>(null);

  useEffect(() => {
    if (!data?.companySettings) return;
    // intentional: seeds editable form fields once the query resolves, not
    // state derivable during render.
    /* eslint-disable react-hooks/set-state-in-effect */
    setName(data.companySettings.name);
    setAliases(data.companySettings.aliases.join(", "));
    setDigest(data.companySettings.digestEmails.join(", "));
    setTax(Object.fromEntries(TAX_FIELDS.map((f) => [f.name, data.companySettings[f.name] ?? ""])) as Record<TaxField, string>);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data]);

  async function submitTax(e: React.FormEvent) {
    e.preventDefault();
    setTaxOk(null);
    setTaxErr(null);
    try {
      await updateTax({
        variables: Object.fromEntries(TAX_FIELDS.map((f) => [f.name, tax[f.name].trim() || null])),
      });
      setTaxOk("Saved.");
      refetch();
    } catch (e) {
      setTaxErr(e instanceof Error ? e.message : "Couldn't save");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setOk(null);
    setErr(null);
    try {
      await update({
        variables: {
          name: name.trim(),
          aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean),
          digestEmails: digest.split(",").map((a) => a.trim()).filter(Boolean),
        },
      });
      setOk("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t save");
    }
  }

  return (
    <>
      <PageHeader
        title="Company settings"
        meta="Your company's own name — used to tell payables from receivables automatically when a document is uploaded."
      />

      <Panel>
        {isAdmin ? (
          <>
            <form onSubmit={submit} className="grid gap-4 max-w-xl">
              <Field label="Company name">
                <TextInput
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Acme Private Limited"
                  disabled={loading}
                />
                <p className="mt-1 text-2xs text-ink-muted">Exactly as it appears on invoices you issue or receive.</p>
              </Field>
              <Field label="Also known as">
                <TextInput
                  value={aliases}
                  onChange={(e) => setAliases(e.target.value)}
                  placeholder="Acme Pvt Ltd, Acme Technologies"
                  disabled={loading}
                />
                <p className="mt-1 text-2xs text-ink-muted">
                  Comma-separated alternate spellings, if any — minor punctuation and Pvt/Ltd
                  differences are already matched automatically.
                </p>
              </Field>
              <Field label="Overdue digest recipients">
                <TextInput
                  value={digest}
                  onChange={(e) => setDigest(e.target.value)}
                  placeholder="ap-team@acme.com, cfo@acme.com"
                  disabled={loading}
                />
                <p className="mt-1 text-2xs text-ink-muted">
                  Comma-separated. Get the daily list of your newly overdue invoices — only your company&apos;s.
                </p>
              </Field>
              <div className="flex justify-end">
                <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </form>
            {err && <Callout tone="bad" className="mt-3 text-xs">{err}</Callout>}
            {ok && <Callout tone="ok" className="mt-3 text-xs">{ok}</Callout>}
            {!name.trim() && !loading && (
              <Callout tone="warn" className="mt-3 text-xs">
                Not set yet — document uploads default to payable until this is filled in.
              </Callout>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-muted">
            {data?.companySettings.name || "Not set yet"} — only an admin can rename the company.
          </p>
        )}
      </Panel>

      <Panel title="Tax & billing details" className="mt-6">
        <p className="mb-3 text-xs text-ink-muted">
          Printed on every generated invoice — GSTIN/PAN/state determine the CGST+SGST vs IGST
          split, and bank details show in the payment block.
        </p>
        <form onSubmit={submitTax} className="grid gap-4 max-w-xl">
          <div className="grid gap-4 md:grid-cols-2">
            {TAX_FIELDS.filter((f) => !f.bank).map(({ name, label, placeholder }) => (
              <Field key={name} label={label}>
                <TextInput value={tax[name]} onChange={set(name)} placeholder={placeholder} />
              </Field>
            ))}
          </div>
          <div className="border-t border-line pt-4">
            <p className="mb-2 text-2xs font-medium uppercase tracking-wide text-ink-muted">Bank details</p>
            <div className="grid gap-4 md:grid-cols-2">
              {TAX_FIELDS.filter((f) => f.bank).map(({ name, label }) => (
                <Field key={name} label={label}>
                  <TextInput value={tax[name]} onChange={set(name)} />
                </Field>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={savingTax}>
              {savingTax ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
        {taxErr && <Callout tone="bad" className="mt-3 text-xs">{taxErr}</Callout>}
        {taxOk && <Callout tone="ok" className="mt-3 text-xs">{taxOk}</Callout>}
      </Panel>

      <Panel title="Company logo" className="mt-6">
        <p className="mb-3 text-xs text-ink-muted">
          Shown in the header of every invoice you generate and send from Invoices → Create &amp; send.
        </p>
        <LogoUpload savedDataUrl={data?.companySettings.logoDataUrl ?? null} />
      </Panel>

      <Panel title="Digital signature" className="mt-6">
        <p className="mb-3 text-xs text-ink-muted">
          Draw a signature once, or upload an image — it&apos;s stamped on every invoice you generate
          and send from Invoices → Create &amp; send.
        </p>
        <SignaturePad savedDataUrl={data?.companySettings.signatureDataUrl ?? null} />
      </Panel>

      {isAdmin && (
        <>
          <div className="mt-6">
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-ink-muted">
              ML models
            </div>
            <ModelStatusPanel />
          </div>

          <div className="mt-6">
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-ink-muted">
              Model drift
            </div>
            <ModelDriftPanel />
          </div>

          <div className="mt-6">
            <RetrainHistoryPanel />
          </div>
        </>
      )}
    </>
  );
}
