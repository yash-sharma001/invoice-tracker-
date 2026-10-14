/**
 * Builds the IRP "INV-1" (schema v1.1) JSON for a B2B tax invoice and checks
 * the rules the IRP rejects on, so errors surface as field-level messages
 * before any API call. Pure — no I/O. The IRN, ack number and signed QR come
 * back from the IRP; nothing here can produce them.
 *
 * ponytail: B2B only. SEZ / export / deemed-export need ShipDtls/ExpDtls and
 * credit/debit notes need a preceding-document reference; add when needed.
 */

export interface EInvoiceParty {
  gstin: string | null;
  legalName: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
}

export interface EInvoiceItem {
  description: string;
  hsnSac: string | null;
  quantity: number;
  unitPrice: number;
  uqc: string;
  gstRate: number | null;
}

export interface EInvoiceInput {
  invoiceNumber: string;
  /** YYYY-MM-DD */
  invoiceDate: string;
  seller: EInvoiceParty;
  buyer: EInvoiceParty;
  /** 2-digit state code; defaults to the buyer's. */
  placeOfSupply?: string | null;
  items: EInvoiceItem[];
}

export interface IrpItem {
  SlNo: string;
  PrdDesc: string;
  IsServc: "Y" | "N";
  HsnCd: string;
  Qty: number;
  Unit: string;
  UnitPrice: number;
  TotAmt: number;
  Discount: number;
  AssAmt: number;
  GstRt: number;
  IgstAmt: number;
  CgstAmt: number;
  SgstAmt: number;
  CesRt: number;
  CesAmt: number;
  TotItemVal: number;
}

export interface IrpPayload {
  Version: "1.1";
  TranDtls: { TaxSch: "GST"; SupTyp: "B2B"; RegRev: "N"; IgstOnIntra: "N" };
  DocDtls: { Typ: "INV"; No: string; Dt: string };
  SellerDtls: { Gstin: string; LglNm: string; Addr1: string; Loc: string; Pin: number; Stcd: string };
  BuyerDtls: { Gstin: string; LglNm: string; Pos: string; Addr1: string; Loc: string; Pin: number; Stcd: string };
  ItemList: IrpItem[];
  ValDtls: {
    AssVal: number;
    CgstVal: number;
    SgstVal: number;
    IgstVal: number;
    CesVal: number;
    Discount: number;
    RndOffAmt: number;
    TotInvVal: number;
  };
}

const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];
const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Format check + the mod-36 check character (last digit). */
export function isValidGstin(g: string): boolean {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14];
}

const stateCode = (gstin: string) => gstin.slice(0, 2);
const trimmed = (s: string | null | undefined) => (s ?? "").trim();

function checkParty(who: string, p: EInvoiceParty, errors: string[]) {
  const gstin = trimmed(p.gstin).toUpperCase();
  if (!gstin) errors.push(`${who}: GSTIN is required`);
  else if (!isValidGstin(gstin)) errors.push(`${who}: GSTIN "${gstin}" is not valid`);
  const name = trimmed(p.legalName);
  if (name.length < 3 || name.length > 100) errors.push(`${who}: legal name must be 3–100 characters`);
  const addr = trimmed(p.address);
  if (addr.length < 1 || addr.length > 100) errors.push(`${who}: address must be 1–100 characters`);
  const city = trimmed(p.city);
  if (city.length < 3 || city.length > 100) errors.push(`${who}: city must be 3–100 characters`);
  if (!/^[1-9]\d{5}$/.test(trimmed(p.pincode))) errors.push(`${who}: pincode must be 6 digits`);
}

