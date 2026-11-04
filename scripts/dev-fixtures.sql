-- Demo data for local development and the API e2e tests. Fixed UUIDs so tests can reference them.
SELECT set_config('app.user_id', 'a0000000-0000-0000-0000-000000000001', false);
INSERT INTO users (id, "fullNameI18n", "preferredLocale", "updatedAt") VALUES
 ('a0000000-0000-0000-0000-000000000001', '{"ar":"ماجد","en":"Majid"}', 'ar', now()),   -- head
 ('a0000000-0000-0000-0000-000000000002', '{"en":"EFA Office"}',       'ar', now()),   -- EFA admin
 ('a0000000-0000-0000-0000-000000000003', '{"tl":"Maria"}',            'tl', now()),   -- maid
 ('a0000000-0000-0000-0000-000000000004', '{"ar":"أم أحمد"}',          'ar', now()),   -- spouse
 ('a0000000-0000-0000-0000-000000000009', '{"en":"Other head"}',       'en', now());   -- head of household 2

-- Fixed ids via p_id (renaming ids after the fact would cascade through tables
-- in arbitrary order and trip the same-household reference triggers).
SELECT app.provision_household('a0000000-0000-0000-0000-000000000001', 'demo', '{"ar":"بيت ماجد","en":"Majid household"}', 'ar',
                               'b0000000-0000-0000-0000-000000000001');
SELECT set_config('app.user_id', 'a0000000-0000-0000-0000-000000000009', false);
SELECT app.provision_household('a0000000-0000-0000-0000-000000000009', 'other', '{"en":"Other household"}', 'en',
                               'b0000000-0000-0000-0000-000000000002');

INSERT INTO memberships (id, "householdId", "userId", "roleId", status, "displayName", "updatedAt")
SELECT v.mid::uuid, 'b0000000-0000-0000-0000-000000000001', v.uid::uuid, r.id, 'ACTIVE', v.dn, now()
FROM (VALUES ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'EFA_OFFICE_ADMIN', 'EFA'),
             ('c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'STAFF', 'Maria'),
             ('c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', 'SPOUSE', 'Umm Ahmed')) v(mid, uid, role, dn)
JOIN roles r ON r."householdId" = 'b0000000-0000-0000-0000-000000000001' AND r."systemRole" = v.role::"SystemRole";
RESET app.user_id;
