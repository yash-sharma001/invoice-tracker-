/**
 * The one seam between the app and whatever registers an invoice with the
 * IRP. Two routes, chosen per company (`einvoice_credentials.provider`):
 *   nic -> NIC's own IRP API, direct (only open to taxpayers > Rs 100 cr)
 *   gsp -> a GST Suvidha Provider
 *
 * `gsp` is Masters India (./mastersIndia.ts). `nic` is unbuilt until its API
 * docs are in hand: it throws, so an e-invoice company's invoice fails closed
 * (status `failed`, never emailed) instead of going out without an IRN.
 */
import type { IrpPayload } from "../../lib/einvoice/payload";
import { mastersIndiaProvider } from "./mastersIndia";

export interface IrpResult {
  irn: string;
  ackNo: string;
  /** ISO timestamp */
  ackDate: string;
  /** The IRP-signed QR payload (a JWT) — encode it as the QR image on the PDF. */
  signedQr: string;
}

export interface EInvoiceProvider {
  generate(payload: IrpPayload): Promise<IrpResult>;
}

export type ProviderName = "nic" | "gsp";
export type ProviderConfig = { baseUrl?: string } & Record<string, string | undefined>;

const notBuilt = (what: string): EInvoiceProvider => ({
  async generate() {
    throw new Error(`${what} isn't built yet — this invoice was not registered and was not sent`);
  },
});

export function providerFor(name: ProviderName, config: ProviderConfig): EInvoiceProvider {
  if (name === "nic") return notBuilt("The NIC IRP client");

  // GSP = Masters India. A company's saved credentials win; otherwise the
  // platform-wide account from the environment serves every tenant (each
  // request names the tenant's GSTIN, so the IRN is issued under theirs).
  const baseUrl = config.baseUrl ?? process.env.MASTERS_BASE_URL;
  // A sandbox IRN has no legal standing; never let one reach a real customer.
  const prod = process.env.NODE_ENV === "production" && /^(1|true|yes)$/i.test(process.env.REQUIRE_AUTH ?? "");
  if (prod && /sandb|trial|test|staging|uat|demo/i.test(baseUrl ?? "")) {
    throw new Error("Refusing to use a sandbox IRP URL in production");
  }
  return mastersIndiaProvider({ baseUrl, apiKey: config.apiKey ?? process.env.MASTERS_API_KEY });
}
