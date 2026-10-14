import { Document, Page, View, Text, Image, StyleSheet } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/stylesheet";
import { splitTax, amountInWords, type GstLineItem } from "./gst";

export type Template = "classic" | "modern" | "minimal" | "sidebar" | "compact";

export interface LineItem {
  description: string;
  note?: string | null;
  quantity: number;
  unitPrice: number;
  unit?: string | null;
  hsnSac?: string | null;
  gstRate?: number | null;
}

export interface BankDetails {
  accountName?: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
  ifsc?: string | null;
  swift?: string | null;
}

export interface InvoiceDocumentData {
  template: Template;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  notes?: string | null;
  buyerOrderNo?: string | null;
  ackNo?: string | null;
  company: {
    name: string;
    gstin?: string | null;
    pan?: string | null;
    address?: string | null;
    state?: string | null;
    logoDataUrl?: string | null;
    bank?: BankDetails | null;
  };
  customer: {
    name: string;
    email?: string | null;
    gstin?: string | null;
    pan?: string | null;
    address?: string | null;
    state?: string | null;
  };
  lineItems: LineItem[];
  subtotal: number;
  tax: number;
  total: number;
  signatureDataUrl?: string | null;
  /** IRP registration result; `qrDataUrl` is the signed QR rendered as an image. */
  einvoice?: { irn: string; ackNo: string; ackDate: string; qrDataUrl: string } | null;
}

const ACCENT: Record<Template, string> = {
  classic: "#2A55D1",
  modern: "#1D4ED8",
  minimal: "#171923",
  sidebar: "#1E3A5F",
  compact: "#374151",
};

const INK = "#171923";
const MUTED = "#64748B";
const HAIRLINE = "#E5E7EB";
const FAINT_BG = "#F8F9FB";

const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Mixes a hex accent toward white — used for soft tinted cards/backgrounds
 * (e.g. the totals box) instead of a flat gray, so each template's accent
 * still reads through in its low-emphasis surfaces. */
