DROP TRIGGER invoice_line_items_einvoice_freeze ON invoice_line_items;
DROP FUNCTION einvoice_freeze_line_items();
DROP TRIGGER invoices_einvoice_freeze ON invoices;
DROP FUNCTION einvoice_freeze_invoice();
DROP INDEX invoices_einvoice_number_key;
DROP INDEX invoices_irn_key;
ALTER TABLE invoices
  DROP COLUMN einvoice_error, DROP COLUMN einvoice_status, DROP COLUMN signed_qr,
  DROP COLUMN ack_date, DROP COLUMN irn, DROP COLUMN place_of_supply;
ALTER TABLE invoice_line_items DROP COLUMN uqc;
ALTER TABLE customers DROP COLUMN pincode, DROP COLUMN city, DROP COLUMN legal_name;
ALTER TABLE companies
  DROP COLUMN einvoice_enabled, DROP COLUMN pincode, DROP COLUMN city, DROP COLUMN legal_name;
