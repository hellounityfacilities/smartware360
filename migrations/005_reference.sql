-- =============================================================================
-- 005_reference.sql
-- Data the application's logic depends on existing: permissions, the standard
-- role set, and units of measure. Not demo data — this ships to every customer.
-- =============================================================================

INSERT INTO permission (code, description) VALUES
  ('dashboard.view',     'See the daily update and warehouse dashboard'),
  ('inventory.view',     'Look up items, balances and locations'),
  ('stock.receive',      'Book goods in against a receipt'),
  ('stock.issue',        'Issue stock out of the warehouse'),
  ('stock.transfer',     'Move stock between locations or warehouses'),
  ('stock.count',        'Perform physical counts'),
  ('stock.adjust',       'Raise a stock adjustment'),
  ('request.create',     'Raise a material request'),
  ('request.approve',    'Approve material requests'),
  ('adjustment.approve', 'Approve stock adjustments within the value band'),
  ('approve.any',        'Approve at any value band, overriding thresholds'),
  ('purchase.view',      'See reorder recommendations and purchase requirement'),
  ('supplier.manage',    'Maintain the supplier master'),
  ('report.view',        'Run and export reports'),
  ('report.financial',   'See valuation, cost and money-trapped reporting'),
  ('intel.view',         'Use forecasting, risk and anomaly screens'),
  ('audit.view',         'Read the audit trail'),
  ('settings.manage',    'Change company settings and thresholds'),
  ('user.manage',        'Create users and assign roles');

INSERT INTO role (code, name, is_system) VALUES
  ('SUPERADMIN',  'Super Administrator', true),
  ('WH_MANAGER',  'Warehouse Manager',   true),
  ('STOREKEEPER', 'Storekeeper',         true),
  ('PROCUREMENT', 'Procurement Officer', true),
  ('FINANCE',     'Finance',             true),
  ('DEPT_USER',   'Department User',     true),
  ('OPS_MANAGER', 'Operations Manager',  true),
  ('GM',          'General Manager',     true),
  ('AUDITOR',     'Auditor',             true);

-- Super Administrator and General Manager hold every permission.
INSERT INTO role_permission (role_id, permission_code)
SELECT r.id, p.code FROM role r CROSS JOIN permission p
 WHERE r.code IN ('SUPERADMIN','GM');

INSERT INTO role_permission (role_id, permission_code)
SELECT r.id, x.code FROM role r
  JOIN (VALUES
    ('WH_MANAGER','dashboard.view'),('WH_MANAGER','inventory.view'),('WH_MANAGER','stock.receive'),
    ('WH_MANAGER','stock.issue'),('WH_MANAGER','stock.transfer'),('WH_MANAGER','stock.count'),
    ('WH_MANAGER','stock.adjust'),('WH_MANAGER','request.approve'),('WH_MANAGER','adjustment.approve'),
    ('WH_MANAGER','purchase.view'),('WH_MANAGER','report.view'),('WH_MANAGER','intel.view'),
    ('WH_MANAGER','audit.view'),('WH_MANAGER','request.create'),

    ('STOREKEEPER','dashboard.view'),('STOREKEEPER','inventory.view'),('STOREKEEPER','stock.receive'),
    ('STOREKEEPER','stock.issue'),('STOREKEEPER','stock.transfer'),('STOREKEEPER','stock.count'),
    ('STOREKEEPER','stock.adjust'),('STOREKEEPER','request.create'),

    ('PROCUREMENT','dashboard.view'),('PROCUREMENT','inventory.view'),('PROCUREMENT','purchase.view'),
    ('PROCUREMENT','supplier.manage'),('PROCUREMENT','report.view'),('PROCUREMENT','intel.view'),
    ('PROCUREMENT','request.create'),

    ('FINANCE','dashboard.view'),('FINANCE','inventory.view'),('FINANCE','report.view'),
    ('FINANCE','report.financial'),('FINANCE','intel.view'),

    ('DEPT_USER','inventory.view'),('DEPT_USER','request.create'),

    ('OPS_MANAGER','dashboard.view'),('OPS_MANAGER','inventory.view'),('OPS_MANAGER','request.approve'),
    ('OPS_MANAGER','adjustment.approve'),('OPS_MANAGER','report.view'),('OPS_MANAGER','report.financial'),
    ('OPS_MANAGER','intel.view'),('OPS_MANAGER','audit.view'),

    ('AUDITOR','dashboard.view'),('AUDITOR','inventory.view'),('AUDITOR','report.view'),
    ('AUDITOR','report.financial'),('AUDITOR','audit.view'),('AUDITOR','intel.view')
  ) AS x(role_code, code) ON x.role_code = r.code;

INSERT INTO uom (code, name, name_ar, is_integral) VALUES
  ('PC',    'Piece',    'قطعة',   true),
  ('BOX',   'Box',      'صندوق',  true),
  ('PACK',  'Pack',     'عبوة',   true),
  ('PAIR',  'Pair',     'زوج',    true),
  ('SET',   'Set',      'طقم',    true),
  ('ROLL',  'Roll',     'لفة',    true),
  ('DRUM',  'Drum',     'برميل',  true),
  ('BOTTLE','Bottle',   'زجاجة',  true),
  ('TUBE',  'Tube',     'أنبوب',  true),
  ('REAM',  'Ream',     'رزمة',   true),
  ('CYL',   'Cylinder', 'أسطوانة',true),
  ('KG',    'Kilogram', 'كيلوجرام',false),
  ('L',     'Litre',    'لتر',    false),
  ('M',     'Metre',    'متر',    false);