export function buildEInvoice(input: EInvoiceInput, today = new Date()): { payload?: IrpPayload; errors: string[] } {
  const errors: string[] = [];

  const no = trimmed(input.invoiceNumber);
  if (!/^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$/.test(no)) {
    errors.push("Invoice number must be 1–16 characters: letters, digits, / and -, not starting with 0, / or -");
  }
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.invoiceDate);
  const date = dm ? new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3])) : null;
  if (!dm || !date || date.getUTCMonth() !== +dm[2] - 1) errors.push("Invoice date must be a valid date");
  else if (date.getTime() > today.getTime()) errors.push("Invoice date can't be in the future");
  else if (date.getTime() < Date.UTC(2017, 6, 1)) errors.push("Invoice date can't be before 1 July 2017");

  checkParty("Seller", input.seller, errors);
  checkParty("Buyer", input.buyer, errors);
  const sGstin = trimmed(input.seller.gstin).toUpperCase();
  const bGstin = trimmed(input.buyer.gstin).toUpperCase();
  if (sGstin && sGstin === bGstin) errors.push("Seller and buyer GSTIN can't be the same");

  const pos = trimmed(input.placeOfSupply) || (bGstin ? stateCode(bGstin) : "");
  if (!/^\d{2}$/.test(pos)) errors.push("Place of supply must be a 2-digit state code");

  if (!input.items.length) errors.push("Add at least one line item");
  if (input.items.length > 1000) errors.push("An e-invoice can have at most 1000 line items");

  // Intra-state (CGST+SGST) vs inter-state (IGST) follows the GSTIN state
  // codes — the same thing the IRP validates against.
  const intra = Boolean(sGstin && pos) && stateCode(sGstin) === pos;

  const items: IrpItem[] = input.items.map((li, i) => {
    const row = `Line ${i + 1}`;
    const desc = trimmed(li.description);
    if (desc.length < 1 || desc.length > 300) errors.push(`${row}: description must be 1–300 characters`);
    const hsn = trimmed(li.hsnSac);
    if (!/^\d{4,8}$/.test(hsn)) errors.push(`${row}: HSN/SAC must be 4–8 digits`);
    if (!(li.quantity > 0)) errors.push(`${row}: quantity must be greater than 0`);
    if (!(li.unitPrice >= 0)) errors.push(`${row}: unit price can't be negative`);
    if (!/^[A-Z]{3}$/.test(trimmed(li.uqc))) errors.push(`${row}: unit code (UQC) must be 3 capital letters, e.g. NOS`);
    const rate = li.gstRate ?? NaN;
    if (!GST_RATES.includes(rate)) errors.push(`${row}: GST rate must be one of ${GST_RATES.join(", ")}`);

    const tot = r2(li.quantity * li.unitPrice);
    const tax = r2(tot * (rate / 100));
    const half = r2(tax / 2);
    const [igst, cgst, sgst] = intra ? [0, half, half] : [tax, 0, 0];
    return {
      SlNo: String(i + 1),
      PrdDesc: desc,
      IsServc: hsn.startsWith("99") ? "Y" : "N",
      HsnCd: hsn,
      Qty: li.quantity,
      Unit: trimmed(li.uqc),
      UnitPrice: li.unitPrice,
      TotAmt: tot,
      Discount: 0,
      AssAmt: tot,
      GstRt: rate,
      IgstAmt: igst,
      CgstAmt: cgst,
      SgstAmt: sgst,
      CesRt: 0,
      CesAmt: 0,
      TotItemVal: r2(tot + igst + cgst + sgst),
    };
  });

  if (errors.length) return { errors };

  const sum = (k: keyof IrpItem) => r2(items.reduce((s, it) => s + (it[k] as number), 0));
  const assVal = sum("AssAmt");
  const cgst = sum("CgstAmt");
  const sgst = sum("SgstAmt");
  const igst = sum("IgstAmt");
  const exact = r2(assVal + cgst + sgst + igst);
  const total = Math.round(exact);

  return {
    errors,
    payload: {
      Version: "1.1",
      TranDtls: { TaxSch: "GST", SupTyp: "B2B", RegRev: "N", IgstOnIntra: "N" },
      DocDtls: { Typ: "INV", No: no, Dt: `${dm![3]}/${dm![2]}/${dm![1]}` },
      SellerDtls: {
        Gstin: sGstin,
        LglNm: trimmed(input.seller.legalName),
        Addr1: trimmed(input.seller.address),
        Loc: trimmed(input.seller.city),
        Pin: Number(trimmed(input.seller.pincode)),
        Stcd: stateCode(sGstin),
      },
      BuyerDtls: {
        Gstin: bGstin,
        LglNm: trimmed(input.buyer.legalName),
        Pos: pos,
        Addr1: trimmed(input.buyer.address),
        Loc: trimmed(input.buyer.city),
        Pin: Number(trimmed(input.buyer.pincode)),
        Stcd: stateCode(bGstin),
      },
      ItemList: items,
      ValDtls: {
        AssVal: assVal,
        CgstVal: cgst,
        SgstVal: sgst,
        IgstVal: igst,
        CesVal: 0,
        Discount: 0,
        RndOffAmt: r2(total - exact),
        TotInvVal: total,
      },
    },
  };
}
