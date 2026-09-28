REVOKE SELECT (company_id, amount, created_at) ON invoices FROM auth_service;
DROP TRIGGER users_seat_limit ON users;
DROP FUNCTION enforce_seat_limit();
DELETE FROM users WHERE company_id = '00000000-0000-0000-0000-0000000000ff';
DELETE FROM companies WHERE id = '00000000-0000-0000-0000-0000000000ff';
ALTER TABLE companies DROP COLUMN deleted_at, DROP COLUMN status;
