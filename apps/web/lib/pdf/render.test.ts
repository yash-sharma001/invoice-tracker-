import { describe, it, expect } from "vitest";
import { safeImageSrc, renderInvoicePdf } from "./render";

describe("renderInvoicePdf with an e-invoice", () => {
  it.each(["classic", "modern", "minimal", "sidebar", "compact"] as const)("%s renders the IRN + QR", async (template) => {
    const pdf = await renderInvoicePdf({
      template,
      invoiceNumber: "INV/26-27/001",
      invoiceDate: "2026-10-01",
      dueDate: "2026-10-31",
      company: { name: "Acme", gstin: "27AAPFU0939F1ZV", state: "Maharashtra" },
      customer: { name: "Buyer", gstin: "07AAGFF2194N1Z1", state: "Delhi" },
      lineItems: [{ description: "Widget", quantity: 1, unitPrice: 100, hsnSac: "8471", gstRate: 18 }],
      subtotal: 100,
      tax: 18,
      total: 118,
      einvoice: { irn: "a".repeat(64), ackNo: "112010000001", ackDate: "2026-10-01 10:00:00", signedQr: "eyJhbGciOiJSUzI1NiJ9.e30.sig" },
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("safeImageSrc", () => {
  it("rejects remote URLs react-pdf would fetch server-side (SSRF)", () => {
    expect(safeImageSrc("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(safeImageSrc("https://evil.example/logo.png")).toBeNull();
    expect(safeImageSrc("file:///etc/passwd")).toBeNull();
  });

  it("rejects oversized data URLs", () => {
    expect(safeImageSrc("data:image/png;base64," + "A".repeat(3_000_001))).toBeNull();
  });

  it("allows an inline image", () => {
    expect(safeImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("treats missing as absent, not a crash", () => {
    expect(safeImageSrc(null)).toBeNull();
    expect(safeImageSrc(undefined)).toBeNull();
  });
});
