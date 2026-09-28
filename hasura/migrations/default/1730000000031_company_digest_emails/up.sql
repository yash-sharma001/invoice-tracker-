-- Per-company recipients for the daily overdue digest (was one global EMAIL_TO,
-- which mailed every tenant's invoices to a single inbox). Defaults to the
-- company admin's email so existing tenants keep getting their own digest.
ALTER TABLE companies ADD COLUMN digest_emails text[] NOT NULL DEFAULT '{}';

UPDATE companies c SET digest_emails = ARRAY[u.email]
  FROM users u
 WHERE u.company_id = c.id AND u.role = 'admin' AND u.is_active;
