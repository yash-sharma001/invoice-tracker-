/**
 * Read-model field mapping (snake_case Hasura rows -> the frontend's
 * camelCase GraphQL types) plus the small date/number helpers the mappers
 * share. Pure functions only — no I/O, no auth, no Hasura calls — so they're
 * safe to unit test directly.
 */

export const TODAY = new Date();
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const dayDiff = (a: string | Date, b: string | Date) =>
  Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
export const round = (n: number) => Math.round(n * 100) / 100;
export const num = (v: unknown) => (v == null ? 0 : Number(v));

export function effectivePayment(row: any): "PAID" | "UNPAID" | "OVERDUE" {
  if (row.payment_status === "paid") return "PAID";
  return new Date(row.due_date) < TODAY ? "OVERDUE" : "UNPAID";
}
export const daysOverdue = (row: any) =>
  effectivePayment(row) === "OVERDUE" ? dayDiff(TODAY, row.due_date) : 0;
export const grossOutstanding = (row: any) =>
  effectivePayment(row) === "PAID" ? 0 : num(row.amount) + num(row.tax_amount);

/** Trim; empty -> null; reject anything without an "@". */
export function cleanEmail(raw?: string | null): string | null {
  const e = String(raw ?? "").trim();
  if (!e) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("Enter a valid email address");
  return e;
}

export function mapMlModel(m: any) {
  const metrics = m?.metrics ?? {};
  return {
    status: m?.status ?? "not_trained",
    method: m?.method ?? "unknown",
    modelVersion: m?.model_version ?? null,
    trainedAt: m?.trained_at ?? null,
    nRows: m?.n_rows ?? null,
    featureCount: m?.feature_count ?? null,
    threshold: m?.threshold ?? null,
    metrics: {
      rocAuc: metrics.roc_auc ?? null,
      accuracy: metrics.accuracy ?? null,
      precision: metrics.precision ?? null,
      recall: metrics.recall ?? null,
      maeDays: metrics.mae_days ?? null,
      r2: metrics.r2 ?? null,
    },
  };
}

export function mapMlDriftReport(r: any) {
  return {
    modelName: r?.model_name ?? "unknown",
    checkedAt: r?.checked_at ?? null,
    driftDetected: Boolean(r?.drift_detected),
    featurePsiJson: JSON.stringify(r?.feature_psi ?? {}),
    rollingMetricsJson: JSON.stringify(r?.rolling_metrics ?? {}),
    baselineMetricsJson: JSON.stringify(r?.baseline_metrics ?? {}),
    notes: r?.notes ?? null,
  };
}

export function mapMlRetrainEvent(e: any) {
  const metrics = (m: any) => ({
    rocAuc: m?.roc_auc ?? null,
    accuracy: m?.accuracy ?? null,
    precision: m?.precision ?? null,
    recall: m?.recall ?? null,
    maeDays: m?.mae_days ?? null,
    r2: m?.r2 ?? null,
  });
  return {
    id: e.id,
    modelName: e.model_name,
    triggeredBy: e.triggered_by,
    startedAt: e.started_at,
    finishedAt: e.finished_at ?? null,
    status: e.status,
    oldVersion: e.old_version ?? null,
    newVersion: e.new_version ?? null,
    oldMetrics: e.old_metrics ? metrics(e.old_metrics) : null,
    newMetrics: e.new_metrics ? metrics(e.new_metrics) : null,
    error: e.error ?? null,
  };
}

export function mapReviewQueueItem(r: any) {
  const draft = r.invoice_draft ?? {};
  return {
    id: r.id,
    status: r.status,
    issues: r.issues ?? [],
    createdAt: r.created_at,
    filename: draft.filename ?? null,
    direction: draft.direction ?? null,
    counterpartyName: draft.counterparty_name ?? null,
    extractedFieldsJson: JSON.stringify(draft.extracted_fields ?? {}),
    sourceMapJson: JSON.stringify(draft.source_map ?? []),
    fullText: draft.full_text || null,
  };
}

