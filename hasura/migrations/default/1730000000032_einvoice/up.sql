-- GST e-invoicing (IRP) support, per tenant.
--
-- A company opts in with `einvoice_enabled`. Invoices of opted-in companies
-- get an IRN + signed QR from the IRP before they are sent. Once an invoice
-- has an IRN it is a legal document: its core fields and line items are
-- frozen and it can't be deleted (corrections go through a credit note;
-- cancellation is only possible on the IRP within 24h).
--
-- Credentials for the GSP/IRP live in their own table (added with the client),
-- never on `companies` — finance_user can select `*` there.

-- IRP party fields the free-text address/state columns can't supply.
ALTER TABLE companies ADD COLUMN legal_name TEXT;
ALTER TABLE companies ADD COLUMN city TEXT;
ALTER TABLE companies ADD COLUMN pincode TEXT;
ALTER TABLE companies ADD COLUMN einvoice_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE customers ADD COLUMN legal_name TEXT;
ALTER TABLE customers ADD COLUMN city TEXT;
ALTER TABLE customers ADD COLUMN pincode TEXT;

-- UQC unit code (NOS, KGS, ...) the IRP requires; `unit` stays free text for display.
ALTER TABLE invoice_line_items ADD COLUMN uqc TEXT NOT NULL DEFAULT 'OTH';

-- `ack_no` already exists (hand-typed reference); for e-invoices it is the IRP's.
ALTER TABLE invoices ADD COLUMN place_of_supply TEXT;      -- 2-digit state code; defaults to the buyer's
ALTER TABLE invoices ADD COLUMN irn TEXT;
ALTER TABLE invoices ADD COLUMN ack_date TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN signed_qr TEXT;
ALTER TABLE invoices ADD COLUMN einvoice_status TEXT
  CHECK (einvoice_status IN ('pending', 'generated', 'failed', 'cancelled'));
ALTER TABLE invoices ADD COLUMN einvoice_error TEXT;

CREATE UNIQUE INDEX invoices_irn_key ON invoices (irn) WHERE irn IS NOT NULL;
-- One number per company per FY is enforced by the IRP; this stops our own
-- retries/duplicates from ever reaching it twice.
CREATE UNIQUE INDEX invoices_einvoice_number_key ON invoices (company_id, invoice_number)
  WHERE einvoice_status IS NOT NULL AND einvoice_status <> 'failed';

-- Freeze a registered invoice.
CREATE FUNCTION einvoice_freeze_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.irn IS NOT NULL THEN
      RAISE EXCEPTION 'Invoice % has an IRN and cannot be deleted', OLD.invoice_number;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.irn IS NOT NULL AND (
       NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
    OR NEW.invoice_date   IS DISTINCT FROM OLD.invoice_date
    OR NEW.amount         IS DISTINCT FROM OLD.amount
    OR NEW.tax_amount     IS DISTINCT FROM OLD.tax_amount
    OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id
    OR NEW.place_of_supply IS DISTINCT FROM OLD.place_of_supply
    OR NEW.irn            IS DISTINCT FROM OLD.irn
    OR NEW.signed_qr      IS DISTINCT FROM OLD.signed_qr
    OR NEW.ack_no         IS DISTINCT FROM OLD.ack_no
  ) THEN
    RAISE EXCEPTION 'Invoice % has an IRN; issue a credit note instead of editing it', OLD.invoice_number;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoices_einvoice_freeze
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION einvoice_freeze_invoice();

CREATE FUNCTION einvoice_freeze_line_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv UUID := COALESCE(OLD.invoice_id, NEW.invoice_id);
BEGIN
  IF EXISTS (SELECT 1 FROM invoices WHERE id = inv AND irn IS NOT NULL) THEN
    RAISE EXCEPTION 'Invoice has an IRN; its line items can no longer change';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER invoice_line_items_einvoice_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION einvoice_freeze_line_items();
