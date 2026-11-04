-- RLS acceptance test. Run: psql -v ON_ERROR_STOP=1 -d <db> -f tests/rls_test.sql
\set QUIET on
BEGIN;
-- ---------- fixtures (as superuser: RLS bypassed) ----------
INSERT INTO users (id, "fullNameI18n", "updatedAt") VALUES
 ('00000000-0000-0000-0000-00000000000a','{"ar":"ماجد"}',now()),     -- head H1
 ('00000000-0000-0000-0000-00000000000b','{"en":"Other head"}',now()),-- head H2
 ('00000000-0000-0000-0000-00000000000c','{"tl":"Maria"}',now()),     -- maid H1
 ('00000000-0000-0000-0000-00000000000d','{"ar":"أحمد"}',now()),      -- child H1
 ('00000000-0000-0000-0000-00000000000e','{"bn":"Rahim"}',now());     -- driver H1

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO app_user;
SELECT set_config('app.user_id','00000000-0000-0000-0000-00000000000a',true);
INSERT INTO ids SELECT 'h1', app.provision_household('00000000-0000-0000-0000-00000000000a','h1','{"ar":"بيت ماجد"}');
SELECT set_config('app.user_id','00000000-0000-0000-0000-00000000000b',true);
INSERT INTO ids SELECT 'h2', app.provision_household('00000000-0000-0000-0000-00000000000b','h2','{"en":"Other"}');

INSERT INTO ids SELECT 'head1', id FROM memberships WHERE "userId"='00000000-0000-0000-0000-00000000000a';
INSERT INTO ids SELECT 'head2', id FROM memberships WHERE "userId"='00000000-0000-0000-0000-00000000000b';

CREATE FUNCTION pg_temp.add_member(u uuid, r text, guardian uuid) RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO memberships (id,"householdId","userId","roleId",status,"guardianId","updatedAt")
  SELECT gen_random_uuid(), (SELECT v FROM ids WHERE k='h1'), u, ro.id, 'ACTIVE', guardian, now()
  FROM roles ro WHERE ro."householdId"=(SELECT v FROM ids WHERE k='h1') AND ro."systemRole"=r::"SystemRole"
  RETURNING id $$;
INSERT INTO ids VALUES ('maid',   pg_temp.add_member('00000000-0000-0000-0000-00000000000c','STAFF',null)),
                       ('child',  pg_temp.add_member('00000000-0000-0000-0000-00000000000d','DEPENDENT',(SELECT v FROM ids WHERE k='head1'))),
                       ('driver', pg_temp.add_member('00000000-0000-0000-0000-00000000000e','DRIVER',null));

-- staff profiles + payroll for maid and driver
INSERT INTO staff_profiles (id,"householdId","membershipId","staffType",status,nationality,"updatedAt") VALUES
 (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='maid'),'HOUSEMAID','ACTIVE','PH',now()),
 (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='driver'),'DRIVER','ACTIVE','BD',now());
INSERT INTO payroll_runs (id,"householdId","periodYear","periodMonth") VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),2026,10);
INSERT INTO payroll_lines (id,"householdId","payrollRunId","staffId",type,amount)
 SELECT gen_random_uuid(), s."householdId", (SELECT id FROM payroll_runs), s.id, 'BASIC_SALARY', 1500 FROM staff_profiles s;

-- one account; transactions spent by head, child, maid; one in H2
INSERT INTO financial_accounts (id,"householdId",type,"updatedAt") VALUES
 ('10000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='h1'),'BANK_CURRENT',now()),
 ('10000000-0000-0000-0000-000000000002',(SELECT v FROM ids WHERE k='h2'),'BANK_CURRENT',now());
INSERT INTO transactions (id,"householdId","accountId",type,amount,currency,"baseAmount","occurredAt","createdById","spentById")
SELECT gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),'10000000-0000-0000-0000-000000000001','EXPENSE',a,'SAR',a,now(),
       (SELECT v FROM ids WHERE k='head1'),(SELECT v FROM ids WHERE k=who)
FROM (VALUES (100,'head1'),(20,'child'),(35,'maid')) x(a,who);
INSERT INTO transactions (id,"householdId","accountId",type,amount,currency,"baseAmount","occurredAt","createdById")
VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h2'),'10000000-0000-0000-0000-000000000002','EXPENSE',999,'SAR',999,now(),(SELECT v FROM ids WHERE k='head2'));

-- two vehicles, driver assigned to one
INSERT INTO vehicles (id,"householdId",make,model,year,"plateNumber","updatedAt") VALUES
 ('20000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='h1'),'Toyota','Land Cruiser',2024,'ABC 1234',now()),
 ('20000000-0000-0000-0000-000000000002',(SELECT v FROM ids WHERE k='h1'),'Lexus','ES',2025,'XYZ 5678',now());
INSERT INTO vehicle_assignments (id,"householdId","vehicleId","driverId","startsAt")
VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),'20000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='driver'),now()-interval '1 day');

INSERT INTO portfolios (id,"householdId") VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'));


-- ---------- v2 fixtures: spouse, EFA admin, governance, petty cash, work orders, travel ----------
INSERT INTO users (id, "fullNameI18n", "updatedAt") VALUES
 ('00000000-0000-0000-0000-00000000000f','{"ar":"أم أحمد"}',now()),        -- spouse H1
 ('00000000-0000-0000-0000-000000000010','{"en":"Family office"}',now());  -- EFA admin H1
