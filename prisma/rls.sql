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
DECLARE v_pol approval_policies; v_step jsonb; v_n int := 0;
BEGIN
  IF NEW.status = 'DRAFT' THEN RETURN NEW; END IF;

  SELECT * INTO v_pol FROM approval_policies p
  WHERE p."householdId" = NEW."householdId" AND p."requestType" = NEW.type AND p."isActive"
    AND (p."minAmount" IS NULL OR NEW.amount >= p."minAmount")
    AND (p."maxAmount" IS NULL OR NEW.amount <  p."maxAmount")
  ORDER BY p."minAmount" DESC NULLS LAST LIMIT 1;

  IF v_pol.id IS NOT NULL AND v_pol."autoApproveBelow" IS NOT NULL AND NEW.amount < v_pol."autoApproveBelow" THEN
    UPDATE requests SET status = 'APPROVED', "resolvedAt" = now() WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  IF v_pol.id IS NOT NULL THEN
    FOR v_step IN SELECT * FROM jsonb_array_elements(v_pol.steps) LOOP
      INSERT INTO approvals (id, "householdId", "requestId", step, "approverId")
      SELECT gen_random_uuid(), NEW."householdId", NEW.id, (v_step->>'step')::int, m.id
      FROM memberships m JOIN roles r ON r.id = m."roleId"
      WHERE m."householdId" = NEW."householdId" AND m.status = 'ACTIVE' AND m.id <> NEW."requesterId"
        AND (m.id::text = v_step->>'membershipId' OR r."systemRole"::text = v_step->>'approverRole');
      GET DIAGNOSTICS v_n = ROW_COUNT;
    END LOOP;
  END IF;

  IF v_pol.id IS NULL OR NOT EXISTS (SELECT 1 FROM approvals WHERE "requestId" = NEW.id) THEN
    INSERT INTO approvals (id, "householdId", "requestId", step, "approverId")
    SELECT gen_random_uuid(), NEW."householdId", NEW.id, 1, m.id
    FROM memberships m JOIN roles r ON r.id = m."roleId"
    WHERE m."householdId" = NEW."householdId" AND m.status = 'ACTIVE' AND m.id <> NEW."requesterId"
      AND r."systemRole" IN ('HOUSEHOLD_HEAD', 'EFA_OFFICE_ADMIN');
  END IF;

  UPDATE requests SET status = 'IN_REVIEW', "currentStep" = 1 WHERE id = NEW.id;
  RETURN NEW;
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
  IF TG_OP = 'UPDATE' AND NEW.status = 'COMPLETED' AND OLD.status <> 'COMPLETED' THEN NEW."completedAt" := now(); END IF;
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
BEGIN
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
  ('attachments',             'uploadedById',       'memberships',        false)
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
  p_owner uuid, p_slug text, p_name jsonb, p_locale "Locale" DEFAULT 'ar'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hh uuid := gen_random_uuid(); v_role uuid; r record;
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

  RETURN v_hh;
END $$;
GRANT EXECUTE ON FUNCTION app.provision_household TO app_user, app_service;
