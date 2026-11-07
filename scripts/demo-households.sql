-- Demo tenants for local development / screenshots (applied after dev-db.sh --fixtures).
-- H1 = EFA Private Office, H2 = AFA Household; the EFA office (user …0002) serves both.
UPDATE households SET slug = 'efa', "nameI18n" = '{"ar":"مكتب EFA الخاص","en":"EFA Private Office"}' WHERE id = 'b0000000-0000-0000-0000-000000000001';
UPDATE households SET slug = 'afa', "nameI18n" = '{"ar":"منزل AFA","en":"AFA Household"}' WHERE id = 'b0000000-0000-0000-0000-000000000002';
INSERT INTO memberships (id, "householdId", "userId", "roleId", status, "displayName", "updatedAt")
SELECT 'c0000000-0000-0000-0000-0000000000a2', 'b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', r.id, 'ACTIVE', 'EFA', now()
FROM roles r WHERE r."householdId" = 'b0000000-0000-0000-0000-000000000002' AND r."systemRole" = 'EFA_OFFICE_ADMIN'
ON CONFLICT DO NOTHING;
