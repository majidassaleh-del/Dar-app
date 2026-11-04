-- =============================================================================
--  Permission catalogue + default role matrix (run BEFORE rls.sql uses them;
--  idempotent). Households copy this template at provisioning time, then the
--  Household Head may customise their own copy.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS app;

INSERT INTO permissions (id, module, description) VALUES
  ('admin.household.manage',     'admin',    'Settings, billing, delete household'),
  ('admin.members.manage',       'admin',    'Invite/suspend members, edit roles & overrides'),
  ('admin.audit.read',           'admin',    'Read audit log'),
  ('staff.profile.read',         'staff',    'View staff profiles'),
  ('staff.profile.manage',       'staff',    'Create/edit staff, documents, contracts'),
  ('staff.documents.read',       'staff',    'View passports / iqama / visas'),
  ('staff.payroll.read',         'staff',    'View salaries, payslips, advances, leave'),
  ('staff.payroll.manage',       'staff',    'Run payroll, approve advances'),
  ('staff.attendance.manage',    'staff',    'Record attendance'),
  ('staff.tasks.manage',         'staff',    'Assign and manage chores'),
  ('finance.accounts.read',      'finance',  'View bank / cash accounts & balances'),
  ('finance.accounts.manage',    'finance',  'Manage accounts, reconcile, reverse txns'),
  ('finance.cards.read',         'finance',  'View cards'),
  ('finance.cards.manage',       'finance',  'Issue/freeze cards, set limits'),
  ('finance.transactions.read',  'finance',  'View transactions'),
  ('finance.transactions.create','finance',  'Record expenses/income'),
  ('finance.receipts.upload',    'finance',  'Upload receipts'),
  ('finance.budgets.manage',     'finance',  'Create budgets'),
  ('finance.allowance.manage',   'finance',  'Manage dependents allowances'),
  ('finance.reports.read',       'finance',  'Financial reports & exports'),
  ('requests.create',            'requests', 'Submit requests'),
  ('requests.read',              'requests', 'View requests'),
  ('requests.approve',           'requests', 'Approve / reject requests'),
  ('invest.read',                'invest',   'View portfolios, net worth, zakat'),
  ('invest.manage',              'invest',   'Record trades, valuations'),
  ('fleet.read',                 'fleet',    'View vehicles'),
  ('fleet.manage',               'fleet',    'Manage vehicles, assignments, maintenance'),
  ('fleet.trips.log',            'fleet',    'Log trips / odometer'),
  ('fleet.fuel.log',             'fleet',    'Log fuel fill-ups'),
  ('property.read',              'property', 'View properties, leases, bills'),
  ('property.manage',            'property', 'Manage properties, leases, bills'),
  ('property.tickets.create',    'property', 'Report a maintenance issue'),
  ('governance.read',            'governance', 'Read published policies, code of ethics, privacy terms'),
  ('governance.manage',          'governance', 'Draft, translate and publish governance documents'),
  ('governance.acknowledgments.read', 'governance', 'See who acknowledged what, and consent withdrawals'),
  ('finance.pettycash.read',     'finance',  'View petty-cash floats and logs'),
  ('finance.pettycash.log',      'finance',  'Record expenses / returns on own float'),
  ('finance.pettycash.manage',   'finance',  'Create floats, top up, adjust, review expenses'),
  ('workorders.create',          'workorders', 'Raise a work order'),
  ('workorders.read',            'workorders', 'View work orders'),
  ('workorders.manage',          'workorders', 'Assign, edit, cancel any work order'),
  ('travel.read',                'travel',   'View trips, passengers, bookings'),
  ('travel.manage',              'travel',   'Plan trips and manage bookings')
ON CONFLICT (id) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

DROP TABLE IF EXISTS app.role_template;
CREATE TABLE app.role_template (system_role text, permission_id text REFERENCES permissions(id), scope text,
                                PRIMARY KEY (system_role, permission_id));

