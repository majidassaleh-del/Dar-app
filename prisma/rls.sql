-- =============================================================================
--  Household ERP — Row-Level Security (apply AFTER prisma migrations)
-- -----------------------------------------------------------------------------
--  Two layers, both enforced by Postgres:
--    1. TENANT ISOLATION (permissive): a row is visible only if its
--       "householdId" equals the *active* household AND the caller is an
--       ACTIVE member of it. Cross-tenant leakage is impossible even if the
--       API forgets a WHERE clause.
--    2. ROLE / SCOPE (restrictive): sensitive tables additionally require a
--       permission whose scope (ALL | OWN | ASSIGNED | WARDS) covers the row.
--       e.g. a maid sees only her own payslips; a child only their own spend.
--
--  Request context (set once per DB transaction by the API):
--      SET LOCAL ROLE app_user;
--      SELECT set_config('app.user_id',      '<uuid>', true),
--             set_config('app.household_id', '<uuid>', true);
--  On Supabase (PostgREST / supabase-js), the same functions fall back to the
--  JWT: `sub` and a custom `household_id` claim (Custom Access Token Hook).
--
--  Background workers (OCR, reminders, bank feeds) use `app_service`
--  (BYPASSRLS) and must filter by householdId explicitly.
-- =============================================================================

-- ---------------------------------------------------------------- roles ----
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_service') THEN
    CREATE ROLE app_service NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- On Supabase also: GRANT app_user TO authenticated;  (or swap app_user → authenticated)

-- SECURITY DEFINER helpers and triggers below must run as a role that is
-- not subject to RLS (tables use FORCE ROW LEVEL SECURITY). Superuser locally;
-- on Supabase / Cloud SQL the migration owner must have BYPASSRLS.
DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'rls.sql must be applied by a role with BYPASSRLS (current: %)', current_user;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app, public TO app_user, app_service;

-- -------------------------------------------------------- context helpers --
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    NULLIF(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
  )
$$;

-- Returns the active household ONLY if the caller is an ACTIVE, non-expired
-- member. Otherwise NULL → every tenant policy evaluates false.
CREATE OR REPLACE FUNCTION app.current_household_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m."householdId"
  FROM memberships m
  WHERE m."userId" = app.current_user_id()
    AND m."householdId" = COALESCE(
          NULLIF(current_setting('app.household_id', true), '')::uuid,
          NULLIF(current_setting('request.jwt.claims', true)::json ->> 'household_id', '')::uuid)
    AND m.status = 'ACTIVE'
    AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
$$;

CREATE OR REPLACE FUNCTION app.current_membership_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id FROM memberships m
  WHERE m."userId" = app.current_user_id()
    AND m."householdId" = app.current_household_id()
$$;

CREATE OR REPLACE FUNCTION app.my_wards() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(id), '{}') FROM memberships
  WHERE "guardianId" = app.current_membership_id()
$$;

-- Effective scope of a permission for the caller (explicit deny wins,
-- membership override beats role grant). NULL = no access.
CREATE OR REPLACE FUNCTION app.perm_scope(p_perm text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT m.id, m."roleId" FROM memberships m WHERE m.id = app.current_membership_id()
  ), ovr AS (
    SELECT mp.granted, mp.scope FROM membership_permissions mp, me
    WHERE mp."membershipId" = me.id AND mp."permissionId" = p_perm
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM ovr WHERE NOT granted) THEN NULL
    WHEN EXISTS (SELECT 1 FROM ovr WHERE granted)     THEN (SELECT scope FROM ovr LIMIT 1)
    ELSE (SELECT rp.scope FROM role_permissions rp, me
          WHERE rp."roleId" = me."roleId" AND rp."permissionId" = p_perm)
  END
$$;

-- Is the *invoking* role subject to RLS (app_user, or Supabase's authenticated)?
-- False for the migration owner / app_service (BYPASSRLS), so provisioning and
-- workers skip the interactive-user guards. Only meaningful in SECURITY INVOKER
-- functions: inside a SECURITY DEFINER function current_user is the owner.
CREATE OR REPLACE FUNCTION app.caller_is_restricted() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT (rolsuper OR rolbypassrls) FROM pg_roles WHERE rolname = current_user
$$;

-- True for HOUSEHOLD_HEAD and EFA_OFFICE_ADMIN. Role-based on purpose: a
-- permission override can never grant this, so a spouse with
-- admin.members.manage still cannot modify protected tables.
CREATE OR REPLACE FUNCTION app.is_household_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((
    SELECT r."systemRole" IN ('HOUSEHOLD_HEAD', 'EFA_OFFICE_ADMIN')
    FROM memberships m JOIN roles r ON r.id = m."roleId"
    WHERE m.id = app.current_membership_id()), false)
$$;

CREATE OR REPLACE FUNCTION app.is_admin_role(p_role uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT "systemRole" IN ('HOUSEHOLD_HEAD', 'EFA_OFFICE_ADMIN') FROM roles WHERE id = p_role), false)
$$;

-- Row check: does `scope` cover a row owned/assigned to any of `owners`?
-- Callers pass `(SELECT app.perm_scope('…'))` so the scope is computed once
-- per statement (InitPlan), not per row.
CREATE OR REPLACE FUNCTION app.can_access(p_scope text, p_owners uuid[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_scope = 'ALL' THEN true
    WHEN p_scope IN ('OWN', 'ASSIGNED') THEN app.current_membership_id() = ANY (p_owners)
    WHEN p_scope = 'WARDS' THEN app.current_membership_id() = ANY (p_owners)
                               OR p_owners && app.my_wards()
    ELSE false
  END
$$;

-- Resolve owners through parent tables (definer: bypasses RLS on the parent).
CREATE OR REPLACE FUNCTION app.staff_member(p_staff uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ARRAY["membershipId"] FROM staff_profiles WHERE id = p_staff
$$;

CREATE OR REPLACE FUNCTION app.vehicle_drivers(p_vehicle uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg("driverId"), '{}') FROM vehicle_assignments
  WHERE "vehicleId" = p_vehicle AND "startsAt" <= now() AND ("endsAt" IS NULL OR "endsAt" > now())
$$;

CREATE OR REPLACE FUNCTION app.request_parties(p_request uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ARRAY[r."requesterId"] || COALESCE((SELECT array_agg(a."approverId") FROM approvals a
                                             WHERE a."requestId" = r.id), '{}')
  FROM requests r WHERE r.id = p_request
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_user, app_service;

-- ----------------------------------------------------- table privileges ----
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, app_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, app_service;
-- Immutable audit trail & global catalogue.
REVOKE UPDATE, DELETE ON audit_logs FROM app_user, app_service;
REVOKE INSERT, UPDATE, DELETE ON permissions FROM app_user;

-- ============================================ LAYER 1: TENANT ISOLATION ====
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND c.column_name = 'householdId'
      AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I AS PERMISSIVE FOR ALL TO app_user
      USING      ("householdId" = (SELECT app.current_household_id()))
      WITH CHECK ("householdId" = (SELECT app.current_household_id()))
    $p$, t);
  END LOOP;
END $$;

-- Tables without householdId ------------------------------------------------
ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE households FORCE ROW LEVEL SECURITY;
CREATE POLICY household_member ON households FOR SELECT TO app_user
  USING (id = (SELECT app.current_household_id()));
CREATE POLICY household_head_update ON households FOR UPDATE TO app_user
  USING (id = (SELECT app.current_household_id())
         AND (SELECT app.perm_scope('admin.household.manage')) = 'ALL');
-- Household creation goes through app.provision_household() (definer).

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self_or_housemate ON users FOR SELECT TO app_user
  USING (id = app.current_user_id()
         OR id IN (SELECT "userId" FROM memberships)); -- memberships is itself tenant-filtered
CREATE POLICY users_self_write ON users FOR UPDATE TO app_user
  USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY devices_self ON user_devices FOR ALL TO app_user
  USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY permissions_read ON permissions FOR SELECT TO app_user USING (true);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY rp_tenant ON role_permissions FOR ALL TO app_user
  USING ("roleId" IN (SELECT id FROM roles))
  WITH CHECK ("roleId" IN (SELECT id FROM roles) AND (SELECT app.is_household_admin()));

ALTER TABLE membership_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY mp_tenant ON membership_permissions FOR ALL TO app_user
  USING ("membershipId" IN (SELECT id FROM memberships))
  WITH CHECK ("membershipId" IN (SELECT id FROM memberships) AND (SELECT app.is_household_admin()));

-- ======================================== LAYER 2: ROLE / SCOPE (restrictive)
-- Helper macro: CREATE POLICY <name> ON <t> AS RESTRICTIVE FOR <cmd> TO app_user ...

-- Members & roles: everyone can see the household roster; only admins write.
CREATE POLICY members_write ON memberships AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('admin.members.manage')) = 'ALL');
-- A member may edit their own row, but the guard trigger below limits
-- self-edits to cosmetic columns (displayName). Changing role, status,
-- guardian or expiry needs admin.members.manage, and granting an ADMIN
-- role (Head / EFA) needs to be an admin oneself.
CREATE POLICY members_update ON memberships AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('admin.members.manage')) = 'ALL' OR "userId" = app.current_user_id());
CREATE POLICY members_delete ON memberships AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('admin.members.manage')) = 'ALL');
CREATE POLICY roles_write ON roles AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('admin.members.manage')) = 'ALL'
              AND ("systemRole" NOT IN ('HOUSEHOLD_HEAD', 'EFA_OFFICE_ADMIN') OR (SELECT app.is_household_admin())));

-- ---- Staff HR --------------------------------------------------------------
CREATE POLICY staff_read ON staff_profiles AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.profile.read')), ARRAY["membershipId"]));
CREATE POLICY staff_ins ON staff_profiles AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL');
CREATE POLICY staff_upd ON staff_profiles AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL');
CREATE POLICY staff_del ON staff_profiles AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL');

CREATE POLICY docs_read ON identity_documents AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.documents.read')), app.staff_member("staffId")));
CREATE POLICY docs_write ON identity_documents AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employment_contracts','payroll_lines','salary_advances','leave_records','attendance']
  LOOP
    EXECUTE format($p$CREATE POLICY payroll_read ON %I AS RESTRICTIVE FOR SELECT TO app_user
      USING (app.can_access((SELECT app.perm_scope('staff.payroll.read')), app.staff_member("staffId")))$p$, t);
    EXECUTE format($p$CREATE POLICY payroll_ins ON %I AS RESTRICTIVE FOR INSERT TO app_user
      WITH CHECK ((SELECT app.perm_scope('staff.payroll.manage')) = 'ALL'
                  OR (%L = 'attendance' AND app.can_access((SELECT app.perm_scope('staff.attendance.manage')), app.staff_member("staffId"))))$p$, t, t);
    EXECUTE format($p$CREATE POLICY payroll_upd ON %I AS RESTRICTIVE FOR UPDATE TO app_user
      USING ((SELECT app.perm_scope('staff.payroll.manage')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY payroll_del ON %I AS RESTRICTIVE FOR DELETE TO app_user
      USING ((SELECT app.perm_scope('staff.payroll.manage')) = 'ALL')$p$, t);
  END LOOP;
END $$;

CREATE POLICY payroll_run_read ON payroll_runs AS RESTRICTIVE FOR SELECT TO app_user
  USING ((SELECT app.perm_scope('staff.payroll.read')) = 'ALL');
CREATE POLICY payroll_run_write ON payroll_runs AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('staff.payroll.manage')) = 'ALL');
CREATE POLICY payroll_run_upd ON payroll_runs AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('staff.payroll.manage')) = 'ALL');

CREATE POLICY tasks_read ON household_tasks AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.tasks.manage')), ARRAY["assigneeId","createdById"])
         OR "assigneeId" = app.current_membership_id());
CREATE POLICY tasks_upd ON household_tasks AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('staff.tasks.manage')) = 'ALL' OR "assigneeId" = app.current_membership_id());
CREATE POLICY tasks_ins ON household_tasks AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (app.can_access((SELECT app.perm_scope('staff.tasks.manage')), ARRAY["assigneeId"])
              OR (SELECT app.perm_scope('staff.tasks.manage')) = 'WARDS');

-- ---- Accounting ------------------------------------------------------------
CREATE POLICY acct_read ON financial_accounts AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('finance.accounts.read')), ARRAY["custodianId"]));
CREATE POLICY acct_ins ON financial_accounts AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL');
CREATE POLICY acct_upd ON financial_accounts AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL');

CREATE POLICY card_read ON cards AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('finance.cards.read')), ARRAY["holderId"]));
CREATE POLICY card_ins ON cards AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.cards.manage')) = 'ALL');
CREATE POLICY card_upd ON cards AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.cards.manage')) = 'ALL'
         OR (SELECT app.perm_scope('finance.cards.manage')) = 'WARDS' AND "holderId" = ANY (app.my_wards()));

CREATE POLICY txn_read ON transactions AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('finance.transactions.read')), ARRAY["createdById","spentById"]));
CREATE POLICY txn_ins ON transactions AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (app.can_access((SELECT app.perm_scope('finance.transactions.create')), ARRAY["createdById"])
              AND "createdById" = app.current_membership_id());
-- Ledger immutability: only status transitions by finance managers; never DELETE.
CREATE POLICY txn_upd ON transactions AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL');
CREATE POLICY txn_del ON transactions AS RESTRICTIVE FOR DELETE TO app_user USING (false);

CREATE POLICY rcpt_read ON receipts AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('finance.transactions.read')), ARRAY["uploadedById"])
         OR "uploadedById" = app.current_membership_id());
CREATE POLICY rcpt_ins ON receipts AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.receipts.upload')) IS NOT NULL
              AND "uploadedById" = app.current_membership_id());

CREATE POLICY budget_read ON budgets AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('finance.transactions.read')), ARRAY["ownerId"]));
CREATE POLICY budget_write ON budgets AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.budgets.manage')) = 'ALL');

CREATE POLICY allowance_read ON allowance_plans AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('finance.transactions.read')), ARRAY["dependentId"]));
CREATE POLICY allowance_write ON allowance_plans AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (app.can_access((SELECT app.perm_scope('finance.allowance.manage')), ARRAY["dependentId"])
              AND "dependentId" <> app.current_membership_id());

CREATE POLICY recurring_read ON recurring_rules AS RESTRICTIVE FOR ALL TO app_user
  USING ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL');

-- ---- Requests & approvals --------------------------------------------------
CREATE POLICY req_read ON requests AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('requests.read')), ARRAY["requesterId"])
         OR app.current_membership_id() = ANY (app.request_parties(id)));
CREATE POLICY req_ins ON requests AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('requests.create')) IS NOT NULL
              AND "requesterId" = app.current_membership_id());
CREATE POLICY req_upd ON requests AS RESTRICTIVE FOR UPDATE TO app_user
  USING (app.current_membership_id() = ANY (app.request_parties(id))
         OR (SELECT app.perm_scope('requests.approve')) = 'ALL');

CREATE POLICY appr_read ON approvals AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.current_membership_id() = ANY (app.request_parties("requestId"))
         OR (SELECT app.perm_scope('requests.read')) = 'ALL');
CREATE POLICY appr_decide ON approvals AS RESTRICTIVE FOR UPDATE TO app_user
  USING ("approverId" = app.current_membership_id()
         AND (SELECT app.perm_scope('requests.approve')) IS NOT NULL);
CREATE POLICY appr_policy ON approval_policies AS RESTRICTIVE FOR ALL TO app_user
  USING ((SELECT app.perm_scope('requests.approve')) = 'ALL');

-- ---- Investments: all-or-nothing visibility -------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portfolios','assets','holdings','investment_transactions','asset_valuations']
  LOOP
    EXECUTE format($p$CREATE POLICY invest_read ON %I AS RESTRICTIVE FOR SELECT TO app_user
      USING ((SELECT app.perm_scope('invest.read')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY invest_ins ON %I AS RESTRICTIVE FOR INSERT TO app_user
      WITH CHECK ((SELECT app.perm_scope('invest.manage')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY invest_upd ON %I AS RESTRICTIVE FOR UPDATE TO app_user
      USING ((SELECT app.perm_scope('invest.manage')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY invest_del ON %I AS RESTRICTIVE FOR DELETE TO app_user
      USING ((SELECT app.perm_scope('invest.manage')) = 'ALL')$p$, t);
  END LOOP;
END $$;

-- ---- Fleet: drivers see only currently-assigned vehicles ------------------
CREATE POLICY veh_read ON vehicles AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('fleet.read')), app.vehicle_drivers(id)));
CREATE POLICY veh_ins ON vehicles AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('fleet.manage')) = 'ALL');
CREATE POLICY veh_upd ON vehicles AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('fleet.manage')) = 'ALL'
         OR app.can_access((SELECT app.perm_scope('fleet.trips.log')), app.vehicle_drivers(id))); -- odometer

CREATE POLICY va_read ON vehicle_assignments AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('fleet.read')), ARRAY["driverId"]));
CREATE POLICY va_write ON vehicle_assignments AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('fleet.manage')) = 'ALL');

DO $$
DECLARE t text; perm text;
BEGIN
  FOR t, perm IN VALUES ('maintenance_records','fleet.manage'), ('traffic_violations','fleet.manage'),
                        ('fuel_logs','fleet.fuel.log'), ('trip_logs','fleet.trips.log')
  LOOP
    EXECUTE format($p$CREATE POLICY fleet_read ON %I AS RESTRICTIVE FOR SELECT TO app_user
      USING (app.can_access((SELECT app.perm_scope('fleet.read')), app.vehicle_drivers("vehicleId")))$p$, t);
    EXECUTE format($p$CREATE POLICY fleet_ins ON %I AS RESTRICTIVE FOR INSERT TO app_user
      WITH CHECK (app.can_access((SELECT app.perm_scope(%L)), app.vehicle_drivers("vehicleId")))$p$, t, perm);
    EXECUTE format($p$CREATE POLICY fleet_upd ON %I AS RESTRICTIVE FOR UPDATE TO app_user
      USING ((SELECT app.perm_scope('fleet.manage')) = 'ALL')$p$, t);
  END LOOP;
END $$;

-- ---- Property --------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['properties','property_units','leases','rent_payments','utility_bills']
  LOOP
    EXECUTE format($p$CREATE POLICY prop_read ON %I AS RESTRICTIVE FOR SELECT TO app_user
      USING ((SELECT app.perm_scope('property.read')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY prop_ins ON %I AS RESTRICTIVE FOR INSERT TO app_user
      WITH CHECK ((SELECT app.perm_scope('property.manage')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY prop_upd ON %I AS RESTRICTIVE FOR UPDATE TO app_user
      USING ((SELECT app.perm_scope('property.manage')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY prop_del ON %I AS RESTRICTIVE FOR DELETE TO app_user
      USING ((SELECT app.perm_scope('property.manage')) = 'ALL')$p$, t);
  END LOOP;
END $$;

CREATE POLICY ticket_read ON maintenance_tickets AS RESTRICTIVE FOR SELECT TO app_user
  USING ((SELECT app.perm_scope('property.read')) = 'ALL'
         OR app.current_membership_id() IN ("reporterId", "assigneeId"));
CREATE POLICY ticket_ins ON maintenance_tickets AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('property.tickets.create')) IS NOT NULL
              AND "reporterId" = app.current_membership_id());
CREATE POLICY ticket_upd ON maintenance_tickets AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('property.manage')) = 'ALL' OR "assigneeId" = app.current_membership_id());

-- ---- Cross-cutting ---------------------------------------------------------
CREATE POLICY notif_self ON notifications AS RESTRICTIVE FOR ALL TO app_user
  USING ("userId" = app.current_user_id());
CREATE POLICY reminder_self ON reminders AS RESTRICTIVE FOR SELECT TO app_user
  USING ("recipientId" = app.current_membership_id()
         OR ("recipientId" IS NULL AND (SELECT app.perm_scope('admin.household.manage')) IS NOT NULL)
         OR (SELECT app.perm_scope('admin.members.manage')) = 'ALL');
CREATE POLICY attach_sensitive ON attachments AS RESTRICTIVE FOR SELECT TO app_user
  USING (NOT "isSensitive" OR (SELECT app.perm_scope('staff.documents.read')) = 'ALL'
         OR "uploadedById" = app.current_membership_id());
CREATE POLICY audit_read ON audit_logs AS RESTRICTIVE FOR SELECT TO app_user
  USING ((SELECT app.perm_scope('admin.audit.read')) = 'ALL');

-- =============================================== LAYER 2b: WRITE-GAP CLOSURE ==
-- Every INSERT / UPDATE / DELETE on every RLS table is now covered by a
-- restrictive policy (or the privilege is revoked). tests/rls_test.sql
-- asserts this with a catalogue query, so a new table without write
-- policies fails CI.

-- ---- Protected tables: only HOUSEHOLD_HEAD / EFA_OFFICE_ADMIN may modify --
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['budgets','allowance_plans','identity_documents','roles',
                           'vehicle_assignments','receipts']
  LOOP
    EXECUTE format($p$CREATE POLICY admin_only_update ON %I AS RESTRICTIVE FOR UPDATE TO app_user
      USING ((SELECT app.is_household_admin())) WITH CHECK ((SELECT app.is_household_admin()))$p$, t);
    EXECUTE format($p$CREATE POLICY admin_only_delete ON %I AS RESTRICTIVE FOR DELETE TO app_user
      USING ((SELECT app.is_household_admin()))$p$, t);
  END LOOP;
END $$;
-- Seeded system roles can never be deleted (would orphan memberships).
CREATE POLICY roles_keep_defaults ON roles AS RESTRICTIVE FOR DELETE TO app_user USING (NOT "isDefault");

-- ---- Remaining gaps found by the coverage query -----------------------------
CREATE POLICY rp_admin ON role_permissions AS RESTRICTIVE FOR ALL TO app_user
  USING (true) WITH CHECK ((SELECT app.is_household_admin()));
CREATE POLICY rp_admin_del ON role_permissions AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.is_household_admin()));
CREATE POLICY mp_admin ON membership_permissions AS RESTRICTIVE FOR ALL TO app_user
  USING (true) WITH CHECK ((SELECT app.is_household_admin()));
CREATE POLICY mp_admin_del ON membership_permissions AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.is_household_admin()));

-- Approval rows are created ONLY by the routing trigger (below), never by a
-- client, so a requester cannot pick a friendly approver.
CREATE POLICY appr_no_client_insert ON approvals AS RESTRICTIVE FOR INSERT TO app_user WITH CHECK (false);
CREATE POLICY appr_no_delete        ON approvals AS RESTRICTIVE FOR DELETE TO app_user USING (false);

