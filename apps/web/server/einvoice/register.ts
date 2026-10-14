/**
 * Registers one saved invoice with the IRP and records the outcome. A
 * failure is stored on the invoice (status `failed` + message) and re-thrown,
 * so the caller can't carry on and send it.
 *
 * ponytail: single synchronous attempt. If the IRP registers the invoice but
 * the write-back below fails, the IRN exists only at the IRP — the thrown
 * error carries it so it can be recovered; add a get-by-IRN reconcile job
 * when that matters in practice.
 */
import { hasura, einvoiceClaims } from "../hasura";
import type { IrpPayload } from "../../lib/einvoice/payload";
import { decryptConfig } from "./secrets";
import { providerFor, type IrpResult, type ProviderConfig, type ProviderName } from "./provider";

async function setResult(companyId: string, invoiceId: string, set: Record<string, unknown>) {
  await hasura(
    `mutation($id: uuid!, $set: invoices_set_input!) { update_invoices_by_pk(pk_columns: { id: $id }, _set: $set) { id } }`,
    { id: invoiceId, set },
    { claims: einvoiceClaims(companyId) },
  );
}

export async function registerWithIrp(companyId: string, invoiceId: string, payload: IrpPayload): Promise<IrpResult> {
  const claims = einvoiceClaims(companyId);
  let result: IrpResult;
  try {
    const { einvoice_credentials } = await hasura<{
      einvoice_credentials: { provider: ProviderName; config_encrypted: string }[];
    }>(`query { einvoice_credentials { provider config_encrypted } }`, {}, { claims });
    const cred = einvoice_credentials[0];
    if (!cred) throw new Error("E-invoicing isn't set up: add your IRP credentials first");
    result = await providerFor(cred.provider, decryptConfig<ProviderConfig>(cred.config_encrypted)).generate(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setResult(companyId, invoiceId, { einvoice_status: "failed", einvoice_error: message.slice(0, 1000) });
    throw err;
  }
  try {
    await setResult(companyId, invoiceId, {
      irn: result.irn,
      ack_no: result.ackNo,
      ack_date: result.ackDate,
      signed_qr: result.signedQr,
      einvoice_status: "generated",
      einvoice_error: null,
    });
  } catch (err) {
    throw new Error(`Registered with the IRP (IRN ${result.irn}) but couldn't save it: ${err instanceof Error ? err.message : err}`);
  }
  return result;
}
