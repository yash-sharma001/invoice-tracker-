"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@apollo/client";
import { InvoiceDetailQuery } from "@/graphql/operations/queries";
import {
  SetCollectionStatusMutation,
  DeleteInvoiceMutation,
  ResendInvoiceMutation,
  RetryEinvoiceMutation,
} from "@/graphql/operations/mutations";
import { useState, use } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Badge, PaymentBadge, OverdueBadge } from "@/components/ui/Badge";
import { Field, Select } from "@/components/ui/Field";
import { QueryState } from "@/components/ui/QueryState";
import { DelayPanel } from "@/components/invoice/DelayPanel";
import { InvoiceSummaryPanel } from "@/components/invoice/InvoiceSummaryPanel";
import { PaymentPanel } from "@/components/invoice/PaymentPanel";
import { COLLECTION_TONE } from "@/components/invoice/columns";
import { inr, fmtDate } from "@/lib/format";
import { useRole } from "@/lib/role";

const STAGES = ["DRAFT", "SENT", "DISPUTED", "SETTLED"] as const;

export default function ReceivableDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { can } = useRole();
  const router = useRouter();
  const { data, loading, error } = useQuery(InvoiceDetailQuery, {
    variables: { id: params.id },
  });
  const [setStatus, statusState] = useMutation(SetCollectionStatusMutation, {
    refetchQueries: ["InvoiceDetail", "InflowStats", "Invoices"],
    onError: () => {},
  });
  const [deleteInvoice, deleteState] = useMutation(DeleteInvoiceMutation, {
    refetchQueries: ["InflowStats", "Invoices"],
    onError: () => {},
  });
  const [resendInvoice, resendState] = useMutation(ResendInvoiceMutation, { onError: () => {} });
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const [retryEinvoice, retryState] = useMutation(RetryEinvoiceMutation, {
    refetchQueries: ["InvoiceDetail", "Invoices"],
    onError: () => {},
  });

  const inv = data?.invoice;

  return (
    <QueryState loading={loading && !inv} error={error} minRows={6}>
      {!inv || inv.direction !== "RECEIVABLE" ? (
        <p className="text-sm text-ink-muted">Receivable not found.</p>
      ) : (
        <>
          <PageHeader
            title={<span className="tabular">{inv.invoiceNumber}</span>}
            meta={
              <span>
                {inv.customer ? (
                  <Link
                    href={`/customers/${inv.customer.id}`}
                    className="text-accent hover:underline"
                  >
                    {inv.customer.name}
                  </Link>
                ) : (
                  "Customer"
                )}{" "}
                · {inv.department}
              </span>
            }
            actions={
              <>
                {inv.template && can("addInvoices") && (
                  <Button
                    variant="default"
                    disabled={resendState.loading}
                    onClick={async () => {
                      setResendMsg(null);
                      const res = await resendInvoice({ variables: { id: inv.id } });
                      setResendMsg(
                        res.errors
                          ? res.errors[0].message
                          : res.data?.resendInvoice
                            ? "Resent."
                            : "Recreated the PDF, but the email wasn't sent (SMTP isn't configured) — check the server log.",
                      );
                    }}
                  >
                    {resendState.loading ? "Resending…" : "Resend invoice"}
                  </Button>
                )}
                {/* A registered e-invoice is a legal document — the DB refuses to delete it. */}
                {can("deleteInvoice") && !inv.irn && (
                  <Button
                    variant="danger"
                    data-testid="delete-invoice"
                    disabled={deleteState.loading}
                    onClick={async () => {
                      if (
                        !window.confirm(`Delete invoice ${inv.invoiceNumber}? This can't be undone.`)
                      )
                        return;
                      const res = await deleteInvoice({ variables: { id: inv.id } });
                      if (res.data?.deleteInvoice) router.push("/receivables");
                    }}
                  >
                    Delete
                  </Button>
                )}
              </>
            }
          />
          {resendMsg && (
            <Callout tone={resendMsg === "Resent." ? "ok" : "warn"} className="mb-4 text-xs">
              {resendMsg}
            </Callout>
          )}

          {deleteState.error && (
            <Callout tone="bad" className="mb-4">
              {deleteState.error.message}
            </Callout>
          )}

          <div className="mb-4 flex flex-wrap gap-2">
            {inv.collectionStatus && (
              <Badge tone={COLLECTION_TONE[inv.collectionStatus] ?? "neutral"}>
                {inv.collectionStatus.toLowerCase()}
              </Badge>
            )}
            <PaymentBadge status={inv.paymentStatus} />
            {inv.daysOverdue > 0 && <OverdueBadge days={inv.daysOverdue} />}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              <InvoiceSummaryPanel invoiceId={inv.id} description={inv.description} />

              {inv.einvoiceStatus && (
                <Panel title="GST e-invoice">
                  {inv.irn ? (
                    <>
                      <Badge tone="ok">Registered with IRP</Badge>
                      <p className="mt-2 break-all text-2xs text-ink-muted">IRN: <span className="tabular">{inv.irn}</span></p>
                    </>
                  ) : (
                    <>
                      <Badge tone="bad">Not registered — not a valid e-invoice, not sent</Badge>
                      {inv.einvoiceError && <p className="mt-2 text-xs text-ink-muted">{inv.einvoiceError}</p>}
                      {can("addInvoices") && inv.einvoiceStatus === "failed" && (
                        <Button
                          className="mt-3"
                          variant="primary"
                          disabled={retryState.loading}
                          onClick={() => retryEinvoice({ variables: { id: inv.id } })}
                        >
                          {retryState.loading ? "Retrying…" : "Retry registration"}
                        </Button>
                      )}
                      {retryState.error && (
                        <Callout tone="bad" className="mt-3 text-xs">{retryState.error.message}</Callout>
                      )}
                    </>
                  )}
                </Panel>
              )}

              <Panel title="Details">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                  <Detail label="Amount" value={inr(inv.amount)} mono />
                  <Detail label="Tax (GST)" value={inr(inv.taxAmount)} mono />
                  <Detail label="Total" value={inr(inv.amount + inv.taxAmount)} mono />
                  <Detail label="Invoice date" value={fmtDate(inv.invoiceDate)} mono />
                  <Detail label="Due date" value={fmtDate(inv.dueDate)} mono />
                  <Detail
                    label="Payment terms"
                    value={
                      inv.customer?.paymentTermsDays
                        ? `${inv.customer.paymentTermsDays} days`
                        : "—"
                    }
                  />
                  <Detail label="Customer GSTIN" value={inv.customer?.taxId ?? "—"} mono />
                  <Detail
                    label="Credit limit"
                    value={inv.customer?.creditLimit ? inr(inv.customer.creditLimit) : "—"}
                    mono
                  />
                </dl>
              </Panel>
            </div>

            <div className="space-y-4">
              <Panel title="Collection stage">
                {can("addInvoices") || can("recordPayment") ? (
                  <Field label="Stage">
                    <Select
                      value={inv.collectionStatus ?? "DRAFT"}
                      onChange={(e) =>
                        setStatus({
                          variables: { id: inv.id, status: e.target.value as never },
                        })
                      }
                      disabled={statusState.loading}
                    >
                      {STAGES.map((s) => (
                        <option key={s} value={s}>
                          {s[0] + s.slice(1).toLowerCase()}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : (
                  <p className="text-sm text-ink-muted">
                    {inv.collectionStatus?.toLowerCase() ?? "draft"}
                  </p>
                )}
                {statusState.error && (
                  <Callout tone="bad" className="mt-3 text-xs">
                    {statusState.error.message}
                  </Callout>
                )}
              </Panel>

              {inv.delayPrediction && (
                <DelayPanel
                  pred={inv.delayPrediction}
                  vendorName={inv.customer?.name ?? "this customer"}
                />
              )}

              <PaymentPanel
                invoiceId={inv.id}
                total={inv.amount + inv.taxAmount}
                approvalStatus="APPROVED"
                paymentStatus={inv.paymentStatus}
                payments={inv.payments}
                canRecord={can("recordPayment")}
                title="Receipt"
                actionLabel="Mark as received"
                showGateway={false}
              />
            </div>
          </div>
        </>
      )}
    </QueryState>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={mono ? "tabular mt-0.5" : "mt-0.5"}>{value}</dd>
    </div>
  );
}
