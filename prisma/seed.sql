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
  ('travel.manage',              'travel',   'Plan trips and manage bookings'),
  ('finance.ledger.read',        'finance',  'Read the chart of accounts, journals, trial balance'),
  ('finance.ledger.manage',      'finance',  'Manage accounts, post manual journals, reverse entries'),
  ('staff.health.read',          'staff',    'Read health records and medical checkups (PDPL sensitive data)'),
  ('staff.health.manage',        'staff',    'Record medical checkups and health information')
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
  WHERE id NOT IN ('admin.household.manage', 'invest.manage', 'staff.health.read', 'staff.health.manage'); -- health is need-to-know

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
  ('STAFF', 'staff.health.read',           'OWN'),
  ('STAFF', 'staff.health.manage',         'OWN'),   -- self-disclosure of conditions / allergies
  ('STAFF', 'finance.cards.read',          'OWN'),   -- a holder sees (and can freeze) their own card
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
  ('DRIVER', 'staff.health.read',           'OWN'),
  ('DRIVER', 'staff.health.manage',         'OWN'),   -- self-disclosure of conditions / allergies
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
  ('ACCOUNTANT', 'finance.ledger.read',       'ALL'),
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

-- Chart-of-accounts template, copied into each household by app.ensure_chart_of_accounts().
DROP TABLE IF EXISTS app.coa_template;
CREATE TABLE app.coa_template (code text PRIMARY KEY, system_key text UNIQUE, type text, parent_key text, is_header boolean, name_i18n jsonb);
INSERT INTO app.coa_template VALUES
  ('1000', 'assets',             'ASSET',     NULL,          true,  '{"ar":"الأصول","en":"Assets"}'),
  ('1100', 'petty_cash',         'ASSET',     'assets',      true,  '{"ar":"العهد النقدية","en":"Petty cash floats"}'),
  ('1190', 'funding_clearing',   'ASSET',     'assets',      false, '{"ar":"حساب تمويل المالك (وسيط)","en":"Owner funding clearing"}'),
  ('1200', 'bank_accounts',      'ASSET',     'assets',      true,  '{"ar":"الحسابات البنكية والنقدية","en":"Bank & cash accounts"}'),
  ('1300', 'staff_receivables',  'ASSET',     'assets',      false, '{"ar":"ذمم العمالة المدينة","en":"Staff receivables"}'),
  ('1310', 'staff_advances',     'ASSET',     'assets',      false, '{"ar":"سلف رواتب العمالة","en":"Staff salary advances"}'),
  ('2000', 'liabilities',        'LIABILITY', NULL,          true,  '{"ar":"الالتزامات","en":"Liabilities"}'),
  ('2100', 'salaries_payable',   'LIABILITY', 'liabilities', false, '{"ar":"رواتب مستحقة الدفع","en":"Salaries payable"}'),
  ('2200', 'cards_loans',        'LIABILITY', 'liabilities', true,  '{"ar":"البطاقات الائتمانية والقروض","en":"Credit cards & loans"}'),
  ('3000', 'equity',             'EQUITY',    NULL,          true,  '{"ar":"حقوق الملكية","en":"Equity"}'),
  ('3100', 'owner_equity',       'EQUITY',    'equity',      false, '{"ar":"حقوق المالك","en":"Owner''s equity"}'),
  ('4000', 'income',             'INCOME',    NULL,          true,  '{"ar":"الإيرادات","en":"Income"}'),
  ('4900', 'other_income',       'INCOME',    'income',      false, '{"ar":"إيرادات أخرى","en":"Other income"}'),
  ('6000', 'expenses',           'EXPENSE',   NULL,          true,  '{"ar":"المصروفات","en":"Expenses"}'),
  ('6100', 'salaries_expense',   'EXPENSE',   'expenses',    false, '{"ar":"الرواتب والأجور","en":"Salaries & wages"}'),
  ('6200', 'household_expenses', 'EXPENSE',   'expenses',    false, '{"ar":"مصروفات المنزل","en":"Household expenses"}'),
  ('6950', 'cash_shortage',      'EXPENSE',   'expenses',    false, '{"ar":"عجز النقدية","en":"Cash shortages"}');