CREATE POLICY attach_ins ON attachments AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ("uploadedById" = app.current_membership_id());
CREATE POLICY attach_upd ON attachments AS RESTRICTIVE FOR UPDATE TO app_user
  USING ("uploadedById" = app.current_membership_id() OR (SELECT app.is_household_admin()));
CREATE POLICY attach_del ON attachments AS RESTRICTIVE FOR DELETE TO app_user
  USING ("uploadedById" = app.current_membership_id() OR (SELECT app.is_household_admin()));

CREATE POLICY audit_ins_self ON audit_logs AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ("actorUserId" = app.current_user_id());

CREATE POLICY cat_ins ON categories AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.budgets.manage')) = 'ALL');
CREATE POLICY cat_upd ON categories AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.budgets.manage')) = 'ALL');
CREATE POLICY cat_del ON categories AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('finance.budgets.manage')) = 'ALL' AND NOT "isSystem");

-- Financial history is closed/frozen, never deleted.
CREATE POLICY card_del ON cards              AS RESTRICTIVE FOR DELETE TO app_user USING (false);
CREATE POLICY acct_del ON financial_accounts AS RESTRICTIVE FOR DELETE TO app_user USING (false);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fuel_logs','maintenance_records','traffic_violations','trip_logs','vehicles']
  LOOP
    EXECUTE format($p$CREATE POLICY fleet_del ON %I AS RESTRICTIVE FOR DELETE TO app_user
      USING ((SELECT app.perm_scope('fleet.manage')) = 'ALL')$p$, t);
  END LOOP;
END $$;

CREATE POLICY tasks_del ON household_tasks AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('staff.tasks.manage')) = 'ALL' OR "createdById" = app.current_membership_id());
CREATE POLICY ticket_del ON maintenance_tickets AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('property.manage')) = 'ALL');
CREATE POLICY payroll_run_del ON payroll_runs AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('staff.payroll.manage')) = 'ALL' AND status = 'DRAFT');
CREATE POLICY req_del ON requests AS RESTRICTIVE FOR DELETE TO app_user
  USING (("requesterId" = app.current_membership_id() AND status = 'DRAFT') OR (SELECT app.is_household_admin()));

CREATE POLICY reminder_ins ON reminders AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('admin.members.manage')) = 'ALL' OR "recipientId" = app.current_membership_id());
CREATE POLICY reminder_upd ON reminders AS RESTRICTIVE FOR UPDATE TO app_user
  USING ("recipientId" = app.current_membership_id() OR (SELECT app.is_household_admin()));
CREATE POLICY reminder_del ON reminders AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.is_household_admin()));

-- ---- Membership guard (fixes self-promotion) --------------------------------
CREATE OR REPLACE FUNCTION app.guard_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_manager boolean; v_admin boolean;
BEGIN
  IF NOT app.caller_is_restricted() THEN RETURN NEW; END IF; -- provisioning / workers
  -- COALESCE matters: perm_scope() is NULL when not granted, and NOT NULL skips an IF.
  v_manager := COALESCE(app.perm_scope('admin.members.manage') = 'ALL', false);
  v_admin   := app.is_household_admin();

  IF app.is_admin_role(NEW."roleId") AND NOT v_admin
     AND (TG_OP = 'INSERT' OR NEW."roleId" IS DISTINCT FROM OLD."roleId") THEN
    RAISE EXCEPTION 'only a Household Head or EFA Office Admin can grant an admin role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."householdId", NEW."userId") IS DISTINCT FROM (OLD."householdId", OLD."userId") THEN
      RAISE EXCEPTION 'membership owner cannot change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT v_manager AND (NEW."roleId", NEW.status, NEW."guardianId", NEW."expiresAt", NEW."dateOfBirth",
                          NEW.relationship, NEW."invitedById", NEW."joinedAt")
                IS DISTINCT FROM (OLD."roleId", OLD.status, OLD."guardianId", OLD."expiresAt", OLD."dateOfBirth",
                                  OLD.relationship, OLD."invitedById", OLD."joinedAt") THEN
      RAISE EXCEPTION 'members may only change their own display name' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Admins can be demoted/suspended only by admins, and never the last Head.
    IF app.is_admin_role(OLD."roleId") AND NOT v_admin
       AND (NEW."roleId", NEW.status) IS DISTINCT FROM (OLD."roleId", OLD.status) THEN
      RAISE EXCEPTION 'only an admin can change another admin' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (SELECT "systemRole" FROM roles WHERE id = OLD."roleId") = 'HOUSEHOLD_HEAD'
       AND ((SELECT "systemRole" FROM roles WHERE id = NEW."roleId") <> 'HOUSEHOLD_HEAD' OR NEW.status <> 'ACTIVE')
       AND NOT EXISTS (SELECT 1 FROM memberships m JOIN roles r ON r.id = m."roleId"
                       WHERE m."householdId" = OLD."householdId" AND m.id <> OLD.id
                         AND r."systemRole" = 'HOUSEHOLD_HEAD' AND m.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'a household must keep at least one active Household Head'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_guard BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.guard_membership();

-- ---- Approval routing (requests → approvals) --------------------------------
-- ApprovalPolicy.steps: [{ "step": 1, "approverRole": "SPOUSE" } | { "step": 1, "membershipId": "…" }]
-- No matching policy → step 1 = every active Household Head / EFA admin.
-- The requester is never their own approver.
CREATE OR REPLACE FUNCTION app.route_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status <> 'DRAFT' THEN PERFORM app.route_request_rows(NEW.id); END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.route_request_rows(p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r requests; v_pol approval_policies; v_step jsonb; v_n int := 0;
BEGIN
  SELECT * INTO r FROM requests WHERE id = p_request;

  SELECT * INTO v_pol FROM approval_policies p
  WHERE p."householdId" = r."householdId" AND p."requestType" = r.type AND p."isActive"
    AND (p."minAmount" IS NULL OR r.amount >= p."minAmount")
    AND (p."maxAmount" IS NULL OR r.amount <  p."maxAmount")
  ORDER BY p."minAmount" DESC NULLS LAST LIMIT 1;

  IF v_pol.id IS NOT NULL AND v_pol."autoApproveBelow" IS NOT NULL AND r.amount < v_pol."autoApproveBelow" THEN
    UPDATE requests SET status = 'APPROVED', "resolvedAt" = now() WHERE id = r.id;
    PERFORM app.fulfil_request(r.id);
    RETURN;
  END IF;

  IF v_pol.id IS NOT NULL THEN
    FOR v_step IN SELECT * FROM jsonb_array_elements(v_pol.steps) LOOP
      INSERT INTO approvals (id, "householdId", "requestId", step, "approverId")
      SELECT gen_random_uuid(), r."householdId", r.id, (v_step->>'step')::int, m.id
      FROM memberships m JOIN roles ro ON ro.id = m."roleId"
      WHERE m."householdId" = r."householdId" AND m.status = 'ACTIVE' AND m.id <> r."requesterId"
        AND (m.id::text = v_step->>'membershipId' OR ro."systemRole"::text = v_step->>'approverRole');
      GET DIAGNOSTICS v_n = ROW_COUNT;
    END LOOP;
  END IF;

  IF v_pol.id IS NULL OR NOT EXISTS (SELECT 1 FROM approvals WHERE "requestId" = r.id) THEN
    INSERT INTO approvals (id, "householdId", "requestId", step, "approverId")
    SELECT gen_random_uuid(), r."householdId", r.id, 1, m.id
    FROM memberships m JOIN roles ro ON ro.id = m."roleId"
    WHERE m."householdId" = r."householdId" AND m.status = 'ACTIVE' AND m.id <> r."requesterId"
      AND ro."systemRole" IN ('HOUSEHOLD_HEAD', 'EFA_OFFICE_ADMIN');
  END IF;

  UPDATE requests SET status = 'IN_REVIEW', "currentStep" = (SELECT min(step) FROM approvals WHERE "requestId" = r.id)
  WHERE id = r.id;
END $$;
CREATE TRIGGER requests_route AFTER INSERT ON requests
  FOR EACH ROW EXECUTE FUNCTION app.route_request();

-- ============================================= MODULE 5: GOVERNANCE & POLICY ==
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policies','codes_of_ethics','privacy_agreements']
  LOOP
    -- Everyone in the household reads PUBLISHED documents (staff must be able to
    -- read what they sign); drafts only for governance managers.
    EXECUTE format($p$CREATE POLICY gov_read ON %I AS RESTRICTIVE FOR SELECT TO app_user
      USING (status = 'PUBLISHED' OR (SELECT app.perm_scope('governance.manage')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY gov_ins ON %I AS RESTRICTIVE FOR INSERT TO app_user
      WITH CHECK ((SELECT app.perm_scope('governance.manage')) = 'ALL')$p$, t);
    -- Published text is frozen; changes = new version row.
    EXECUTE format($p$CREATE POLICY gov_upd ON %I AS RESTRICTIVE FOR UPDATE TO app_user
      USING ((SELECT app.perm_scope('governance.manage')) = 'ALL' AND status <> 'ARCHIVED')$p$, t);
    EXECUTE format($p$CREATE POLICY gov_del ON %I AS RESTRICTIVE FOR DELETE TO app_user
      USING ((SELECT app.is_household_admin()) AND status = 'DRAFT')$p$, t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.freeze_published_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' AND (NEW."bodyI18n", NEW."titleI18n", NEW.version)
        IS DISTINCT FROM (OLD."bodyI18n", OLD."titleI18n", OLD.version) THEN
    RAISE EXCEPTION 'published documents are immutable; publish a new version'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'PUBLISHED' AND OLD.status <> 'PUBLISHED' THEN
    NEW."publishedAt" := now();
    NEW."contentHash" := encode(digest(NEW."bodyI18n"::text, 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policies_freeze           BEFORE UPDATE ON policies           FOR EACH ROW EXECUTE FUNCTION app.freeze_published_document();
CREATE TRIGGER codes_of_ethics_freeze    BEFORE UPDATE ON codes_of_ethics    FOR EACH ROW EXECUTE FUNCTION app.freeze_published_document();
CREATE TRIGGER privacy_agreements_freeze BEFORE UPDATE ON privacy_agreements FOR EACH ROW EXECUTE FUNCTION app.freeze_published_document();

-- Acknowledgments: signer-only insert, evidence never deleted, and the only
-- column a signer can ever change is the withdrawal (column-level GRANT).
CREATE POLICY ack_read ON policy_acknowledgments AS RESTRICTIVE FOR SELECT TO app_user
  USING ("membershipId" = app.current_membership_id()
         OR (SELECT app.perm_scope('governance.acknowledgments.read')) = 'ALL');
CREATE POLICY ack_ins ON policy_acknowledgments AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ("membershipId" = app.current_membership_id());
CREATE POLICY ack_withdraw ON policy_acknowledgments AS RESTRICTIVE FOR UPDATE TO app_user
  USING ("membershipId" = app.current_membership_id() AND "privacyAgreementId" IS NOT NULL
         AND "withdrawnAt" IS NULL)
  WITH CHECK ("membershipId" = app.current_membership_id() AND "privacyAgreementId" IS NOT NULL);
CREATE POLICY ack_no_delete ON policy_acknowledgments AS RESTRICTIVE FOR DELETE TO app_user USING (false);
REVOKE UPDATE ON policy_acknowledgments FROM app_user;
GRANT UPDATE ("withdrawnAt", "withdrawalReason") ON policy_acknowledgments TO app_user;

-- Version + hash on an acknowledgment must match the published document.
CREATE OR REPLACE FUNCTION app.check_acknowledgment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status "DocumentStatus"; v_version int; v_withdrawable boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."withdrawnAt" IS NOT NULL AND
       NOT COALESCE((SELECT withdrawable FROM privacy_agreements WHERE id = NEW."privacyAgreementId"), false) THEN
      RAISE EXCEPTION 'this agreement rests on a non-consent lawful basis and cannot be withdrawn'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status, version INTO v_status, v_version FROM (
    SELECT status, version FROM policies           WHERE id = NEW."policyId"
    UNION ALL SELECT status, version FROM codes_of_ethics    WHERE id = NEW."codeOfEthicsId"
    UNION ALL SELECT status, version FROM privacy_agreements WHERE id = NEW."privacyAgreementId") d;
  IF v_status IS DISTINCT FROM 'PUBLISHED' OR v_version <> NEW."documentVersion" THEN
    RAISE EXCEPTION 'can only acknowledge the current published version' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.method = 'VERBAL_WITNESSED' AND (NEW."witnessId" IS NULL OR NEW."witnessId" = NEW."membershipId") THEN
    RAISE EXCEPTION 'verbal acknowledgment needs an independent witness' USING ERRCODE = 'check_violation';
  END IF;
  NEW."acknowledgedAt" := now(); NEW."ackDate" := CURRENT_DATE; -- client cannot backdate
  RETURN NEW;
END $$;
CREATE TRIGGER acknowledgments_check BEFORE INSERT OR UPDATE ON policy_acknowledgments
  FOR EACH ROW EXECUTE FUNCTION app.check_acknowledgment();

-- ======================================================== MODULE 6: PETTY CASH ==
CREATE POLICY pca_read ON petty_cash_accounts AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('finance.pettycash.read')), ARRAY["custodianId"]));
CREATE POLICY pca_ins ON petty_cash_accounts AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.pettycash.manage')) = 'ALL');
CREATE POLICY pca_upd ON petty_cash_accounts AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.pettycash.manage')) = 'ALL');
CREATE POLICY pca_del ON petty_cash_accounts AS RESTRICTIVE FOR DELETE TO app_user USING (false);
REVOKE UPDATE ON petty_cash_accounts FROM app_user;   -- balance is trigger-owned
GRANT UPDATE ("nameI18n", "floatLimit", "lowBalanceAlert", "receiptRequiredOver", "allowNegative",
              "isActive", "lastReconciledAt", "custodianId", "updatedAt") ON petty_cash_accounts TO app_user;

CREATE OR REPLACE FUNCTION app.petty_cash_custodian(p_account uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ARRAY["custodianId"] FROM petty_cash_accounts WHERE id = p_account
$$;

CREATE POLICY pcl_read ON petty_cash_logs AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('finance.pettycash.read')), app.petty_cash_custodian("accountId")));
-- Custodians log EXPENSE / RETURN on their own float; TOP_UP and ADJUSTMENT need manage.
CREATE POLICY pcl_ins ON petty_cash_logs AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ("recordedById" = app.current_membership_id() AND (
                (SELECT app.perm_scope('finance.pettycash.manage')) = 'ALL'
             OR (type IN ('EXPENSE', 'RETURN')
                 AND app.can_access((SELECT app.perm_scope('finance.pettycash.log')),
                                    app.petty_cash_custodian("accountId")))));
CREATE POLICY pcl_review ON petty_cash_logs AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.pettycash.manage')) = 'ALL');
CREATE POLICY pcl_no_delete ON petty_cash_logs AS RESTRICTIVE FOR DELETE TO app_user USING (false);
REVOKE UPDATE ON petty_cash_logs FROM app_user;
GRANT UPDATE (status, "reviewedById", "reviewedAt", "categoryId", "transactionId") ON petty_cash_logs TO app_user;

CREATE OR REPLACE FUNCTION app.apply_petty_cash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_acc petty_cash_accounts; v_delta numeric;
BEGIN
  SELECT * INTO v_acc FROM petty_cash_accounts WHERE id = NEW."accountId" FOR UPDATE;
  IF NOT v_acc."isActive" THEN
    RAISE EXCEPTION 'petty cash account is inactive' USING ERRCODE = 'check_violation';
  END IF;
  IF v_acc."householdId" <> NEW."householdId" THEN
    RAISE EXCEPTION 'account belongs to another household' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_delta := CASE NEW.type WHEN 'TOP_UP' THEN NEW.amount WHEN 'ADJUSTMENT' THEN NEW.amount ELSE -NEW.amount END;
  IF v_acc."currentBalance" + v_delta < 0 AND NOT v_acc."allowNegative" THEN
    RAISE EXCEPTION 'insufficient petty cash: balance %, requested %', v_acc."currentBalance", NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.type = 'TOP_UP' AND v_acc."currentBalance" + v_delta > v_acc."floatLimit" THEN
    RAISE EXCEPTION 'top-up exceeds float limit %', v_acc."floatLimit" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.type = 'EXPENSE' THEN
    -- Custodian-recorded expenses wait for review; over the threshold they need a receipt.
    IF NEW.amount > v_acc."receiptRequiredOver" AND NEW."receiptId" IS NULL THEN
      RAISE EXCEPTION 'receipt required for expenses over %', v_acc."receiptRequiredOver"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recordedById" = v_acc."custodianId" THEN NEW.status := 'PENDING_REVIEW'; END IF;
  END IF;
  NEW."balanceAfter" := v_acc."currentBalance" + v_delta;
  UPDATE petty_cash_accounts SET "currentBalance" = NEW."balanceAfter", "updatedAt" = now() WHERE id = v_acc.id;
  RETURN NEW;
END $$;
-- BEFORE triggers run ahead of RLS WITH CHECK, so authorise in a SECURITY
-- INVOKER trigger that fires first (triggers fire in name order). Otherwise the
-- balance-quoting errors of apply_petty_cash would leak another float's balance.
CREATE OR REPLACE FUNCTION app.authorize_petty_cash() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.caller_is_restricted()
     AND NOT COALESCE((app.petty_cash_custodian(NEW."accountId"))[1] = app.current_membership_id()
                      OR app.perm_scope('finance.pettycash.manage') = 'ALL', false) THEN
    RAISE EXCEPTION 'not allowed to post to this petty cash account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER petty_cash_0_authorize BEFORE INSERT ON petty_cash_logs
  FOR EACH ROW EXECUTE FUNCTION app.authorize_petty_cash();
CREATE TRIGGER petty_cash_1_apply BEFORE INSERT ON petty_cash_logs
  FOR EACH ROW EXECUTE FUNCTION app.apply_petty_cash();

-- ======================================================= MODULE 7: WORK ORDERS ==
CREATE OR REPLACE FUNCTION app.work_order_parties(p_wo uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ARRAY["requesterId", "assigneeId"] FROM work_orders WHERE id = p_wo
$$;

CREATE POLICY wo_read ON work_orders AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('workorders.read')), ARRAY["requesterId", "assigneeId"]));
CREATE POLICY wo_ins ON work_orders AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ("requesterId" = app.current_membership_id()
              AND (SELECT app.perm_scope('workorders.create')) IS NOT NULL);
CREATE POLICY wo_upd ON work_orders AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('workorders.manage')) = 'ALL'
         OR "assigneeId" = app.current_membership_id() OR "requesterId" = app.current_membership_id());
CREATE POLICY wo_del ON work_orders AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('workorders.manage')) = 'ALL');

CREATE POLICY woi_read ON work_order_instructions AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('workorders.read')), app.work_order_parties("workOrderId")));
CREATE POLICY woi_ins ON work_order_instructions AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('workorders.manage')) = 'ALL'
              OR (app.work_order_parties("workOrderId"))[1] = app.current_membership_id()); -- requester
CREATE POLICY woi_upd ON work_order_instructions AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('workorders.manage')) = 'ALL'
         OR app.current_membership_id() = ANY (app.work_order_parties("workOrderId")));
CREATE POLICY woi_del ON work_order_instructions AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('workorders.manage')) = 'ALL'
         OR (app.work_order_parties("workOrderId"))[1] = app.current_membership_id());

-- Sequence number per household + workflow rules.
CREATE OR REPLACE FUNCTION app.work_order_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtext('wo:' || NEW."householdId"::text));
    SELECT COALESCE(max(number), 0) + 1 INTO NEW.number FROM work_orders WHERE "householdId" = NEW."householdId";
    IF NEW."assigneeId" IS NOT NULL AND NEW.status = 'NEW' THEN NEW.status := 'ASSIGNED'; END IF;
  END IF;
  -- A safety-critical instruction must have a human-reviewed translation
  -- before the order is dispatched to someone who reads another language.
  IF NEW.status NOT IN ('NEW', 'CANCELLED') AND EXISTS (
       SELECT 1 FROM work_order_instructions i
       WHERE i."workOrderId" = NEW.id AND i."isSafetyCritical"
         AND i."translationStatus" NOT IN ('HUMAN_REVIEWED', 'ORIGINAL_ONLY')) THEN
    RAISE EXCEPTION 'safety-critical instruction needs a human-reviewed translation before dispatch'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'IN_PROGRESS' AND OLD."startedAt" IS NULL THEN NEW."startedAt" := now(); END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'COMPLETED' AND OLD.status <> 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM work_order_instructions i WHERE i."workOrderId" = NEW.id AND i."completedAt" IS NULL) THEN
      RAISE EXCEPTION 'complete every instruction before completing the work order' USING ERRCODE = 'check_violation';
    END IF;
    NEW."completedAt" := now();
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'VERIFIED' AND OLD.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'only a COMPLETED work order can be verified' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'VERIFIED' AND OLD.status <> 'VERIFIED' THEN
    NEW."verifiedAt" := now(); NEW."verifiedById" := app.current_membership_id();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_orders_1_rules BEFORE INSERT OR UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION app.work_order_rules();

-- Only the requester (or a manager) can mark VERIFIED; assignees stop at COMPLETED.
CREATE OR REPLACE FUNCTION app.authorize_work_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_me uuid := app.current_membership_id();
BEGIN
  -- Assignee (not requester, not manager): progress, hold, complete, actual cost. Nothing else.
  IF app.caller_is_restricted() AND OLD."assigneeId" = v_me AND OLD."requesterId" IS DISTINCT FROM v_me
     AND NOT COALESCE(app.perm_scope('workorders.manage') = 'ALL', false) THEN
    IF (NEW."titleI18n", NEW."descriptionI18n", NEW.category, NEW.priority, NEW."requesterId", NEW."assigneeId",
        NEW."assigneeStaffType", NEW."dueAt", NEW."scheduledAt", NEW."estimatedCost", NEW.rating, NEW."vendorName",
        NEW."propertyId", NEW."unitId", NEW."vehicleId", NEW."tripId", NEW."requiresPhotoProof")
       IS DISTINCT FROM
       (OLD."titleI18n", OLD."descriptionI18n", OLD.category, OLD.priority, OLD."requesterId", OLD."assigneeId",
        OLD."assigneeStaffType", OLD."dueAt", OLD."scheduledAt", OLD."estimatedCost", OLD.rating, OLD."vendorName",
        OLD."propertyId", OLD."unitId", OLD."vehicleId", OLD."tripId", OLD."requiresPhotoProof") THEN
      RAISE EXCEPTION 'assignees can only update progress and actual cost' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('IN_PROGRESS', 'ON_HOLD', 'COMPLETED') THEN
      RAISE EXCEPTION 'assignees can move a work order to IN_PROGRESS, ON_HOLD or COMPLETED only' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF app.caller_is_restricted() AND NEW.status = 'VERIFIED' AND OLD.status <> 'VERIFIED'
     AND NOT COALESCE(OLD."requesterId" = app.current_membership_id()
                      OR app.perm_scope('workorders.manage') = 'ALL', false) THEN
    RAISE EXCEPTION 'only the requester can verify a work order' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_orders_0_authorize BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION app.authorize_work_order();

