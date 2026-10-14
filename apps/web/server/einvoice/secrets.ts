/**
 * AES-256-GCM for the per-tenant IRP credentials stored in
 * `einvoice_credentials.config_encrypted`. Layout: base64(iv[12] | tag[16] | ciphertext).
 * The key comes from EINVOICE_CREDENTIALS_KEY (32 random bytes, base64) and is
 * never stored in the DB. GCM authenticates, so a tampered value throws on decrypt.
 *
 * ponytail: single key, no rotation — add a key id prefix when rotation is needed.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
  const k = Buffer.from(process.env.EINVOICE_CREDENTIALS_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("EINVOICE_CREDENTIALS_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encryptConfig(config: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(config), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decryptConfig<T = Record<string, string>>(blob: string): T {
  const raw = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as T;
}
