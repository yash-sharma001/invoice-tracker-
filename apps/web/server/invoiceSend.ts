/**
 * generateAndSendInvoice / resendInvoice business logic — PDF rendering +
 * best-effort email delivery. Takes `companyId` as a plain argument; the
 * caller (server/resolvers.ts) is responsible for requireRole/requireCompanyId
 * before calling in — this module never imports ./auth.
 */
import { hasura, NOTIFICATION_URL, internalServiceHeaders } from "./hasura";
import { mapInvoice, round, num } from "./mappers";
import { publishNotification } from "./queue";
import {
  type CompanyBillingCtx,
  type CustomerBillingCtx,
  COMPANY_BILLING_SEL,
  CUSTOMER_BILLING_SEL,
  emptyCompanyBillingCtx,
  companyForPdf,
  customerForPdf,
  lineItemForPdf,
  lineItemInsertRow,
  uqcFromUnit,
} from "./invoicePdfContext";
import { INVOICE_SEL } from "./mappers";
import { buildEInvoice, type IrpPayload } from "../lib/einvoice/payload";
import { registerWithIrp } from "./einvoice/register";
import type { IrpResult } from "./einvoice/provider";

/** Builds + validates the IRP payload. No side effects, so it can run before
 * anything is saved. `sameState` is what the PDF's tax table will show (from
 * the free-text State fields); the IRP splits from the GSTIN state codes, so if
 * they disagree the printed invoice would contradict the registered one. */
function buildIrpPayloadOrThrow(
  company: CompanyBillingCtx,
  customer: CustomerBillingCtx,
  invoiceNumber: string,
  invoiceDate: string,
  lineItems: { description: string; quantity: number; unitPrice: number; unit?: string | null; hsnSac?: string | null; gstRate?: number | null }[],
  sameState: boolean,
): IrpPayload {
  const built = buildEInvoice({
    invoiceNumber,
    invoiceDate,
    seller: { gstin: company.gstin, legalName: company.legal_name, address: company.address, city: company.city, pincode: company.pincode },
    buyer: { gstin: customer.gstin, legalName: customer.legal_name ?? customer.name, address: customer.address, city: customer.city, pincode: customer.pincode },
    items: lineItems.map((li) => ({
      description: li.description,
      hsnSac: li.hsnSac ?? null,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      uqc: uqcFromUnit(li.unit),
      gstRate: li.gstRate ?? null,
    })),
  });
  if (built.errors.length) throw new Error(`Can't create this e-invoice:\n- ${built.errors.join("\n- ")}`);
  const payload = built.payload!;
  if (sameState !== (payload.SellerDtls.Stcd === payload.BuyerDtls.Pos)) {
    throw new Error("The State on the company/customer doesn't match their GSTIN's state code — fix it in Settings/Customers before creating an e-invoice");
  }
  return payload;
}