CREATE OR REPLACE FUNCTION app.instruction_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."isSafetyCritical" AND NEW."translationStatus" NOT IN ('HUMAN_REVIEWED', 'ORIGINAL_ONLY')
     AND (SELECT status FROM work_orders WHERE id = NEW."workOrderId") NOT IN ('NEW', 'CANCELLED') THEN
    RAISE EXCEPTION 'safety-critical instruction needs a human-reviewed translation before dispatch'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."completedAt" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."completedAt" IS NULL) THEN
    NEW."completedById" := app.current_membership_id();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_order_instructions_rules BEFORE INSERT OR UPDATE ON work_order_instructions
  FOR EACH ROW EXECUTE FUNCTION app.instruction_rules();

-- Assignees tick instructions off (with photo when required); they never edit the text.
CREATE OR REPLACE FUNCTION app.authorize_instruction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_parties uuid[];
BEGIN
  IF NEW."completedAt" IS NOT NULL AND NEW."requiresPhoto" AND NEW."photoStorageKey" IS NULL THEN
    RAISE EXCEPTION 'this instruction needs a photo to be completed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT app.caller_is_restricted() OR COALESCE(app.perm_scope('workorders.manage') = 'ALL', false) THEN RETURN NEW; END IF;
  v_parties := app.work_order_parties(NEW."workOrderId");   -- [requester, assignee]
  IF TG_OP = 'UPDATE' AND v_parties[1] IS DISTINCT FROM app.current_membership_id()
     AND (NEW."textI18n", NEW."originalLocale", NEW."translationStatus", NEW."translationMeta", NEW."isSafetyCritical",
          NEW."requiresPhoto", NEW.sequence)
         IS DISTINCT FROM
         (OLD."textI18n", OLD."originalLocale", OLD."translationStatus", OLD."translationMeta", OLD."isSafetyCritical",
          OLD."requiresPhoto", OLD.sequence) THEN
    RAISE EXCEPTION 'assignees can only complete instructions, not edit them' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_order_instructions_0_authorize BEFORE INSERT OR UPDATE ON work_order_instructions
  FOR EACH ROW EXECUTE FUNCTION app.authorize_instruction();

-- ============================================================ MODULE 8: TRAVEL ==
-- Passengers (including a travelling nanny) see the trip they are on and
-- its bookings; nothing else.
CREATE OR REPLACE FUNCTION app.trip_parties(p_trip uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ARRAY[t."organizerId"]
         || COALESCE((SELECT array_agg(COALESCE(p."membershipId", s."membershipId"))
                      FROM trip_passengers p LEFT JOIN staff_profiles s ON s.id = p."staffId"
                      WHERE p."tripId" = t.id), '{}')
  FROM trips t WHERE t.id = p_trip
$$;

CREATE POLICY trip_read ON trips AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('travel.read')), app.trip_parties(id)));
CREATE POLICY trip_ins ON trips AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('travel.manage')) = 'ALL' AND "organizerId" = app.current_membership_id());
CREATE POLICY trip_upd ON trips AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('travel.manage')) = 'ALL');
CREATE POLICY trip_del ON trips AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('travel.manage')) = 'ALL' AND status IN ('PLANNING', 'CANCELLED'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_passengers','trip_bookings']
  LOOP
    EXECUTE format($p$CREATE POLICY travel_read ON %I AS RESTRICTIVE FOR SELECT TO app_user
      USING (app.can_access((SELECT app.perm_scope('travel.read')), app.trip_parties("tripId")))$p$, t);
    EXECUTE format($p$CREATE POLICY travel_ins ON %I AS RESTRICTIVE FOR INSERT TO app_user
      WITH CHECK ((SELECT app.perm_scope('travel.manage')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY travel_upd ON %I AS RESTRICTIVE FOR UPDATE TO app_user
      USING ((SELECT app.perm_scope('travel.manage')) = 'ALL')$p$, t);
    EXECUTE format($p$CREATE POLICY travel_del ON %I AS RESTRICTIVE FOR DELETE TO app_user
      USING ((SELECT app.perm_scope('travel.manage')) = 'ALL')$p$, t);
  END LOOP;
END $$;

-- ---- Non-tenant tables: restrictive twins of their self-scoped policies ----
CREATE POLICY households_upd_r ON households AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('admin.household.manage')) = 'ALL');
CREATE POLICY users_self_r ON users AS RESTRICTIVE FOR UPDATE TO app_user
  USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());
CREATE POLICY devices_self_r ON user_devices AS RESTRICTIVE FOR ALL TO app_user
  USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());

-- ===================================================== ENCRYPTION: TENANT KEYS ==
-- The API (app_user) may read its own tenant's *wrapped* keys to unwrap them
-- through KMS; only the key-management worker (app_service) writes them.
CREATE POLICY tk_read_only ON tenant_keys AS RESTRICTIVE FOR SELECT TO app_user
  USING (status <> 'DESTROYED');
REVOKE INSERT, UPDATE, DELETE ON tenant_keys FROM app_user;

-- Household picker for GET /v1/me: the caller's ACTIVE, unexpired memberships
-- across households. Memberships are tenant-isolated, so this is the one
-- cross-tenant read, and it returns only the caller's own rows.
CREATE OR REPLACE FUNCTION app.my_households()
RETURNS TABLE (household_id uuid, household_name jsonb, membership_id uuid, system_role text, role_name jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT h.id, h."nameI18n", m.id, r."systemRole"::text, r."nameI18n"
  FROM memberships m JOIN households h ON h.id = m."householdId" JOIN roles r ON r.id = m."roleId"
  WHERE m."userId" = app.current_user_id() AND m.status = 'ACTIVE'
    AND (m."expiresAt" IS NULL OR m."expiresAt" > now()) AND h."deletedAt" IS NULL
  ORDER BY m."createdAt"
$$;
GRANT EXECUTE ON FUNCTION app.my_households() TO app_user;

-- ================================================ STAFF HR: SALARY PAYMENTS ==
-- Domestic-worker pay log (Musaned / bank / cash / wallet; no WPS rules).
-- Managers record and reverse; ONLY the worker acknowledges or disputes,
-- because that acknowledgment is the evidence in a labour dispute.
CREATE POLICY salpay_read ON salary_payments AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.payroll.read')), app.staff_member("staffId")));
CREATE POLICY salpay_ins ON salary_payments AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('staff.payroll.manage')) = 'ALL' AND "recordedById" = app.current_membership_id());
CREATE POLICY salpay_upd ON salary_payments AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('staff.payroll.manage')) = 'ALL'
         OR app.current_membership_id() = ANY (app.staff_member("staffId")));
CREATE POLICY salpay_no_delete ON salary_payments AS RESTRICTIVE FOR DELETE TO app_user USING (false);
REVOKE UPDATE ON salary_payments FROM app_user;
GRANT UPDATE (status, "acknowledgedAt", "ackMethod", "disputeReason", "reversedAt", "reversalReason", "transactionId")
  ON salary_payments TO app_user;

CREATE OR REPLACE FUNCTION app.salary_payment_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_worker boolean; v_manager boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- (staffId tenancy is enforced by the generic a_tenant_ref trigger.)
    NEW.status := 'RECORDED'; NEW."acknowledgedAt" := NULL; NEW."ackMethod" := NULL;
    NEW."reversedAt" := NULL; NEW."disputeReason" := NULL;
    IF NEW."paidAt" > now() + interval '1 day' THEN
      RAISE EXCEPTION 'paidAt cannot be in the future' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT app.caller_is_restricted() THEN RETURN NEW; END IF;   -- workers / migrations
  v_worker  := COALESCE(app.current_membership_id() = ANY (app.staff_member(OLD."staffId")), false);
  v_manager := COALESCE(app.perm_scope('staff.payroll.manage') = 'ALL', false);

  IF OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'a reversed payment is final; record a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."transactionId" IS DISTINCT FROM OLD."transactionId" AND NOT v_manager THEN
    RAISE EXCEPTION 'only payroll managers can link ledger entries' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    CASE NEW.status
      WHEN 'ACKNOWLEDGED', 'DISPUTED' THEN
        IF NOT v_worker THEN
          RAISE EXCEPTION 'only the worker can acknowledge or dispute their own salary' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.status = 'DISPUTED' AND length(trim(coalesce(NEW."disputeReason", ''))) = 0 THEN
          RAISE EXCEPTION 'a dispute needs a reason' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status = 'ACKNOWLEDGED' THEN
          NEW."acknowledgedAt" := now(); NEW."ackMethod" := COALESCE(NEW."ackMethod", 'TAP_TO_ACCEPT');
        END IF;
      WHEN 'REVERSED' THEN
        IF NOT v_manager THEN
          RAISE EXCEPTION 'only payroll managers can reverse a payment' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF length(trim(coalesce(NEW."reversalReason", ''))) = 0 THEN
          RAISE EXCEPTION 'a reversal needs a reason' USING ERRCODE = 'check_violation';
        END IF;
        NEW."reversedAt" := now();
      ELSE
        RAISE EXCEPTION 'invalid status transition % → %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END CASE;
  ELSIF (NEW."acknowledgedAt", NEW."ackMethod", NEW."disputeReason", NEW."reversedAt", NEW."reversalReason")
        IS DISTINCT FROM (OLD."acknowledgedAt", OLD."ackMethod", OLD."disputeReason", OLD."reversedAt", OLD."reversalReason") THEN
    RAISE EXCEPTION 'acknowledgment fields change only with a status transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER salary_payments_rules BEFORE INSERT OR UPDATE ON salary_payments
  FOR EACH ROW EXECUTE FUNCTION app.salary_payment_rules();

-- ======================================== STAFF HR: DOCUMENT EXPIRY ALERTS ==
-- Tier of a document for dashboards: EXPIRED, or the smallest alert tier
-- (default 60/30/15 days) that the remaining days fall within.
CREATE OR REPLACE FUNCTION app.document_alert_tier(p_days_left int, p_tiers int[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_days_left < 0 THEN 'EXPIRED'
              ELSE (SELECT min(t)::text FROM unnest(p_tiers) t WHERE p_days_left <= t) END
$$;

-- Idempotent reminder sweep, run daily by the scheduler (app_service).
-- For every document with an expiry date it keeps exactly one PENDING
-- reminder per alert tier at a deterministic time (09:00 household-local on
-- expiry − tier):
--   * tiers still ahead are scheduled;
--   * the tier the document is in now is due immediately (its time is past);
--   * tiers already overtaken are skipped (no 60-day alert at 10 days);
--   * expired documents get one EXPIRED reminder.
-- When a document is renewed (expiry changes), pending reminders for the old
-- date are deleted and the new date's tiers are scheduled.
-- Recipient NULL = household admins (Head / EFA).
CREATE OR REPLACE FUNCTION app.sync_document_reminders(p_household uuid DEFAULT NULL)
RETURNS TABLE (inserted int, removed int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ins int; v_del int;
BEGIN
  WITH docs AS (
    SELECT d.id, d."householdId",
           ((d."expiryDate" + time '09:00') AT TIME ZONE h.timezone) AS due_at
    FROM identity_documents d
    JOIN staff_profiles s ON s.id = d."staffId"
    JOIN households h ON h.id = d."householdId"
    WHERE d."expiryDate" IS NOT NULL AND s."deletedAt" IS NULL AND h."deletedAt" IS NULL
      AND s.status NOT IN ('TERMINATED', 'FINAL_EXIT')
      AND (p_household IS NULL OR d."householdId" = p_household))
  DELETE FROM reminders r
  WHERE r."entityType" = 'STAFF_DOCUMENT' AND r.status = 'PENDING'
    AND (p_household IS NULL OR r."householdId" = p_household)
    AND NOT EXISTS (SELECT 1 FROM docs WHERE docs.id = r."entityId" AND docs.due_at = r."dueAt");
  GET DIAGNOSTICS v_del = ROW_COUNT;

  WITH docs AS (
    SELECT d.id, d."householdId", d.type, d."alertDays", s."fullNameI18n" AS name,
           ((d."expiryDate" + time '09:00') AT TIME ZONE h.timezone) AS due_at,
           d."expiryDate", h.timezone,
           (d."expiryDate" - (now() AT TIME ZONE h.timezone)::date) AS days_left
    FROM identity_documents d
    JOIN staff_profiles s ON s.id = d."staffId"
    JOIN households h ON h.id = d."householdId"
    WHERE d."expiryDate" IS NOT NULL AND s."deletedAt" IS NULL AND h."deletedAt" IS NULL
      AND s.status NOT IN ('TERMINATED', 'FINAL_EXIT')
      AND (p_household IS NULL OR d."householdId" = p_household)),
  wanted AS (
    SELECT docs.*, t AS tier FROM docs, unnest(docs."alertDays") t
    WHERE docs.days_left >= 0
      AND (docs.days_left > t OR t = (SELECT min(x) FROM unnest(docs."alertDays") x WHERE docs.days_left <= x))
    UNION ALL
    SELECT docs.*, 0 FROM docs WHERE docs.days_left < 0),
  labels AS (
    SELECT w.*,
      CASE w.type WHEN 'IQAMA' THEN 'الإقامة' WHEN 'PASSPORT' THEN 'جواز السفر' WHEN 'VISA' THEN 'التأشيرة'
                  WHEN 'EXIT_REENTRY_VISA' THEN 'تأشيرة الخروج والعودة' WHEN 'DRIVING_LICENSE' THEN 'رخصة القيادة'
                  WHEN 'MEDICAL_INSURANCE' THEN 'التأمين الطبي' WHEN 'WORK_PERMIT' THEN 'رخصة العمل' ELSE 'الوثيقة' END AS type_ar,
      initcap(replace(lower(w.type::text), '_', ' ')) AS type_en,
      COALESCE(w.name->>'ar', w.name->>'en', w.name->>(SELECT k FROM jsonb_object_keys(w.name) k LIMIT 1), '') AS name_ar,
      COALESCE(w.name->>'en', w.name->>(SELECT k FROM jsonb_object_keys(w.name) k LIMIT 1), '') AS name_en
    FROM wanted w)
  INSERT INTO reminders (id, "householdId", "recipientId", "entityType", "entityId", "titleI18n", "dueAt", "remindAt", status, channels)
  SELECT gen_random_uuid(), l."householdId", NULL, 'STAFF_DOCUMENT', l.id,
         CASE WHEN l.tier = 0
           THEN jsonb_build_object('ar', format('انتهت صلاحية %s للعامل %s', l.type_ar, l.name_ar),
                                   'en', format('%s of %s has expired', l.type_en, l.name_en))
           ELSE jsonb_build_object('ar', format('تنتهي %s للعامل %s خلال %s يوماً', l.type_ar, l.name_ar, l.tier),
                                   'en', format('%s of %s expires within %s days', l.type_en, l.name_en, l.tier)) END
           || jsonb_build_object('tier', l.tier),
         l.due_at,
         ((l."expiryDate" - l.tier + time '09:00') AT TIME ZONE l.timezone),
         'PENDING',
         CASE WHEN l.tier <= 15 THEN ARRAY['IN_APP','PUSH','WHATSAPP']::"NotificationChannel"[]
              ELSE ARRAY['IN_APP','PUSH']::"NotificationChannel"[] END
  FROM labels l
  ON CONFLICT ("householdId", "entityType", "entityId", "dueAt", "remindAt") DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  RETURN QUERY SELECT v_ins, v_del;
END $$;
REVOKE ALL ON FUNCTION app.sync_document_reminders(uuid) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION app.sync_document_reminders(uuid) TO app_service;

-- ======================================================= REQUEST WORKFLOW ==
-- v1.1 hole: the requests UPDATE policy let a requester change ANY column of
-- their own request, including status → APPROVED. Now: interactive users may
-- only edit a DRAFT, submit it, or cancel it. Every other status change comes
-- from the approval engine below (SECURITY DEFINER, so not "restricted").
CREATE OR REPLACE FUNCTION app.guard_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_requester boolean;
BEGIN
  IF NOT app.caller_is_restricted() THEN RETURN NEW; END IF;
  v_requester := OLD."requesterId" = app.current_membership_id();
  IF (NEW."householdId", NEW."requesterId", NEW.type) IS DISTINCT FROM (OLD."householdId", OLD."requesterId", OLD.type) THEN
    RAISE EXCEPTION 'request owner and type cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.payload, NEW.amount, NEW.currency, NEW."titleI18n", NEW."neededBy")
       IS DISTINCT FROM (OLD.payload, OLD.amount, OLD.currency, OLD."titleI18n", OLD."neededBy") THEN
    RAISE EXCEPTION 'a submitted request cannot be edited; cancel and resubmit' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currentStep" IS DISTINCT FROM OLD."currentStep" OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt" THEN
    RAISE EXCEPTION 'workflow fields are managed by the approval engine' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'CANCELLED' AND v_requester AND OLD.status IN ('DRAFT', 'SUBMITTED', 'IN_REVIEW') THEN
      NEW."resolvedAt" := now();
    ELSIF NEW.status = 'SUBMITTED' AND v_requester AND OLD.status = 'DRAFT' THEN
      NULL; -- routed by requests_route_on_submit
    ELSIF NEW.status = 'FULFILLED' AND OLD.status = 'APPROVED' AND COALESCE(app.perm_scope('requests.approve') = 'ALL', false) THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'status % → % is not allowed for you', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requests_0_guard BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION app.guard_request();

-- DRAFT → SUBMITTED routes like a fresh submission.
CREATE OR REPLACE FUNCTION app.route_request_on_submit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED' THEN
    PERFORM app.route_request_rows(NEW.id);
  END IF;
  RETURN NULL;
END $$;

-- Approvers: decide once, at the current step, only decision/comment.
REVOKE UPDATE ON approvals FROM app_user;
GRANT UPDATE (decision, comment) ON approvals TO app_user;

CREATE OR REPLACE FUNCTION app.guard_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_req requests;
BEGIN
  SELECT * INTO v_req FROM requests WHERE id = NEW."requestId";
  IF OLD.decision <> 'PENDING' THEN
    RAISE EXCEPTION 'this approval was already decided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decision NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'decision must be APPROVED or REJECTED' USING ERRCODE = 'check_violation';
  END IF;
  IF v_req.status <> 'IN_REVIEW' OR NEW.step <> v_req."currentStep" THEN
    RAISE EXCEPTION 'request is not awaiting step % (status %, step %)', NEW.step, v_req.status, v_req."currentStep"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decision = 'REJECTED' AND length(trim(coalesce(NEW.comment, ''))) = 0 THEN
    RAISE EXCEPTION 'a rejection needs a comment' USING ERRCODE = 'check_violation';
  END IF;
  NEW."decidedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_0_guard BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION app.guard_approval();

-- Fulfilment of approved requests that create HR records.
CREATE OR REPLACE FUNCTION app.fulfil_request(p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r requests; v_staff uuid; v_start date; v_end date; v_n int;
BEGIN
  SELECT * INTO r FROM requests WHERE id = p_request;
  v_staff := COALESCE((r.payload->>'staffId')::uuid,
                      (SELECT id FROM staff_profiles WHERE "membershipId" = r."requesterId" AND "householdId" = r."householdId"));
  IF r.type = 'LEAVE' THEN
    IF v_staff IS NULL THEN RETURN; END IF;
    v_start := (r.payload->>'startDate')::date; v_end := (r.payload->>'endDate')::date;
    INSERT INTO leave_records (id, "householdId", "staffId", "requestId", type, "startDate", "endDate", days, paid)
    VALUES (gen_random_uuid(), r."householdId", v_staff, r.id, (r.payload->>'leaveType')::"LeaveType", v_start, v_end,
            v_end - v_start + 1, (r.payload->>'leaveType') <> 'UNPAID');
    UPDATE staff_profiles SET status = 'ON_LEAVE'
      WHERE id = v_staff AND status = 'ACTIVE' AND v_start <= CURRENT_DATE AND v_end >= CURRENT_DATE;
  ELSIF r.type = 'SALARY_ADVANCE' THEN
    IF v_staff IS NULL OR r.amount IS NULL THEN RETURN; END IF;
    v_n := GREATEST(1, LEAST(12, COALESCE((r.payload->>'installments')::int, 1)));
    INSERT INTO salary_advances (id, "householdId", "staffId", "requestId", amount, outstanding, "monthlyInstallment", currency, "issuedAt")
    VALUES (gen_random_uuid(), r."householdId", v_staff, r.id, r.amount, r.amount, round(r.amount / v_n, 2),
            COALESCE(r.currency, 'SAR'), CURRENT_DATE);
  ELSE
    RETURN; -- other types are fulfilled by their own module
  END IF;
  UPDATE requests SET status = 'FULFILLED' WHERE id = p_request;
END $$;

CREATE OR REPLACE FUNCTION app.advance_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_next int;
BEGIN
  IF NEW.decision = 'REJECTED' THEN
    UPDATE requests SET status = 'REJECTED', "resolvedAt" = now() WHERE id = NEW."requestId";
  ELSIF NEW.decision = 'APPROVED' THEN
    SELECT min(step) INTO v_next FROM approvals WHERE "requestId" = NEW."requestId" AND step > NEW.step;
    IF v_next IS NOT NULL THEN
      UPDATE requests SET "currentStep" = v_next WHERE id = NEW."requestId";
    ELSE
      UPDATE requests SET status = 'APPROVED', "resolvedAt" = now() WHERE id = NEW."requestId";
      PERFORM app.fulfil_request(NEW."requestId");
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER approvals_advance AFTER UPDATE OF decision ON approvals FOR EACH ROW EXECUTE FUNCTION app.advance_request();
CREATE TRIGGER requests_route_on_submit AFTER UPDATE OF status ON requests FOR EACH ROW EXECUTE FUNCTION app.route_request_on_submit();

-- =============================================================== PAYROLL ==
CREATE OR REPLACE FUNCTION app.guard_payroll_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status "PayrollStatus";
BEGIN
  SELECT status INTO v_status FROM payroll_runs WHERE id = COALESCE(NEW."payrollRunId", OLD."payrollRunId");
  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'payroll run is % — lines can only change while DRAFT', v_status USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER payroll_lines_0_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_line();

CREATE OR REPLACE FUNCTION app.payroll_total() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run uuid := COALESCE(NEW."payrollRunId", OLD."payrollRunId");
BEGIN
  UPDATE payroll_runs SET "totalAmount" = COALESCE((SELECT sum(amount) FROM payroll_lines WHERE "payrollRunId" = v_run), 0)
  WHERE id = v_run;
  RETURN NULL;
END $$;
CREATE TRIGGER payroll_lines_total AFTER INSERT OR UPDATE OR DELETE ON payroll_lines
  FOR EACH ROW EXECUTE FUNCTION app.payroll_total();

CREATE OR REPLACE FUNCTION app.guard_payroll_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status, NEW.status) IN (('DRAFT','APPROVED'), ('APPROVED','DRAFT'), ('APPROVED','PAID'),
                                         ('DRAFT','CANCELLED'), ('APPROVED','CANCELLED'))) THEN
      RAISE EXCEPTION 'payroll run % → % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'APPROVED' THEN NEW."approvedAt" := now(); NEW."approvedById" := app.current_membership_id(); END IF;
    IF NEW.status = 'DRAFT' THEN NEW."approvedAt" := NULL; NEW."approvedById" := NULL; END IF;
    IF NEW.status = 'PAID' THEN NEW."paidAt" := now(); END IF;
  ELSIF OLD.status <> 'DRAFT' AND app.caller_is_restricted()
        AND (NEW."periodYear", NEW."periodMonth", NEW.currency) IS DISTINCT FROM (OLD."periodYear", OLD."periodMonth", OLD.currency) THEN
    RAISE EXCEPTION 'payroll run is %', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_runs_0_guard BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_run();

-- ============================================================ ATTENDANCE ==
-- Staff check in for TODAY (household-local) and check out once; times are
-- server-stamped. Managers (staff.payroll.manage) can correct anything.
DROP POLICY payroll_upd ON attendance;
CREATE OR REPLACE FUNCTION app.household_today(p_household uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (now() AT TIME ZONE timezone)::date FROM households WHERE id = p_household
$$;
CREATE POLICY attendance_upd ON attendance AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('staff.payroll.manage')) = 'ALL'
         OR (app.can_access((SELECT app.perm_scope('staff.attendance.manage')), app.staff_member("staffId"))
             AND date = app.household_today("householdId")));

CREATE OR REPLACE FUNCTION app.guard_attendance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.caller_is_restricted() OR COALESCE(app.perm_scope('staff.payroll.manage') = 'ALL', false) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.date <> app.household_today(NEW."householdId") THEN
      RAISE EXCEPTION 'you can only check in for today' USING ERRCODE = 'check_violation';
    END IF;
    NEW."checkInAt" := now(); NEW."checkOutAt" := NULL; NEW.status := 'PRESENT';
  ELSE
    IF (NEW."staffId", NEW.date, NEW.status, NEW."checkInAt", NEW."checkInGeo") IS DISTINCT FROM
       (OLD."staffId", OLD.date, OLD.status, OLD."checkInAt", OLD."checkInGeo") THEN
      RAISE EXCEPTION 'only a manager can correct attendance' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."checkOutAt" IS NOT NULL THEN
      RAISE EXCEPTION 'already checked out' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."checkOutAt" IS NOT NULL THEN NEW."checkOutAt" := now(); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_0_guard BEFORE INSERT OR UPDATE ON attendance FOR EACH ROW EXECUTE FUNCTION app.guard_attendance();

-- Payslips: staff may read their own payroll LINES but not payroll RUNS (a
-- run's total would reveal everyone's pay). This returns only status/period of
-- runs that contain the caller's own lines.
CREATE OR REPLACE FUNCTION app.my_payslip_runs()
RETURNS TABLE (id uuid, period_year int, period_month int, status text, paid_at timestamptz, currency text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT r.id, r."periodYear", r."periodMonth", r.status::text, r."paidAt", r.currency
  FROM payroll_runs r
  JOIN payroll_lines l ON l."payrollRunId" = r.id
  JOIN staff_profiles s ON s.id = l."staffId"
  WHERE s."membershipId" = app.current_membership_id() AND r."householdId" = app.current_household_id()
$$;
GRANT EXECUTE ON FUNCTION app.my_payslip_runs() TO app_user;

-- ================================================================ CHORES ==
CREATE OR REPLACE FUNCTION app.guard_task() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.caller_is_restricted() OR COALESCE(app.perm_scope('staff.tasks.manage') = 'ALL', false)
     OR OLD."createdById" = app.current_membership_id() THEN
    IF NEW.status = 'DONE' AND OLD.status <> 'DONE' THEN NEW."completedAt" := now(); END IF;
    RETURN NEW;
  END IF;
  -- Assignee: progress and proof only.
  IF (NEW."titleI18n", NEW.description, NEW."assigneeId", NEW."dueAt", NEW.recurrence, NEW."createdById")
     IS DISTINCT FROM (OLD."titleI18n", OLD.description, OLD."assigneeId", OLD."dueAt", OLD.recurrence, OLD."createdById") THEN
    RAISE EXCEPTION 'assignees can only update status and photo proof' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'only the creator can cancel a task' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'DONE' AND OLD.status <> 'DONE' THEN NEW."completedAt" := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER household_tasks_0_guard BEFORE UPDATE ON household_tasks FOR EACH ROW EXECUTE FUNCTION app.guard_task();

-- ================================================== DOUBLE-ENTRY LEDGER ==
-- Chart of accounts per household (copied from app.coa_template).
CREATE OR REPLACE FUNCTION app.ensure_chart_of_accounts(p_household uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM app.coa_template ORDER BY code LOOP
    INSERT INTO ledger_accounts (id, "householdId", code, "nameI18n", type, "parentId", "isHeader", "isSystem", "systemKey")
    VALUES (gen_random_uuid(), p_household, t.code, t.name_i18n, t.type::"LedgerAccountType",
            (SELECT id FROM ledger_accounts WHERE "householdId" = p_household AND "systemKey" = t.parent_key),
            t.is_header, true, t.system_key)
    ON CONFLICT ("householdId", code) DO NOTHING;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.ledger_account(p_household uuid, p_key text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM ledger_accounts WHERE "householdId" = p_household AND "systemKey" = p_key;
  IF v IS NULL THEN RAISE EXCEPTION 'ledger account % missing for household', p_key; END IF;
  RETURN v;
END $$;

-- One ledger account per petty-cash float (1101, 1102, … under 1100).
CREATE OR REPLACE FUNCTION app.create_float_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text; v_name text;
BEGIN
  PERFORM app.ensure_chart_of_accounts(NEW."householdId");
  PERFORM pg_advisory_xact_lock(hashtext('coa:' || NEW."householdId"::text));
  SELECT lpad((COALESCE(max(code::int), 1100) + 1)::text, 4, '0') INTO v_code
    FROM ledger_accounts WHERE "householdId" = NEW."householdId" AND code ~ '^11[0-8][0-9]$' AND code <> '1100';
  v_name := COALESCE(NEW."nameI18n"->>'ar', NEW."nameI18n"->>'en', NEW."nameI18n"->>(SELECT k FROM jsonb_object_keys(NEW."nameI18n") k LIMIT 1), '');
  INSERT INTO ledger_accounts (id, "householdId", code, "nameI18n", type, "parentId", "isSystem", "systemKey", currency, "pettyCashAccountId")
  VALUES (gen_random_uuid(), NEW."householdId", v_code,
          jsonb_build_object('ar', 'عهدة نقدية – ' || v_name,
                             'en', 'Petty cash – ' || COALESCE(NEW."nameI18n"->>'en', v_name)),
          'ASSET', app.ledger_account(NEW."householdId", 'petty_cash'), true, 'float:' || NEW.id, NEW.currency, NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER petty_cash_accounts_ledger AFTER INSERT ON petty_cash_accounts FOR EACH ROW EXECUTE FUNCTION app.create_float_account();

-- ---- entry / line invariants ------------------------------------------------
CREATE OR REPLACE FUNCTION app.journal_entry_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_closed date;
BEGIN
  SELECT "booksClosedThrough" INTO v_closed FROM households WHERE id = NEW."householdId";
  IF v_closed IS NOT NULL AND NEW."entryDate" <= v_closed THEN
    RAISE EXCEPTION 'books are closed through %; date the entry after it', v_closed USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('je:' || NEW."householdId"::text));
  SELECT COALESCE(max(number), 0) + 1 INTO NEW.number FROM journal_entries WHERE "householdId" = NEW."householdId";
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_0_rules BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION app.journal_entry_rules();

CREATE OR REPLACE FUNCTION app.journal_line_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_entry journal_entries; v_acc ledger_accounts;
BEGIN
  SELECT * INTO v_entry FROM journal_entries WHERE id = NEW."entryId";
  -- Lines can only be added in the transaction that created the entry: a posted
  -- entry can never be extended later, even with a balanced pair.
  IF v_entry."createdAt" <> now() THEN
    RAISE EXCEPTION 'journal entry % is already posted; post a new entry instead', v_entry.number USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_acc FROM ledger_accounts WHERE id = NEW."ledgerAccountId";
  IF v_acc."isHeader" THEN
    RAISE EXCEPTION 'account % is a header; post to one of its sub-accounts', v_acc.code USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_acc."isActive" THEN
    RAISE EXCEPTION 'account % is inactive', v_acc.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_0_rules BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION app.journal_line_rules();

-- Balanced and at least two lines, checked at COMMIT (deferred), so an entry
-- and its lines can be inserted in any order inside one transaction.
CREATE OR REPLACE FUNCTION app.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := COALESCE((to_jsonb(NEW) ->> 'entryId')::uuid, NEW.id);  -- fires for entries and lines
        v_dr numeric; v_cr numeric; v_n int;
BEGIN
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), count(*) INTO v_dr, v_cr, v_n FROM journal_lines WHERE "entryId" = v_id;
  IF v_n < 2 OR v_dr <> v_cr THEN
    RAISE EXCEPTION 'journal entry does not balance (debits %, credits %, % line(s))', v_dr, v_cr, v_n USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_balanced();

-- System accounts keep their identity.
CREATE OR REPLACE FUNCTION app.guard_ledger_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isSystem" THEN RAISE EXCEPTION 'system accounts cannot be deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."isSystem" AND (NEW.code, NEW.type, NEW."systemKey", NEW."isHeader", NEW."parentId", NEW."pettyCashAccountId")
       IS DISTINCT FROM (OLD.code, OLD.type, OLD."systemKey", OLD."isHeader", OLD."parentId", OLD."pettyCashAccountId") THEN
    RAISE EXCEPTION 'system accounts: only the name and active flag can change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.type IS DISTINCT FROM OLD.type AND EXISTS (SELECT 1 FROM journal_lines WHERE "ledgerAccountId" = OLD.id) THEN
    RAISE EXCEPTION 'account % has postings; its type cannot change', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."isHeader" AND NOT OLD."isHeader" AND EXISTS (SELECT 1 FROM journal_lines WHERE "ledgerAccountId" = OLD.id) THEN
    RAISE EXCEPTION 'account % has postings; it cannot become a header', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_accounts_0_guard BEFORE UPDATE OR DELETE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION app.guard_ledger_account();

-- ---- RLS ----------------------------------------------------------------------
CREATE POLICY coa_read ON ledger_accounts AS RESTRICTIVE FOR SELECT TO app_user
  USING ((SELECT app.perm_scope('finance.ledger.read')) = 'ALL');
CREATE POLICY coa_ins ON ledger_accounts AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.ledger.manage')) = 'ALL' AND NOT "isSystem" AND "systemKey" IS NULL AND "pettyCashAccountId" IS NULL);
CREATE POLICY coa_upd ON ledger_accounts AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.ledger.manage')) = 'ALL');
CREATE POLICY coa_del ON ledger_accounts AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('finance.ledger.manage')) = 'ALL');

CREATE POLICY je_read ON journal_entries AS RESTRICTIVE FOR SELECT TO app_user
  USING ((SELECT app.perm_scope('finance.ledger.read')) = 'ALL');
-- Interactive users post MANUAL / OPENING_BALANCE entries only; hook sources are definer-only.
CREATE POLICY je_ins ON journal_entries AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.ledger.manage')) = 'ALL' AND source IN ('MANUAL', 'OPENING_BALANCE')
              AND "sourceId" IS NULL AND "postedById" = app.current_membership_id() AND status = 'POSTED');
