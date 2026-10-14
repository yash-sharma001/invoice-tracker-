-- Per-tenant IRP credentials. `config_encrypted` is AES-256-GCM ciphertext
-- (see apps/web/server/einvoice/secrets.ts) — the DB never sees plaintext.
-- No user role gets any permission on this table; only the server-minted
-- `einvoice_service` role reads/writes it.
--   provider 'nic' -> direct NIC IRP API (tenants > Rs 100 cr)
--   provider 'gsp' -> a GST Suvidha Provider (everyone else)
CREATE TABLE einvoice_credentials (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('nic', 'gsp')),
  config_encrypted TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