-- HOUSEHOLD_HEAD: everything, ALL scope
INSERT INTO app.role_template SELECT 'HOUSEHOLD_HEAD', id, 'ALL' FROM permissions;

-- EFA_OFFICE_ADMIN (family-office administrator): everything except billing / deleting the household
INSERT INTO app.role_template SELECT 'EFA_OFFICE_ADMIN', id, 'ALL' FROM permissions
  WHERE id <> 'admin.household.manage';

-- SPOUSE: everything except household deletion/billing and trading; WARDS for allowance
INSERT INTO app.role_template SELECT 'SPOUSE', id, 'ALL' FROM permissions
  WHERE id NOT IN ('admin.household.manage', 'invest.manage');

INSERT INTO app.role_template (system_role, permission_id, scope) VALUES
  -- DEPENDENT (children): own money, own requests, own chores
  ('DEPENDENT', 'finance.transactions.read',   'OWN'),
  ('DEPENDENT', 'finance.transactions.create', 'OWN'),
  ('DEPENDENT', 'finance.cards.read',          'OWN'),
  ('DEPENDENT', 'finance.receipts.upload',     'OWN'),
  ('DEPENDENT', 'requests.create',             'OWN'),
  ('DEPENDENT', 'requests.read',               'OWN'),
  ('DEPENDENT', 'staff.tasks.manage',          'ASSIGNED'),
  ('DEPENDENT', 'property.tickets.create',     'OWN'),
  ('DEPENDENT', 'travel.read',                 'OWN'),
  ('DEPENDENT', 'workorders.create',           'OWN'),
  ('DEPENDENT', 'workorders.read',             'OWN'),
  -- STAFF: own HR file, own petty cash, own tasks
  ('STAFF', 'staff.profile.read',          'OWN'),
  ('STAFF', 'staff.documents.read',        'OWN'),
  ('STAFF', 'staff.payroll.read',          'OWN'),
  ('STAFF', 'staff.attendance.manage',     'OWN'),
  ('STAFF', 'staff.tasks.manage',          'ASSIGNED'),
  ('STAFF', 'finance.accounts.read',       'OWN'),   -- petty-cash box they hold
  ('STAFF', 'finance.transactions.read',   'OWN'),
  ('STAFF', 'finance.transactions.create', 'OWN'),
  ('STAFF', 'finance.receipts.upload',     'OWN'),
  ('STAFF', 'requests.create',             'OWN'),
  ('STAFF', 'requests.read',               'OWN'),
  ('STAFF', 'property.tickets.create',     'OWN'),
  ('STAFF', 'governance.read',             'ALL'),
  ('STAFF', 'finance.pettycash.read',      'OWN'),
  ('STAFF', 'finance.pettycash.log',       'OWN'),
  ('STAFF', 'workorders.create',           'OWN'),
  ('STAFF', 'workorders.read',             'ASSIGNED'),
  ('STAFF', 'travel.read',                 'OWN'),
  -- DRIVER: STAFF + assigned vehicles
  ('DRIVER', 'staff.profile.read',          'OWN'),
  ('DRIVER', 'staff.documents.read',        'OWN'),
  ('DRIVER', 'staff.payroll.read',          'OWN'),
  ('DRIVER', 'staff.attendance.manage',     'OWN'),
  ('DRIVER', 'staff.tasks.manage',          'ASSIGNED'),
  ('DRIVER', 'finance.accounts.read',       'OWN'),
  ('DRIVER', 'finance.cards.read',          'OWN'),   -- fuel card
  ('DRIVER', 'finance.transactions.read',   'OWN'),
  ('DRIVER', 'finance.transactions.create', 'OWN'),
  ('DRIVER', 'finance.receipts.upload',     'OWN'),
  ('DRIVER', 'requests.create',             'OWN'),
  ('DRIVER', 'requests.read',               'OWN'),
  ('DRIVER', 'fleet.read',                  'ASSIGNED'),
  ('DRIVER', 'fleet.trips.log',             'ASSIGNED'),
  ('DRIVER', 'fleet.fuel.log',              'ASSIGNED'),
  ('DRIVER', 'property.tickets.create',     'OWN'),
  ('DRIVER', 'governance.read',             'ALL'),
  ('DRIVER', 'finance.pettycash.read',      'OWN'),
  ('DRIVER', 'finance.pettycash.log',       'OWN'),
  ('DRIVER', 'workorders.create',           'OWN'),
  ('DRIVER', 'workorders.read',             'ASSIGNED'),
  ('DRIVER', 'travel.read',                 'OWN'),
  -- ACCOUNTANT: read-only finance, payroll, investments, property
  ('ACCOUNTANT', 'finance.accounts.read',     'ALL'),
  ('ACCOUNTANT', 'finance.cards.read',        'ALL'),
  ('ACCOUNTANT', 'finance.transactions.read', 'ALL'),
  ('ACCOUNTANT', 'finance.reports.read',      'ALL'),
  ('ACCOUNTANT', 'staff.payroll.read',        'ALL'),
  ('ACCOUNTANT', 'invest.read',               'ALL'),
  ('ACCOUNTANT', 'property.read',             'ALL'),
  ('ACCOUNTANT', 'requests.read',             'ALL'),
  ('ACCOUNTANT', 'finance.pettycash.read',    'ALL'),
  -- GUEST: can report issues only
  ('GUEST', 'property.tickets.create', 'OWN');