CREATE POLICY jl_read ON journal_lines AS RESTRICTIVE FOR SELECT TO app_user
  USING ((SELECT app.perm_scope('finance.ledger.read')) = 'ALL');
CREATE POLICY jl_ins ON journal_lines AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.ledger.manage')) = 'ALL'
              AND (SELECT source FROM journal_entries e WHERE e.id = "entryId") IN ('MANUAL', 'OPENING_BALANCE'));
-- Posted means immutable: no UPDATE / DELETE for interactive users at all.
REVOKE UPDATE, DELETE ON journal_entries, journal_lines FROM app_user;

-- ---- posting primitive (hooks) ---------------------------------------------------
-- p_lines: [{ "key": "<systemKey>" | "account": "<uuid>", "debit": n, "credit": n, "staffId": uuid?, "memo": text? }]
-- Idempotent per (household, source, source id). A hook dated inside a closed
-- period is moved to the day after the lock (and says so in the description).
CREATE OR REPLACE FUNCTION app.post_journal(p_household uuid, p_source "JournalSource", p_source_id uuid, p_date date,
                                            p_description jsonb, p_lines jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid(); v_closed date; v_date date := p_date; v_desc jsonb := p_description; l jsonb; v_n int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries WHERE "householdId" = p_household AND source = p_source AND "sourceId" = p_source_id) THEN
    RETURN NULL;
  END IF;
  SELECT "booksClosedThrough" INTO v_closed FROM households WHERE id = p_household;
  IF v_closed IS NOT NULL AND v_date <= v_closed THEN
    v_date := v_closed + 1;
    v_desc := v_desc || jsonb_build_object('en', COALESCE(v_desc->>'en', '') || ' (dated after period lock ' || v_closed || ')');
  END IF;
  INSERT INTO journal_entries (id, "householdId", "entryDate", "descriptionI18n", source, "sourceId", "postedById")
  VALUES (v_id, p_household, v_date, v_desc, p_source, p_source_id, NULL);
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF COALESCE((l->>'debit')::numeric, 0) = 0 AND COALESCE((l->>'credit')::numeric, 0) = 0 THEN CONTINUE; END IF;
    INSERT INTO journal_lines (id, "householdId", "entryId", "ledgerAccountId", debit, credit, "staffId", memo)
    VALUES (gen_random_uuid(), p_household, v_id,
            COALESCE((l->>'account')::uuid, app.ledger_account(p_household, l->>'key')),
            round(COALESCE((l->>'debit')::numeric, 0), 2), round(COALESCE((l->>'credit')::numeric, 0), 2),
            NULLIF(l->>'staffId', '')::uuid, l->>'memo');
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN  -- nothing to post (all-zero): drop the empty header
    DELETE FROM journal_entries WHERE id = v_id; RETURN NULL;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app.reverse_entry_internal(p_entry uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e journal_entries; v_id uuid := gen_random_uuid(); v_today date; v_closed date;
BEGIN
  SELECT * INTO e FROM journal_entries WHERE id = p_entry FOR UPDATE;
  IF e.id IS NULL THEN RAISE EXCEPTION 'journal entry not found' USING ERRCODE = 'no_data_found'; END IF;
  IF e.status = 'REVERSED' OR e.source = 'REVERSAL' THEN
    RAISE EXCEPTION 'entry % is already reversed or is itself a reversal', e.number USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM funding_matches WHERE "journalEntryId" = e.id) THEN
    RAISE EXCEPTION 'JE-% is matched to owner funding; unmatch it first', lpad(e.number::text, 6, '0') USING ERRCODE = 'check_violation';
  END IF;
  v_today := app.household_today(e."householdId");
  SELECT "booksClosedThrough" INTO v_closed FROM households WHERE id = e."householdId";
  INSERT INTO journal_entries (id, "householdId", "entryDate", "descriptionI18n", source, "reversalOfId", "reversalReason", "postedById", currency)
  VALUES (v_id, e."householdId", GREATEST(v_today, COALESCE(v_closed + 1, v_today)),
          jsonb_build_object('en', 'Reversal of JE-' || lpad(e.number::text, 6, '0'), 'ar', 'عكس القيد ' || e.number),
          'REVERSAL', e.id, p_reason, app.current_membership_id(), e.currency);
  INSERT INTO journal_lines (id, "householdId", "entryId", "ledgerAccountId", debit, credit, "staffId", memo)
  SELECT gen_random_uuid(), "householdId", v_id, "ledgerAccountId", credit, debit, "staffId", memo
  FROM journal_lines WHERE "entryId" = e.id;
  UPDATE journal_entries SET status = 'REVERSED' WHERE id = e.id;
  RETURN v_id;
END $$;

-- Public reversal for the API: finance.ledger.manage, own household only.
CREATE OR REPLACE FUNCTION app.reverse_journal_entry(p_entry uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF COALESCE(app.perm_scope('finance.ledger.manage'), '') <> 'ALL' THEN
    RAISE EXCEPTION 'reversing entries needs finance.ledger.manage' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = p_entry AND "householdId" = app.current_household_id()) THEN
    RAISE EXCEPTION 'journal entry not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF length(trim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'a reversal needs a reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN app.reverse_entry_internal(p_entry, p_reason);
END $$;
GRANT EXECUTE ON FUNCTION app.reverse_journal_entry(uuid, text) TO app_user;

-- Period lock: Head / EFA only; forward only; never today or later.
CREATE OR REPLACE FUNCTION app.close_books(p_through date) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hh uuid := app.current_household_id(); v_old date;
BEGIN
  IF NOT app.is_household_admin() THEN
    RAISE EXCEPTION 'only the Household Head or EFA Office Admin can close the books' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT "booksClosedThrough" INTO v_old FROM households WHERE id = v_hh;
  IF p_through >= app.household_today(v_hh) THEN
    RAISE EXCEPTION 'books can only be closed through a past date' USING ERRCODE = 'check_violation';
  END IF;
  IF v_old IS NOT NULL AND p_through <= v_old THEN
    RAISE EXCEPTION 'books are already closed through %; a period lock only moves forward', v_old USING ERRCODE = 'check_violation';
  END IF;
  UPDATE households SET "booksClosedThrough" = p_through WHERE id = v_hh;
  INSERT INTO audit_logs ("householdId", "actorUserId", action, "entityType", "entityId", before, after)
  VALUES (v_hh, app.current_user_id(), 'UPDATE', 'households.booksClosedThrough', v_hh::text,
          jsonb_build_object('through', v_old), jsonb_build_object('through', p_through));
  RETURN p_through;
END $$;
GRANT EXECUTE ON FUNCTION app.close_books(date) TO app_user;
-- The lock column is only writable through close_books().
REVOKE UPDATE ON households FROM app_user;
GRANT UPDATE ("nameI18n", "defaultLocale", "enabledLocales", "baseCurrency", "countryCode", timezone, "weekStartDay",
              "fiscalYearStart", settings, "updatedAt", "deletedAt") ON households TO app_user;

-- ---- posting hooks ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.custodian_staff(p_float uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id FROM petty_cash_accounts a JOIN staff_profiles s ON s."membershipId" = a."custodianId" WHERE a.id = p_float
$$;

CREATE OR REPLACE FUNCTION app.post_petty_cash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_float uuid; v_exp uuid; v_date date; v_desc jsonb; v_staff uuid;
BEGIN
  SELECT id INTO v_float FROM ledger_accounts WHERE "pettyCashAccountId" = NEW."accountId";
  v_date := (NEW."occurredAt" AT TIME ZONE (SELECT timezone FROM households WHERE id = NEW."householdId"))::date;
  v_desc := NEW."descriptionI18n";
  IF NEW.type = 'TOP_UP' AND TG_OP = 'INSERT' THEN
    PERFORM app.post_journal(NEW."householdId", 'PETTY_CASH', NEW.id, v_date, v_desc, jsonb_build_array(
      jsonb_build_object('account', v_float, 'debit', NEW.amount), jsonb_build_object('key', 'funding_clearing', 'credit', NEW.amount)));
  ELSIF NEW.type = 'RETURN' AND TG_OP = 'INSERT' THEN
    PERFORM app.post_journal(NEW."householdId", 'PETTY_CASH', NEW.id, v_date, v_desc, jsonb_build_array(
      jsonb_build_object('key', 'funding_clearing', 'debit', NEW.amount), jsonb_build_object('account', v_float, 'credit', NEW.amount)));
  ELSIF NEW.type = 'ADJUSTMENT' AND TG_OP = 'INSERT' THEN
    IF NEW.amount > 0 THEN
      PERFORM app.post_journal(NEW."householdId", 'PETTY_CASH', NEW.id, v_date, v_desc, jsonb_build_array(
        jsonb_build_object('account', v_float, 'debit', NEW.amount), jsonb_build_object('key', 'other_income', 'credit', NEW.amount)));
    ELSE
      PERFORM app.post_journal(NEW."householdId", 'PETTY_CASH', NEW.id, v_date, v_desc, jsonb_build_array(
        jsonb_build_object('key', 'cash_shortage', 'debit', -NEW.amount), jsonb_build_object('account', v_float, 'credit', -NEW.amount)));
    END IF;
  ELSIF NEW.type = 'EXPENSE' AND NEW.status = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'APPROVED') THEN
    v_exp := COALESCE((SELECT id FROM ledger_accounts WHERE "categoryId" = NEW."categoryId" AND type = 'EXPENSE' AND "isActive" AND NOT "isHeader"),
                      app.ledger_account(NEW."householdId", 'household_expenses'));
    PERFORM app.post_journal(NEW."householdId", 'PETTY_CASH', NEW.id, v_date, v_desc, jsonb_build_array(
      jsonb_build_object('account', v_exp, 'debit', NEW.amount, 'memo', NEW."merchantName"),
      jsonb_build_object('account', v_float, 'credit', NEW.amount)));
  ELSIF NEW.type = 'EXPENSE' AND NEW.status = 'REJECTED' AND TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'REJECTED' THEN
    -- Cash is gone but the expense is not accepted: the custodian owes it.
    v_staff := app.custodian_staff(NEW."accountId");
    PERFORM app.post_journal(NEW."householdId", 'PETTY_CASH', NEW.id, v_date,
      v_desc || jsonb_build_object('en', 'Rejected expense — owed by custodian: ' || COALESCE(v_desc->>'en', v_desc->>'ar', '')),
      jsonb_build_array(jsonb_build_object('key', 'staff_receivables', 'debit', NEW.amount, 'staffId', v_staff),
                        jsonb_build_object('account', v_float, 'credit', NEW.amount)));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER petty_cash_logs_ledger AFTER INSERT OR UPDATE OF status ON petty_cash_logs
  FOR EACH ROW EXECUTE FUNCTION app.post_petty_cash();