INSERT INTO ids VALUES ('spouse', pg_temp.add_member('00000000-0000-0000-0000-00000000000f','SPOUSE',null)),
                       ('efa',    pg_temp.add_member('00000000-0000-0000-0000-000000000010','EFA_OFFICE_ADMIN',null));
INSERT INTO ids SELECT 'maidStaff', id FROM staff_profiles WHERE "membershipId"=(SELECT v FROM ids WHERE k='maid');
INSERT INTO ids SELECT 'driverStaff', id FROM staff_profiles WHERE "membershipId"=(SELECT v FROM ids WHERE k='driver');
INSERT INTO ids SELECT 'headRole', id FROM roles WHERE "householdId"=(SELECT v FROM ids WHERE k='h1') AND "systemRole"='HOUSEHOLD_HEAD';
INSERT INTO ids SELECT 'staffRole', id FROM roles WHERE "householdId"=(SELECT v FROM ids WHERE k='h1') AND "systemRole"='STAFF';

-- protected-table rows
INSERT INTO identity_documents (id,"householdId","staffId",type,"numberCiphertext","numberBlindIndex","numberLast4","updatedAt")
VALUES ('30000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='maidStaff'),
        'IQAMA','v1.k1.ct','bi-1','4321',now());
INSERT INTO budgets (id,"householdId",amount,"startsOn") VALUES ('30000000-0000-0000-0000-000000000002',(SELECT v FROM ids WHERE k='h1'),3000,'2026-11-01');
INSERT INTO allowance_plans (id,"householdId","dependentId",amount,"nextPayoutAt")
VALUES ('30000000-0000-0000-0000-000000000003',(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='child'),50,now());
INSERT INTO receipts (id,"householdId","uploadedById","storageKey","mimeType",sha256)
VALUES ('30000000-0000-0000-0000-000000000004',(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='maid'),'k','image/jpeg','abc');
INSERT INTO roles (id,"householdId","systemRole","nameI18n") VALUES ('30000000-0000-0000-0000-000000000005',(SELECT v FROM ids WHERE k='h1'),'STAFF','{"en":"Night nanny"}');

-- approval policy: PURCHASE ≥ 0 → spouse (step 1) then head (step 2); auto-approve under 50
INSERT INTO approval_policies (id,"householdId","requestType","minAmount",steps,"autoApproveBelow")
VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),'PURCHASE',0,
        '[{"step":1,"approverRole":"SPOUSE"},{"step":2,"approverRole":"HOUSEHOLD_HEAD"}]',50);

-- governance documents (published)
INSERT INTO policies (id,"householdId",code,status,"staffTypes","titleI18n","bodyI18n","effectiveFrom","createdById","updatedAt")
VALUES ('40000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='h1'),'DRIVER-DAILY-SAFETY','DRAFT','{DRIVER}',
        '{"ar":"تعليمات السلامة اليومية","bn":"দৈনিক নিরাপত্তা"}','{"ar":"افحص الإطارات","bn":"টায়ার পরীক্ষা করুন"}',
        '2026-11-01',(SELECT v FROM ids WHERE k='head1'),now());
UPDATE policies SET status='PUBLISHED' WHERE id='40000000-0000-0000-0000-000000000001';
INSERT INTO policies (id,"householdId",code,status,"bodyI18n","effectiveFrom","createdById","updatedAt")
VALUES ('40000000-0000-0000-0000-000000000002',(SELECT v FROM ids WHERE k='h1'),'NANNY-DRAFT','DRAFT','{"ar":"مسودة"}','2026-11-01',(SELECT v FROM ids WHERE k='head1'),now());
INSERT INTO privacy_agreements (id,"householdId",type,status,"bodyI18n","dataCategories","surveillanceScope","effectiveFrom","createdById")
VALUES ('40000000-0000-0000-0000-000000000003',(SELECT v FROM ids WHERE k='h1'),'SURVEILLANCE_CONSENT','DRAFT','{"ar":"كاميرات المدخل"}',
        '{cctv_video}','{"cctvZones":["entrance"],"excludedZones":["staff_quarters","bathrooms"]}','2026-11-01',(SELECT v FROM ids WHERE k='head1'));
UPDATE privacy_agreements SET status='PUBLISHED' WHERE id='40000000-0000-0000-0000-000000000003';

-- petty cash: driver float 1000, receipt required over 200
INSERT INTO petty_cash_accounts (id,"householdId","custodianId",currency,"floatLimit","receiptRequiredOver","updatedAt")
VALUES ('50000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='driver'),'SAR',1000,200,now()),
       ('50000000-0000-0000-0000-000000000002',(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='maid'),'SAR',300,100,now());

-- work orders: one for the maid (with a safety-critical instruction), one for the driver
INSERT INTO work_orders (id,"householdId","titleI18n",category,"requesterId","assigneeId","updatedAt")
VALUES ('60000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='h1'),'{"ar":"تحضير غداء الأطفال"}','COOKING',
        (SELECT v FROM ids WHERE k='spouse'),NULL,now()),
       ('60000000-0000-0000-0000-000000000002',(SELECT v FROM ids WHERE k='h1'),'{"ar":"توصيل المدرسة"}','DRIVING',
        (SELECT v FROM ids WHERE k='head1'),(SELECT v FROM ids WHERE k='driver'),now());
INSERT INTO work_order_instructions (id,"householdId","workOrderId",sequence,"textI18n","originalLocale","translationStatus","isSafetyCritical")
VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),'60000000-0000-0000-0000-000000000001',1,
        '{"ar":"أحمد لديه حساسية من الفول السوداني","tl":"May allergy sa mani si Ahmed"}','ar','MACHINE_TRANSLATED',true),
       (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),'60000000-0000-0000-0000-000000000002',1,
        '{"ar":"الانصراف 1:30"}','ar','ORIGINAL_ONLY',false);