export function mapDemoRequest(d: any) {
  return {
    id: d.id,
    companyName: d.company_name,
    contactName: d.contact_name,
    workEmail: d.work_email,
    companySize: d.company_size,
    message: d.message,
    createdAt: d.created_at,
  };
}

export function mapVendor(v: any) {
  return v
    ? {
        id: v.id,
        name: v.name,
        taxId: v.tax_id ?? null,
        paymentTermsDays: v.payment_terms_days ?? null,
        email: v.email ?? null,
        invoices: (v.invoices ?? []).map(mapInvoice),
      }
    : null;
}

export const COMPANY_SEL = `
  name aliases signature_data_url logo_data_url gstin pan address state legal_name city pincode einvoice_enabled
  bank_account_name bank_name bank_account_number bank_ifsc bank_swift digest_emails
`;

export function mapCompanySettings(row: any) {
  row = row ?? {};
  return {
    name: row.name ?? "",
    aliases: row.aliases ?? [],
    digestEmails: row.digest_emails ?? [],
    signatureDataUrl: row.signature_data_url ?? null,
    logoDataUrl: row.logo_data_url ?? null,
    gstin: row.gstin ?? null,
    pan: row.pan ?? null,
    address: row.address ?? null,
    state: row.state ?? null,
    legalName: row.legal_name ?? null,
    city: row.city ?? null,
    pincode: row.pincode ?? null,
    einvoiceEnabled: row.einvoice_enabled ?? false,
    bankAccountName: row.bank_account_name ?? null,
    bankName: row.bank_name ?? null,
    bankAccountNumber: row.bank_account_number ?? null,
    bankIfsc: row.bank_ifsc ?? null,
    bankSwift: row.bank_swift ?? null,
  };
}

export function mapCustomer(c: any) {
  return c
    ? {
        id: c.id,
        name: c.name,
        taxId: c.tax_id ?? null,
        email: c.email ?? null,
        paymentTermsDays: c.payment_terms_days ?? null,
        creditLimit: c.credit_limit == null ? null : num(c.credit_limit),
        gstin: c.gstin ?? null,
        address: c.address ?? null,
        state: c.state ?? null,
        legalName: c.legal_name ?? null,
        city: c.city ?? null,
        pincode: c.pincode ?? null,
        invoices: (c.invoices ?? []).map(mapInvoice),
      }
    : null;
}

export function mapInvoice(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    description: row.description ?? null,
    extractedText: row.extracted_text ?? null,
    direction: String(row.direction ?? "payable").toUpperCase(),
    collectionStatus: row.collection_status
      ? String(row.collection_status).toUpperCase()
      : null,
    customer: mapCustomer(row.customer),
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    amount: num(row.amount),
    taxAmount: num(row.tax_amount),
    department: row.department,
    approvalStatus: String(row.approval_status ?? "pending").toUpperCase(),
    paymentStatus: effectivePayment(row),
    source: row.source,
    template: row.template ?? null,
    irn: row.irn ?? null,
    einvoiceStatus: row.einvoice_status ?? null,
    einvoiceError: row.einvoice_error ?? null,
    daysOverdue: daysOverdue(row),
    vendor: mapVendor(row.vendor),
    purchaseOrder: row.purchaseOrder
      ? {
          id: row.purchaseOrder.id,
          poNumber: row.purchaseOrder.po_number,
          amount: num(row.purchaseOrder.amount),
          status: row.purchaseOrder.status,
          department: row.purchaseOrder.department,
          vendor: mapVendor(row.purchaseOrder.vendor),
        }
      : null,
    // duplicateFlag/delayPrediction are no longer a Hasura relationship —
    // duplicate_flags/delay_predictions moved to ml-service's own private
    // ml_db. Callers that need these (the invoices/invoice/ask resolvers)
    // batch-fetch them via server/predictions.ts's attachPredictions() and
    // merge onto the mapped row afterward; everything else gets null here.
    duplicateFlag: null,
    delayPrediction: null,
    approvalEvents: (row.approvals ?? [])
      .filter((a: any) => a.status && a.status !== "pending")
      .map((a: any) => ({
        id: a.id,
        actor: a.approver,
        action: a.status,
        note: null,
        at: a.acted_at ?? row.invoice_date,
      })),
    payments: (row.payments ?? []).map((p: any) => ({
      id: p.id,
      paidAt: p.paid_at ?? null,
      amountPaid: num(p.amount_paid),
    })),
  };
}