-- A reviewed expense stays reviewed (the ledger already reflects the decision).
CREATE OR REPLACE FUNCTION app.guard_petty_cash_review() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'this entry was already %', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER petty_cash_logs_0_review BEFORE UPDATE ON petty_cash_logs FOR EACH ROW EXECUTE FUNCTION app.guard_petty_cash_review();

CREATE OR REPLACE FUNCTION app.post_payroll_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_lines jsonb;
BEGIN
  IF NEW.status <> 'PAID' OR OLD.status = 'PAID' THEN RETURN NULL; END IF;
  WITH per_staff AS (
    SELECT "staffId",
           sum(amount) FILTER (WHERE amount > 0)                              AS earnings,
           -sum(amount) FILTER (WHERE amount < 0 AND type <> 'ADVANCE_RECOVERY') AS deductions,
           -sum(amount) FILTER (WHERE type = 'ADVANCE_RECOVERY')              AS recovered,
           sum(amount)                                                        AS net
    FROM payroll_lines WHERE "payrollRunId" = NEW.id GROUP BY "staffId")
  SELECT COALESCE(jsonb_agg(x), '[]') INTO v_lines FROM (
    SELECT jsonb_build_object('key', 'salaries_expense', 'debit', earnings, 'staffId', "staffId", 'memo', 'earnings') x FROM per_staff WHERE earnings > 0
    UNION ALL SELECT jsonb_build_object('key', 'salaries_expense', 'credit', deductions, 'staffId', "staffId", 'memo', 'deductions') FROM per_staff WHERE deductions > 0
    UNION ALL SELECT jsonb_build_object('key', 'staff_advances', 'credit', recovered, 'staffId', "staffId", 'memo', 'advance recovery') FROM per_staff WHERE recovered > 0
    UNION ALL SELECT jsonb_build_object('key', 'salaries_payable', 'credit', net, 'staffId', "staffId", 'memo', 'net pay') FROM per_staff WHERE net > 0
  ) t;
  PERFORM app.post_journal(NEW."householdId", 'PAYROLL', NEW.id, app.household_today(NEW."householdId"),
    jsonb_build_object('en', format('Payroll %s-%s', NEW."periodYear", lpad(NEW."periodMonth"::text, 2, '0')),
                       'ar', format('مسير رواتب %s-%s', NEW."periodYear", lpad(NEW."periodMonth"::text, 2, '0'))), v_lines);
  RETURN NULL;
END $$;
CREATE TRIGGER payroll_runs_ledger AFTER UPDATE OF status ON payroll_runs FOR EACH ROW EXECUTE FUNCTION app.post_payroll_run();

CREATE OR REPLACE FUNCTION app.post_salary_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_entry uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.post_journal(NEW."householdId", 'SALARY_PAYMENT', NEW.id,
      (NEW."paidAt" AT TIME ZONE (SELECT timezone FROM households WHERE id = NEW."householdId"))::date,
      jsonb_build_object('en', format('Salary %s-%s via %s', NEW."periodYear", lpad(NEW."periodMonth"::text, 2, '0'), NEW.channel),
                         'ar', format('راتب %s-%s عبر %s', NEW."periodYear", lpad(NEW."periodMonth"::text, 2, '0'), NEW.channel)),
      jsonb_build_array(
        jsonb_build_object('key', CASE WHEN NEW."payrollRunId" IS NOT NULL THEN 'salaries_payable' ELSE 'salaries_expense' END,
                           'debit', NEW.amount, 'staffId', NEW."staffId"),
        jsonb_build_object('key', 'funding_clearing', 'credit', NEW.amount,
                           'memo', NEW.channel || COALESCE(' ' || NEW."externalRef", ''))));
  ELSIF NEW.status = 'REVERSED' AND OLD.status <> 'REVERSED' THEN
    SELECT id INTO v_entry FROM journal_entries WHERE "householdId" = NEW."householdId" AND source = 'SALARY_PAYMENT' AND "sourceId" = NEW.id;
    IF v_entry IS NOT NULL THEN PERFORM app.reverse_entry_internal(v_entry, COALESCE(NEW."reversalReason", 'salary payment reversed')); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER salary_payments_ledger AFTER INSERT OR UPDATE OF status ON salary_payments FOR EACH ROW EXECUTE FUNCTION app.post_salary_payment();

CREATE OR REPLACE FUNCTION app.post_salary_advance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM app.post_journal(NEW."householdId", 'SALARY_ADVANCE', NEW.id, NEW."issuedAt",
    jsonb_build_object('en', 'Salary advance', 'ar', 'سلفة راتب'),
    jsonb_build_array(jsonb_build_object('key', 'staff_advances', 'debit', NEW.amount, 'staffId', NEW."staffId"),
                      jsonb_build_object('key', 'funding_clearing', 'credit', NEW.amount)));
  RETURN NULL;
END $$;
CREATE TRIGGER salary_advances_ledger AFTER INSERT ON salary_advances FOR EACH ROW EXECUTE FUNCTION app.post_salary_advance();

-- ============================================== BANKING & TRANSACTIONS ==
-- Every bank / wallet / cash / card / loan account gets its own ledger
-- account (12xx assets, 22xx liabilities). currentBalance uses one sign
-- convention for all: asset value (a credit card's debt is negative).

CREATE OR REPLACE FUNCTION app.bank_account_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_base text;
BEGIN
  SELECT "baseCurrency" INTO v_base FROM households WHERE id = NEW."householdId";
  IF NEW.currency <> v_base THEN
    RAISE EXCEPTION 'account currency % differs from the household currency %; multi-currency is not supported yet', NEW.currency, v_base
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."currentBalance" := NEW."openingBalance";
  RETURN NEW;
END $$;
CREATE TRIGGER financial_accounts_0_rules BEFORE INSERT ON financial_accounts FOR EACH ROW EXECUTE FUNCTION app.bank_account_rules();

CREATE OR REPLACE FUNCTION app.create_bank_ledger_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_liab boolean := NEW.type IN ('CREDIT_CARD', 'LOAN'); v_prefix text; v_code text; v_acc uuid := gen_random_uuid(); v_name jsonb;
BEGIN
  PERFORM app.ensure_chart_of_accounts(NEW."householdId");
  PERFORM pg_advisory_xact_lock(hashtext('coa:' || NEW."householdId"::text));
  v_prefix := CASE WHEN v_liab THEN '22' ELSE '12' END;
  SELECT lpad((COALESCE(max(code::int), (v_prefix || '00')::int) + 1)::text, 4, '0') INTO v_code
    FROM ledger_accounts WHERE "householdId" = NEW."householdId" AND code ~ ('^' || v_prefix || '[0-9]{2}$') AND code <> v_prefix || '00';
  v_name := CASE WHEN NEW."nameI18n" = '{}'::jsonb THEN jsonb_build_object('en', COALESCE(NEW.institution, NEW.type::text)) ELSE NEW."nameI18n" END;
  INSERT INTO ledger_accounts (id, "householdId", code, "nameI18n", type, "parentId", "isSystem", "systemKey", currency, "financialAccountId")
  VALUES (v_acc, NEW."householdId", v_code, v_name, CASE WHEN v_liab THEN 'LIABILITY' ELSE 'ASSET' END::"LedgerAccountType",
          app.ledger_account(NEW."householdId", CASE WHEN v_liab THEN 'cards_loans' ELSE 'bank_accounts' END),
          true, 'bank:' || NEW.id, NEW.currency, NEW.id);
  IF NEW."openingBalance" <> 0 THEN
    PERFORM app.post_journal(NEW."householdId", 'ACCOUNT_OPENING', NEW.id, app.household_today(NEW."householdId"),
      jsonb_build_object('en', 'Opening balance', 'ar', 'رصيد افتتاحي'),
      CASE WHEN NEW."openingBalance" > 0
        THEN jsonb_build_array(jsonb_build_object('account', v_acc, 'debit', NEW."openingBalance"), jsonb_build_object('key', 'owner_equity', 'credit', NEW."openingBalance"))
        ELSE jsonb_build_array(jsonb_build_object('key', 'owner_equity', 'debit', -NEW."openingBalance"), jsonb_build_object('account', v_acc, 'credit', -NEW."openingBalance")) END);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER financial_accounts_ledger AFTER INSERT ON financial_accounts FOR EACH ROW EXECUTE FUNCTION app.create_bank_ledger_account();

-- Type, currency, opening and current balance are not user-editable (balance is hook-maintained).
REVOKE UPDATE ON financial_accounts FROM app_user;
GRANT UPDATE ("nameI18n", institution, "ibanLast4", "ibanCiphertext", "ibanBlindIndex", "custodianId", "bankFeedRef", "isActive", "updatedAt")
  ON financial_accounts TO app_user;

-- ---- cards ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.card_holder(p_card uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT "holderId" FROM cards WHERE id = p_card $$;
CREATE OR REPLACE FUNCTION app.account_custodian(p_account uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT "custodianId" FROM financial_accounts WHERE id = p_account $$;

CREATE OR REPLACE FUNCTION app.card_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_type "FinancialAccountType";
BEGIN
  SELECT type INTO v_type FROM financial_accounts WHERE id = NEW."accountId";
  IF NEW.type = 'CREDIT' AND v_type <> 'CREDIT_CARD' THEN
    RAISE EXCEPTION 'a credit card must belong to a CREDIT_CARD account' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.type <> 'CREDIT' AND v_type IN ('CREDIT_CARD', 'LOAN') THEN
    RAISE EXCEPTION 'a % card must draw on a bank, wallet or cash account', NEW.type USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expiryMonth" NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'expiryMonth must be 1–12' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cards_1_rules BEFORE INSERT OR UPDATE OF "accountId", type ON cards FOR EACH ROW EXECUTE FUNCTION app.card_rules();

-- Holders may freeze their own card (lost/stolen) but nothing else; guardians manage wards' cards.
DROP POLICY card_upd ON cards;
CREATE POLICY card_upd ON cards AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.cards.manage')) = 'ALL'
         OR ((SELECT app.perm_scope('finance.cards.manage')) = 'WARDS' AND "holderId" = ANY (app.my_wards()))
         OR "holderId" = app.current_membership_id());
CREATE OR REPLACE FUNCTION app.guard_card() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.caller_is_restricted() OR COALESCE(app.perm_scope('finance.cards.manage') = 'ALL', false)
     OR (app.perm_scope('finance.cards.manage') = 'WARDS' AND OLD."holderId" = ANY (app.my_wards())) THEN
    RETURN NEW;
  END IF;
  IF NOT (OLD.status = 'ACTIVE' AND NEW.status = 'FROZEN')
     OR (NEW."accountId", NEW."holderId", NEW.type, NEW.last4, NEW."dailyLimit", NEW."monthlyLimit", NEW."perTxnLimit",
         NEW."allowedCategoryIds", NEW."expiryMonth", NEW."expiryYear", NEW.nickname)
        IS DISTINCT FROM
        (OLD."accountId", OLD."holderId", OLD.type, OLD.last4, OLD."dailyLimit", OLD."monthlyLimit", OLD."perTxnLimit",
         OLD."allowedCategoryIds", OLD."expiryMonth", OLD."expiryYear", OLD.nickname) THEN
    RAISE EXCEPTION 'card holders can only freeze their own card' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cards_0_guard BEFORE UPDATE ON cards FOR EACH ROW EXECUTE FUNCTION app.guard_card();

-- ---- transactions: authorisation (invoker) -----------------------------------------
CREATE OR REPLACE FUNCTION app.authorize_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_manager boolean; v_me uuid;
BEGIN
  IF NOT app.caller_is_restricted() THEN RETURN NEW; END IF;  -- workers (recurring bills, bank feeds)
  v_manager := COALESCE(app.perm_scope('finance.accounts.manage') = 'ALL', false);
  v_me := app.current_membership_id();
  IF TG_OP = 'INSERT' THEN
    IF NOT (NEW.source IN ('MANUAL', 'RECEIPT_OCR') OR (NEW.source = 'BANK_FEED' AND v_manager)) OR NEW."recurringRuleId" IS NOT NULL THEN
      RAISE EXCEPTION 'source % is reserved for system jobs', NEW.source USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."isFunding" AND NOT v_manager THEN
      RAISE EXCEPTION 'only account managers record owner funding' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- COALESCE: a missing custodian/holder makes the comparison NULL, and NOT NULL would skip the refusal.
    IF NOT v_manager AND NOT COALESCE(
         NEW.type = 'EXPENSE' AND NOT NEW."isFunding" AND
         ((NEW."cardId" IS NOT NULL AND app.card_holder(NEW."cardId") = v_me) OR
          (NEW."cardId" IS NULL AND app.account_custodian(NEW."accountId") = v_me)), false) THEN
      RAISE EXCEPTION 'you can only spend with your own card or the cash you hold' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT v_manager THEN NEW."spentById" := v_me; END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NEW.status = 'REVERSED' AND OLD.status <> 'REVERSED' THEN
    RAISE EXCEPTION 'use POST /transactions/{id}/reverse' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transactions_0_authorize BEFORE INSERT OR UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION app.authorize_transaction();

-- ---- transactions: validation (definer: must see the card's account even when the caller cannot) ----
CREATE OR REPLACE FUNCTION app.validate_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a financial_accounts; c cards; v_tz text; v_base text; v_day numeric; v_month numeric; v_kind "TransactionType";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'PENDING' AND (NEW.amount, NEW."accountId", NEW."counterAccountId", NEW."cardId", NEW.type, NEW."isFunding",
                                    NEW."occurredAt", NEW.currency, NEW."categoryId", NEW."householdId")
          IS DISTINCT FROM (OLD.amount, OLD."accountId", OLD."counterAccountId", OLD."cardId", OLD.type, OLD."isFunding",
                            OLD."occurredAt", OLD.currency, OLD."categoryId", OLD."householdId") THEN
      RAISE EXCEPTION 'a posted transaction is immutable; reverse it and record a new one' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status, NEW.status) IN (('PENDING','POSTED'), ('POSTED','RECONCILED'), ('RECONCILED','POSTED'),
                                      ('POSTED','REVERSED'), ('RECONCILED','REVERSED'))) THEN
      RAISE EXCEPTION 'transaction % → % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'RECONCILED' AND OLD.status <> 'RECONCILED' THEN NEW."reconciledAt" := now(); END IF;
    IF NEW.status = 'POSTED' AND OLD.status = 'RECONCILED' THEN NEW."reconciledAt" := NULL; END IF;
    IF OLD.status <> 'PENDING' THEN RETURN NEW; END IF;
  END IF;

  IF NEW.type = 'ADJUSTMENT' THEN
    RAISE EXCEPTION 'use a ledger journal for adjustments' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status NOT IN ('PENDING', 'POSTED') THEN
    RAISE EXCEPTION 'new transactions are PENDING or POSTED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO a FROM financial_accounts WHERE id = NEW."accountId";
  SELECT timezone, "baseCurrency" INTO v_tz, v_base FROM households WHERE id = NEW."householdId";
  IF NOT a."isActive" THEN RAISE EXCEPTION 'account is inactive' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.currency <> a.currency OR NEW.currency <> v_base THEN
    RAISE EXCEPTION 'transaction currency % must match the account and household currency (%)', NEW.currency, v_base USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."counterAccountId" IS NOT NULL AND NOT (SELECT "isActive" FROM financial_accounts WHERE id = NEW."counterAccountId") THEN
    RAISE EXCEPTION 'counter account is inactive' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."categoryId" IS NOT NULL THEN
    SELECT kind INTO v_kind FROM categories WHERE id = NEW."categoryId";
    IF (NEW.type IN ('EXPENSE', 'ALLOWANCE') AND v_kind <> 'EXPENSE') OR (NEW.type IN ('INCOME', 'REFUND') AND v_kind <> 'INCOME') THEN
      RAISE EXCEPTION 'category kind % does not fit a % transaction', v_kind, NEW.type USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."cardId" IS NOT NULL THEN
    SELECT * INTO c FROM cards WHERE id = NEW."cardId" FOR UPDATE;   -- serialises concurrent spends on one card
    IF c."accountId" <> NEW."accountId" THEN RAISE EXCEPTION 'card does not draw on this account' USING ERRCODE = 'check_violation'; END IF;
    IF c.status <> 'ACTIVE' THEN RAISE EXCEPTION 'card is %', c.status USING ERRCODE = 'check_violation'; END IF;
    IF make_date(c."expiryYear", c."expiryMonth", 1) + interval '1 month' <= (NEW."occurredAt" AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'card expired %/%', c."expiryMonth", c."expiryYear" USING ERRCODE = 'check_violation';
    END IF;
    IF cardinality(c."allowedCategoryIds") > 0 AND (NEW."categoryId" IS NULL OR NOT NEW."categoryId" = ANY (c."allowedCategoryIds")) THEN
      RAISE EXCEPTION 'this card is not allowed for that category' USING ERRCODE = 'check_violation';
    END IF;
    IF c."perTxnLimit" IS NOT NULL AND NEW.amount > c."perTxnLimit" THEN
      RAISE EXCEPTION 'amount % exceeds the per-transaction limit %', NEW.amount, c."perTxnLimit" USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(sum(amount) FILTER (WHERE ("occurredAt" AT TIME ZONE v_tz)::date = (NEW."occurredAt" AT TIME ZONE v_tz)::date), 0),
           COALESCE(sum(amount) FILTER (WHERE date_trunc('month', "occurredAt" AT TIME ZONE v_tz) = date_trunc('month', NEW."occurredAt" AT TIME ZONE v_tz)), 0)
      INTO v_day, v_month
      FROM transactions WHERE "cardId" = NEW."cardId" AND type IN ('EXPENSE', 'ALLOWANCE') AND status <> 'REVERSED' AND id <> NEW.id;
    IF c."dailyLimit" IS NOT NULL AND v_day + NEW.amount > c."dailyLimit" THEN
      RAISE EXCEPTION 'daily limit % reached (spent % today)', c."dailyLimit", v_day USING ERRCODE = 'check_violation';
    END IF;
    IF c."monthlyLimit" IS NOT NULL AND v_month + NEW.amount > c."monthlyLimit" THEN
      RAISE EXCEPTION 'monthly limit % reached (spent % this month)', c."monthlyLimit", v_month USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW."baseAmount" := NEW.amount; NEW."fxRate" := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER transactions_1_validate BEFORE INSERT OR UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION app.validate_transaction();

-- ---- transactions: balance + ledger posting (definer) ---------------------------------
CREATE OR REPLACE FUNCTION app.post_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_posted boolean; v_reversed boolean; v_sign int; v_acc uuid; v_counter uuid; v_other uuid; v_entry uuid; v_date date; v_desc jsonb;
BEGIN
  v_posted := NEW.status IN ('POSTED', 'RECONCILED') AND (TG_OP = 'INSERT' OR OLD.status = 'PENDING');
  v_reversed := TG_OP = 'UPDATE' AND NEW.status = 'REVERSED' AND OLD.status IN ('POSTED', 'RECONCILED');
  IF NOT (v_posted OR v_reversed) THEN RETURN NULL; END IF;
  v_sign := CASE WHEN v_posted THEN 1 ELSE -1 END;

  UPDATE financial_accounts SET "currentBalance" = "currentBalance"
         + v_sign * CASE WHEN NEW.type IN ('INCOME', 'REFUND') THEN NEW.amount ELSE -NEW.amount END, "updatedAt" = now()
   WHERE id = NEW."accountId";
  IF NEW."counterAccountId" IS NOT NULL THEN
    UPDATE financial_accounts SET "currentBalance" = "currentBalance" + v_sign * NEW.amount, "updatedAt" = now() WHERE id = NEW."counterAccountId";
  END IF;

  IF v_reversed THEN
    SELECT id INTO v_entry FROM journal_entries WHERE "householdId" = NEW."householdId" AND source = 'BANK_TRANSACTION' AND "sourceId" = NEW.id;
    IF v_entry IS NOT NULL THEN
      PERFORM app.reverse_entry_internal(v_entry, COALESCE(NULLIF(current_setting('app.reversal_reason', true), ''), 'transaction reversed'));
    END IF;
    RETURN NULL;
  END IF;

  v_acc := (SELECT id FROM ledger_accounts WHERE "financialAccountId" = NEW."accountId");
  v_date := (NEW."occurredAt" AT TIME ZONE (SELECT timezone FROM households WHERE id = NEW."householdId"))::date;
  v_desc := CASE WHEN NEW."descriptionI18n" = '{}'::jsonb THEN jsonb_build_object('en', COALESCE(NEW."merchantName", NEW.type::text)) ELSE NEW."descriptionI18n" END;
  IF NEW."isFunding" THEN
    PERFORM app.post_journal(NEW."householdId", 'BANK_TRANSACTION', NEW.id, v_date, v_desc, jsonb_build_array(
      jsonb_build_object('key', 'funding_clearing', 'debit', NEW.amount, 'memo', 'owner funding'), jsonb_build_object('account', v_acc, 'credit', NEW.amount)));
  ELSIF NEW.type = 'TRANSFER' THEN
    v_counter := (SELECT id FROM ledger_accounts WHERE "financialAccountId" = NEW."counterAccountId");
    PERFORM app.post_journal(NEW."householdId", 'BANK_TRANSACTION', NEW.id, v_date, v_desc, jsonb_build_array(
      jsonb_build_object('account', v_counter, 'debit', NEW.amount), jsonb_build_object('account', v_acc, 'credit', NEW.amount)));
  ELSIF NEW.type IN ('INCOME', 'REFUND') THEN
    v_other := COALESCE((SELECT id FROM ledger_accounts WHERE "categoryId" = NEW."categoryId" AND type = 'INCOME' AND "isActive" AND NOT "isHeader"),
                        app.ledger_account(NEW."householdId", 'other_income'));
    PERFORM app.post_journal(NEW."householdId", 'BANK_TRANSACTION', NEW.id, v_date, v_desc, jsonb_build_array(
      jsonb_build_object('account', v_acc, 'debit', NEW.amount), jsonb_build_object('account', v_other, 'credit', NEW.amount)));
  ELSE -- EXPENSE / ALLOWANCE
    v_other := COALESCE((SELECT id FROM ledger_accounts WHERE "categoryId" = NEW."categoryId" AND type = 'EXPENSE' AND "isActive" AND NOT "isHeader"),
                        app.ledger_account(NEW."householdId", 'household_expenses'));
    PERFORM app.post_journal(NEW."householdId", 'BANK_TRANSACTION', NEW.id, v_date, v_desc, jsonb_build_array(
      jsonb_build_object('account', v_other, 'debit', NEW.amount, 'memo', NEW."merchantName"), jsonb_build_object('account', v_acc, 'credit', NEW.amount)));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER transactions_ledger AFTER INSERT OR UPDATE OF status ON transactions FOR EACH ROW EXECUTE FUNCTION app.post_transaction();

CREATE OR REPLACE FUNCTION app.reverse_transaction(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t transactions;
BEGIN
  IF COALESCE(app.perm_scope('finance.accounts.manage'), '') <> 'ALL' THEN
    RAISE EXCEPTION 'reversing transactions needs finance.accounts.manage' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM transactions WHERE id = p_id AND "householdId" = app.current_household_id() FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'transaction not found' USING ERRCODE = 'no_data_found'; END IF;
  IF t.status NOT IN ('POSTED', 'RECONCILED') THEN
    RAISE EXCEPTION 'only a posted transaction can be reversed (this one is %)', t.status USING ERRCODE = 'check_violation';
  END IF;
  IF length(trim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'a reversal needs a reason' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM funding_matches WHERE "transactionId" = p_id) THEN
    RAISE EXCEPTION 'this funding transaction is matched; unmatch it first' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.reversal_reason', p_reason, true);
  UPDATE transactions SET status = 'REVERSED' WHERE id = p_id;
END $$;
GRANT EXECUTE ON FUNCTION app.reverse_transaction(uuid, text) TO app_user;

-- ---- funding clearing reconciliation -----------------------------------------------
CREATE OR REPLACE FUNCTION app.funding_credit(p_entry uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(sum(l.credit - l.debit), 0) FROM journal_lines l JOIN ledger_accounts a ON a.id = l."ledgerAccountId"
  WHERE l."entryId" = p_entry AND a."systemKey" = 'funding_clearing'
$$;

CREATE OR REPLACE FUNCTION app.validate_funding_match() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t transactions; e journal_entries; v_item_left numeric; v_txn_left numeric;
BEGIN
  SELECT * INTO t FROM transactions WHERE id = NEW."transactionId" FOR UPDATE;
  SELECT * INTO e FROM journal_entries WHERE id = NEW."journalEntryId" FOR UPDATE;
  IF NOT t."isFunding" OR t.status NOT IN ('POSTED', 'RECONCILED') THEN
    RAISE EXCEPTION 'only a posted funding transaction can be matched' USING ERRCODE = 'check_violation';
  END IF;
  IF e.status <> 'POSTED' THEN RAISE EXCEPTION 'that clearing entry was reversed' USING ERRCODE = 'check_violation'; END IF;
  v_item_left := app.funding_credit(e.id) - COALESCE((SELECT sum(amount) FROM funding_matches WHERE "journalEntryId" = e.id), 0);
  v_txn_left := t.amount - COALESCE((SELECT sum(amount) FROM funding_matches WHERE "transactionId" = t.id), 0);
  IF v_item_left <= 0 THEN RAISE EXCEPTION 'JE-% has nothing left to clear on 1190', lpad(e.number::text, 6, '0') USING ERRCODE = 'check_violation'; END IF;
  IF NEW.amount > v_item_left THEN
    RAISE EXCEPTION 'match % exceeds what JE-% still owes the clearing account (%)', NEW.amount, lpad(e.number::text, 6, '0'), v_item_left USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount > v_txn_left THEN
    RAISE EXCEPTION 'match % exceeds the transaction''s unmatched amount (%)', NEW.amount, v_txn_left USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER funding_matches_0_validate BEFORE INSERT ON funding_matches FOR EACH ROW EXECUTE FUNCTION app.validate_funding_match();

CREATE POLICY fm_read ON funding_matches AS RESTRICTIVE FOR SELECT TO app_user USING ((SELECT app.perm_scope('finance.ledger.read')) = 'ALL');
CREATE POLICY fm_ins ON funding_matches AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.ledger.manage')) = 'ALL' AND "matchedById" = app.current_membership_id());
CREATE POLICY fm_del ON funding_matches AS RESTRICTIVE FOR DELETE TO app_user USING ((SELECT app.perm_scope('finance.ledger.manage')) = 'ALL');
REVOKE UPDATE ON funding_matches FROM app_user;

-- ---- recurring bills: the JSON template must reference this household only -----------
CREATE OR REPLACE FUNCTION app.validate_recurring_template() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k text; tbl text; v uuid; v_ok boolean;
BEGIN
  IF NOT (NEW.template ? 'accountId') OR NOT (NEW.template->>'type') IN ('EXPENSE', 'INCOME', 'TRANSFER')
     OR COALESCE((NEW.template->>'amount')::numeric, 0) <= 0 THEN
    RAISE EXCEPTION 'template needs accountId, type (EXPENSE/INCOME/TRANSFER) and a positive amount' USING ERRCODE = 'check_violation';
  END IF;
  FOR k, tbl IN VALUES ('accountId', 'financial_accounts'), ('counterAccountId', 'financial_accounts'), ('categoryId', 'categories'), ('cardId', 'cards') LOOP
    CONTINUE WHEN NOT (NEW.template ? k) OR NEW.template->>k IS NULL;
    BEGIN v := (NEW.template->>k)::uuid; EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION '% is not a uuid', k USING ERRCODE = 'check_violation'; END;
    -- (EXECUTE does not set FOUND, so read the answer INTO a variable.)
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND "householdId" = $2)', tbl) INTO v_ok USING v, NEW."householdId";
    IF NOT v_ok THEN RAISE EXCEPTION '% does not exist in this household', k USING ERRCODE = 'foreign_key_violation'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER recurring_rules_0_template BEFORE INSERT OR UPDATE OF template ON recurring_rules FOR EACH ROW EXECUTE FUNCTION app.validate_recurring_template();

-- ============================================== BANK STATEMENT IMPORT ==
CREATE POLICY bsi_read ON bank_statement_imports AS RESTRICTIVE FOR SELECT TO app_user
  USING ((SELECT app.perm_scope('finance.accounts.read')) = 'ALL');
CREATE POLICY bsi_ins ON bank_statement_imports AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL' AND "importedById" = app.current_membership_id());
CREATE POLICY bsi_upd ON bank_statement_imports AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL');
CREATE POLICY bsi_del ON bank_statement_imports AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL' AND status = 'PARSED');
REVOKE UPDATE ON bank_statement_imports FROM app_user;
GRANT UPDATE (status, "appliedAt") ON bank_statement_imports TO app_user;

CREATE POLICY bsl_read ON bank_statement_lines AS RESTRICTIVE FOR SELECT TO app_user
  USING ((SELECT app.perm_scope('finance.accounts.read')) = 'ALL');
CREATE POLICY bsl_ins ON bank_statement_lines AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL');
CREATE POLICY bsl_upd ON bank_statement_lines AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL');
CREATE POLICY bsl_del ON bank_statement_lines AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('finance.accounts.manage')) = 'ALL' AND status = 'UNMATCHED');
REVOKE UPDATE ON bank_statement_lines FROM app_user;
GRANT UPDATE (status, "transactionId", "matchScore") ON bank_statement_lines TO app_user;

-- A line can only point at a transaction on ITS account whose effect equals the line amount;
-- once MATCHED/CREATED the link is permanent (the transaction is RECONCILED from the statement).
CREATE OR REPLACE FUNCTION app.validate_statement_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t transactions; v_delta numeric; v_imp bank_statement_imports;
BEGIN
  SELECT * INTO v_imp FROM bank_statement_imports WHERE id = NEW."importId";
  IF v_imp."accountId" <> NEW."accountId" THEN
    RAISE EXCEPTION 'statement line account differs from its import' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- A wrong auto-match can be undone before applying; a CREATED line is final.
    IF OLD.status = 'CREATED' AND (NEW.status, NEW."transactionId") IS DISTINCT FROM (OLD.status, OLD."transactionId") THEN
      RAISE EXCEPTION 'line % already created a transaction', OLD."lineNo" USING ERRCODE = 'check_violation';
    END IF;
    IF v_imp.status = 'APPLIED' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'statement already applied' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW.status IN ('MATCHED', 'CREATED')) <> (NEW."transactionId" IS NOT NULL) THEN
    RAISE EXCEPTION 'MATCHED/CREATED lines need a transaction (and only they)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."transactionId" IS NOT NULL THEN
    SELECT * INTO t FROM transactions WHERE id = NEW."transactionId";
    IF t.status = 'REVERSED' THEN RAISE EXCEPTION 'cannot match a reversed transaction' USING ERRCODE = 'check_violation'; END IF;
    v_delta := CASE WHEN t."counterAccountId" = NEW."accountId" THEN t.amount
                    WHEN t."accountId" = NEW."accountId" AND t.type IN ('INCOME', 'REFUND') THEN t.amount
                    WHEN t."accountId" = NEW."accountId" THEN -t.amount END;
    IF v_delta IS NULL OR v_delta <> NEW.amount THEN
      RAISE EXCEPTION 'transaction does not match line % (account or amount differs)', NEW."lineNo" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_lines_0_validate BEFORE INSERT OR UPDATE ON bank_statement_lines FOR EACH ROW EXECUTE FUNCTION app.validate_statement_line();