-- travel: family trip with the driver travelling as staff passenger
INSERT INTO trips (id,"householdId","organizerId","titleI18n","startDate","endDate","updatedAt")
VALUES ('70000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='head1'),
        '{"ar":"عمرة رمضان"}','2027-02-20','2027-02-25',now());
INSERT INTO trip_passengers (id,"householdId","tripId","membershipId") VALUES
 (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),'70000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='child'));
INSERT INTO trip_passengers (id,"householdId","tripId","staffId","passengerType") VALUES
 (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),'70000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='driverStaff'),'ADULT');
INSERT INTO trip_bookings (id,"householdId","tripId",type,"startAt","createdById","updatedAt")
VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),'70000000-0000-0000-0000-000000000001','HOTEL','2027-02-20 14:00Z',
        (SELECT v FROM ids WHERE k='head1'),now());

INSERT INTO tenant_keys (id,"householdId",version,"kmsKeyName","wrappedDek","wrappedIndexKey")
VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),1,'local','\x00','\x00');

-- Dry-run a write as the current role: returns rows affected (then rolls back),
-- -1 if refused by privileges/RLS, -2 if refused by a check/trigger rule.
CREATE FUNCTION pg_temp.try_rows(q text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  BEGIN
    EXECUTE q; GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = n::text;
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN RETURN SQLERRM::bigint;
    WHEN insufficient_privilege THEN RETURN -1;
    WHEN check_violation OR unique_violation OR raise_exception THEN RETURN -2;
    WHEN foreign_key_violation THEN RETURN -3;
  END;
END $$;
CREATE FUNCTION pg_temp.q(k text) RETURNS text LANGUAGE sql AS $$ SELECT quote_literal(v) FROM ids WHERE ids.k = $1 $$;

-- ---------- coverage: every tenant FK has a same-household trigger ----------
DO $$
DECLARE missing text; n int;
BEGIN
  SELECT string_agg(ch.relname||'.'||a.attname, ', '), count(*) INTO missing, n
  FROM pg_constraint c
  JOIN pg_class ch ON ch.oid = c.conrelid JOIN pg_class pa ON pa.oid = c.confrelid
  JOIN pg_namespace ns ON ns.oid = ch.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype = 'f' AND ns.nspname = 'public' AND a.attname <> 'householdId'
    AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = ch.oid AND x.attname = 'householdId')
    AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = pa.oid AND x.attname = 'householdId')
    AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = ch.oid AND t.tgname = left('a_tenant_ref_' || a.attname, 63));
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'FAIL  tenant references without same-household trigger: %', missing; END IF;
  RAISE NOTICE 'PASS  reference isolation: % same-household triggers (all tenant FKs + uuid arrays/columns)',
    (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'a_tenant_ref_%');
END $$;

-- ---------- coverage: no RLS table may have an un-policed write path ----------
DO $$
DECLARE gaps text;
BEGIN
  WITH t AS (SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity),
  cmds(cmd) AS (VALUES ('INSERT'),('UPDATE'),('DELETE')),
  x AS (SELECT t.relname, cmds.cmd,
          (has_table_privilege('app_user','public.'||quote_ident(t.relname),cmds.cmd)
           OR (cmds.cmd='UPDATE' AND has_any_column_privilege('app_user','public.'||quote_ident(t.relname),'UPDATE'))) AS priv,
          EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename=t.relname AND p.permissive='PERMISSIVE'
                  AND p.cmd IN (cmds.cmd,'ALL') AND 'app_user'=ANY(p.roles)) AS permissive,
          EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename=t.relname AND p.permissive='RESTRICTIVE'
                  AND p.cmd IN (cmds.cmd,'ALL')) AS restrictive
        FROM t, cmds)
  SELECT string_agg(relname||':'||cmd, ', ') INTO gaps FROM x WHERE priv AND permissive AND NOT restrictive;
  IF gaps IS NOT NULL THEN RAISE EXCEPTION 'FAIL  un-policed write paths: %', gaps; END IF;
  RAISE NOTICE 'PASS  write coverage: every INSERT/UPDATE/DELETE on % RLS tables is policed',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity);
END $$;