export const INVOICE_SEL = `
  id company_id invoice_number description extracted_text direction collection_status
  invoice_date due_date amount tax_amount department
  approval_status payment_status source template irn einvoice_status einvoice_error
  vendor { id name tax_id payment_terms_days }
  customer { id name tax_id payment_terms_days email credit_limit }
  purchaseOrder { id po_number amount status department vendor { id name tax_id payment_terms_days } }
  approvals(order_by: { acted_at: asc_nulls_last }) { id approver level status acted_at }
  payments(order_by: { paid_at: asc_nulls_last }) { id paid_at amount_paid }
`;

/** Field selection for a duplicate flag's matched invoice — same limited
 * shape the old Hasura relationship selected, passed through mapInvoice()
 * to build a (mostly-null, by design) Invoice for the frontend's
 * DuplicateFlag.matchedInvoice field. */
export const MATCHED_INVOICE_SEL = `id invoice_number amount tax_amount invoice_date vendor { id name }`;

export function mapDuplicateFlag(raw: any, matchedInvoiceRow: any): any {
  if (!raw) return null;
  return {
    matchedInvoiceId: raw.matched_invoice_id,
    confidenceScore: num(raw.confidence_score),
    reviewedStatus: raw.reviewed_status,
    reason: raw.reason ?? null,
    explanation: raw.explanation ?? [],
    matchedInvoice: matchedInvoiceRow ? mapInvoice(matchedInvoiceRow) : null,
  };
}

export function mapDelayPrediction(raw: any): any {
  if (!raw) return null;
  return {
    delayProbability: num(raw.delay_probability),
    predictedDelayDays: num(raw.predicted_delay_days),
    modelVersion: raw.model_version,
    explanation: raw.explanation ?? [],
  };
}

export function vendorStats(v: any) {
  const list = v.invoices ?? [];
  const paid = list.filter((i: any) => i.payment_status === "paid");
  const lateness = paid.map((i: any) => {
    const paidAt = i.payments?.[0]?.paid_at;
    return paidAt ? Math.max(0, dayDiff(paidAt, i.due_date)) : 0;
  });
  const avgDelayDays = lateness.length
    ? Math.round((lateness.reduce((a: number, b: number) => a + b, 0) / lateness.length) * 10) / 10
    : 0;
  const onTime = lateness.filter((d: number) => d === 0).length;
  return {
    vendor: {
      id: v.id, name: v.name, taxId: v.tax_id ?? null,
      paymentTermsDays: v.payment_terms_days ?? null, email: v.email ?? null, invoices: [],
    },
    totalInvoices: list.length,
    totalExposure: round(list.reduce((s: number, i: any) => s + grossOutstanding(i), 0)),
    avgDelayDays,
    onTimePct: paid.length ? Math.round((onTime / paid.length) * 100) : 100,
  };
}

export function customerStats(c: any) {
  const list = c.invoices ?? [];
  const paid = list.filter((i: any) => i.payment_status === "paid");
  const lateness = paid.map((i: any) => {
    const paidAt = i.payments?.[0]?.paid_at;
    return paidAt ? Math.max(0, dayDiff(paidAt, i.due_date)) : 0;
  });
  const avgDelayDays = lateness.length
    ? Math.round((lateness.reduce((a: number, b: number) => a + b, 0) / lateness.length) * 10) / 10
    : 0;
  const onTime = lateness.filter((d: number) => d === 0).length;
  return {
    customer: { ...mapCustomer(c), invoices: [] },
    totalInvoices: list.length,
    totalExposure: round(list.reduce((s: number, i: any) => s + grossOutstanding(i), 0)),
    avgDelayDays,
    onTimePct: paid.length ? Math.round((onTime / paid.length) * 100) : 100,
  };
}