-- ================================== STAFF FILES, HEALTH, HANDOVER, TRAINING ==

-- ---- polymorphic references (attachments.entityId, reminders.entityId) ---------
-- These columns point at different tables depending on entityType, so no FK
-- exists. This trigger closes the gap: the target must exist in the SAME
-- household, and a staff file must belong to the same worker as its target.
CREATE TABLE IF NOT EXISTS app.entity_tables (kind text, entity_type text, tbl text, PRIMARY KEY (kind, entity_type));
TRUNCATE app.entity_tables;
INSERT INTO app.entity_tables VALUES
  ('attachment','RECEIPT','receipts'), ('attachment','TRANSACTION','transactions'), ('attachment','STAFF_DOCUMENT','identity_documents'),
  ('attachment','REQUEST','requests'), ('attachment','VEHICLE','vehicles'), ('attachment','MAINTENANCE','maintenance_records'),
  ('attachment','PROPERTY','properties'), ('attachment','LEASE','leases'), ('attachment','BILL','utility_bills'),
  ('attachment','TICKET','maintenance_tickets'), ('attachment','ASSET','assets'), ('attachment','POLICY','policies'),
  ('attachment','WORK_ORDER','work_orders'), ('attachment','TRIP','trips'), ('attachment','PETTY_CASH','petty_cash_logs'),
  ('attachment','STAFF','staff_profiles'), ('attachment','MEDICAL_CHECKUP','medical_checkups'), ('attachment','TRAINING','staff_trainings'),
  ('attachment','ASSET_HANDOVER','asset_handovers'), ('attachment','EVALUATION','staff_evaluations'),
  ('reminder','STAFF_DOCUMENT','identity_documents'), ('reminder','MEDICAL_CHECKUP','staff_profiles'), ('reminder','TRAINING','staff_trainings'),
  ('reminder','ASSET_HANDOVER','asset_handovers'), ('reminder','VEHICLE','vehicles'), ('reminder','LEASE','leases'),
  ('reminder','BILL','utility_bills'), ('reminder','STAFF','staff_profiles'), ('reminder','WORK_ORDER','work_orders'),
  ('reminder','MAINTENANCE_PLAN','maintenance_plans'), ('reminder','SALARY_PAYMENT','salary_payments');

CREATE OR REPLACE FUNCTION app.validate_entity_ref() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tbl text; v_ok boolean; v_staff uuid;
        -- shared by attachments and reminders; only attachments have "staffId" (read via jsonb)
        v_new_staff uuid := (to_jsonb(NEW) ->> 'staffId')::uuid;
        v_old_staff uuid := CASE WHEN TG_OP = 'UPDATE' THEN (to_jsonb(OLD) ->> 'staffId')::uuid END;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."entityType", NEW."entityId", NEW."householdId") IS NOT DISTINCT FROM (OLD."entityType", OLD."entityId", OLD."householdId")
     AND v_new_staff IS NOT DISTINCT FROM v_old_staff THEN RETURN NEW; END IF;
  SELECT tbl INTO v_tbl FROM app.entity_tables WHERE kind = TG_ARGV[0] AND entity_type = NEW."entityType"::text;
  IF v_tbl IS NULL THEN
    IF NEW."entityType"::text = 'OTHER' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'entity type % cannot be used here', NEW."entityType" USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND "householdId" = $2)', v_tbl) INTO v_ok USING NEW."entityId", NEW."householdId";
  IF NOT v_ok THEN RAISE EXCEPTION 'entityId does not exist in this household' USING ERRCODE = 'foreign_key_violation'; END IF;
  IF TG_ARGV[0] = 'attachment' AND v_new_staff IS NOT NULL THEN
    IF v_tbl = 'staff_profiles' THEN v_staff := NEW."entityId";
    ELSIF v_tbl IN ('identity_documents', 'medical_checkups', 'staff_trainings', 'asset_handovers', 'staff_evaluations') THEN
      EXECUTE format('SELECT "staffId" FROM %I WHERE id = $1', v_tbl) INTO v_staff USING NEW."entityId";
    ELSE v_staff := v_new_staff;  -- e.g. a request: the worker is whoever filed it; checked by its own rules
    END IF;
    IF v_staff IS DISTINCT FROM v_new_staff THEN
      RAISE EXCEPTION 'the file belongs to another worker than its target' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_0_entity BEFORE INSERT OR UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION app.validate_entity_ref('attachment');
CREATE TRIGGER reminders_0_entity BEFORE INSERT OR UPDATE ON reminders FOR EACH ROW EXECUTE FUNCTION app.validate_entity_ref('reminder');

-- ---- attachments: who may read staff / health files ---------------------------
DROP POLICY attach_sensitive ON attachments;
CREATE POLICY attach_read ON attachments AS RESTRICTIVE FOR SELECT TO app_user
  USING ("uploadedById" = app.current_membership_id() OR CASE
    WHEN category IN ('MEDICAL_REPORT', 'SICK_LEAVE_CERTIFICATE')
      THEN app.can_access((SELECT app.perm_scope('staff.health.read')), app.staff_member("staffId"))
    WHEN "staffId" IS NOT NULL OR "isSensitive"
      THEN app.can_access((SELECT app.perm_scope('staff.documents.read')), app.staff_member("staffId"))
    ELSE true END);
-- A worker may only file documents about herself; managers file for anyone.
CREATE POLICY attach_ins_staff ON attachments AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ("staffId" IS NULL OR (SELECT app.perm_scope('staff.profile.manage')) = 'ALL'
              OR app.current_membership_id() = ANY (app.staff_member("staffId")));
REVOKE UPDATE ON attachments FROM app_user;
GRANT UPDATE (status, sha256, "uploadedAt", encrypted, "storageKey", "sizeBytes") ON attachments TO app_user;
CREATE OR REPLACE FUNCTION app.guard_attachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'UPLOADED' AND (NEW.sha256, NEW."storageKey", NEW."sizeBytes", NEW.encrypted) IS DISTINCT FROM (OLD.sha256, OLD."storageKey", OLD."sizeBytes", OLD.encrypted) THEN
    RAISE EXCEPTION 'an uploaded file is immutable; upload a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'UPLOADED' AND OLD.status <> 'UPLOADED' THEN NEW."uploadedAt" := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_1_guard BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION app.guard_attachment();

-- ---- medical checkups & health profile -----------------------------------------
CREATE POLICY med_read ON medical_checkups AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.health.read')), app.staff_member("staffId")));
CREATE POLICY med_ins ON medical_checkups AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('staff.health.manage')) = 'ALL' AND "recordedById" = app.current_membership_id());
CREATE POLICY med_upd ON medical_checkups AS RESTRICTIVE FOR UPDATE TO app_user USING ((SELECT app.perm_scope('staff.health.manage')) = 'ALL');
CREATE POLICY med_del ON medical_checkups AS RESTRICTIVE FOR DELETE TO app_user USING ((SELECT app.is_household_admin()));

CREATE POLICY health_read ON staff_health_profiles AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.health.read')), app.staff_member("staffId")));
CREATE POLICY health_ins ON staff_health_profiles AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (app.can_access((SELECT app.perm_scope('staff.health.manage')), app.staff_member("staffId")));
CREATE POLICY health_upd ON staff_health_profiles AS RESTRICTIVE FOR UPDATE TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.health.manage')), app.staff_member("staffId")));
CREATE POLICY health_del ON staff_health_profiles AS RESTRICTIVE FOR DELETE TO app_user USING ((SELECT app.is_household_admin()));

-- ---- asset handover ------------------------------------------------------------
CREATE POLICY ho_read ON asset_handovers AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.profile.read')), app.staff_member("staffId")));
CREATE POLICY ho_ins ON asset_handovers AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL' AND "issuedById" = app.current_membership_id());
CREATE POLICY ho_upd ON asset_handovers AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL' OR app.current_membership_id() = ANY (app.staff_member("staffId")));
CREATE POLICY ho_del ON asset_handovers AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL' AND status = 'PENDING_ACK');

CREATE OR REPLACE FUNCTION app.guard_handover() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_worker boolean; v_manager boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'PENDING_ACK'; NEW."ackAt" := NULL; NEW."returnedAt" := NULL; NEW."issuedAt" := now();
    RETURN NEW;
  END IF;
  IF NOT app.caller_is_restricted() THEN RETURN NEW; END IF;
  v_worker := COALESCE(app.current_membership_id() = ANY (app.staff_member(OLD."staffId")), false);
  v_manager := COALESCE(app.perm_scope('staff.profile.manage') = 'ALL', false);
  IF OLD.status IN ('RETURNED', 'LOST') THEN RAISE EXCEPTION 'this handover is closed (%)', OLD.status USING ERRCODE = 'check_violation'; END IF;
  IF OLD.status <> 'PENDING_ACK' AND (NEW."itemType", NEW."descriptionI18n", NEW."serialOrTag", NEW.quantity, NEW."vehicleId", NEW."cardId", NEW."conditionOut", NEW."staffId")
       IS DISTINCT FROM (OLD."itemType", OLD."descriptionI18n", OLD."serialOrTag", OLD.quantity, OLD."vehicleId", OLD."cardId", OLD."conditionOut", OLD."staffId") THEN
    RAISE EXCEPTION 'issued items are frozen once the worker has signed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'ISSUED' THEN
      IF NOT v_worker OR OLD.status <> 'PENDING_ACK' THEN
        RAISE EXCEPTION 'only the worker signs for items issued to them' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW."ackAt" := now(); NEW."ackMethod" := COALESCE(NEW."ackMethod", 'TAP_TO_ACCEPT');
      NEW."ackContentHash" := encode(digest(concat_ws('|', NEW."itemType", NEW."descriptionI18n"::text, NEW."serialOrTag", NEW.quantity, NEW."conditionOut"), 'sha256'), 'hex');
    ELSIF NEW.status IN ('RETURNED', 'LOST') THEN
      IF NOT v_manager THEN RAISE EXCEPTION 'returns are received by a manager' USING ERRCODE = 'insufficient_privilege'; END IF;
      IF NEW.status = 'RETURNED' THEN NEW."returnedAt" := now(); NEW."returnReceivedById" := app.current_membership_id(); END IF;
      IF NEW.status = 'LOST' AND length(trim(coalesce(NEW."lostNote", ''))) = 0 THEN
        RAISE EXCEPTION 'a lost item needs a note' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'handover % → % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_worker AND NOT v_manager THEN
    RAISE EXCEPTION 'workers can only sign for items' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_handovers_0_guard BEFORE INSERT OR UPDATE ON asset_handovers FOR EACH ROW EXECUTE FUNCTION app.guard_handover();

-- ---- evaluations ---------------------------------------------------------------
CREATE POLICY ev_read ON staff_evaluations AS RESTRICTIVE FOR SELECT TO app_user
  USING ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL'
         OR (status <> 'DRAFT' AND app.can_access((SELECT app.perm_scope('staff.profile.read')), app.staff_member("staffId"))));
CREATE POLICY ev_ins ON staff_evaluations AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL' AND "evaluatorId" = app.current_membership_id());
CREATE POLICY ev_upd ON staff_evaluations AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL' OR app.current_membership_id() = ANY (app.staff_member("staffId")));
CREATE POLICY ev_del ON staff_evaluations AS RESTRICTIVE FOR DELETE TO app_user
  USING ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL' AND status = 'DRAFT');
CREATE OR REPLACE FUNCTION app.guard_evaluation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_worker boolean;
BEGIN
  IF NOT app.caller_is_restricted() THEN RETURN NEW; END IF;
  v_worker := COALESCE(app.current_membership_id() = ANY (app.staff_member(OLD."staffId")), false)
              AND NOT COALESCE(app.perm_scope('staff.profile.manage') = 'ALL', false);
  IF OLD.status <> 'DRAFT' AND (NEW.scores, NEW.overall, NEW."commentsI18n", NEW."periodStart", NEW."periodEnd", NEW."evaluatorId")
       IS DISTINCT FROM (OLD.scores, OLD.overall, OLD."commentsI18n", OLD."periodStart", OLD."periodEnd", OLD."evaluatorId") THEN
    RAISE EXCEPTION 'a shared evaluation is final' USING ERRCODE = 'check_violation';
  END IF;
  IF v_worker THEN
    IF NOT (OLD.status = 'SHARED' AND NEW.status = 'ACKNOWLEDGED') THEN
      RAISE EXCEPTION 'workers can only acknowledge a shared evaluation' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW."acknowledgedAt" := now();
  ELSE
    IF NEW.status = 'ACKNOWLEDGED' AND OLD.status <> 'ACKNOWLEDGED' THEN
      RAISE EXCEPTION 'only the worker acknowledges their evaluation' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."workerComment" IS DISTINCT FROM OLD."workerComment" THEN
      RAISE EXCEPTION 'the worker''s comment is theirs to write' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'SHARED' AND OLD.status = 'DRAFT' THEN NEW."sharedAt" := now(); END IF;
    IF NEW.status = 'DRAFT' AND OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'a shared evaluation cannot return to draft' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_evaluations_0_guard BEFORE UPDATE ON staff_evaluations FOR EACH ROW EXECUTE FUNCTION app.guard_evaluation();

-- ---- trainings -----------------------------------------------------------------
CREATE POLICY tr_read ON staff_trainings AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.profile.read')), app.staff_member("staffId")));
CREATE POLICY tr_ins ON staff_trainings AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL' AND "recordedById" = app.current_membership_id());
CREATE POLICY tr_upd ON staff_trainings AS RESTRICTIVE FOR UPDATE TO app_user
  USING ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL' OR app.current_membership_id() = ANY (app.staff_member("staffId")));