-- ---------- assertions (as app_user: RLS enforced) ----------
CREATE FUNCTION pg_temp.as_user(u text, hh text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id', u, true);
  PERFORM set_config('app.household_id', (SELECT v::text FROM ids WHERE k=hh), true);
END $$;
CREATE FUNCTION pg_temp.expect(label text, got bigint, want bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got = want THEN RAISE NOTICE 'PASS  %  (%)', label, got;
  ELSE RAISE EXCEPTION 'FAIL  %: got %, want %', label, got, want; END IF;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO app_user;

SET LOCAL ROLE app_user;
\set QUIET off
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a','h1');
SELECT pg_temp.expect('head1: sees all 3 H1 txns, none of H2', (SELECT count(*) FROM transactions), 3);
SELECT pg_temp.expect('head1: sees both payroll lines',        (SELECT count(*) FROM payroll_lines), 2);
SELECT pg_temp.expect('head1: sees both vehicles',             (SELECT count(*) FROM vehicles), 2);
SELECT pg_temp.expect('head1: sees portfolio',                 (SELECT count(*) FROM portfolios), 1);
SELECT pg_temp.expect('head1: sees 6 H1 members',          (SELECT count(*) FROM memberships), 6);

SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a','h2');
SELECT pg_temp.expect('head1 spoofing H2 context: 0 txns',     (SELECT count(*) FROM transactions), 0);
SELECT pg_temp.expect('head1 spoofing H2 context: 0 accounts', (SELECT count(*) FROM financial_accounts), 0);

SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000b','h2');
SELECT pg_temp.expect('head2: sees only own 1 txn',            (SELECT count(*) FROM transactions), 1);

SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c','h1');
SELECT pg_temp.expect('maid: only own txn',                    (SELECT count(*) FROM transactions), 1);
SELECT pg_temp.expect('maid: only own payslip',                (SELECT count(*) FROM payroll_lines), 1);
SELECT pg_temp.expect('maid: only own staff profile',          (SELECT count(*) FROM staff_profiles), 1);
SELECT pg_temp.expect('maid: no vehicles',                     (SELECT count(*) FROM vehicles), 0);
SELECT pg_temp.expect('maid: no investments',                  (SELECT count(*) FROM portfolios), 0);
SELECT pg_temp.expect('maid: no bank account',                 (SELECT count(*) FROM financial_accounts), 0);

SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000d','h1');
SELECT pg_temp.expect('child: only own txn',                   (SELECT count(*) FROM transactions), 1);
SELECT pg_temp.expect('child: no payroll',                     (SELECT count(*) FROM payroll_lines), 0);

SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000e','h1');
SELECT pg_temp.expect('driver: only assigned vehicle',         (SELECT count(*) FROM vehicles), 1);
SELECT pg_temp.expect('driver: only own payslip',              (SELECT count(*) FROM payroll_lines), 1);

-- write checks
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c','h1');
DO $$ BEGIN
  INSERT INTO transactions (id,"householdId","accountId",type,amount,currency,"baseAmount","occurredAt","createdById")
  VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h2'),'10000000-0000-0000-0000-000000000002','EXPENSE',1,'SAR',1,now(),
          (SELECT v FROM ids WHERE k='maid'));
  RAISE EXCEPTION 'FAIL  maid inserted into another household';
EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN RAISE NOTICE 'PASS  maid cannot write into H2';
END $$;
DO $$ BEGIN
  UPDATE payroll_lines SET amount = 9999;
  IF FOUND THEN RAISE EXCEPTION 'FAIL  maid edited payroll'; END IF;
  RAISE NOTICE 'PASS  maid cannot edit payroll';
END $$;
DO $$ BEGIN
  INSERT INTO requests (id,"householdId","requesterId",type,"updatedAt")
  VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='maid'),'SALARY_ADVANCE',now());
  RAISE NOTICE 'PASS  maid can submit a salary-advance request';
END $$;
DO $$ BEGIN
  INSERT INTO requests (id,"householdId","requesterId",type,"updatedAt")
  VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='driver'),'GENERAL',now());
  RAISE EXCEPTION 'FAIL  maid filed request as someone else';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS  maid cannot impersonate another requester';
END $$;
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a','h1');
DO $$ BEGIN
  DELETE FROM transactions;
  IF FOUND THEN RAISE EXCEPTION 'FAIL  ledger rows deleted'; END IF;
  RAISE NOTICE 'PASS  ledger is immutable even for head (no DELETE)';
END $$;

-- ======================= v2 assertions =======================
-- ---- 1. protected tables: only Head / EFA may UPDATE or DELETE ----
CREATE TEMP TABLE probes(label text, upd text, del text);
INSERT INTO probes VALUES
 ('budgets',             $$UPDATE budgets SET amount = 1$$,                     $$DELETE FROM budgets$$),
 ('allowance_plans',     $$UPDATE allowance_plans SET amount = 999$$,           $$DELETE FROM allowance_plans$$),
 ('identity_documents',  $$UPDATE identity_documents SET "numberLast4" = '0000'$$, $$DELETE FROM identity_documents$$),
 ('roles',               $$UPDATE roles SET "nameI18n" = '{}' WHERE NOT "isDefault"$$, $$DELETE FROM roles WHERE NOT "isDefault"$$),
 ('vehicle_assignments', $$UPDATE vehicle_assignments SET "isPrimary" = false$$, $$DELETE FROM vehicle_assignments$$),
 ('receipts',            $$UPDATE receipts SET status = 'REJECTED'$$,           $$DELETE FROM receipts$$);
GRANT SELECT ON probes TO app_user;

DO $$
DECLARE p record; who text; uid text; n_upd bigint; n_del bigint; ok boolean;
BEGIN
  FOR who, uid IN VALUES ('head1','00000000-0000-0000-0000-00000000000a'), ('efa','00000000-0000-0000-0000-000000000010'),
                         ('spouse','00000000-0000-0000-0000-00000000000f'), ('maid','00000000-0000-0000-0000-00000000000c'),
                         ('driver','00000000-0000-0000-0000-00000000000e'), ('child','00000000-0000-0000-0000-00000000000d')
  LOOP
    PERFORM pg_temp.as_user(uid, 'h1');
    FOR p IN SELECT * FROM probes LOOP
      n_upd := pg_temp.try_rows(p.upd); n_del := pg_temp.try_rows(p.del);
      ok := CASE WHEN who IN ('head1','efa') THEN n_upd > 0 AND n_del > 0 ELSE n_upd <= 0 AND n_del <= 0 END;
      IF NOT ok THEN RAISE EXCEPTION 'FAIL  % on %: update=% delete=%', who, p.label, n_upd, n_del; END IF;
    END LOOP;
    RAISE NOTICE 'PASS  % %', rpad(who, 6), CASE WHEN who IN ('head1','efa')
      THEN 'CAN update+delete all 6 protected tables' ELSE 'cannot update/delete any of the 6 protected tables' END;
  END LOOP;
