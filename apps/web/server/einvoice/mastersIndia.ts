/**
 * Masters India e-invoice API (a GSP) — "Generate IRN" only:
 *   POST {base}/api/v1/einvoice/   with header `api_key: <key>`
 * (sandbox base https://sandb-api.mastersindia.co, production
 * https://router.mastersindia.co — see docs.mastersindia.co/einvoicing).
 * The request schema is from their older published page; the old
 * `/generateEinvoice` path with `access_token` in the body returns 404 on
 * these hosts. Cancel and get-by-IRN aren't built.
 *
 * One platform key serves many tenants: each request names the seller with
 * `user_gstin`, and the IRP registers the invoice under that GSTIN.
 *
 * UNVERIFIED against a successful live call:
 *  - the v1 success-response shape (assumed same as the older page's),
 *  - state names in STATE_NAMES (upper-case names as in their examples),
 *  - which optional keys they tolerate omitting (phone/email, dispatch, ship…).
 */
import type { IrpPayload } from "../../lib/einvoice/payload";
import type { EInvoiceProvider, IrpResult } from "./provider";

// GST state-code master -> state name, as Masters India's examples spell them.
const STATE_NAMES: Record<string, string> = {
  "01": "JAMMU AND KASHMIR", "02": "HIMACHAL PRADESH", "03": "PUNJAB", "04": "CHANDIGARH",
  "05": "UTTARAKHAND", "06": "HARYANA", "07": "DELHI", "08": "RAJASTHAN", "09": "UTTAR PRADESH",
  "10": "BIHAR", "11": "SIKKIM", "12": "ARUNACHAL PRADESH", "13": "NAGALAND", "14": "MANIPUR",
  "15": "MIZORAM", "16": "TRIPURA", "17": "MEGHALAYA", "18": "ASSAM", "19": "WEST BENGAL",
  "20": "JHARKHAND", "21": "ODISHA", "22": "CHHATTISGARH", "23": "MADHYA PRADESH", "24": "GUJARAT",
  "26": "DADRA AND NAGAR HAVELI AND DAMAN AND DIU", "27": "MAHARASHTRA", "29": "KARNATAKA",
  "30": "GOA", "31": "LAKSHADWEEP", "32": "KERALA", "33": "TAMIL NADU", "34": "PUDUCHERRY",
  "35": "ANDAMAN AND NICOBAR ISLANDS", "36": "TELANGANA", "37": "ANDHRA PRADESH", "38": "LADAKH",
};

const stateName = (code: string) => {
  const n = STATE_NAMES[code];
  if (!n) throw new Error(`Unknown GST state code "${code}"`);
  return n;
};

export function toMastersBody(p: IrpPayload) {
  const s = p.SellerDtls;
  const b = p.BuyerDtls;
  const v = p.ValDtls;
  return {
    user_gstin: s.Gstin,
    data_source: "erp",
    transaction_details: { supply_type: p.TranDtls.SupTyp, charge_type: p.TranDtls.RegRev, igst_on_intra: p.TranDtls.IgstOnIntra, ecommerce_gstin: "" },
    document_details: { document_type: p.DocDtls.Typ, document_number: p.DocDtls.No, document_date: p.DocDtls.Dt },
    seller_details: {
      gstin: s.Gstin, legal_name: s.LglNm, trade_name: s.LglNm,
      address1: s.Addr1, location: s.Loc, pincode: s.Pin, state_code: stateName(s.Stcd),
    },
    buyer_details: {
      gstin: b.Gstin, legal_name: b.LglNm, trade_name: b.LglNm,
      address1: b.Addr1, location: b.Loc, pincode: b.Pin,
      place_of_supply: String(Number(b.Pos)), // their example: "5" for Uttarakhand (code 05)
      state_code: stateName(b.Stcd),
    },
    value_details: {
      total_assessable_value: v.AssVal, total_cgst_value: v.CgstVal, total_sgst_value: v.SgstVal,
      total_igst_value: v.IgstVal, total_cess_value: v.CesVal, total_cess_value_of_state: 0,
      total_discount: v.Discount, total_other_charge: 0, total_invoice_value: v.TotInvVal,
      round_off_amount: v.RndOffAmt, total_invoice_value_additional_currency: 0,
    },
    item_list: p.ItemList.map((it) => ({
      item_serial_number: it.SlNo, product_description: it.PrdDesc, is_service: it.IsServc,
      hsn_code: it.HsnCd, quantity: it.Qty, free_quantity: 0, unit: it.Unit, unit_price: it.UnitPrice,
      total_amount: it.TotAmt, pre_tax_value: 0, discount: it.Discount, other_charge: 0,
      assessable_value: it.AssAmt, gst_rate: it.GstRt,
      igst_amount: it.IgstAmt, cgst_amount: it.CgstAmt, sgst_amount: it.SgstAmt,
      cess_rate: it.CesRt, cess_amount: it.CesAmt, cess_nonadvol_amount: 0,
      state_cess_rate: 0, state_cess_amount: 0, state_cess_nonadvol_amount: 0,
      total_item_value: it.TotItemVal,
    })),
  };
}

/** Turns their response envelope into an IrpResult, or throws their error text. */
export function parseMastersResponse(json: any): IrpResult {
  const r = json?.results;
  const m = r?.message;
  if (r?.status === "Success" && m && typeof m === "object" && m.Irn && m.SignedQRCode) {
    const ack = new Date(`${String(m.AckDt).replace(" ", "T")}+05:30`); // IRP timestamps are IST
    if (Number.isNaN(ack.getTime())) throw new Error(`Masters India returned an unreadable AckDt: ${m.AckDt}`);
    return { irn: m.Irn, ackNo: String(m.AckNo), ackDate: ack.toISOString(), signedQr: m.SignedQRCode };
  }
  const detail = r?.errorMessage || (typeof m === "string" ? m : "") || json?.detail || json?.message || json?.error;
  // An unrecognised shape (e.g. an auth error, or a v1 success we don't parse
  // yet) is shown as-is so it can be diagnosed — responses never contain our key.
  const base = String(detail || `Masters India sent an unrecognised response: ${JSON.stringify(json).slice(0, 400)}`);
  // 2150 Duplicate IRN: the IRP already has it and says which IRN. We don't get
  // the signed QR back here, so it can't be used as-is — surface the IRN.
  const dup = /"Irn"\s*:\s*"([0-9a-f]{64})"/i.exec(String(r?.InfoDtls ?? ""));
  throw new Error(dup ? `${base} (already registered as IRN ${dup[1]})` : base);
}

export function mastersIndiaProvider(cfg: { baseUrl?: string; apiKey?: string }): EInvoiceProvider {
  return {
    async generate(payload) {
      if (!cfg.baseUrl) throw new Error("Masters India base URL isn't configured (MASTERS_BASE_URL)");
      if (!cfg.apiKey) throw new Error("Masters India API key isn't configured (MASTERS_API_KEY)");
      const url = /\/api\/v1\/einvoice\/?$/.test(cfg.baseUrl) ? cfg.baseUrl : `${cfg.baseUrl.replace(/\/+$/, "")}/api/v1/einvoice/`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", api_key: cfg.apiKey },
          body: JSON.stringify(toMastersBody(payload)),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new Error(`Masters India returned an unreadable response (HTTP ${res.status})`);
      }
      return parseMastersResponse(json);
    },
  };
}
