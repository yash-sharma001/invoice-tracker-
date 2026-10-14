"use client";

import { useState, use } from "react";
import { useMutation, useQuery } from "@apollo/client";
import { CustomerDetailQuery, InvoicesQuery } from "@/graphql/operations/queries";
import { UpdateCustomerEmailMutation, UpdateCustomerTaxDetailsMutation } from "@/graphql/operations/mutations";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field, TextInput } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { QueryState } from "@/components/ui/QueryState";
import { pickInvoiceColumns } from "@/components/invoice/columns";
import { inrCompact } from "@/lib/format";
import { useRole } from "@/lib/role";
import type { InvoiceRow } from "@/lib/types";

const HISTORY_COLUMNS = [
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "amount",
  "daysOverdue",
  "collection",
  "risk",
  "payment",
];

function CustomerEmailPanel({ id, email }: { id: string; email: string | null | undefined }) {
  const { can } = useRole();
  const [value, setValue] = useState(email ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [update, { loading }] = useMutation(UpdateCustomerEmailMutation);

  if (!can("manageUsers") && !can("addInvoices") && !can("manageSettings")) {
    return (
      <Panel title="Contact email" className="mt-6">
        <p className="text-sm text-ink-muted">{email || "None on file."}</p>
      </Panel>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaved(false);
    try {
      await update({ variables: { id, email: value || null } });
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t save");
    }
  }

  return (
    <Panel title="Contact email" className="mt-6">
      <form onSubmit={submit} className="flex items-end gap-3">
        <Field label="Email" className="flex-1">
          <TextInput
            type="email"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            placeholder="ap@customer.com"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={loading}>
          {loading ? "Saving…" : "Save"}
        </Button>
      </form>
      {err && <Callout tone="bad" className="mt-3 text-xs">{err}</Callout>}
      {saved && <Callout tone="ok" className="mt-3 text-xs">Saved.</Callout>}
    </Panel>
  );
}

function CustomerTaxPanel({
  id,
  gstin,
  address,
  state,
  legalName,
  city,
  pincode,
}: {
  id: string;
  gstin: string | null | undefined;
  address: string | null | undefined;
  state: string | null | undefined;
  legalName: string | null | undefined;
  city: string | null | undefined;
  pincode: string | null | undefined;
}) {
  const { can } = useRole();
  const [gstinVal, setGstinVal] = useState(gstin ?? "");
  const [addressVal, setAddressVal] = useState(address ?? "");
  const [stateVal, setStateVal] = useState(state ?? "");
  const [legalNameVal, setLegalNameVal] = useState(legalName ?? "");
  const [cityVal, setCityVal] = useState(city ?? "");
  const [pincodeVal, setPincodeVal] = useState(pincode ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [update, { loading }] = useMutation(UpdateCustomerTaxDetailsMutation);

  if (!can("manageUsers")) {
    return (
      <Panel title="Tax details" className="mt-6">
        <p className="text-sm text-ink-muted">
          {gstin || "No GSTIN"} {address ? `· ${address}` : ""} {state ? `· ${state}` : ""}
        </p>
      </Panel>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaved(false);
    try {
      await update({
        variables: {
          id,
          gstin: gstinVal.trim() || null,
          address: addressVal.trim() || null,
          state: stateVal.trim() || null,
          legalName: legalNameVal.trim() || null,
          city: cityVal.trim() || null,
          pincode: pincodeVal.trim() || null,
        },
      });
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save");
    }
  }

  return (
    <Panel title="Tax details" className="mt-6">
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-3">
        <Field label="GSTIN">
          <TextInput value={gstinVal} onChange={(e) => { setGstinVal(e.target.value); setSaved(false); }} placeholder="29ABCDE1234F1Z5" />
        </Field>
        <Field label="State">
          <TextInput value={stateVal} onChange={(e) => { setStateVal(e.target.value); setSaved(false); }} placeholder="Maharashtra" />
        </Field>
        <Field label="Address">
          <TextInput value={addressVal} onChange={(e) => { setAddressVal(e.target.value); setSaved(false); }} placeholder="Street, area" />
        </Field>
        <Field label="Legal name">
          <TextInput value={legalNameVal} onChange={(e) => { setLegalNameVal(e.target.value); setSaved(false); }} placeholder="As on their GST registration" />
        </Field>
        <Field label="City">
          <TextInput value={cityVal} onChange={(e) => { setCityVal(e.target.value); setSaved(false); }} placeholder="New Delhi" />
        </Field>
        <Field label="Pincode">
          <TextInput value={pincodeVal} onChange={(e) => { setPincodeVal(e.target.value); setSaved(false); }} placeholder="110001" />
        </Field>
        <div className="md:col-span-3 flex justify-end">
          <Button type="submit" variant="primary" disabled={loading}>
            {loading ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
      {err && <Callout tone="bad" className="mt-3 text-xs">{err}</Callout>}
      {saved && <Callout tone="ok" className="mt-3 text-xs">Saved.</Callout>}
    </Panel>
  );
}

export default function CustomerDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const customer = useQuery(CustomerDetailQuery, { variables: { id: params.id } });
  const history = useQuery(InvoicesQuery, {
    variables: {
      filter: { direction: "RECEIVABLE" as const, customerId: params.id },
      sort: { field: "invoiceDate", dir: "DESC" as const },
      page: 1,
      pageSize: 500,
    },
  });

  const c = customer.data?.customer;
  const rows = (history.data?.invoices.rows ?? []) as InvoiceRow[];

  return (
    <QueryState loading={customer.loading && !c} error={customer.error} minRows={4}>
      {!c ? (
        <p className="text-sm text-ink-muted">Customer not found.</p>
      ) : (
        <>
          <PageHeader
            title={c.customer.name}
            meta={
              <span className="tabular">
                {c.customer.taxId ?? "No GSTIN"} ·{" "}
                {c.customer.paymentTermsDays ? `${c.customer.paymentTermsDays}-day terms` : "terms n/a"}
                {c.customer.creditLimit ? ` · ${inrCompact(c.customer.creditLimit)} limit` : ""}
              </span>
            }
          />

          <div className="mt-3 grid grid-cols-2 divide-line border border-line bg-surface text-sm sm:grid-cols-4 sm:divide-x">
            <div className="px-4 py-3">
              <div className="text-xs text-ink-muted">Receivables</div>
              <div className="tabular mt-1 text-lg">{c.totalInvoices}</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-ink-muted">Outstanding</div>
              <div className="tabular mt-1 text-lg">{inrCompact(c.totalExposure)}</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-ink-muted">Avg collection delay</div>
              <div className="tabular mt-1 text-lg">{c.avgDelayDays.toFixed(1)} days</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-ink-muted">Paid on time</div>
              <div className="tabular mt-1 text-lg">{c.onTimePct}%</div>
            </div>
          </div>

          <CustomerEmailPanel id={params.id} email={c.customer.email} />
          <CustomerTaxPanel
            id={params.id}
            gstin={c.customer.gstin}
            address={c.customer.address}
            state={c.customer.state}
            legalName={c.customer.legalName}
            city={c.customer.city}
            pincode={c.customer.pincode}
          />

          <Panel title="Receivable history" className="mt-6">
            <QueryState loading={history.loading} error={history.error} minRows={6}>
              <DataTable
                rows={rows}
                columns={pickInvoiceColumns(HISTORY_COLUMNS)}
                rowId={(r) => r.id}
                rowHref={(r) => `/receivables/${r.id}`}
                defaultSort={{ field: "invoiceDate", dir: "DESC" }}
                empty="No receivables for this customer."
              />
            </QueryState>
          </Panel>
        </>
      )}
    </QueryState>
  );
}