END $$;

-- ---- 2. privilege escalation ----
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c','h1');
SELECT pg_temp.expect('maid cannot promote herself to Head (was possible in v1)',
  pg_temp.try_rows(format('UPDATE memberships SET "roleId" = %s WHERE id = %s', pg_temp.q('headRole'), pg_temp.q('maid'))), -1);
SELECT pg_temp.expect('maid can still change her own display name',
  pg_temp.try_rows(format('UPDATE memberships SET "displayName" = %L WHERE id = %s', 'Ate Maria', pg_temp.q('maid'))), 1);
SELECT pg_temp.expect('maid cannot extend her own access expiry',
  pg_temp.try_rows(format($q$UPDATE memberships SET "expiresAt" = now() + interval '10 years' WHERE id = %s$q$, pg_temp.q('maid'))), -1);
SELECT pg_temp.expect('maid cannot grant herself permission overrides',
  pg_temp.try_rows(format($q$INSERT INTO membership_permissions VALUES (%s, 'invest.read', true, 'ALL')$q$, pg_temp.q('maid'))), -1);

SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000f','h1');
SELECT pg_temp.expect('spouse cannot assign the Head role to the driver',
  pg_temp.try_rows(format('UPDATE memberships SET "roleId" = %s WHERE id = %s', pg_temp.q('headRole'), pg_temp.q('driver'))), -1);
SELECT pg_temp.expect('spouse cannot create a Head-type role',
  pg_temp.try_rows(format($q$INSERT INTO roles (id,"householdId","systemRole") VALUES (gen_random_uuid(), %s, 'HOUSEHOLD_HEAD')$q$, pg_temp.q('h1'))), -1);
SELECT pg_temp.expect('spouse cannot suspend the Head',
  pg_temp.try_rows(format('UPDATE memberships SET status = %L WHERE id = %s', 'SUSPENDED', pg_temp.q('head1'))), -1);
SELECT pg_temp.expect('spouse cannot edit role permission matrix',
  pg_temp.try_rows(format($q$UPDATE role_permissions SET scope = 'ALL' WHERE "roleId" = %s$q$, pg_temp.q('staffRole'))), -1);
SELECT pg_temp.expect('spouse CAN still move the maid between staff roles',
  pg_temp.try_rows(format('UPDATE memberships SET "roleId" = %L WHERE id = %s', '30000000-0000-0000-0000-000000000005', pg_temp.q('maid'))), 1);

SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a','h1');
SELECT pg_temp.expect('the last Head cannot demote themselves',
  pg_temp.try_rows(format('UPDATE memberships SET "roleId" = %s WHERE id = %s', pg_temp.q('staffRole'), pg_temp.q('head1'))), -2);

-- ---- 3. approval routing (approvals are trigger-created only) ----
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c','h1');
SELECT pg_temp.expect('maid cannot insert approval rows directly',
  pg_temp.try_rows(format($q$INSERT INTO approvals (id,"householdId","requestId",step,"approverId")
     SELECT gen_random_uuid(), %s, id, 1, %s FROM requests LIMIT 1$q$, pg_temp.q('h1'), pg_temp.q('maid'))), -1);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000d','h1');
INSERT INTO requests (id,"householdId","requesterId",type,amount,currency,"updatedAt") VALUES
 ('80000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='child'),'PURCHASE',30,'SAR',now()),
 ('80000000-0000-0000-0000-000000000002',(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='child'),'PURCHASE',500,'SAR',now());
SELECT pg_temp.expect('child purchase 30 SAR auto-approved (under policy threshold)',
  (SELECT count(*) FROM requests WHERE id='80000000-0000-0000-0000-000000000001' AND status='APPROVED'), 1);
SELECT pg_temp.expect('child purchase 500 SAR → spouse at step 1, head at step 2',
  (SELECT count(*) FROM approvals a JOIN memberships m ON m.id=a."approverId" JOIN roles r ON r.id=m."roleId"
   WHERE a."requestId"='80000000-0000-0000-0000-000000000002'
     AND ((a.step=1 AND r."systemRole"='SPOUSE') OR (a.step=2 AND r."systemRole"='HOUSEHOLD_HEAD'))), 2);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c','h1');
SELECT pg_temp.expect('maid sees the 2 approvers on her advance request (no policy → Head + EFA)',
  (SELECT count(*) FROM approvals a JOIN requests r ON r.id=a."requestId" WHERE r.type='SALARY_ADVANCE'), 2);
SELECT pg_temp.expect('…and she is not her own approver',
  (SELECT count(*) FROM approvals WHERE "approverId" = (SELECT v FROM ids WHERE k='maid')), 0);
RESET ROLE;
SELECT pg_temp.expect('  …verified as superuser: 2 approvers, both admins',
  (SELECT count(*) FROM approvals a JOIN requests r ON r.id=a."requestId" JOIN memberships m ON m.id=a."approverId"
   JOIN roles ro ON ro.id=m."roleId" WHERE r.type='SALARY_ADVANCE' AND ro."systemRole" IN ('HOUSEHOLD_HEAD','EFA_OFFICE_ADMIN')), 2);
SET LOCAL ROLE app_user;

-- ---- 4. governance & acknowledgments ----
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000e','h1');
SELECT pg_temp.expect('driver sees published policy, not drafts', (SELECT count(*) FROM policies), 1);
SELECT pg_temp.expect('driver cannot edit a policy',
  pg_temp.try_rows($q$UPDATE policies SET "bodyI18n" = '{}'$q$), 0);
INSERT INTO policy_acknowledgments (id,"householdId","membershipId","policyId","documentVersion","contentHash",locale,method)
VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='driver'),
        '40000000-0000-0000-0000-000000000001',1,'sha','bn','TAP_TO_ACCEPT');
