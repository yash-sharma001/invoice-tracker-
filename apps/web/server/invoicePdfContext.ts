/**
 * Billing-context types and pure shaping helpers shared by
 * generateAndSendInvoice / resendInvoice (server/invoiceSend.ts) — no fetch,
 * no Hasura calls, just row -> PDF-render-input shaping.
 */
import { round } from "./mappers";

export interface CompanyBillingCtx {
  name: string;
  gstin: string | null;
  pan: string | null;
  address: string | null;
  state: string | null;
  legal_name: string | null;
  city: string | null;
  pincode: string | null;
  einvoice_enabled: boolean;
  signature_data_url: string | null;
  logo_data_url: string | null;
  bank_account_name: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_swift: string | null;
}
export interface CustomerBillingCtx {
  name: string;
  email: string | null;
  gstin: string | null;
  tax_id: string | null;
  address: string | null;
  state: string | null;
  legal_name: string | null;
  city: string | null;
  pincode: string | null;
}

export const COMPANY_BILLING_SEL = `
  name gstin pan address state legal_name city pincode einvoice_enabled signature_data_url logo_data_url
  bank_account_name bank_name bank_account_number bank_ifsc bank_swift
`;
export const CUSTOMER_BILLING_SEL = `name email gstin tax_id address state legal_name city pincode`;

export const emptyCompanyBillingCtx = (): CompanyBillingCtx => ({
  name: "",
  gstin: null,
  pan: null,
  address: null,
  state: null,
  legal_name: null,
  city: null,
  pincode: null,
  einvoice_enabled: false,
  signature_data_url: null,
  logo_data_url: null,
  bank_account_name: null,
  bank_name: null,
  bank_account_number: null,
  bank_ifsc: null,
  bank_swift: null,
});

/** The IRP wants a GST UQC code, not the free-text display unit. Hours/Days
 * have no UQC (services), so they're OTH. */
const UQC: Record<string, string> = { units: "UNT", pieces: "PCS", kg: "KGS" };
export const uqcFromUnit = (unit?: string | null) => UQC[(unit ?? "").trim().toLowerCase()] ?? "OTH";

export function companyForPdf(c: CompanyBillingCtx) {
  const hasBank = c.bank_account_name || c.bank_name || c.bank_account_number;
  return {
    name: c.name,
    gstin: c.gstin,
    pan: c.pan,
    address: c.address,
    state: c.state,
    logoDataUrl: c.logo_data_url,
    bank: hasBank
      ? {
          accountName: c.bank_account_name,
          bankName: c.bank_name,
          accountNumber: c.bank_account_number,
          ifsc: c.bank_ifsc,
          swift: c.bank_swift,
        }
      : null,
  };
}

export function customerForPdf(c: CustomerBillingCtx) {
  return { name: c.name, email: c.email, gstin: c.gstin, pan: c.tax_id, address: c.address, state: c.state };
}

export function lineItemForPdf(li: {
  description: string;
  note?: string | null;
  quantity: number;
  unitPrice: number;
  unit?: string | null;
  hsnSac?: string | null;
  gstRate?: number | null;
}) {
  return {
    description: li.description,
    note: li.note ?? null,
    quantity: li.quantity,
    unitPrice: li.unitPrice,
    unit: li.unit || "Units",
    hsnSac: li.hsnSac ?? null,
    gstRate: li.gstRate ?? null,
  };
}

export function lineItemInsertRow(
  li: {
    description: string;
    note?: string | null;
    quantity: number;
    unitPrice: number;
    unit?: string | null;
    hsnSac?: string | null;
    gstRate?: number | null;
  },
  invoiceId: string,
) {
  // No company_id field — the insert permission auto-fills it from the session.
  return {
    invoice_id: invoiceId,
    description: li.description,
    note: li.note ?? null,
    quantity: li.quantity,
    unit_price: li.unitPrice,
    line_amount: round(li.quantity * li.unitPrice),
    unit: li.unit || "Units",
    uqc: uqcFromUnit(li.unit),
    hsn_sac: li.hsnSac ?? null,
    gst_rate: li.gstRate ?? null,
  };
}