export async function generateAndSendInvoiceImpl(companyId: string, input: any) {
  const template = ["classic", "modern", "minimal", "sidebar", "compact"].includes(input.template) ? input.template : "classic";
  const lineItems = (input.lineItems ?? []) as {
    description: string;
    note?: string | null;
    quantity: number;
    unitPrice: number;
    unit?: string | null;
    hsnSac?: string | null;
    gstRate?: number | null;
  }[];
  if (!lineItems.length) throw new Error("Add at least one line item");
  const subtotal = round(lineItems.reduce((sum: number, li) => sum + li.quantity * li.unitPrice, 0));

  const ctx = await hasura<{
    customers_by_pk: CustomerBillingCtx | null;
    companies_by_pk: CompanyBillingCtx | null;
  }>(
    `query Ctx($customerId: uuid!, $companyId: uuid!) {
       customers_by_pk(id: $customerId) { ${CUSTOMER_BILLING_SEL} }
       companies_by_pk(id: $companyId) { ${COMPANY_BILLING_SEL} }
     }`,
    { customerId: input.customerId, companyId },
  );
  const customer = ctx.customers_by_pk;
  if (!customer) throw new Error("Customer not found");
  const company = ctx.companies_by_pk ?? emptyCompanyBillingCtx();

  const { splitTax } = await import("../lib/pdf/gst");
  const gst = splitTax(
    lineItems.map((li) => ({ hsnSac: li.hsnSac ?? null, gstRate: li.gstRate ?? null, taxableValue: li.quantity * li.unitPrice })),
    company.state,
    customer.state,
  );

  // B2B invoice of an e-invoicing company -> must be registered with the IRP.
  // Validate (no side effects) before saving anything, so a bad GSTIN/pincode/
  // HSN is reported up front instead of leaving a half-created invoice.
  const irpPayload =
    company.einvoice_enabled && customer.gstin?.trim()
      ? buildIrpPayloadOrThrow(company, customer, String(input.invoiceNumber), String(input.invoiceDate), lineItems, gst.sameState)
      : undefined;

  // For an e-invoice the amounts must be the IRP's, not our own rounding of them.
  const v = irpPayload?.ValDtls;
  const subtotalFinal = v ? v.AssVal : subtotal;
  const tax = v ? round(v.CgstVal + v.SgstVal + v.IgstVal) : gst.totalTax;
  const total = round(subtotalFinal + tax);

  const data = await hasura(
    `mutation Create($o: invoices_insert_input!) { insert_invoices_one(object: $o) { ${INVOICE_SEL} } }`,
    {
      // company_id isn't a field here — the insert permission auto-fills it
      // from the session.
      o: {
        invoice_number: String(input.invoiceNumber),
        description: input.notes ? String(input.notes).trim() : null,
        direction: "receivable",
        customer_id: input.customerId,
        invoice_date: String(input.invoiceDate),
        due_date: String(input.dueDate),
        amount: subtotalFinal,
        tax_amount: tax,
        department: "sales",
        source: "manual",
        // An e-invoice stays a draft until the IRP has registered it — a
        // never-sent invoice must not trigger overdue reminders to the customer.
        collection_status: irpPayload ? "draft" : "sent",
        template,
        buyer_order_no: input.buyerOrderNo ? String(input.buyerOrderNo).trim() || null : null,
        // For an e-invoice the ack no. is the IRP's, written by the server role.
        ack_no: irpPayload ? null : input.ackNo ? String(input.ackNo).trim() || null : null,
        place_of_supply: irpPayload?.BuyerDtls.Pos ?? null,
      },
    },
  );
  const invoiceRow = data.insert_invoices_one;

  await hasura(
    `mutation Items($rows: [invoice_line_items_insert_input!]!) { insert_invoice_line_items(objects: $rows) { affected_rows } }`,
    { rows: lineItems.map((li) => lineItemInsertRow(li, invoiceRow.id)) },
  );

  // No IRN, no send: if the IRP doesn't register it, this throws, the invoice
  // is left `failed` (see registerWithIrp), and nothing below runs.
  let registered: IrpResult | undefined;
  if (irpPayload) {
    try {
      registered = await registerWithIrp(companyId, invoiceRow.id, irpPayload);
    } catch (err) {
      throw new Error(
        `Invoice ${input.invoiceNumber} was saved but NOT registered with the IRP, so it was not sent: ${err instanceof Error ? err.message : err}`,
      );
    }
    await hasura(
      `mutation($id: uuid!) { update_invoices_by_pk(pk_columns: { id: $id }, _set: { collection_status: "sent" }) { id } }`,
      { id: invoiceRow.id },
    );
    invoiceRow.collection_status = "sent";
    invoiceRow.irn = registered.irn;
  }

  // Best-effort: the invoice is created and tracked either way, even if
  // rendering or sending the PDF fails (a registered one can be re-sent).
  try {
    const { renderInvoicePdf } = await import("../lib/pdf/render");
    const pdf = await renderInvoicePdf({
      template,
      invoiceNumber: String(input.invoiceNumber),
      invoiceDate: String(input.invoiceDate),
      dueDate: String(input.dueDate),
      notes: input.notes ?? null,
      buyerOrderNo: input.buyerOrderNo ?? null,
      ackNo: registered ? registered.ackNo : (input.ackNo ?? null),
      company: companyForPdf(company),
      customer: customerForPdf(customer),
      lineItems: lineItems.map(lineItemForPdf),
      subtotal: subtotalFinal,
      tax,
      total,
      signatureDataUrl: company.signature_data_url,
      einvoice: registered,
    });
    if (customer.email) {
      await publishNotification({
        type: "send-invoice",
        payload: {
          customer_email: customer.email,
          customer_name: customer.name,
          invoice_number: String(input.invoiceNumber),
          pdf_base64: pdf.toString("base64"),
        },
      });
    }
  } catch (err) {
    // rendering failed — the invoice itself is still created and tracked
    console.error(`generateAndSendInvoice: PDF render failed for invoice ${input.invoiceNumber}`, err);
  }

  return mapInvoice(invoiceRow);
}