SELECT pg_temp.expect('driver acknowledged today''s safety policy (in Bengali)', (SELECT count(*) FROM policy_acknowledgments), 1);
SELECT pg_temp.expect('…but only once per day',
  pg_temp.try_rows(format($q$INSERT INTO policy_acknowledgments (id,"householdId","membershipId","policyId","documentVersion","contentHash",locale)
     VALUES (gen_random_uuid(), %s, %s, '40000000-0000-0000-0000-000000000001', 1, 'sha', 'bn')$q$, pg_temp.q('h1'), pg_temp.q('driver'))), -2);
SELECT pg_temp.expect('driver cannot acknowledge on the maid''s behalf',
  pg_temp.try_rows(format($q$INSERT INTO policy_acknowledgments (id,"householdId","membershipId","policyId","documentVersion","contentHash",locale)
     VALUES (gen_random_uuid(), %s, %s, '40000000-0000-0000-0000-000000000001', 1, 'sha', 'tl')$q$, pg_temp.q('h1'), pg_temp.q('maid'))), -1);
SELECT pg_temp.expect('cannot acknowledge a draft',
  pg_temp.try_rows(format($q$INSERT INTO policy_acknowledgments (id,"householdId","membershipId","policyId","documentVersion","contentHash",locale)
     VALUES (gen_random_uuid(), %s, %s, '40000000-0000-0000-0000-000000000002', 1, 'sha', 'bn')$q$, pg_temp.q('h1'), pg_temp.q('driver'))), -2);  -- refused by the version trigger
SELECT pg_temp.expect('acknowledgment evidence cannot be deleted',
  pg_temp.try_rows($q$DELETE FROM policy_acknowledgments$q$), 0);
SELECT pg_temp.expect('acknowledgment hash cannot be rewritten (column grant)',
  pg_temp.try_rows($q$UPDATE policy_acknowledgments SET "contentHash" = 'forged'$q$), -1);
INSERT INTO policy_acknowledgments (id,"householdId","membershipId","privacyAgreementId","documentVersion","contentHash",locale,method)
VALUES ('40000000-0000-0000-0000-0000000000a1',(SELECT v FROM ids WHERE k='h1'),(SELECT v FROM ids WHERE k='driver'),
        '40000000-0000-0000-0000-000000000003',1,'sha','bn','OTP_CONFIRMED');
SELECT pg_temp.expect('driver can WITHDRAW surveillance consent (PDPL)',
  pg_temp.try_rows($q$UPDATE policy_acknowledgments SET "withdrawnAt" = now(), "withdrawalReason" = 'x'
                     WHERE id = '40000000-0000-0000-0000-0000000000a1'$q$), 1);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a','h1');
SELECT pg_temp.expect('published policy text is frozen, even for the Head',
  pg_temp.try_rows($q$UPDATE policies SET "bodyI18n" = '{"ar":"x"}' WHERE id = '40000000-0000-0000-0000-000000000001'$q$), -1);
SELECT pg_temp.expect('Head sees acknowledgment ledger', (SELECT count(*) FROM policy_acknowledgments), 2);
SELECT pg_temp.expect('publishing stamped a sha256 content hash',
  (SELECT count(*) FROM policies WHERE length("contentHash") = 64), 1);

-- ---- 5. petty cash ----
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a','h1');
INSERT INTO petty_cash_logs (id,"householdId","accountId",type,amount,"recordedById")
VALUES (gen_random_uuid(),(SELECT v FROM ids WHERE k='h1'),'50000000-0000-0000-0000-000000000001','TOP_UP',500,(SELECT v FROM ids WHERE k='head1'));
SELECT pg_temp.expect('Head tops up driver float to 500',
  (SELECT "currentBalance"::int FROM petty_cash_accounts WHERE id='50000000-0000-0000-0000-000000000001'), 500);
SELECT pg_temp.expect('top-up beyond the 1000 float limit refused',
  pg_temp.try_rows(format($q$INSERT INTO petty_cash_logs (id,"householdId","accountId",type,amount,"recordedById")
     VALUES (gen_random_uuid(), %s, '50000000-0000-0000-0000-000000000001', 'TOP_UP', 600, %s)$q$, pg_temp.q('h1'), pg_temp.q('head1'))), -2);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000e','h1');
