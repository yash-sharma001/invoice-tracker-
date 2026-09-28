-- Platform super admin + company lifecycle + per-company seat limits.
--
-- * companies.status: 'active' | 'suspended' | 'deleted'. Deleting a company is
--   a soft delete (users can't sign in, data is kept for the audit trail).
-- * A fixed "Qlens Platform" company owns the super_admin user(s) so users.company_id
--   stays NOT NULL. It is excluded from every customer count in app code.
-- * Seats per company: 1 admin, 2 finance_user, 2 approver — counting ACTIVE
--   users only, so deactivating someone frees their seat. Enforced here (not just
--   in app code) so two concurrent invites can't both slip past the limit.
ALTER TABLE companies
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  ADD COLUMN deleted_at timestamptz;

INSERT INTO companies (id, name) VALUES ('00000000-0000-0000-0000-0000000000ff', 'Qlens Platform');

CREATE FUNCTION enforce_seat_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  seat_limit int;
  taken int;
BEGIN
  IF NOT NEW.is_active OR NEW.role = 'super_admin' THEN RETURN NEW; END IF;
  seat_limit := CASE NEW.role WHEN 'admin' THEN 1 ELSE 2 END;
  -- Serialise seat checks per company so concurrent inserts can't both pass.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.company_id::text));
  SELECT count(*) INTO taken FROM users
   WHERE company_id = NEW.company_id AND role = NEW.role AND is_active AND id <> NEW.id;
  IF taken >= seat_limit THEN
    RAISE EXCEPTION 'seat limit reached: % allows % active %', 'this company', seat_limit, NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_seat_limit BEFORE INSERT OR UPDATE OF role, is_active, company_id ON users
  FOR EACH ROW EXECUTE FUNCTION enforce_seat_limit();

-- auth_service already has SELECT/INSERT/UPDATE on companies and users. The
-- platform dashboard needs per-company invoice totals (columns only — never
-- invoice contents) and hard-deleting a user needs no new grant (DELETE on users
-- was added in 1730000000028).
GRANT SELECT (company_id, amount, created_at) ON invoices TO auth_service;