function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// ponytail: react-pdf's yoga layout engine mis-measures negative-margin
// "bleed to page edge" bands once their text wraps to a 2nd line (the
// following sibling ends up overlapping it). Page always has padding: 0 and
// every template supplies its own inset via `body`/`sidebarCol`/`mainCol` —
// no negative margins anywhere, so a colored band can bleed to the true
// page edge without that whole class of bug.
const styles = StyleSheet.create({
  page: { padding: 0, fontSize: 9.5, fontFamily: "Helvetica", color: INK },
  body: { padding: 40 },
  topBar: { height: 4 },

  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 },
  companyNameRow: { flexDirection: "row", alignItems: "center", gap: 10, maxWidth: 300 },
  companyName: { fontSize: 15, fontWeight: 700 },
  logoImg: { width: 34, height: 34, objectFit: "contain" },
  logoChip: { width: 40, height: 40, borderRadius: 8, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },

  titleBlock: { alignItems: "flex-end" },
  title: { fontSize: 22, fontWeight: 700, letterSpacing: 0.5 },
  invoiceNumberPill: { fontSize: 9, marginTop: 4 },

  metaRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4, gap: 16 },
  metaBlock: { flexDirection: "column", gap: 1.5, flex: 1 },
  label: { fontSize: 7, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginTop: 5, marginBottom: 1.5 },
  value: { fontSize: 10, fontWeight: 700 },
  small: { fontSize: 8.5, color: "#475569", lineHeight: 1.35 },

  table: { marginTop: 24, borderRadius: 4, overflow: "hidden" },
  tHeadRow: { flexDirection: "row", paddingVertical: 7, paddingHorizontal: 8, backgroundColor: FAINT_BG },
  tRow: { flexDirection: "row", paddingVertical: 7, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: HAIRLINE },
  tRowAlt: { backgroundColor: "#FCFCFD" },
  colDesc: { flex: 3.4 },
  colHsn: { flex: 1, textAlign: "center" },
  colGst: { flex: 0.7, textAlign: "center" },
  colQty: { flex: 1.1, textAlign: "right" },
  colPrice: { flex: 1.3, textAlign: "right" },
  colAmount: { flex: 1.4, textAlign: "right" },
  tHeadText: { fontSize: 7, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 700 },
  itemNote: { fontSize: 8.5, fontStyle: "italic", color: MUTED, marginTop: 1 },

  totalsCard: { marginTop: 18, alignSelf: "flex-end", width: 240, borderRadius: 8, padding: 16 },
  totalsRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5 },
  totalsLabel: { color: MUTED, fontSize: 9 },
  totalsValue: { fontSize: 9 },
  grandTotalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: 8, marginTop: 4, borderTopWidth: 1 },
  grandTotalText: { fontWeight: 700, fontSize: 12.5 },

  words: { marginTop: 16, fontSize: 8.5, color: "#334155" },
  wordsLabel: { color: MUTED },

  gstTable: { marginTop: 22 },
  gstSectionLabel: { fontSize: 7, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 },
  gstHeadRow: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: INK },
  gstRow: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: HAIRLINE },
  gstColHsn: { flex: 2 },
  gstColNum: { flex: 1.3, textAlign: "right" },

  bottomRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 30, gap: 16, borderTopWidth: 1, borderTopColor: HAIRLINE, paddingTop: 18 },
  bankBlock: { flex: 1.4 },
  notes: { marginTop: 20, fontSize: 8.5, color: "#475569" },
  signatureBlock: { alignItems: "flex-end", flex: 1 },
  signatureImg: { width: 130, height: 46, objectFit: "contain" },
  signatureCaption: { fontSize: 7.5, color: MUTED, marginTop: 4, borderTopWidth: 1, borderTopColor: HAIRLINE, paddingTop: 3, width: 130, textAlign: "center" },

  // modern
  modernBand: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 40, paddingVertical: 26 },

  // sidebar
  sidebarWrap: { flexDirection: "row", flexGrow: 1 },
  sidebarCol: { width: 165, padding: 26 },
  sidebarDivider: { height: 1, backgroundColor: "rgba(255,255,255,0.18)", marginVertical: 14 },
  sidebarLabel: { fontSize: 7, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 },
  sidebarValue: { fontSize: 8.5, color: "#fff", lineHeight: 1.4 },
  sidebarName: { fontSize: 14, fontWeight: 700, color: "#fff", marginTop: 12, lineHeight: 1.3 },
  mainCol: { flex: 1, padding: 34 },

  // compact
  compactBody: { padding: 32, fontSize: 8.5 },
  compactHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 10, borderBottomWidth: 2 },
  compactMetaRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 16, marginBottom: 6, gap: 16 },
  compactPartyCol: { flexDirection: "column", gap: 10, flex: 1.6 },
  compactMetaBox: { flex: 1, borderRadius: 6, backgroundColor: FAINT_BG, padding: 10, gap: 4 },
});

function PartyBlock({
  title,
  name,
  email,
  gstin,
  pan,
  address,
  state,
  compact,
}: {
  title: string;
  name: string;
  email?: string | null;
  gstin?: string | null;
  pan?: string | null;
  address?: string | null;
  state?: string | null;
  compact?: boolean;
}) {
  return (
    <View style={compact ? undefined : styles.metaBlock}>
      <Text style={styles.label}>{title}</Text>
      <Text style={compact ? { fontSize: 9.5, fontWeight: 700 } : styles.value}>{name}</Text>
      {address ? <Text style={styles.small}>{address}</Text> : null}
      {state ? <Text style={styles.small}>{state}</Text> : null}
      {gstin ? <Text style={styles.small}>GSTIN: {gstin}</Text> : null}
      {pan ? <Text style={styles.small}>PAN: {pan}</Text> : null}
      {email ? <Text style={styles.small}>{email}</Text> : null}
    </View>
  );
}

function ExtraRefs({ buyerOrderNo, ackNo }: { buyerOrderNo?: string | null; ackNo?: string | null }) {
  if (!buyerOrderNo && !ackNo) return null;
  return (
    <>
      {buyerOrderNo ? (
        <>
          <Text style={styles.label}>Buyer&apos;s order no.</Text>
          <Text style={styles.value}>{buyerOrderNo}</Text>
        </>
      ) : null}
      {ackNo ? (
        <>
          <Text style={styles.label}>Ack no.</Text>
          <Text style={styles.value}>{ackNo}</Text>
        </>
      ) : null}
    </>
  );
}