INSERT INTO petty_cash_logs (id,"householdId","accountId",type,amount,"recordedById","merchantName")
VALUES ('50000000-0000-0000-0000-0000000000b1',(SELECT v FROM ids WHERE k='h1'),'50000000-0000-0000-0000-000000000001','EXPENSE',120,(SELECT v FROM ids WHERE k='driver'),'ADNOC');
SELECT pg_temp.expect('driver logs 120 SAR fuel → balance 380',
  (SELECT "currentBalance"::int FROM petty_cash_accounts), 380);
SELECT pg_temp.expect('driver''s own expense lands as PENDING_REVIEW',
  (SELECT count(*) FROM petty_cash_logs WHERE status='PENDING_REVIEW'), 1);
SELECT pg_temp.expect('expense over 200 without receipt refused',
  pg_temp.try_rows(format($q$INSERT INTO petty_cash_logs (id,"householdId","accountId",type,amount,"recordedById")
     VALUES (gen_random_uuid(), %s, '50000000-0000-0000-0000-000000000001', 'EXPENSE', 250, %s)$q$, pg_temp.q('h1'), pg_temp.q('driver'))), -2);
SELECT pg_temp.expect('driver cannot top himself up',
  pg_temp.try_rows(format($q$INSERT INTO petty_cash_logs (id,"householdId","accountId",type,amount,"recordedById")
     VALUES (gen_random_uuid(), %s, '50000000-0000-0000-0000-000000000001', 'TOP_UP', 100, %s)$q$, pg_temp.q('h1'), pg_temp.q('driver'))), -1);
SELECT pg_temp.expect('driver cannot log against the maid''s float',
  pg_temp.try_rows(format($q$INSERT INTO petty_cash_logs (id,"householdId","accountId",type,amount,"recordedById")
     VALUES (gen_random_uuid(), %s, '50000000-0000-0000-0000-000000000002', 'EXPENSE', 10, %s)$q$, pg_temp.q('h1'), pg_temp.q('driver'))), -1);
SELECT pg_temp.expect('driver cannot set his balance directly',
  pg_temp.try_rows($q$UPDATE petty_cash_accounts SET "currentBalance" = 9999$q$), -1);
SELECT pg_temp.expect('driver cannot approve his own expense',
  pg_temp.try_rows($q$UPDATE petty_cash_logs SET status = 'APPROVED'$q$), 0);
SELECT pg_temp.expect('driver cannot delete a log', pg_temp.try_rows($q$DELETE FROM petty_cash_logs$q$), 0);
SELECT pg_temp.expect('driver sees only his own float', (SELECT count(*) FROM petty_cash_accounts), 1);
SELECT pg_temp.expect('returning 400 SAR with only 380 in hand is refused (no overdraft)',
  pg_temp.try_rows(format($q$INSERT INTO petty_cash_logs (id,"householdId","accountId",type,amount,"recordedById","receiptId")
     VALUES (gen_random_uuid(), %s, '50000000-0000-0000-0000-000000000001', 'RETURN', 400, %s, NULL)$q$, pg_temp.q('h1'), pg_temp.q('driver'))), -2);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a','h1');
SELECT pg_temp.expect('Head approves the pending expense',
  pg_temp.try_rows($q$UPDATE petty_cash_logs SET status = 'APPROVED' WHERE id = '50000000-0000-0000-0000-0000000000b1'$q$), 1);
SELECT pg_temp.expect('…but cannot alter the amount after the fact',
  pg_temp.try_rows($q$UPDATE petty_cash_logs SET amount = 1 WHERE id = '50000000-0000-0000-0000-0000000000b1'$q$), -1);

-- ---- 6. work orders ----
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000f','h1');
SELECT pg_temp.expect('work orders numbered per household', (SELECT max(number) FROM work_orders), 2);
SELECT pg_temp.expect('dispatching with an unreviewed safety-critical translation is blocked',
  pg_temp.try_rows(format($q$UPDATE work_orders SET "assigneeId" = %s, status = 'ASSIGNED'
     WHERE id = '60000000-0000-0000-0000-000000000001'$q$, pg_temp.q('maid'))), -2);
UPDATE work_order_instructions SET "translationStatus" = 'HUMAN_REVIEWED' WHERE "workOrderId" = '60000000-0000-0000-0000-000000000001';
UPDATE work_orders SET "assigneeId" = (SELECT v FROM ids WHERE k='maid'), status = 'ASSIGNED' WHERE id = '60000000-0000-0000-0000-000000000001';
SELECT pg_temp.expect('…after human review it dispatches', (SELECT count(*) FROM work_orders WHERE status='ASSIGNED'), 2);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c','h1');
SELECT pg_temp.expect('maid sees only her work order', (SELECT count(*) FROM work_orders), 1);
SELECT pg_temp.expect('maid sees its instruction (allergy, in Tagalog)',
  (SELECT count(*) FROM work_order_instructions WHERE "textI18n" ? 'tl'), 1);
SELECT pg_temp.expect('maid can complete her work order',
  pg_temp.try_rows($q$UPDATE work_orders SET status = 'COMPLETED' WHERE id = '60000000-0000-0000-0000-000000000001'$q$), 1);
UPDATE work_orders SET status = 'COMPLETED' WHERE id = '60000000-0000-0000-0000-000000000001';
SELECT pg_temp.expect('maid cannot verify her own work',
  pg_temp.try_rows($q$UPDATE work_orders SET status = 'VERIFIED' WHERE id = '60000000-0000-0000-0000-000000000001'$q$), -1);