export async function resendInvoiceImpl(companyId: string, id: string): Promise<boolean> {
  const ctx = await hasura<{
    invoices_by_pk: {
      invoice_number: string;
      invoice_date: string;
      due_date: string;
      description: string | null;
      amount: string;
      tax_amount: string;
      template: string | null;
      company_id: string;
      buyer_order_no: string | null;
      ack_no: string | null;
      irn: string | null;
      ack_date: string | null;
      signed_qr: string | null;
      einvoice_status: string | null;
      customer: CustomerBillingCtx | null;
      lineItems: {
        description: string;
        note: string | null;
        quantity: string;
        unit_price: string;
        unit: string | null;
        hsn_sac: string | null;
        gst_rate: string | null;
      }[];
    } | null;
    companies_by_pk: CompanyBillingCtx | null;
  }>(
    `query Ctx($id: uuid!, $companyId: uuid!) {
       invoices_by_pk(id: $id) {
         invoice_number invoice_date due_date description amount tax_amount template company_id buyer_order_no ack_no
         irn ack_date signed_qr einvoice_status
         customer { ${CUSTOMER_BILLING_SEL} }
         lineItems { description note quantity unit_price unit hsn_sac gst_rate }
       }
       companies_by_pk(id: $companyId) { ${COMPANY_BILLING_SEL} }
     }`,
    { id, companyId },
  );
  const invoice = ctx.invoices_by_pk;
  if (!invoice || invoice.company_id !== companyId) throw new Error("Invoice not found");
  if (!invoice.template) throw new Error("This invoice wasn't generated with a template — nothing to resend.");
  if (!invoice.customer) throw new Error("This invoice has no customer to send to.");
  if (!invoice.customer.email) throw new Error("This customer has no email on file.");
  if (invoice.einvoice_status && !invoice.irn) {
    throw new Error("This invoice was never registered with the IRP, so it isn't a valid e-invoice and can't be sent.");
  }

  const subtotal = num(invoice.amount);
  const tax = num(invoice.tax_amount);
  const company = ctx.companies_by_pk ?? emptyCompanyBillingCtx();

  const { renderInvoicePdf } = await import("../lib/pdf/render");
  const pdf = await renderInvoicePdf({
    template: invoice.template as any,
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    dueDate: invoice.due_date,
    notes: invoice.description,
    buyerOrderNo: invoice.buyer_order_no,
    ackNo: invoice.ack_no,
    company: companyForPdf(company),
    customer: customerForPdf(invoice.customer),
    lineItems: invoice.lineItems.map((li) =>
      lineItemForPdf({
        description: li.description,
        note: li.note,
        quantity: num(li.quantity),
        unitPrice: num(li.unit_price),
        unit: li.unit,
        hsnSac: li.hsn_sac,
        gstRate: li.gst_rate == null ? null : num(li.gst_rate),
      }),
    ),
    subtotal,
    tax,
    total: round(subtotal + tax),
    signatureDataUrl: company.signature_data_url,
    einvoice:
      invoice.irn && invoice.signed_qr
        ? { irn: invoice.irn, ackNo: invoice.ack_no ?? "", ackDate: invoice.ack_date ?? "", signedQr: invoice.signed_qr }
        : null,
  });

  // Kept as a direct, synchronous call (not queued like send-invoice/
  // payment-received above) — its boolean result drives a real UI toast
  // (app/(app)/receivables/[id]/page.tsx), so the caller needs the actual
  // send outcome back, not a fire-and-forget queue ack.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let res: Response;
  try {
    res = await fetch(`${NOTIFICATION_URL}/notify/send-invoice`, {
      method: "POST",
      headers: { "content-type": "application/json", ...internalServiceHeaders() },
      body: JSON.stringify({
        customer_email: invoice.customer.email,
        customer_name: invoice.customer.name,
        invoice_number: invoice.invoice_number,
        pdf_base64: pdf.toString("base64"),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Couldn't send the email (notification-service returned ${res.status})`);
  const body = await res.json();
  return Boolean(body.sent);
}

/** Re-attempts IRP registration for an invoice that `failed` (e.g. the IRP was
 * down, or the customer's details were fixed since). Rebuilds the payload from
 * what's saved — so the same invoice is reused, not duplicated — and emails it
 * once registered. */
export async function retryEinvoiceImpl(companyId: string, id: string) {
  const ctx = await hasura<{
    invoices_by_pk: {
      invoice_number: string;
      invoice_date: string;
      company_id: string;
      irn: string | null;
      einvoice_status: string | null;
      customer: CustomerBillingCtx | null;
      lineItems: { description: string; quantity: string; unit_price: string; unit: string | null; hsn_sac: string | null; gst_rate: string | null }[];
    } | null;
    companies_by_pk: CompanyBillingCtx | null;
  }>(
    `query Ctx($id: uuid!, $companyId: uuid!) {
       invoices_by_pk(id: $id) {
         invoice_number invoice_date company_id irn einvoice_status
         customer { ${CUSTOMER_BILLING_SEL} }
         lineItems { description quantity unit_price unit hsn_sac gst_rate }
       }
       companies_by_pk(id: $companyId) { ${COMPANY_BILLING_SEL} }
     }`,
    { id, companyId },
  );
  const invoice = ctx.invoices_by_pk;
  if (!invoice || invoice.company_id !== companyId) throw new Error("Invoice not found");
  if (invoice.einvoice_status !== "failed" || invoice.irn) throw new Error("Only an invoice whose IRP registration failed can be retried");
  if (!invoice.customer) throw new Error("This invoice has no customer");
  const company = ctx.companies_by_pk ?? emptyCompanyBillingCtx();

  const items = invoice.lineItems.map((li) => ({
    description: li.description,
    quantity: num(li.quantity),
    unitPrice: num(li.unit_price),
    unit: li.unit,
    hsnSac: li.hsn_sac,
    gstRate: li.gst_rate == null ? null : num(li.gst_rate),
  }));
  const { splitTax } = await import("../lib/pdf/gst");
  const { sameState } = splitTax(
    items.map((li) => ({ hsnSac: li.hsnSac, gstRate: li.gstRate, taxableValue: li.quantity * li.unitPrice })),
    company.state,
    invoice.customer.state,
  );
  const payload = buildIrpPayloadOrThrow(company, invoice.customer, invoice.invoice_number, invoice.invoice_date, items, sameState);

  try {
    await registerWithIrp(companyId, id, payload);
  } catch (err) {
    throw new Error(`Still not registered with the IRP: ${err instanceof Error ? err.message : err}`);
  }
  await hasura(
    `mutation($id: uuid!) { update_invoices_by_pk(pk_columns: { id: $id }, _set: { collection_status: "sent" }) { id } }`,
    { id },
  );
  // Registered either way; a missing customer email or SMTP outage shouldn't
  // undo that — the user can press "Resend invoice".
  await resendInvoiceImpl(companyId, id).catch((err) => console.error(`retryEinvoice: registered ${id} but couldn't email it`, err));

  const data = await hasura(`query($id: uuid!) { invoices_by_pk(id: $id) { ${INVOICE_SEL} } }`, { id });
  return mapInvoice(data.invoices_by_pk);
}