DROP TABLE IF EXISTS app.role_names;
CREATE TABLE app.role_names (system_role text PRIMARY KEY, name_i18n jsonb);
INSERT INTO app.role_names VALUES
  ('HOUSEHOLD_HEAD', '{"ar":"رب الأسرة","en":"Household Head","hi":"परिवार प्रमुख","tl":"Pinuno ng Sambahayan","am":"የቤተሰብ ኃላፊ","bn":"পরিবারের প্রধান"}'),
  -- EFA = Esam Alnahdi Family Affairs (مكتب عصام النهدي الخاص). Arabic label is the official one; others translated.
  ('EFA_OFFICE_ADMIN', '{"ar":"مكتب EFA - الإدارة التشغيلية","en":"EFA Office – Operations Management","hi":"EFA कार्यालय – परिचालन प्रबंधन","tl":"EFA Office – Pamamahala ng Operasyon","am":"የEFA ቢሮ – የሥራ ክንውን አስተዳደር","bn":"EFA অফিস – পরিচালন ব্যবস্থাপনা"}'),
  ('SPOUSE',         '{"ar":"الزوج / الزوجة","en":"Spouse","hi":"जीवनसाथी","tl":"Asawa","am":"የትዳር ጓደኛ","bn":"স্বামী/স্ত্রী"}'),
  ('DEPENDENT',      '{"ar":"الأبناء / المُعالون","en":"Dependent","hi":"आश्रित","tl":"Dependiyente","am":"ጥገኛ","bn":"নির্ভরশীল"}'),
  ('STAFF',          '{"ar":"العمالة المنزلية","en":"Domestic Staff","hi":"घरेलू कर्मचारी","tl":"Kasambahay","am":"የቤት ሠራተኛ","bn":"গৃহকর্মী"}'),
  ('DRIVER',         '{"ar":"السائق","en":"Driver","hi":"ड्राइवर","tl":"Drayber","am":"ሹፌር","bn":"চালক"}'),
  ('ACCOUNTANT',     '{"ar":"المحاسب","en":"Accountant","hi":"लेखाकार","tl":"Accountant","am":"የሂሳብ ባለሙያ","bn":"হিসাবরক্ষক"}'),
  ('GUEST',          '{"ar":"ضيف","en":"Guest","hi":"अतिथि","tl":"Bisita","am":"እንግዳ","bn":"অতিথি"}');
