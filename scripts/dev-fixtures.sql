-- Demo data for local development and the API e2e tests. Fixed UUIDs so tests can reference them.
SELECT set_config('app.user_id', 'a0000000-0000-0000-0000-000000000001', false);
INSERT INTO users (id, "fullNameI18n", "preferredLocale", "updatedAt") VALUES
 ('a0000000-0000-0000-0000-000000000001', '{"ar":"ماجد","en":"Majid"}', 'ar', now()),   -- head
 ('a0000000-0000-0000-0000-000000000002', '{"en":"EFA Office"}',       'ar', now()),   -- EFA admin
 ('a0000000-0000-0000-0000-000000000003', '{"tl":"Maria"}',            'tl', now()),   -- maid
 ('a0000000-0000-0000-0000-000000000004', '{"ar":"أم أحمد"}',          'ar', now()),   -- spouse
 ('a0000000-0000-0000-0000-000000000005', '{"am":"Tigist"}',           'am', now()),   -- nanny
 ('a0000000-0000-0000-0000-000000000006', '{"hi":"Sunita"}',           'hi', now()),   -- cook (ledger suite)
 ('a0000000-0000-0000-0000-000000000007', '{"ar":"سمير"}',             'ar', now()),   -- gardener (HR extension suite)
 ('a0000000-0000-0000-0000-000000000008', '{"bn":"Rahim"}',           'bn', now()),   -- driver (fleet suite)
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
             ('c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', 'SPOUSE', 'Umm Ahmed'),
             ('c0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000005', 'STAFF', 'Tigist'),
             ('c0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000006', 'STAFF', 'Sunita'),
             ('c0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000007', 'STAFF', 'Samir'),
             ('c0000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000008', 'DRIVER', 'Rahim')) v(mid, uid, role, dn)
JOIN roles r ON r."householdId" = 'b0000000-0000-0000-0000-000000000001' AND r."systemRole" = v.role::"SystemRole";
RESET app.user_id;

-- Fixture users count as onboarded (phone + email verified), so the e2e suites exercise the
-- modules; the onboarding suite uses fresh users. They have no authenticator yet: a person
-- signing in on the web enrols one on first sign-in (an authenticator is never marked verified
-- without a secret behind it).
INSERT INTO user_auth_factors ("userId", "phoneVerifiedAt", "emailVerifiedAt", "onboardedAt")
SELECT id, now(), now(), now() FROM users WHERE id::text LIKE 'a0000000-%';