CREATE POLICY tr_del ON staff_trainings AS RESTRICTIVE FOR DELETE TO app_user USING ((SELECT app.perm_scope('staff.profile.manage')) = 'ALL');
CREATE OR REPLACE FUNCTION app.guard_training() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.caller_is_restricted() OR COALESCE(app.perm_scope('staff.profile.manage') = 'ALL', false) THEN RETURN NEW; END IF;
  IF (NEW.category, NEW."titleI18n", NEW.provider, NEW."completedAt", NEW."validUntil", NEW.hours, NEW."certificateAttachmentId", NEW."staffId")
     IS DISTINCT FROM (OLD.category, OLD."titleI18n", OLD.provider, OLD."completedAt", OLD."validUntil", OLD.hours, OLD."certificateAttachmentId", OLD."staffId")
     OR OLD."workerAckAt" IS NOT NULL THEN
    RAISE EXCEPTION 'workers can only acknowledge a training once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."workerAckAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_trainings_0_guard BEFORE UPDATE ON staff_trainings FOR EACH ROW EXECUTE FUNCTION app.guard_training();

-- ---- staff lifecycle: medical clearance in, asset clearance out -----------------
CREATE OR REPLACE FUNCTION app.has_valid_medical(p_staff uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM medical_checkups c JOIN staff_profiles s ON s.id = c."staffId"
                 WHERE c."staffId" = p_staff AND c.result IN ('FIT', 'FIT_WITH_RESTRICTIONS')
                   AND c."validUntil" >= app.household_today(s."householdId"))
$$;
CREATE OR REPLACE FUNCTION app.has_outstanding_items(p_staff uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM asset_handovers WHERE "staffId" = p_staff AND status IN ('PENDING_ACK', 'ISSUED'))
$$;
-- SECURITY INVOKER on purpose: on INSERT the rule applies to interactive users
-- (caller_is_restricted), while migrations / seed fixtures may load ACTIVE staff.
CREATE OR REPLACE FUNCTION app.staff_lifecycle_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Mandatory annual medical checkup for ALL staff roles, whatever the job title.
  IF NEW.status = 'ACTIVE'
     AND ((TG_OP = 'UPDATE' AND OLD.status IN ('RECRUITING', 'ON_PROBATION', 'ABSCONDED')) OR (TG_OP = 'INSERT' AND app.caller_is_restricted()))
     AND NOT app.has_valid_medical(NEW.id) THEN
    RAISE EXCEPTION 'a valid annual medical checkup (FIT) is required before a worker becomes ACTIVE' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IN ('TERMINATED', 'FINAL_EXIT') AND OLD.status NOT IN ('TERMINATED', 'FINAL_EXIT')
     AND app.has_outstanding_items(NEW.id) THEN
    RAISE EXCEPTION 'exit clearance: items are still issued to this worker (return or mark them lost first)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_profiles_1_lifecycle BEFORE INSERT OR UPDATE OF status ON staff_profiles FOR EACH ROW EXECUTE FUNCTION app.staff_lifecycle_rules();

-- ---- sick leave over one day needs a medical certificate -------------------------
CREATE OR REPLACE FUNCTION app.check_sick_leave() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_days int; v_staff uuid; v_att uuid;
BEGIN
  IF NEW.type <> 'LEAVE' OR NEW.payload->>'leaveType' <> 'SICK' THEN RETURN NEW; END IF;
  v_days := (NEW.payload->>'endDate')::date - (NEW.payload->>'startDate')::date + 1;
  IF v_days <= 1 THEN RETURN NEW; END IF;
  v_staff := COALESCE((NEW.payload->>'staffId')::uuid,
                      (SELECT id FROM staff_profiles WHERE "membershipId" = NEW."requesterId" AND "householdId" = NEW."householdId"));
  BEGIN v_att := (NEW.payload->>'certificateAttachmentId')::uuid; EXCEPTION WHEN invalid_text_representation THEN v_att := NULL; END;
  IF v_att IS NULL OR NOT EXISTS (SELECT 1 FROM attachments WHERE id = v_att AND "householdId" = NEW."householdId"
                                   AND category = 'SICK_LEAVE_CERTIFICATE' AND "staffId" = v_staff) THEN
    RAISE EXCEPTION 'sick leave of % days needs a medical certificate (SICK_LEAVE_CERTIFICATE attachment of this worker)', v_days
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requests_1_sick_leave BEFORE INSERT OR UPDATE OF payload ON requests FOR EACH ROW EXECUTE FUNCTION app.check_sick_leave();

-- ---- compliance reminders: medical (ALL staff), trainings, handover returns ------
CREATE OR REPLACE FUNCTION app.reminder_tiers(p_days_left int, p_tiers int[]) RETURNS SETOF int
LANGUAGE sql IMMUTABLE AS $$
  SELECT 0 WHERE p_days_left < 0
  UNION ALL
  SELECT t FROM unnest(p_tiers) t
  WHERE p_days_left >= 0 AND (p_days_left > t OR t = (SELECT min(x) FROM unnest(p_tiers) x WHERE p_days_left <= x))
$$;

CREATE OR REPLACE FUNCTION app.sync_staff_compliance_reminders(p_household uuid DEFAULT NULL)
RETURNS TABLE (inserted int, removed int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ins int; v_del int;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _want (hh uuid, et "AttachmentEntity", eid uuid, due_at timestamptz, remind_at timestamptz, tier int, title jsonb) ON COMMIT DROP;
  TRUNCATE _want;
  -- Annual medical checkup: every worker, no job-type exemption. Due = last valid checkup's
  -- validUntil, or 30 days after hire for someone never examined.
  INSERT INTO _want
  SELECT s."householdId", 'MEDICAL_CHECKUP', s.id, (d.due + time '09:00') AT TIME ZONE h.timezone,
         (d.due - t + time '09:00') AT TIME ZONE h.timezone, t,
         CASE WHEN t = 0 THEN jsonb_build_object('ar', format('الفحص الطبي السنوي للعامل %s متأخر', n.ar), 'en', format('Annual medical checkup for %s is overdue', n.en))
              ELSE jsonb_build_object('ar', format('الفحص الطبي السنوي للعامل %s مستحق خلال %s يوماً', n.ar, t), 'en', format('Annual medical checkup for %s is due within %s days', n.en, t)) END
  FROM staff_profiles s JOIN households h ON h.id = s."householdId"
  CROSS JOIN LATERAL (SELECT COALESCE((SELECT max(c."validUntil") FROM medical_checkups c WHERE c."staffId" = s.id AND c.result IN ('FIT', 'FIT_WITH_RESTRICTIONS')),
                                      COALESCE(s."hireDate", s."createdAt"::date) + 30) AS due) d
  CROSS JOIN LATERAL (SELECT COALESCE(s."fullNameI18n"->>'ar', s."fullNameI18n"->>'en', '') AS ar, COALESCE(s."fullNameI18n"->>'en', s."fullNameI18n"->>'ar', '') AS en) n
  CROSS JOIN LATERAL app.reminder_tiers(d.due - (now() AT TIME ZONE h.timezone)::date, ARRAY[60, 30, 15]) t
  WHERE s."deletedAt" IS NULL AND s.status NOT IN ('TERMINATED', 'FINAL_EXIT') AND (p_household IS NULL OR s."householdId" = p_household);
  -- Safety trainings: the latest per worker and category.
  INSERT INTO _want
  SELECT tr."householdId", 'TRAINING', tr.id, (tr."validUntil" + time '09:00') AT TIME ZONE h.timezone,
         (tr."validUntil" - t + time '09:00') AT TIME ZONE h.timezone, t,
         jsonb_build_object('ar', format('تجديد تدريب %s للعامل %s', tr.category, COALESCE(s."fullNameI18n"->>'ar', s."fullNameI18n"->>'en')),
                            'en', format('%s training for %s %s', initcap(replace(lower(tr.category::text), '_', ' ')), COALESCE(s."fullNameI18n"->>'en', s."fullNameI18n"->>'ar'),
                                         CASE WHEN t = 0 THEN 'has expired' ELSE format('expires within %s days', t) END))
  FROM staff_trainings tr JOIN staff_profiles s ON s.id = tr."staffId" JOIN households h ON h.id = tr."householdId"
  CROSS JOIN LATERAL app.reminder_tiers(tr."validUntil" - (now() AT TIME ZONE h.timezone)::date, ARRAY[60, 30, 15]) t
  WHERE tr."validUntil" IS NOT NULL AND s."deletedAt" IS NULL AND s.status NOT IN ('TERMINATED', 'FINAL_EXIT')
    AND tr."completedAt" = (SELECT max(x."completedAt") FROM staff_trainings x WHERE x."staffId" = tr."staffId" AND x.category = tr.category)
    AND (p_household IS NULL OR tr."householdId" = p_household);
  -- Items due back (7 days and 1 day before, then overdue).
  INSERT INTO _want
  SELECT a."householdId", 'ASSET_HANDOVER', a.id, a."expectedReturnAt", a."expectedReturnAt" - make_interval(days => t), t,
         jsonb_build_object('ar', format('إرجاع %s من العامل %s', a."itemType", COALESCE(s."fullNameI18n"->>'ar', s."fullNameI18n"->>'en')),
                            'en', format('%s due back from %s', initcap(replace(lower(a."itemType"::text), '_', ' ')), COALESCE(s."fullNameI18n"->>'en', s."fullNameI18n"->>'ar')))
  FROM asset_handovers a JOIN staff_profiles s ON s.id = a."staffId" JOIN households h ON h.id = a."householdId"
  CROSS JOIN LATERAL app.reminder_tiers(((a."expectedReturnAt" AT TIME ZONE h.timezone)::date - (now() AT TIME ZONE h.timezone)::date), ARRAY[7, 1]) t
  WHERE a.status IN ('PENDING_ACK', 'ISSUED') AND a."expectedReturnAt" IS NOT NULL AND (p_household IS NULL OR a."householdId" = p_household);

  DELETE FROM reminders r
  WHERE r."entityType" IN ('MEDICAL_CHECKUP', 'TRAINING', 'ASSET_HANDOVER') AND r.status = 'PENDING'
    AND (p_household IS NULL OR r."householdId" = p_household)
    AND NOT EXISTS (SELECT 1 FROM _want w WHERE w.eid = r."entityId" AND w.et = r."entityType" AND w.due_at = r."dueAt");
  GET DIAGNOSTICS v_del = ROW_COUNT;
  INSERT INTO reminders (id, "householdId", "recipientId", "entityType", "entityId", "titleI18n", "dueAt", "remindAt", status, channels)
  SELECT gen_random_uuid(), hh, NULL, et, eid, title || jsonb_build_object('tier', tier), due_at, remind_at, 'PENDING',
         CASE WHEN tier <= 15 THEN ARRAY['IN_APP','PUSH','WHATSAPP']::"NotificationChannel"[] ELSE ARRAY['IN_APP','PUSH']::"NotificationChannel"[] END
  FROM _want
  ON CONFLICT ("householdId", "entityType", "entityId", "dueAt", "remindAt") DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  RETURN QUERY SELECT v_ins, v_del;
END $$;
REVOKE ALL ON FUNCTION app.sync_staff_compliance_reminders(uuid) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION app.sync_staff_compliance_reminders(uuid) TO app_service;

-- ============================================================ NOTIFICATIONS ==
-- Deliveries are written by the dispatcher (app_service); a user may only mark
-- their own notifications read.
REVOKE INSERT, UPDATE, DELETE ON notifications FROM app_user;
GRANT UPDATE ("readAt") ON notifications TO app_user;
REVOKE UPDATE, DELETE ON sync_operations FROM app_user;

-- =================================== CROSS-HOUSEHOLD REFERENCE ISOLATION ==
-- Foreign keys prove a referenced row EXISTS, not that it belongs to the same
-- household. Without this, a request that guessed another household's UUID
-- could link to it (a transaction on their bank account, an allowance paid to
-- their card, a work order assigned to their driver). One generic trigger per
-- reference checks parent."householdId" = NEW."householdId".
-- Installed for:
--   * every single-column FK whose child and parent both have "householdId"
--     (discovered from the catalogue, so new FKs are covered automatically);
--   * uuid columns/arrays that have no FK (listed below).
-- It runs for every role (workers too): this is integrity, not authorisation.
-- tests/rls_test.sql asserts that every eligible reference has its trigger.
CREATE OR REPLACE FUNCTION app.enforce_same_household() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  col text := TG_ARGV[0];
  parent text := TG_ARGV[1];
  is_array boolean := COALESCE(TG_ARGV[2], '') = 'array';
  v jsonb := to_jsonb(NEW) -> col;
  ok boolean;
BEGIN
  IF v IS NULL OR v = 'null'::jsonb OR (is_array AND jsonb_array_length(v) = 0) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) -> col) IS NOT DISTINCT FROM v AND OLD."householdId" = NEW."householdId" THEN
    RETURN NEW;  -- reference unchanged
  END IF;
  IF is_array THEN
    EXECUTE format('SELECT count(*) = (SELECT count(DISTINCT x) FROM jsonb_array_elements_text($1) x)
                    FROM %I WHERE id IN (SELECT x::uuid FROM jsonb_array_elements_text($1) x) AND "householdId" = $2', parent)
      INTO ok USING v, NEW."householdId";
  ELSE
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND "householdId" = $2)', parent)
      INTO ok USING (v #>> '{}')::uuid, NEW."householdId";
  END IF;
  IF NOT ok THEN
    -- Same message whether the id exists elsewhere or not at all: no cross-tenant oracle.
    RAISE EXCEPTION '% does not exist in this household', col USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

-- ============================================ SAUDI DOMESTIC LABOR COMPLIANCE ==
-- لائحة عمال الخدمة المنزلية ومن في حكمهم (Decision 310/1434H).

-- Art. 9: deductions from the wage (manual deductions + salary-advance recovery) may not
-- exceed half of the wage earned that month (earnings less unpaid leave). Checked per
-- worker per run after every statement that touches the lines.
CREATE OR REPLACE FUNCTION app.check_payroll_deduction_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_earned numeric; v_ded numeric; r record;
BEGIN
  FOR r IN SELECT DISTINCT "payrollRunId" AS run, "staffId" AS staff FROM new_rows LOOP
    SELECT COALESCE(sum(amount) FILTER (WHERE type IN ('BASIC_SALARY', 'ALLOWANCE', 'OVERTIME', 'BONUS', 'UNPAID_LEAVE')), 0),
           COALESCE(-sum(amount) FILTER (WHERE type IN ('DEDUCTION', 'ADVANCE_RECOVERY')), 0)
      INTO v_earned, v_ded
      FROM payroll_lines WHERE "payrollRunId" = r.run AND "staffId" = r.staff;
    IF v_ded > round(GREATEST(v_earned, 0) * 0.5, 2) THEN
      RAISE EXCEPTION 'deductions of % SAR exceed half of the % SAR wage earned (Domestic Workers Regulation, Art. 9)', v_ded, v_earned
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS payroll_lines_deduction_cap_ins ON payroll_lines;
DROP TRIGGER IF EXISTS payroll_lines_deduction_cap_upd ON payroll_lines;
CREATE TRIGGER payroll_lines_deduction_cap_ins AFTER INSERT ON payroll_lines REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.check_payroll_deduction_cap();
CREATE TRIGGER payroll_lines_deduction_cap_upd AFTER UPDATE ON payroll_lines REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.check_payroll_deduction_cap();

-- Art. 11: up to 30 days of paid sick leave (with a medical report) per 12 months. A sick
-- leave that goes beyond is split: the paid part stays paid, the excess becomes unpaid
-- leave, which payroll deducts at (monthly wage / 30) per day.
CREATE OR REPLACE FUNCTION app.cap_paid_sick_leave() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_used numeric; v_left int;
BEGIN
  IF NEW.type <> 'SICK' OR NOT NEW.paid THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(days), 0) INTO v_used FROM leave_records
   WHERE "staffId" = NEW."staffId" AND type = 'SICK' AND paid AND id <> NEW.id
     AND "startDate" > NEW."startDate" - 365 AND "startDate" <= NEW."startDate";
  v_left := GREATEST(0, 30 - floor(v_used)::int);
  IF NEW.days <= v_left THEN RETURN NEW; END IF;
  IF v_left = 0 THEN NEW.paid := false; RETURN NEW; END IF;
  INSERT INTO leave_records (id, "householdId", "staffId", "requestId", type, "startDate", "endDate", days, paid)
  VALUES (gen_random_uuid(), NEW."householdId", NEW."staffId", NULL, 'SICK', NEW."startDate" + v_left, NEW."endDate", NEW.days - v_left, false);
  NEW."endDate" := NEW."startDate" + v_left - 1;
  NEW.days := v_left;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS leave_records_sick_cap ON leave_records;
CREATE TRIGGER leave_records_sick_cap BEFORE INSERT ON leave_records FOR EACH ROW EXECUTE FUNCTION app.cap_paid_sick_leave();

-- Payroll acknowledgment: a recorded salary payment asks the worker to confirm receipt
-- (now, after 3 days, after 7 days) on WhatsApp, push and in-app; acknowledging,
-- disputing or reversing it withdraws the outstanding reminders.
CREATE OR REPLACE FUNCTION app.salary_ack_reminders() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_member uuid; d int;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status <> 'RECORDED' AND OLD.status = 'RECORDED' THEN
      DELETE FROM reminders WHERE "entityType" = 'SALARY_PAYMENT' AND "entityId" = NEW.id AND status = 'PENDING';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.status <> 'RECORDED' THEN RETURN NULL; END IF;
  SELECT "membershipId" INTO v_member FROM staff_profiles WHERE id = NEW."staffId";
  IF v_member IS NULL THEN RETURN NULL; END IF; -- worker has no app account: nothing to send
  FOREACH d IN ARRAY ARRAY[0, 3, 7] LOOP
    INSERT INTO reminders (id, "householdId", "recipientId", "entityType", "entityId", "titleI18n", "dueAt", "remindAt", status, channels)
    VALUES (gen_random_uuid(), NEW."householdId", v_member, 'SALARY_PAYMENT', NEW.id,
            jsonb_build_object('tier', d, 'period', format('%s-%s', NEW."periodYear", lpad(NEW."periodMonth"::text, 2, '0')),
                               'ar', 'يرجى تأكيد استلام الراتب', 'en', 'Please confirm you received your salary'),
            NEW."paidAt" + interval '7 days', NEW."paidAt" + make_interval(days => d), 'PENDING',
            ARRAY['IN_APP', 'PUSH', 'WHATSAPP']::"NotificationChannel"[])
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS salary_payments_ack_reminders ON salary_payments;
CREATE TRIGGER salary_payments_ack_reminders AFTER INSERT OR UPDATE OF status ON salary_payments FOR EACH ROW EXECUTE FUNCTION app.salary_ack_reminders();

-- ESB snapshots: computed by the worker (app_service); members read them like payroll data.
CREATE POLICY esb_read ON esb_accruals AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('staff.payroll.read')), app.staff_member("staffId")));
REVOKE INSERT, UPDATE, DELETE ON esb_accruals FROM app_user;

-- ================================================================ FLEET ==
-- Vehicles: only fleet managers edit the profile. (veh_upd also admits assigned
-- drivers; the odometer is now kept from odometer_readings by a definer trigger.)
CREATE OR REPLACE FUNCTION app.guard_vehicle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.caller_is_restricted() AND NOT COALESCE(app.perm_scope('fleet.manage') = 'ALL', false) THEN
    RAISE EXCEPTION 'only fleet managers can edit a vehicle; drivers record odometer readings instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS vehicles_0_guard ON vehicles;
CREATE TRIGGER vehicles_0_guard BEFORE UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION app.guard_vehicle();

-- Maintenance plans: readable like the vehicle, managed by fleet managers.
CREATE POLICY mp_read ON maintenance_plans AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('fleet.read')), app.vehicle_drivers("vehicleId")));
CREATE POLICY mp_ins ON maintenance_plans AS RESTRICTIVE FOR INSERT TO app_user WITH CHECK ((SELECT app.perm_scope('fleet.manage')) = 'ALL');
CREATE POLICY mp_upd ON maintenance_plans AS RESTRICTIVE FOR UPDATE TO app_user USING ((SELECT app.perm_scope('fleet.manage')) = 'ALL');
CREATE POLICY mp_del ON maintenance_plans AS RESTRICTIVE FOR DELETE TO app_user USING ((SELECT app.perm_scope('fleet.manage')) = 'ALL');

CREATE OR REPLACE FUNCTION app.maintenance_plan_due() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."intervalKm" IS NULL AND NEW."intervalDays" IS NULL THEN
    RAISE EXCEPTION 'a maintenance plan needs an interval in km, in days, or both' USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(NEW."intervalKm", 1) <= 0 OR COALESCE(NEW."intervalDays", 1) <= 0 THEN
    RAISE EXCEPTION 'intervals must be positive' USING ERRCODE = 'check_violation';
  END IF;
  -- No service history yet: the plan starts from today's odometer and date (fixed baseline, so it never slides).
  NEW."lastDoneKm" := COALESCE(NEW."lastDoneKm", (SELECT "odometerKm" FROM vehicles WHERE id = NEW."vehicleId"));
  NEW."lastDoneAt" := COALESCE(NEW."lastDoneAt", (now() AT TIME ZONE 'Asia/Riyadh')::date);
  NEW."nextDueKm" := CASE WHEN NEW."intervalKm" IS NOT NULL THEN NEW."lastDoneKm" + NEW."intervalKm" END;
  NEW."nextDueDate" := CASE WHEN NEW."intervalDays" IS NOT NULL THEN NEW."lastDoneAt" + NEW."intervalDays" END;
  IF TG_OP = 'UPDATE' AND (NEW."lastDoneKm", NEW."intervalKm") IS DISTINCT FROM (OLD."lastDoneKm", OLD."intervalKm") THEN NEW."kmAlertAt" := NULL; END IF;
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS maintenance_plans_due ON maintenance_plans;
CREATE TRIGGER maintenance_plans_due BEFORE INSERT OR UPDATE ON maintenance_plans FOR EACH ROW EXECUTE FUNCTION app.maintenance_plan_due();

