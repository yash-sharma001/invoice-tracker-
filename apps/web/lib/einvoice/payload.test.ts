import { describe, expect, it } from "vitest";
import { buildEInvoice, isValidGstin, type EInvoiceInput } from "./payload";

const TODAY = new Date("2026-10-04");

const input = (over: Partial<EInvoiceInput> = {}): EInvoiceInput => ({
  invoiceNumber: "INV/26-27/001",
  invoiceDate: "2026-10-01",
  seller: { gstin: "27AAPFU0939F1ZV", legalName: "Acme Traders", address: "1 MG Road", city: "Mumbai", pincode: "400001" },
  buyer: { gstin: "07AAGFF2194N1Z1", legalName: "Buyer Pvt Ltd", address: "5 CP", city: "New Delhi", pincode: "110001" },
  items: [{ description: "Widget", hsnSac: "8471", quantity: 2, unitPrice: 1000.5, uqc: "NOS", gstRate: 18 }],
  ...over,
});

describe("isValidGstin", () => {
  it("accepts real GSTINs and rejects a bad check character", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin("07AAGFF2194N1Z1")).toBe(true);
    expect(isValidGstin("27AAPFU0939F1ZX")).toBe(false);
    expect(isValidGstin("nope")).toBe(false);
  });
});

describe("buildEInvoice", () => {
  it("inter-state: IGST only, totals reconcile, date in DD/MM/YYYY", () => {
    const { payload, errors } = buildEInvoice(input(), TODAY);
    expect(errors).toEqual([]);
    expect(payload!.DocDtls.Dt).toBe("01/10/2026");
    expect(payload!.BuyerDtls.Pos).toBe("07");
    expect(payload!.ValDtls).toMatchObject({ AssVal: 2001, IgstVal: 360.18, CgstVal: 0, SgstVal: 0, TotInvVal: 2361, RndOffAmt: -0.18 });
  });

  it("intra-state: CGST+SGST half each", () => {
    // place of supply = seller's state (27) makes it intra-state
    const { payload } = buildEInvoice(input({ placeOfSupply: "27" }), TODAY);
    expect(payload!.ItemList[0]).toMatchObject({ IgstAmt: 0, CgstAmt: 180.09, SgstAmt: 180.09 });
  });

  it("reports every problem instead of stopping at the first", () => {
    const { payload, errors } = buildEInvoice(
      input({
        invoiceNumber: "0-bad",
        invoiceDate: "2099-01-01",
        buyer: { gstin: "bad", legalName: "", address: "", city: "", pincode: "12" },
        items: [{ description: "x", hsnSac: "12", quantity: 0, unitPrice: 1, uqc: "nos", gstRate: 17 }],
      }),
      TODAY,
    );
    expect(payload).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(9);
  });
});