SELECT pg_temp.expect('maid cannot delete a work order', pg_temp.try_rows($q$DELETE FROM work_orders$q$), 0);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000f','h1');
SELECT pg_temp.expect('requester (spouse) verifies it',
  pg_temp.try_rows($q$UPDATE work_orders SET status = 'VERIFIED', rating = 5 WHERE id = '60000000-0000-0000-0000-000000000001'$q$), 1);

-- ---- 7. travel ----
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000e','h1');
SELECT pg_temp.expect('driver (staff passenger) sees the trip he travels on', (SELECT count(*) FROM trips), 1);
SELECT pg_temp.expect('…and its bookings', (SELECT count(*) FROM trip_bookings), 1);
SELECT pg_temp.expect('…but cannot edit bookings', pg_temp.try_rows($q$UPDATE trip_bookings SET amount = 1$q$), 0);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c','h1');
SELECT pg_temp.expect('maid (not travelling) sees no trips', (SELECT count(*) FROM trips), 0);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000d','h1');
SELECT pg_temp.expect('child passenger sees the trip', (SELECT count(*) FROM trips), 1);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000b','h2');
SELECT pg_temp.expect('other household sees none of it',
  (SELECT count(*) FROM trips) + (SELECT count(*) FROM work_orders) + (SELECT count(*) FROM petty_cash_logs)
  + (SELECT count(*) FROM policy_acknowledgments), 0);

-- ---- 8. cross-household references ----
RESET ROLE;
INSERT INTO categories (id,"householdId",kind,"nameI18n") VALUES ('90000000-0000-0000-0000-000000000002',(SELECT v FROM ids WHERE k='h2'),'EXPENSE','{"en":"H2 cat"}');
INSERT INTO categories (id,"householdId",kind,"nameI18n") VALUES ('90000000-0000-0000-0000-000000000001',(SELECT v FROM ids WHERE k='h1'),'EXPENSE','{"en":"H1 cat"}');
SELECT pg_temp.expect('even a superuser/worker cannot link H1 data to an H2 account',
  pg_temp.try_rows(format($q$INSERT INTO transactions (id,"householdId","accountId",type,amount,currency,"baseAmount","occurredAt","createdById")
     VALUES (gen_random_uuid(), %s, '10000000-0000-0000-0000-000000000002', 'EXPENSE', 1, 'SAR', 1, now(), %s)$q$, pg_temp.q('h1'), pg_temp.q('head1'))), -3);
SET LOCAL ROLE app_user;
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a','h1');
SELECT pg_temp.expect('head cannot record an H1 expense on H2''s bank account (guessed UUID)',
  pg_temp.try_rows(format($q$INSERT INTO transactions (id,"householdId","accountId",type,amount,currency,"baseAmount","occurredAt","createdById")
     VALUES (gen_random_uuid(), %s, '10000000-0000-0000-0000-000000000002', 'EXPENSE', 1, 'SAR', 1, now(), %s)$q$, pg_temp.q('h1'), pg_temp.q('head1'))), -3);
SELECT pg_temp.expect('…nor re-point an existing transaction to it (UPDATE)',
  pg_temp.try_rows($q$UPDATE transactions SET "counterAccountId" = '10000000-0000-0000-0000-000000000002'$q$), -3);
SELECT pg_temp.expect('…nor assign a work order to another household''s member',
  pg_temp.try_rows(format($q$UPDATE work_orders SET "assigneeId" = %s WHERE id = '60000000-0000-0000-0000-000000000002'$q$, pg_temp.q('head2'))), -3);
SELECT pg_temp.expect('…nor allow a card to spend in another household''s category (uuid array)',
  pg_temp.try_rows(format($q$INSERT INTO cards (id,"householdId","accountId",type,last4,"expiryMonth","expiryYear","allowedCategoryIds","updatedAt")
     VALUES (gen_random_uuid(), %s, '10000000-0000-0000-0000-000000000001', 'PREPAID', '1234', 1, 2030,
             ARRAY['90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000002']::uuid[], now())$q$, pg_temp.q('h1'))), -3);
SELECT pg_temp.expect('…while own-household references still work',
  pg_temp.try_rows(format($q$INSERT INTO cards (id,"householdId","accountId",type,last4,"expiryMonth","expiryYear","allowedCategoryIds","updatedAt")
     VALUES (gen_random_uuid(), %s, '10000000-0000-0000-0000-000000000001', 'PREPAID', '1234', 1, 2030,
             ARRAY['90000000-0000-0000-0000-000000000001']::uuid[], now())$q$, pg_temp.q('h1'))), 1);
SELECT pg_temp.expect('…and the error never reveals whether the foreign id exists',
  (SELECT count(*) FROM (SELECT 1) x WHERE pg_temp.try_rows(format($q$INSERT INTO transactions (id,"householdId","accountId",type,amount,currency,"baseAmount","occurredAt","createdById")
     VALUES (gen_random_uuid(), %s, gen_random_uuid(), 'EXPENSE', 1, 'SAR', 1, now(), %s)$q$, pg_temp.q('h1'), pg_temp.q('head1'))) = -3), 1);

-- ---- 9. tenant keys ----
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a','h1');
SELECT pg_temp.expect('API can read its own wrapped tenant key', (SELECT count(*) FROM tenant_keys), 1);
SELECT pg_temp.expect('…but never write one', pg_temp.try_rows($q$UPDATE tenant_keys SET status = 'DESTROYED'$q$), -1);
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000b','h2');
SELECT pg_temp.expect('other household cannot see H1 key', (SELECT count(*) FROM tenant_keys), 0);

ROLLBACK;