-- A completed service resets its plan (and the vehicle's odometer reading). Definer: runs for whoever records it.
CREATE OR REPLACE FUNCTION app.apply_maintenance_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_plan maintenance_plans;
BEGIN
  IF NEW."planId" IS NOT NULL THEN
    SELECT * INTO v_plan FROM maintenance_plans WHERE id = NEW."planId";
    IF v_plan."vehicleId" IS DISTINCT FROM NEW."vehicleId" THEN
      RAISE EXCEPTION 'maintenance plan belongs to another vehicle' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'COMPLETED' AND (TG_OP = 'INSERT' OR OLD.status <> 'COMPLETED') THEN
    NEW."completedAt" := COALESCE(NEW."completedAt", now());
    IF NEW."planId" IS NOT NULL THEN
      UPDATE maintenance_plans SET "lastDoneAt" = (NEW."completedAt" AT TIME ZONE 'Asia/Riyadh')::date,
             "lastDoneKm" = COALESCE(NEW."odometerKm", (SELECT "odometerKm" FROM vehicles WHERE id = NEW."vehicleId"))
       WHERE id = NEW."planId";
      SELECT "nextDueKm", "nextDueDate" INTO NEW."nextDueKm", NEW."nextDueDate" FROM maintenance_plans WHERE id = NEW."planId";
    END IF;
    IF NEW.type = 'INSPECTION' THEN
      UPDATE vehicles SET "lastInspectionAt" = (NEW."completedAt" AT TIME ZONE 'Asia/Riyadh')::date WHERE id = NEW."vehicleId";
    END IF;
    IF NEW."odometerKm" IS NOT NULL THEN
      INSERT INTO odometer_readings (id, "householdId", "vehicleId", "readingKm", "readAt", source, "recordedById", note)
      VALUES (gen_random_uuid(), NEW."householdId", NEW."vehicleId", NEW."odometerKm", NEW."completedAt", 'SERVICE',
              COALESCE(app.current_membership_id(), (SELECT "driverId" FROM vehicle_assignments WHERE "vehicleId" = NEW."vehicleId" ORDER BY "startsAt" DESC LIMIT 1)),
              format('service %s', NEW.type));
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS maintenance_records_apply ON maintenance_records;
CREATE TRIGGER maintenance_records_apply BEFORE INSERT OR UPDATE ON maintenance_records FOR EACH ROW EXECUTE FUNCTION app.apply_maintenance_record();

-- Odometer readings: assigned drivers (fleet.trips.log) and managers append; immutable afterwards.
CREATE POLICY odo_read ON odometer_readings AS RESTRICTIVE FOR SELECT TO app_user
  USING (app.can_access((SELECT app.perm_scope('fleet.read')), app.vehicle_drivers("vehicleId")));
CREATE POLICY odo_ins ON odometer_readings AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ("recordedById" = app.current_membership_id()
              AND (app.can_access((SELECT app.perm_scope('fleet.trips.log')), app.vehicle_drivers("vehicleId"))
                   OR app.can_access((SELECT app.perm_scope('fleet.fuel.log')), app.vehicle_drivers("vehicleId"))
                   OR (SELECT app.perm_scope('fleet.manage')) = 'ALL'));
CREATE POLICY odo_del ON odometer_readings AS RESTRICTIVE FOR DELETE TO app_user USING ((SELECT app.perm_scope('fleet.manage')) = 'ALL');
REVOKE UPDATE ON odometer_readings FROM app_user;

CREATE OR REPLACE FUNCTION app.apply_odometer_reading() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_max int;
BEGIN
  IF NEW."readingKm" < 0 OR NEW."readingKm" > 2000000 THEN
    RAISE EXCEPTION 'odometer reading % km is not plausible', NEW."readingKm" USING ERRCODE = 'check_violation';
  END IF;
  SELECT GREATEST(COALESCE(max("readingKm"), 0), (SELECT "odometerKm" FROM vehicles WHERE id = NEW."vehicleId")) INTO v_max
  FROM odometer_readings WHERE "vehicleId" = NEW."vehicleId" AND "readAt" <= NEW."readAt";
  IF NEW."readingKm" < v_max THEN
    RAISE EXCEPTION 'odometer cannot go backwards: % km is below the last reading of % km', NEW."readingKm", v_max USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM odometer_readings WHERE "vehicleId" = NEW."vehicleId" AND "readAt" > NEW."readAt" AND "readingKm" < NEW."readingKm") THEN
    RAISE EXCEPTION 'a later reading is lower than % km', NEW."readingKm" USING ERRCODE = 'check_violation';
  END IF;
  UPDATE vehicles SET "odometerKm" = GREATEST("odometerKm", NEW."readingKm") WHERE id = NEW."vehicleId";
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS odometer_readings_apply ON odometer_readings;
CREATE TRIGGER odometer_readings_apply BEFORE INSERT ON odometer_readings FOR EACH ROW EXECUTE FUNCTION app.apply_odometer_reading();

-- Fuel: cost must equal litres × price (±1 SAR / 2%); distance and km/L since the previous fill are derived here,
-- so the anomaly checks in the API work from numbers the driver cannot set.
CREATE OR REPLACE FUNCTION app.apply_fuel_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_prev int;
BEGIN
  IF NEW.liters <= 0 OR NEW."pricePerLiter" <= 0 OR NEW."totalCost" <= 0 THEN
    RAISE EXCEPTION 'litres, price and total must be positive' USING ERRCODE = 'check_violation';
  END IF;
  IF abs(NEW.liters * NEW."pricePerLiter" - NEW."totalCost") > GREATEST(1, NEW."totalCost" * 0.02) THEN
    RAISE EXCEPTION 'total % does not match % L × % SAR/L', NEW."totalCost", NEW.liters, NEW."pricePerLiter" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."driverId" := COALESCE(app.current_membership_id(), NEW."driverId");
    SELECT "odometerKm" INTO v_prev FROM fuel_logs WHERE "vehicleId" = NEW."vehicleId" AND "filledAt" < NEW."filledAt" ORDER BY "filledAt" DESC LIMIT 1;
    NEW."kmSinceLast" := CASE WHEN v_prev IS NOT NULL THEN NEW."odometerKm" - v_prev END;
    NEW."kmPerL" := CASE WHEN v_prev IS NOT NULL AND NEW."odometerKm" > v_prev THEN round((NEW."odometerKm" - v_prev) / NEW.liters, 2) END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fuel_logs_apply ON fuel_logs;
CREATE TRIGGER fuel_logs_apply BEFORE INSERT OR UPDATE OF liters, "pricePerLiter", "totalCost" ON fuel_logs FOR EACH ROW EXECUTE FUNCTION app.apply_fuel_log();

-- Fleet reminders on the 60/30/15 engine: Istimara, insurance, Fahas (VEHICLE), and maintenance plans
-- by date (tiers below the interval) or by km (alert once within 1,000 km, anchored at kmAlertAt).
CREATE OR REPLACE FUNCTION app.sync_fleet_reminders(p_household uuid DEFAULT NULL)
RETURNS TABLE (inserted int, removed int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ins int; v_del int;
BEGIN
  UPDATE maintenance_plans p SET "kmAlertAt" = now()
  FROM vehicles v WHERE v.id = p."vehicleId" AND p."isActive" AND p."nextDueKm" IS NOT NULL AND p."kmAlertAt" IS NULL
    AND v."odometerKm" >= p."nextDueKm" - 1000 AND (p_household IS NULL OR p."householdId" = p_household);

  CREATE TEMP TABLE IF NOT EXISTS _fwant (hh uuid, et "AttachmentEntity", eid uuid, due_at timestamptz, remind_at timestamptz, tier int, title jsonb) ON COMMIT DROP;
  TRUNCATE _fwant;
  INSERT INTO _fwant
  SELECT v."householdId", 'VEHICLE', v.id, (d.due + time '09:00') AT TIME ZONE h.timezone, (d.due - t + time '09:00') AT TIME ZONE h.timezone, t,
         jsonb_build_object('doc', d.doc, 'plate', v."plateNumber",
           'ar', format('%s للمركبة %s %s', d.ar, v."plateNumber", CASE WHEN t = 0 THEN 'منتهية' ELSE format('تنتهي خلال %s يوماً', t) END),
           'en', format('%s for %s %s', d.en, v."plateNumber", CASE WHEN t = 0 THEN 'has expired' ELSE format('expires within %s days', t) END))
  FROM vehicles v JOIN households h ON h.id = v."householdId"
  CROSS JOIN LATERAL (VALUES ('REGISTRATION', v."registrationExpiry", 'الاستمارة', 'Registration (Istimara)'),
                             ('INSURANCE', v."insuranceExpiry", 'التأمين', 'Insurance'),
                             ('INSPECTION', v."inspectionExpiry", 'الفحص الدوري', 'Periodic inspection (Fahas)')) d(doc, due, ar, en)
  CROSS JOIN LATERAL app.reminder_tiers(d.due - (now() AT TIME ZONE h.timezone)::date, ARRAY[60, 30, 15]) t
  WHERE d.due IS NOT NULL AND v."deletedAt" IS NULL AND v.status NOT IN ('SOLD', 'OUT_OF_SERVICE') AND (p_household IS NULL OR v."householdId" = p_household);
  -- by date
  INSERT INTO _fwant
  SELECT p."householdId", 'MAINTENANCE_PLAN', p.id, (p."nextDueDate" + time '09:00') AT TIME ZONE h.timezone,
         (p."nextDueDate" - t + time '09:00') AT TIME ZONE h.timezone, t,
         jsonb_build_object('basis', 'date', 'plate', v."plateNumber", 'ar', format('صيانة %s للمركبة %s', p.type, v."plateNumber"),
                            'en', format('%s for %s %s', initcap(replace(lower(p.type::text), '_', ' ')), v."plateNumber",
                                         CASE WHEN t = 0 THEN 'is overdue' ELSE format('is due within %s days', t) END))
  FROM maintenance_plans p JOIN vehicles v ON v.id = p."vehicleId" JOIN households h ON h.id = p."householdId"
  CROSS JOIN LATERAL app.reminder_tiers(p."nextDueDate" - (now() AT TIME ZONE h.timezone)::date,
                                        ARRAY(SELECT x FROM unnest(ARRAY[60, 30, 15]) x WHERE x < p."intervalDays" OR x = 15)) t
  WHERE p."isActive" AND p."nextDueDate" IS NOT NULL AND v."deletedAt" IS NULL AND v.status NOT IN ('SOLD', 'OUT_OF_SERVICE')
    AND (p_household IS NULL OR p."householdId" = p_household);
  -- by km
  INSERT INTO _fwant
  SELECT p."householdId", 'MAINTENANCE_PLAN', p.id, p."kmAlertAt", p."kmAlertAt", -1,
         jsonb_build_object('basis', 'km', 'plate', v."plateNumber", 'dueKm', p."nextDueKm", 'odometerKm', v."odometerKm",
                            'ar', format('صيانة %s للمركبة %s عند %s كم (العداد %s كم)', p.type, v."plateNumber", p."nextDueKm", v."odometerKm"),
                            'en', format('%s for %s due at %s km (odometer %s km)', initcap(replace(lower(p.type::text), '_', ' ')), v."plateNumber", p."nextDueKm", v."odometerKm"))
  FROM maintenance_plans p JOIN vehicles v ON v.id = p."vehicleId"
  WHERE p."isActive" AND p."kmAlertAt" IS NOT NULL AND v."deletedAt" IS NULL AND (p_household IS NULL OR p."householdId" = p_household);

  DELETE FROM reminders r
  WHERE r."entityType" IN ('VEHICLE', 'MAINTENANCE_PLAN') AND r.status = 'PENDING' AND (p_household IS NULL OR r."householdId" = p_household)
    AND NOT EXISTS (SELECT 1 FROM _fwant w WHERE w.eid = r."entityId" AND w.et = r."entityType" AND w.due_at = r."dueAt");
  GET DIAGNOSTICS v_del = ROW_COUNT;
  INSERT INTO reminders (id, "householdId", "recipientId", "entityType", "entityId", "titleI18n", "dueAt", "remindAt", status, channels)
  SELECT gen_random_uuid(), hh, NULL, et, eid, title || jsonb_build_object('tier', tier), due_at, remind_at, 'PENDING',
         CASE WHEN tier <= 15 THEN ARRAY['IN_APP','PUSH','WHATSAPP']::"NotificationChannel"[] ELSE ARRAY['IN_APP','PUSH']::"NotificationChannel"[] END
  FROM _fwant
  ON CONFLICT ("householdId", "entityType", "entityId", "dueAt", "remindAt") DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  RETURN QUERY SELECT v_ins, v_del;
END $$;
REVOKE ALL ON FUNCTION app.sync_fleet_reminders(uuid) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION app.sync_fleet_reminders(uuid) TO app_service;

-- ========================================================= OCR RECEIPTS ==
-- Receipts are admin-only for UPDATE (protected table); OCR results are written
-- through this function, which lets the uploader (or an admin) record the
-- extraction once per processing attempt and nothing else.
CREATE OR REPLACE FUNCTION app.record_receipt_extraction(p_id uuid, p_status text, p_provider text, p_extracted jsonb,
                                                         p_confidence double precision, p_qr text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE r receipts;
BEGIN
  SELECT * INTO r FROM receipts WHERE id = p_id AND "householdId" = app.current_household_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'receipt not found' USING ERRCODE = 'P0002'; END IF;
  IF r."uploadedById" IS DISTINCT FROM app.current_membership_id() AND NOT COALESCE(app.is_household_admin(), false) THEN
    RAISE EXCEPTION 'only the uploader or the household office can process this receipt' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r.status NOT IN ('UPLOADED', 'PROCESSING') THEN
    RAISE EXCEPTION 'receipt already processed (%)', r.status USING ERRCODE = 'check_violation';
  END IF;
  IF p_status NOT IN ('PROCESSING', 'EXTRACTED', 'UPLOADED') THEN
    RAISE EXCEPTION 'invalid OCR status %', p_status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE receipts SET status = p_status::"ReceiptStatus", "ocrProvider" = p_provider, extracted = p_extracted,
         confidence = p_confidence, "zatcaQr" = p_qr, "processedAt" = CASE WHEN p_status = 'EXTRACTED' THEN now() END
   WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION app.record_receipt_extraction(uuid, text, text, jsonb, double precision, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_receipt_extraction(uuid, text, text, jsonb, double precision, text) TO app_user;

-- A petty-cash entry may only cite a receipt its recorder uploaded (or any, for the household office);
-- one receipt backs one entry (unique column).
CREATE OR REPLACE FUNCTION app.check_petty_cash_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."receiptId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."receiptId" IS DISTINCT FROM OLD."receiptId")
     AND app.caller_is_restricted() AND NOT COALESCE(app.is_household_admin(), false)
     AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.id = NEW."receiptId" AND r."uploadedById" = app.current_membership_id()) THEN
    RAISE EXCEPTION 'you can only attach a receipt you uploaded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS petty_cash_logs_receipt ON petty_cash_logs;
CREATE TRIGGER petty_cash_logs_receipt BEFORE INSERT OR UPDATE ON petty_cash_logs FOR EACH ROW EXECUTE FUNCTION app.check_petty_cash_receipt();

-- ========================================================= OFFLINE SYNC ==
-- Row versions are kept by the database, so a device can neither fake nor skip
-- one; offline pushes send the version they last saw (baseVersion) and the API
-- reports a CONFLICT when the server copy moved on. Runs last among the BEFORE
-- triggers (name "z_…"), after the guards have normalised NEW.
CREATE OR REPLACE FUNCTION app.bump_row_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1; NEW."updatedAt" := clock_timestamp();
  ELSIF (to_jsonb(NEW) - 'version' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'version' - 'updatedAt') THEN
    NEW.version := OLD.version + 1; NEW."updatedAt" := clock_timestamp();
  ELSE
    NEW.version := OLD.version; NEW."updatedAt" := OLD."updatedAt";
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS z_row_version ON household_tasks;
CREATE TRIGGER z_row_version BEFORE INSERT OR UPDATE ON household_tasks FOR EACH ROW EXECUTE FUNCTION app.bump_row_version();
DROP TRIGGER IF EXISTS z_row_version ON work_order_instructions;
CREATE TRIGGER z_row_version BEFORE INSERT OR UPDATE ON work_order_instructions FOR EACH ROW EXECUTE FUNCTION app.bump_row_version();

-- Sync journal: a member reads and appends only their own operations; rows are immutable.
CREATE POLICY syncop_read ON sync_operations AS RESTRICTIVE FOR SELECT TO app_user
  USING ("membershipId" = app.current_membership_id());
CREATE POLICY syncop_ins ON sync_operations AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK ("membershipId" = app.current_membership_id());

-- entityId is polymorphic (no FK): it must name a row of the matching kind in the same household.
CREATE OR REPLACE FUNCTION app.validate_sync_entity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  IF NOT (CASE NEW.kind
           WHEN 'TASK_UPDATE' THEN EXISTS (SELECT 1 FROM household_tasks t WHERE t.id = NEW."entityId" AND t."householdId" = NEW."householdId")
           WHEN 'INSTRUCTION_COMPLETE' THEN EXISTS (SELECT 1 FROM work_order_instructions i WHERE i.id = NEW."entityId" AND i."householdId" = NEW."householdId")
           ELSE false END) THEN
    RAISE EXCEPTION 'sync operation entity % is not a % of this household', NEW."entityId", NEW.kind USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sync_operations_entity ON sync_operations;
CREATE TRIGGER sync_operations_entity BEFORE INSERT OR UPDATE ON sync_operations FOR EACH ROW EXECUTE FUNCTION app.validate_sync_entity();

CREATE TABLE IF NOT EXISTS app.tenant_refs (tbl text, col text, parent text, is_array boolean, PRIMARY KEY (tbl, col));
TRUNCATE app.tenant_refs;
INSERT INTO app.tenant_refs
SELECT ch.relname, a.attname, pa.relname, false
FROM pg_constraint c
JOIN pg_class ch ON ch.oid = c.conrelid JOIN pg_class pa ON pa.oid = c.confrelid
JOIN pg_namespace n ON n.oid = ch.relnamespace
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f' AND n.nspname = 'public' AND array_length(c.conkey, 1) = 1 AND a.attname <> 'householdId'
  AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = ch.oid AND x.attname = 'householdId')
  AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = pa.oid AND x.attname = 'householdId');
INSERT INTO app.tenant_refs VALUES
  -- uuid arrays (no FK possible)
  ('cards',                   'allowedCategoryIds', 'categories',         true),
  ('trip_logs',               'passengers',         'memberships',        true),
  ('trip_bookings',           'passengerIds',       'trip_passengers',    true),
  -- uuid columns without an FK
  ('allowance_plans',         'targetCardId',       'cards',              false),
  ('salary_payments',         'proofFileId',        'attachments',        false),
  ('leave_records',           'exitReentryVisaId',  'identity_documents', false),
  ('payroll_runs',            'approvedById',       'memberships',        false),
  ('memberships',             'invitedById',        'memberships',        false),
  ('policies',                'createdById',        'memberships',        false),
  ('codes_of_ethics',         'createdById',        'memberships',        false),
  ('privacy_agreements',      'createdById',        'memberships',        false),
  ('trip_bookings',           'createdById',        'memberships',        false),
  ('petty_cash_logs',         'reviewedById',       'memberships',        false),
  ('work_orders',             'verifiedById',       'memberships',        false),
  ('work_order_instructions', 'completedById',      'memberships',        false),
  ('salary_payments',         'recordedById',       'memberships',        false),
  ('attachments',             'uploadedById',       'memberships',        false),
  ('journal_entries',         'postedById',         'memberships',        false),
  ('recurring_rules',         'createdById',        'memberships',        false),
  ('funding_matches',         'matchedById',        'memberships',        false),
  ('bank_statement_imports',  'importedById',       'memberships',        false),
  ('medical_checkups',        'recordedById',       'memberships',        false),
  ('medical_checkups',        'reportAttachmentId', 'attachments',        false),
  ('staff_health_profiles',   'disclosedById',      'memberships',        false),
  ('asset_handovers',         'issuedById',         'memberships',        false),
  ('asset_handovers',         'returnReceivedById', 'memberships',        false),
  ('asset_handovers',         'vehicleId',          'vehicles',           false),
  ('asset_handovers',         'cardId',             'cards',              false),
  ('staff_evaluations',       'evaluatorId',        'memberships',        false),
  ('staff_trainings',         'recordedById',       'memberships',        false),
  ('staff_trainings',         'certificateAttachmentId', 'attachments',   false),
  ('odometer_readings',       'recordedById',       'memberships',        false)
ON CONFLICT DO NOTHING;

DO $$
DECLARE r record; trg text;
BEGIN
  FOR r IN SELECT * FROM app.tenant_refs LOOP
    trg := left('a_tenant_ref_' || r.col, 63);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trg, r.tbl);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.enforce_same_household(%L, %L%s)',
                   trg, r.tbl, r.col, r.parent, CASE WHEN r.is_array THEN ', ''array''' ELSE '' END);
  END LOOP;
END $$;

-- ============================================================ PROVISIONING =
-- Creates a household, its default roles + permission matrix, and the owner
-- membership in one call. Exposed as POST /v1/households.
CREATE OR REPLACE FUNCTION app.provision_household(
  p_owner uuid, p_slug text, p_name jsonb, p_locale "Locale" DEFAULT 'ar', p_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hh uuid := COALESCE(p_id, gen_random_uuid()); v_role uuid; r record;
BEGIN
  -- (current_user is the function owner here, so there is no reliable way to
  -- exempt workers by role; a worker provisioning for someone sets app.user_id.)
  IF p_owner IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'owner must be the calling user' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO households (id, slug, "nameI18n", "defaultLocale", "updatedAt")
  VALUES (v_hh, p_slug, p_name, p_locale, now());

  FOR r IN SELECT DISTINCT system_role FROM app.role_template LOOP
    INSERT INTO roles (id, "householdId", "systemRole", "nameI18n", "isDefault")
    VALUES (gen_random_uuid(), v_hh, r.system_role::"SystemRole",
            (SELECT name_i18n FROM app.role_names WHERE system_role = r.system_role), true)
    RETURNING id INTO v_role;
    INSERT INTO role_permissions ("roleId", "permissionId", scope)
    SELECT v_role, permission_id, scope FROM app.role_template WHERE system_role = r.system_role;
  END LOOP;

  INSERT INTO memberships (id, "householdId", "userId", "roleId", status, "joinedAt", "updatedAt")
  SELECT gen_random_uuid(), v_hh, p_owner, id, 'ACTIVE', now(), now()
  FROM roles WHERE "householdId" = v_hh AND "systemRole" = 'HOUSEHOLD_HEAD';

  PERFORM app.ensure_chart_of_accounts(v_hh);

  RETURN v_hh;
END $$;
GRANT EXECUTE ON FUNCTION app.provision_household TO app_user, app_service;
