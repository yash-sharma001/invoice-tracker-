import { renderToBuffer } from "@react-pdf/renderer";
import QRCode from "qrcode";
import { InvoiceDocument, type InvoiceDocumentData } from "./InvoiceDocument";

/** react-pdf resolves a non-`data:` Image src by fetching it server-side, so a
 * "logo"/"signature" URL that ever reached it would be an SSRF. Callers today pass
 * DB values already checked on write — this keeps that true for future callers. */
export function safeImageSrc(url: string | null | undefined): string | null {
  return url && url.startsWith("data:image/") && url.length <= MAX_IMAGE_CHARS ? url : null;
}

const MAX_IMAGE_CHARS = 3_000_000; // ~2MB of base64 — bounds DB rows and email attachments
const MAX_LINE_ITEMS = 200; // ponytail: flat cap, paginate properly if real invoices ever exceed it

/** The IRP stamps in IST; show it that way (DD/MM/YYYY HH:mm) whatever shape the caller holds. */
function formatAckDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short", hour12: false });
}

/** Callers pass the IRP's signed QR string; it's drawn as the QR image here. */
export type RenderInvoiceInput = Omit<InvoiceDocumentData, "einvoice"> & {
  einvoice?: { irn: string; ackNo: string; ackDate: string; signedQr: string } | null;
};

export async function renderInvoicePdf(data: RenderInvoiceInput): Promise<Buffer> {
  const { einvoice, ...rest } = data;
  const safe: InvoiceDocumentData = {
    ...rest,
    company: { ...data.company, logoDataUrl: safeImageSrc(data.company.logoDataUrl) },
    signatureDataUrl: safeImageSrc(data.signatureDataUrl),
    lineItems: data.lineItems.slice(0, MAX_LINE_ITEMS),
    einvoice: einvoice && {
      irn: einvoice.irn,
      ackNo: einvoice.ackNo,
      ackDate: formatAckDate(einvoice.ackDate),
      qrDataUrl: await QRCode.toDataURL(einvoice.signedQr, { margin: 1, width: 240, errorCorrectionLevel: "M" }),
    },
  };
  return renderToBuffer(InvoiceDocument(safe) as any);
}