function CompanyLockup({
  name,
  logoDataUrl,
  nameStyle,
  chip,
}: {
  name: string;
  logoDataUrl?: string | null;
  nameStyle: Style | Style[];
  chip?: boolean;
}) {
  return (
    <View style={styles.companyNameRow}>
      {logoDataUrl ? (
        chip ? (
          <View style={styles.logoChip}>
            <Image src={logoDataUrl} style={{ width: 30, height: 30, objectFit: "contain" }} />
          </View>
        ) : (
          <Image src={logoDataUrl} style={styles.logoImg} />
        )
      ) : null}
      <Text style={nameStyle}>{name}</Text>
    </View>
  );
}

export function InvoiceDocument(data: InvoiceDocumentData) {
  const accent = ACCENT[data.template];
  const accentTint = tint(accent, 0.93);
  const isModern = data.template === "modern";
  const isMinimal = data.template === "minimal";
  const isSidebar = data.template === "sidebar";
  const isCompact = data.template === "compact";

  const gstItems: GstLineItem[] = data.lineItems.map((li) => ({
    hsnSac: li.hsnSac ?? null,
    gstRate: li.gstRate ?? null,
    taxableValue: li.quantity * li.unitPrice,
  }));
  const gst = splitTax(gstItems, data.company.state, data.customer.state);
  const hasGstBreakdown = gst.groups.some((g) => g.taxAmount > 0);

  const table = (
    <View style={styles.table}>
      <View style={styles.tHeadRow}>
        <Text style={[styles.colDesc, styles.tHeadText]}>Description</Text>
        <Text style={[styles.colHsn, styles.tHeadText]}>HSN/SAC</Text>
        <Text style={[styles.colGst, styles.tHeadText]}>GST</Text>
        <Text style={[styles.colQty, styles.tHeadText]}>Qty</Text>
        <Text style={[styles.colPrice, styles.tHeadText]}>Rate</Text>
        <Text style={[styles.colAmount, styles.tHeadText]}>Amount</Text>
      </View>
      {data.lineItems.map((li, i) => (
        <View style={[styles.tRow, i % 2 === 1 ? styles.tRowAlt : undefined]} key={i}>
          <View style={styles.colDesc}>
            <Text>{li.description}</Text>
            {li.note ? <Text style={styles.itemNote}>{li.note}</Text> : null}
          </View>
          <Text style={styles.colHsn}>{li.hsnSac || "—"}</Text>
          <Text style={styles.colGst}>{li.gstRate ? `${li.gstRate}%` : "—"}</Text>
          <Text style={styles.colQty}>
            {li.quantity} {li.unit || "Units"}
          </Text>
          <Text style={styles.colPrice}>{money(li.unitPrice)}</Text>
          <Text style={styles.colAmount}>{money(li.quantity * li.unitPrice)}</Text>
        </View>
      ))}
    </View>
  );

  const totals = (
    <View style={[styles.totalsCard, { backgroundColor: accentTint }]}>
      <View style={styles.totalsRow}>
        <Text style={styles.totalsLabel}>Subtotal</Text>
        <Text style={styles.totalsValue}>{money(data.subtotal)}</Text>
      </View>
      <View style={styles.totalsRow}>
        <Text style={styles.totalsLabel}>{gst.sameState ? "CGST + SGST" : "IGST"}</Text>
        <Text style={styles.totalsValue}>{money(data.tax)}</Text>
      </View>
      <View style={[styles.grandTotalRow, { borderTopColor: tint(accent, 0.7) }]}>
        <Text style={styles.grandTotalText}>Total</Text>
        <Text style={[styles.grandTotalText, { color: accent }]}>₹{money(data.total)}</Text>
      </View>
    </View>
  );

  const words = (
    <Text style={styles.words}>
      <Text style={styles.wordsLabel}>Amount in words: </Text>
      INR {amountInWords(data.total)}
    </Text>
  );

  const gstBreakdown = hasGstBreakdown && (
    <View style={styles.gstTable}>
      <Text style={styles.gstSectionLabel}>Tax breakdown</Text>
      <View style={styles.gstHeadRow}>
        <Text style={[styles.gstColHsn, styles.tHeadText]}>HSN/SAC</Text>
        <Text style={[styles.gstColNum, styles.tHeadText]}>Taxable value</Text>
        {gst.sameState ? (
          <>
            <Text style={[styles.gstColNum, styles.tHeadText]}>CGST</Text>
            <Text style={[styles.gstColNum, styles.tHeadText]}>SGST</Text>
          </>
        ) : (
          <Text style={[styles.gstColNum, styles.tHeadText]}>IGST</Text>
        )}
        <Text style={[styles.gstColNum, styles.tHeadText]}>Tax amount</Text>
      </View>
      {gst.groups.map((g, i) => (
        <View style={styles.gstRow} key={i}>
          <Text style={styles.gstColHsn}>
            {g.hsnSac} ({g.gstRate}%)
          </Text>
          <Text style={styles.gstColNum}>{money(g.taxableValue)}</Text>
          {gst.sameState ? (
            <>
              <Text style={styles.gstColNum}>{money(g.cgst ?? 0)}</Text>
              <Text style={styles.gstColNum}>{money(g.sgst ?? 0)}</Text>
            </>
          ) : (
            <Text style={styles.gstColNum}>{money(g.igst ?? 0)}</Text>
          )}
          <Text style={styles.gstColNum}>{money(g.taxAmount)}</Text>
        </View>
      ))}
    </View>
  );

  // Present only for an invoice the IRP has registered: the IRN + the
  // IRP-signed QR are what make it a valid e-invoice.
  const einvoiceBlock = data.einvoice ? (
    <View style={[styles.notes, { flexDirection: "row", alignItems: "center" }]} wrap={false}>
      <Image src={data.einvoice.qrDataUrl} style={{ width: 80, height: 80 }} />
      <View style={{ marginLeft: 10, flex: 1 }}>
        <Text style={styles.label}>IRN</Text>
        <Text style={{ fontSize: 7 }}>{data.einvoice.irn}</Text>
        <Text style={[styles.label, { marginTop: 4 }]}>Ack no. / date</Text>
        <Text style={{ fontSize: 8 }}>{data.einvoice.ackNo} · {data.einvoice.ackDate}</Text>
      </View>
    </View>
  ) : null;

  const notes = (
    <>
      {einvoiceBlock}
      {data.notes ? (
        <View style={styles.notes}>
          <Text style={styles.label}>Notes</Text>
          <Text>{data.notes}</Text>
        </View>
      ) : null}
    </>
  );

  // Sidebar keeps bank + signature in the sidebar itself, so the main column
  // only needs the notes block — bottomRow is shared by the other 4 templates.
  const bankAndSignature = (
    <View style={styles.bottomRow}>
      {data.company.bank ? (
        <View style={styles.bankBlock}>
          <Text style={styles.label}>Bank details</Text>
          {data.company.bank.accountName ? <Text style={styles.small}>A/c holder: {data.company.bank.accountName}</Text> : null}
          {data.company.bank.bankName ? <Text style={styles.small}>Bank: {data.company.bank.bankName}</Text> : null}
          {data.company.bank.accountNumber ? <Text style={styles.small}>A/c No.: {data.company.bank.accountNumber}</Text> : null}
          {data.company.bank.ifsc ? <Text style={styles.small}>IFSC: {data.company.bank.ifsc}</Text> : null}
          {data.company.bank.swift ? <Text style={styles.small}>SWIFT: {data.company.bank.swift}</Text> : null}
        </View>
      ) : (
        <View style={styles.bankBlock} />
      )}

      {data.signatureDataUrl ? (
        <View style={styles.signatureBlock}>
          <Image src={data.signatureDataUrl} style={styles.signatureImg} />
          <Text style={styles.signatureCaption}>Authorized signature</Text>
        </View>
      ) : null}
    </View>
  );

  if (isSidebar) {
    return (
      <Document title={`Invoice ${data.invoiceNumber}`}>
        <Page size="A4" style={styles.page}>
          <View style={styles.sidebarWrap}>
            <View fixed style={[styles.sidebarCol, { backgroundColor: accent }]}>
              {data.company.logoDataUrl ? <Image src={data.company.logoDataUrl} style={[styles.logoImg, { width: 40, height: 40 }]} /> : null}
              <Text style={styles.sidebarName}>{data.company.name}</Text>
              {data.company.address ? <Text style={[styles.sidebarValue, { marginTop: 8 }]}>{data.company.address}</Text> : null}
              {data.company.state ? <Text style={styles.sidebarValue}>{data.company.state}</Text> : null}

              {(data.company.gstin || data.company.pan) && <View style={styles.sidebarDivider} />}
              {data.company.gstin ? (
                <>
                  <Text style={styles.sidebarLabel}>GSTIN</Text>
                  <Text style={[styles.sidebarValue, { marginBottom: 8 }]}>{data.company.gstin}</Text>
                </>
              ) : null}
              {data.company.pan ? (
                <>
                  <Text style={styles.sidebarLabel}>PAN</Text>
                  <Text style={styles.sidebarValue}>{data.company.pan}</Text>
                </>
              ) : null}

              {data.company.bank && <View style={styles.sidebarDivider} />}
              {data.company.bank ? (
                <>
                  <Text style={styles.sidebarLabel}>Bank details</Text>
                  {data.company.bank.accountName ? <Text style={styles.sidebarValue}>{data.company.bank.accountName}</Text> : null}
                  {data.company.bank.bankName ? <Text style={styles.sidebarValue}>{data.company.bank.bankName}</Text> : null}
                  {data.company.bank.accountNumber ? <Text style={styles.sidebarValue}>A/c: {data.company.bank.accountNumber}</Text> : null}
                  {data.company.bank.ifsc ? <Text style={styles.sidebarValue}>IFSC: {data.company.bank.ifsc}</Text> : null}
                  {data.company.bank.swift ? <Text style={styles.sidebarValue}>SWIFT: {data.company.bank.swift}</Text> : null}
                </>
              ) : null}

              {data.signatureDataUrl ? (
                <>
                  <View style={styles.sidebarDivider} />
                  <Text style={styles.sidebarLabel}>Authorized signature</Text>
                  <Image src={data.signatureDataUrl} style={[styles.signatureImg, { width: 105, height: 40, marginTop: 2 }]} />
                </>
              ) : null}
            </View>

            <View style={styles.mainCol}>
              <View style={styles.headerRow}>
                <Text style={[styles.title, { color: accent }]}>TAX INVOICE</Text>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.label}>Invoice #</Text>
                  <Text style={styles.value}>{data.invoiceNumber}</Text>
                </View>
              </View>

              <View style={styles.metaRow}>
                <PartyBlock
                  title="Billed to"
                  name={data.customer.name}
                  email={data.customer.email}
                  gstin={data.customer.gstin}
                  pan={data.customer.pan}
                  address={data.customer.address}
                  state={data.customer.state}
                />
                <View style={styles.metaBlock}>
                  <Text style={styles.label}>Invoice date</Text>
                  <Text style={styles.value}>{data.invoiceDate}</Text>
                  <Text style={styles.label}>Due date</Text>
                  <Text style={styles.value}>{data.dueDate}</Text>
                  <ExtraRefs buyerOrderNo={data.buyerOrderNo} ackNo={data.ackNo} />
                </View>
              </View>

              {table}
              {totals}
              {words}
              {gstBreakdown}
              {notes}
            </View>
          </View>
        </Page>
      </Document>
    );
  }

  if (isCompact) {
    return (
      <Document title={`Invoice ${data.invoiceNumber}`}>
        <Page size="A4" style={[styles.page, styles.compactBody]}>
          <View style={[styles.compactHeaderRow, { borderBottomColor: accent }]}>
            <CompanyLockup name={data.company.name} logoDataUrl={data.company.logoDataUrl} nameStyle={{ fontSize: 13, fontWeight: 700, color: accent }} />
            <View style={{ alignItems: "flex-end" }}>
              <Text style={{ fontSize: 13, fontWeight: 700, color: accent }}>TAX INVOICE</Text>
              <Text style={{ fontSize: 8, color: MUTED, marginTop: 2 }}>{data.invoiceNumber}</Text>
            </View>
          </View>

          <View style={styles.compactMetaRow}>
            <View style={styles.compactPartyCol}>
              <PartyBlock title="Seller" name={data.company.name} gstin={data.company.gstin} pan={data.company.pan} address={data.company.address} state={data.company.state} compact />
              <PartyBlock title="Billed to" name={data.customer.name} email={data.customer.email} gstin={data.customer.gstin} pan={data.customer.pan} address={data.customer.address} state={data.customer.state} compact />
            </View>
            <View style={styles.compactMetaBox}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={styles.label}>Invoice #</Text>
                <Text style={{ fontSize: 9, fontWeight: 700 }}>{data.invoiceNumber}</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={styles.label}>Date</Text>
                <Text style={{ fontSize: 9 }}>{data.invoiceDate}</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={styles.label}>Due</Text>
                <Text style={{ fontSize: 9 }}>{data.dueDate}</Text>
              </View>
              {data.buyerOrderNo ? (
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={styles.label}>Buyer&apos;s order no.</Text>
                  <Text style={{ fontSize: 9 }}>{data.buyerOrderNo}</Text>
                </View>
              ) : null}
              {data.ackNo ? (
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={styles.label}>Ack no.</Text>
                  <Text style={{ fontSize: 9 }}>{data.ackNo}</Text>
                </View>
              ) : null}
            </View>
          </View>

          {table}
          {totals}
          {words}
          {gstBreakdown}
          {notes}
          {bankAndSignature}
        </Page>
      </Document>
    );
  }

  return (
    <Document title={`Invoice ${data.invoiceNumber}`}>
      <Page size="A4" style={styles.page}>
        {isModern ? (
          <View style={[styles.modernBand, { backgroundColor: accent }]}>
            <CompanyLockup name={data.company.name} logoDataUrl={data.company.logoDataUrl} nameStyle={[styles.companyName, { color: "#fff" }]} chip />
            <View style={{ alignItems: "flex-end" }}>
              <Text style={[styles.title, { color: "#fff", fontSize: 19 }]}>TAX INVOICE</Text>
              <Text style={{ fontSize: 8.5, color: "rgba(255,255,255,0.75)", marginTop: 2 }}>{data.invoiceNumber}</Text>
            </View>
          </View>
        ) : (
          <View style={[styles.topBar, { backgroundColor: accent }]} />
        )}

        <View style={styles.body}>
          {isMinimal ? (
            <View style={styles.headerRow}>
              <CompanyLockup name={data.company.name} logoDataUrl={data.company.logoDataUrl} nameStyle={[styles.companyName, { fontWeight: 400, fontSize: 13 }]} />
              <Text style={[styles.title, { fontSize: 15, fontWeight: 400, letterSpacing: 3 }]}>TAX INVOICE</Text>
            </View>
          ) : !isModern ? (
            <View style={styles.headerRow}>
              <CompanyLockup name={data.company.name} logoDataUrl={data.company.logoDataUrl} nameStyle={[styles.companyName, { color: accent }]} />
              <View style={styles.titleBlock}>
                <Text style={[styles.title, { color: accent }]}>TAX INVOICE</Text>
                <Text style={[styles.invoiceNumberPill, { color: MUTED }]}>{data.invoiceNumber}</Text>
              </View>
            </View>
          ) : null}

          <View style={styles.metaRow}>
            <PartyBlock title="Seller" name={data.company.name} gstin={data.company.gstin} pan={data.company.pan} address={data.company.address} state={data.company.state} />
            <PartyBlock title="Billed to" name={data.customer.name} email={data.customer.email} gstin={data.customer.gstin} pan={data.customer.pan} address={data.customer.address} state={data.customer.state} />
            <View style={styles.metaBlock}>
              <Text style={styles.label}>{isModern ? "Invoice date" : "Invoice #"}</Text>
              <Text style={styles.value}>{isModern ? data.invoiceDate : data.invoiceNumber}</Text>
              <Text style={styles.label}>{isModern ? "Due date" : "Invoice date"}</Text>
              <Text style={styles.value}>{isModern ? data.dueDate : data.invoiceDate}</Text>
              {!isModern && (
                <>
                  <Text style={styles.label}>Due date</Text>
                  <Text style={styles.value}>{data.dueDate}</Text>
                </>
              )}
              <ExtraRefs buyerOrderNo={data.buyerOrderNo} ackNo={data.ackNo} />
            </View>
          </View>

          {table}
          {totals}
          {words}
          {gstBreakdown}
          {notes}
          {bankAndSignature}
        </View>
      </Page>
    </Document>
  );
}
