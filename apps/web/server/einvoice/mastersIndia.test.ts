import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEInvoice } from "../../lib/einvoice/payload";
import { mastersIndiaProvider, parseMastersResponse, toMastersBody } from "./mastersIndia";

const built = buildEInvoice(
  {
    invoiceNumber: "INV/26-27/001",
    invoiceDate: "2026-10-01",
    seller: { gstin: "27AAPFU0939F1ZV", legalName: "Acme Traders", address: "1 MG Road", city: "Mumbai", pincode: "400001" },
    buyer: { gstin: "07AAGFF2194N1Z1", legalName: "Buyer Pvt Ltd", address: "5 CP", city: "New Delhi", pincode: "110001" },
    items: [{ description: "Widget", hsnSac: "8471", quantity: 2, unitPrice: 1000.5, uqc: "NOS", gstRate: 18 }],
  },
  new Date("2026-10-04"),
);
const payload = built.payload!;

// Shapes copied from Masters India's published Generate e-invoice page.
const success = {
  results: {
    message: {
      AckNo: 48100019285, AckDt: "2020-05-23 14:37:00", Irn: "9333faeb236d89bf77a009d59a5750c0f8a8733a670965cbc08fb3f330d293ac",
      SignedInvoice: "x.y.z", SignedQRCode: "a.b.c", Status: "ACT", error: false,
    },
    errorMessage: "", status: "Success", code: 200,
  },
};
const duplicate = {
  results: {
    message: "", errorMessage: "2150: Duplicate IRN",
    InfoDtls: '[{"InfCd":"DUPIRN","Desc":{"AckNo":142010000000208,"AckDt":"2020-08-10 09:56:00","Irn":"9bc08c72c8c406d0d6a7080524f7e0bfd8fdf8156573201efadf8d7ac11a6f23"}}]',
    status: "Failed", code: 204,
  },
};

describe("toMastersBody", () => {
  const body = toMastersBody(payload);
  it("names the seller GSTIN and uses their field names, state names and dd/mm/yyyy date", () => {
    expect(body).not.toHaveProperty("access_token"); // v1 authenticates by header, not body
    expect(body).toMatchObject({
      user_gstin: "27AAPFU0939F1ZV",
      document_details: { document_type: "INV", document_number: "INV/26-27/001", document_date: "01/10/2026" },
      seller_details: { state_code: "MAHARASHTRA", pincode: 400001 },
      buyer_details: { state_code: "DELHI", place_of_supply: "7", pincode: 110001 },
      value_details: { total_assessable_value: 2001, total_igst_value: 360.18, total_invoice_value: 2361 },
    });
    expect(body.item_list[0]).toMatchObject({ hsn_code: "8471", unit: "NOS", igst_amount: 360.18, gst_rate: 18 });
  });
});

describe("parseMastersResponse", () => {
  it("reads IRN, ack number, IST ack time and the signed QR", () => {
    expect(parseMastersResponse(success)).toEqual({
      irn: success.results.message.Irn,
      ackNo: "48100019285",
      ackDate: "2020-05-23T09:07:00.000Z", // 14:37 IST
      signedQr: "a.b.c",
    });
  });

  it("throws their error text, and names the IRN on a duplicate", () => {
    expect(() => parseMastersResponse(duplicate)).toThrow(/2150: Duplicate IRN.*9bc08c72/);
    expect(() => parseMastersResponse({ results: { errorMessage: "2172: bad GSTIN", status: "Failed" } })).toThrow("2172: bad GSTIN");
  });

  it("never treats a success without a signed QR as valid", () => {
    const noQr = { results: { ...success.results, message: { ...success.results.message, SignedQRCode: undefined } } };
    expect(() => parseMastersResponse(noQr)).toThrow();
  });
});

describe("mastersIndiaProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to {base}/api/v1/einvoice/ with the api_key header and returns the parsed result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => success });
    vi.stubGlobal("fetch", fetchMock);
    const out = await mastersIndiaProvider({ baseUrl: "https://example.test/", apiKey: "key" }).generate(payload);
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/api/v1/einvoice/");
    expect(fetchMock.mock.calls[0][1].headers.api_key).toBe("key");
    expect(fetchMock.mock.calls[0][1].body).not.toContain("key");
    expect(out.irn).toBe(success.results.message.Irn);
  });

  it("fails closed when not configured", async () => {
    await expect(mastersIndiaProvider({ apiKey: "key" }).generate(payload)).rejects.toThrow(/base URL/);
    await expect(mastersIndiaProvider({ baseUrl: "https://x" }).generate(payload)).rejects.toThrow(/API key/);
  });
});
