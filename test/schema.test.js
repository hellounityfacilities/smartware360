'use strict';
/**
 * Schema invariant suite.
 *
 * Every test below tries to tell the database a lie and asserts that it
 * refuses. These run against real PostgreSQL semantics via PGlite, so a pass
 * here means the production server behaves the same way — including for a
 * developer with psql access who bypasses the API entirely.
 */
const { connect } = require('../src/db');
const { migrate } = require('../src/migrate');

let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail) {
  if (cond) { pass++; results.push(['  ok  ', name]); }
  else { fail++; results.push(['FAIL  ', name + (detail ? ' — ' + detail : '')]); }
}
function eq(name, actual, expected) {
  ok(name, String(actual) === String(expected), `expected ${expected}, got ${actual}`);
}

/** Assert that a statement is rejected, optionally matching the message. */
async function rejects(db, name, sql, params, match) {
  try {
    await db.query(sql, params);
    ok(name, false, 'statement was accepted but should have been refused');
  } catch (e) {
    const m = e.message || '';
    ok(name, !match || m.toLowerCase().includes(match.toLowerCase()), `message was "${m}"`);
  }
}
/** Assert that a statement succeeds. */
async function accepts(db, name, sql, params) {
  try { await db.query(sql, params); ok(name, true); }
  catch (e) { ok(name, false, e.message); }
}

const S = {};   // ids captured during setup

async function setup(db) {
  await db.exec(`
    INSERT INTO company (code, name, name_ar, currency)
      VALUES ('UFM','Unity Facilities Management & Services','يونيتي لإدارة المرافق','QAR');
    INSERT INTO company_setting (company_id, key, value) VALUES
      (1,'allow_negative_stock','false'),
      (1,'dead_stock_days','90'),
      (1,'tax_rate','0'),
      (1,'enforce_fefo','true');
    INSERT INTO warehouse (company_id, code, name, name_ar, site) VALUES
      (1,'WH-01','Main Warehouse','المستودع الرئيسي','Industrial Area St 38'),
      (1,'WH-02','Maintenance Store','مخزن الصيانة','Al Sadd');
    INSERT INTO location (warehouse_id, zone, rack, shelf, bin, code, capacity) VALUES
      (1,'A','R01','S01','B01','WH-01/A/R01/S01/B01',200),
      (1,'A','R01','S01','B02','WH-01/A/R01/S01/B02',200),
      (1,'B','R02','S01','B01','WH-01/B/R02/S01/B01',200),
      (2,'A','R01','S01','B01','WH-02/A/R01/S01/B01',150);
    INSERT INTO category (company_id, code, name, name_ar) VALUES
      (1,'PPE','PPE','معدات الوقاية'),
      (1,'CLN','Cleaning Materials','مواد التنظيف');
    INSERT INTO supplier (company_id, code, name, lead_time_days) VALUES
      (1,'S1','Gulf Safety Supplies',12),
      (1,'S2','Qatar Clean Chem',3);
    INSERT INTO department (company_id, code, name) VALUES (1,'D1','HSE');
    INSERT INTO project (company_id, code, name) VALUES (1,'P1','Lusail Towers FM Contract');
    INSERT INTO app_user (company_id, username, full_name, role_id) VALUES
      (1,'irshaad','Irshaad Foumie',  (SELECT id FROM role WHERE code='SUPERADMIN')),
      (1,'saleem','Saleem Hassan',    (SELECT id FROM role WHERE code='STOREKEEPER')),
      (1,'rashid','Rashid Al-Kuwari', (SELECT id FROM role WHERE code='WH_MANAGER')),
      (1,'omar','Omar Bilal',         (SELECT id FROM role WHERE code='OPS_MANAGER')),
      (1,'mary','Mary Fernandez',     (SELECT id FROM role WHERE code='DEPT_USER'));
    INSERT INTO item (company_id, sku, barcode, name, name_ar, category_id, uom_code,
                      min_qty, max_qty, reorder_qty, standard_cost, is_batched, is_expiry_controlled) VALUES
      (1,'PPE-109','6284000377','Safety Helmet White','خوذة سلامة بيضاء',1,'PC',90,350,150,38,false,false),
      (1,'PPE-111','6284000411','Nitrile Gloves Box','قفازات نتريل',1,'BOX',200,800,300,34,true,true),
      (1,'CLN-101','6284000101','Floor Cleaner 5L','منظف أرضيات',2,'DRUM',120,400,180,38,true,false);
    INSERT INTO batch (item_id, batch_no, expires_on) VALUES
      (2,'B-2601-A','2027-03-01'),
      (2,'B-2601-B','2026-11-15');
    INSERT INTO batch (item_id, batch_no) VALUES (3,'B-CLN-01');
    INSERT INTO doc_sequence (company_id, doc_type, prefix, width) VALUES
      (1,'GRN','GRN-',6),(1,'TXN','TX',8),(1,'ADJ','ADJ-',6),(1,'MR','MR-',6),(1,'SC','SC-',6);
    INSERT INTO adjustment_threshold (company_id, max_value, approver_role_id) VALUES
      (1,  500, (SELECT id FROM role WHERE code='WH_MANAGER')),
      (1, 5000, (SELECT id FROM role WHERE code='OPS_MANAGER')),
      (1, NULL, (SELECT id FROM role WHERE code='GM'));
    INSERT INTO period (company_id, year, month) VALUES (1,2026,9),(1,2026,8);
  `);
  Object.assign(S, {
    co: 1, wh1: 1, wh2: 2, locA: 1, locB: 2, locC: 3, locW2: 4,
    helmet: 1, gloves: 2, cleaner: 3,
    batchA: 1, batchB: 2, batchCln: 3,
    admin: 1, store: 2, manager: 3, ops: 4, dept: 5
  });
}

/** Post a transaction, returning its id. */
async function post(db, o) {
  const no = (await db.query(`SELECT next_doc_no($1,'TXN') AS n`, [S.co])).rows[0].n;
  const r = await db.query(
    `INSERT INTO stock_txn (txn_no, company_id, warehouse_id, location_id, item_id, batch_id,
       txn_type, qty, unit_cost, ref_no, reason, posted_by, posted_at, reverses_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, now()),$14) RETURNING id`,
    [no, S.co, o.wh, o.loc, o.item, o.batch || null, o.type, o.qty, o.cost || 0,
     o.ref || null, o.reason || null, o.by || S.store, o.at || null, o.reverses || null]);
  return r.rows[0].id;
}

(async () => {
  const db = await connect();
  console.log('\nSMARTWARE 360 — schema invariant suite\n');

  // ---------------------------------------------------------------- migrations
  const applied = await migrate(db, { log: () => {} });
  eq('migrations apply cleanly', applied, 5);
  eq('re-running migrations is a no-op', await migrate(db, { log: () => {} }), 0);
  await setup(db);

  // --------------------------------------------------- no balance columns ----
  const suspicious = await db.query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name IN ('item','location','batch','warehouse')
       AND (column_name ILIKE '%on_hand%' OR column_name ILIKE '%balance%'
            OR column_name = 'qty' OR column_name ILIKE 'stock%qty')`);
  ok('no master table carries a stored stock balance', suspicious.rows.length === 0,
     suspicious.rows.map(r => r.table_name + '.' + r.column_name).join(', '));

  // ------------------------------------------------------- append-only ------
  const t1 = await post(db, { wh: S.wh1, loc: S.locA, item: S.helmet, type: 'RECEIVE', qty: 100, cost: 38 });
  await rejects(db, 'stock_txn refuses UPDATE',
    'UPDATE stock_txn SET qty = 999 WHERE id = $1', [t1], 'append-only');
  await rejects(db, 'stock_txn refuses DELETE',
    'DELETE FROM stock_txn WHERE id = $1', [t1], 'append-only');
  await db.query(
    `INSERT INTO audit_log (company_id, user_id, action, entity, new_value)
     VALUES ($1,$2,'Receive','stock_txn','100')`, [S.co, S.store]);
  await rejects(db, 'audit_log refuses UPDATE',
    "UPDATE audit_log SET action='tamper'", [], 'append-only');
  await rejects(db, 'audit_log refuses DELETE', 'DELETE FROM audit_log', [], 'append-only');

  // ---------------------------------------------------- row-level sanity ----
  await rejects(db, 'a zero-quantity movement is refused',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by)
     VALUES ('TXZERO',1,1,1,1,'RECEIVE',0,2)`, [], 'qty');
  await rejects(db, 'a receipt cannot be negative',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by)
     VALUES ('TXNEG',1,1,1,1,'RECEIVE',-5,2)`, [], 'txn_sign');
  await rejects(db, 'an issue cannot be positive',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by)
     VALUES ('TXPOS',1,1,1,1,'ISSUE',5,2)`, [], 'txn_sign');
  await rejects(db, 'an adjustment without a reason is refused',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by)
     VALUES ('TXADJ',1,1,1,1,'ADJUST',-2,2)`, [], 'txn_reason');
  await rejects(db, 'a location in another warehouse is refused',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by)
     VALUES ('TXLOC',1,2,1,1,'RECEIVE',5,2)`, [], 'does not belong to warehouse');

  // ------------------------------------------------------------ batching ----
  await rejects(db, 'a batch-controlled item cannot move without a batch',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by)
     VALUES ('TXNB',1,1,1,2,'RECEIVE',10,2)`, [], 'batch is required');
  await rejects(db, "a batch belonging to another item is refused",
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,batch_id,txn_type,qty,posted_by)
     VALUES ('TXWB',1,1,1,2,3,'RECEIVE',10,2)`, [], 'different item');
  await rejects(db, 'an expiry-controlled item cannot have an undated batch',
    `INSERT INTO batch (item_id, batch_no) VALUES (2,'B-NO-DATE')`, [], 'expiry date');

  // -------------------------------------------------------- negative stock --
  await post(db, { wh: S.wh1, loc: S.locA, item: S.gloves, batch: S.batchA, type: 'RECEIVE', qty: 60 });
  await rejects(db, 'a bin cannot be driven negative',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,batch_id,txn_type,qty,posted_by)
     VALUES ('TXOVER',1,1,1,2,1,'ISSUE',-61,2)`, [], 'insufficient stock');
  await accepts(db, 'issuing exactly what the bin holds is allowed',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,batch_id,txn_type,qty,posted_by)
     VALUES ('TXEXACT',1,1,1,2,1,'ISSUE',-60,2)`, []);
  eq('bin balance is back to zero', (await db.query(
    'SELECT COALESCE(sum(qty),0)::text q FROM stock_txn WHERE item_id=2 AND location_id=1')).rows[0].q, '0.000');

  await db.query(`UPDATE company_setting SET value='true' WHERE company_id=1 AND key='allow_negative_stock'`);
  await accepts(db, 'negative stock is permitted once a company opts in',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,batch_id,txn_type,qty,posted_by)
     VALUES ('TXNEG2',1,1,1,2,1,'ISSUE',-5,2)`, []);
  await db.query(`UPDATE company_setting SET value='false' WHERE company_id=1 AND key='allow_negative_stock'`);
  await post(db, { wh: S.wh1, loc: S.locA, item: S.gloves, batch: S.batchA, type: 'RECEIVE', qty: 5 });

  // --------------------------------------------------------- period lock ----
  await db.query(`UPDATE period SET is_locked=true, locked_at=now(), locked_by=1
                   WHERE company_id=1 AND year=2026 AND month=8`);
  await rejects(db, 'a closed period refuses new postings',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by,posted_at)
     VALUES ('TXLOCK',1,1,1,1,'RECEIVE',10,2,'2026-08-15')`, [], 'closed');
  await accepts(db, 'the open period still accepts postings',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by)
     VALUES ('TXOPEN',1,1,1,1,'RECEIVE',10,2)`, []);

  // ----------------------------------------------------------- transfers ----
  try {
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,ref_no,posted_by)
       VALUES ('TXT1',1,1,1,1,'TRANSFER_OUT',-10,'TRF-1',2)`);
    await db.query('COMMIT');
    ok('a one-legged transfer is refused at commit', false, 'it committed');
  } catch (e) {
    ok('a one-legged transfer is refused at commit', /does not balance/i.test(e.message), e.message);
    await db.query('ROLLBACK').catch(() => {});
  }
  try {
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,ref_no,posted_by)
       VALUES ('TXT2',1,1,1,1,'TRANSFER_OUT',-10,'TRF-2',2)`);
    await db.query(
      `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,ref_no,posted_by)
       VALUES ('TXT3',1,2,4,1,'TRANSFER_IN',10,'TRF-2',2)`);
    await db.query('COMMIT');
    ok('a balanced two-leg transfer commits', true);
  } catch (e) {
    ok('a balanced two-leg transfer commits', false, e.message);
    await db.query('ROLLBACK').catch(() => {});
  }
  eq('transferred stock arrived in the destination warehouse',
    (await db.query('SELECT fn_on_hand(1,2)::text q')).rows[0].q, '10.000');

  // ----------------------------------------------------------- reversals ----
  const orig = await post(db, { wh: S.wh1, loc: S.locA, item: S.helmet, type: 'RECEIVE', qty: 25 });
  await rejects(db, 'a reversal with the wrong quantity is refused',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by,reverses_id)
     VALUES ('TXR1',1,1,1,1,'ADJUST',-20,2,$1)`, [orig], 'mirror the original');
  const rev = await post(db, { wh: S.wh1, loc: S.locA, item: S.helmet, type: 'ADJUST', qty: -25,
    reason: 'Reversal of GRN keyed against the wrong bin', reverses: orig });
  ok('a mirrored reversal is accepted', !!rev);
  await rejects(db, 'the same transaction cannot be reversed twice',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by,reason,reverses_id)
     VALUES ('TXR3',1,1,1,1,'ADJUST',-25,2,'Duplicate reversal attempt',$1)`, [orig]);
  await rejects(db, 'a reversal cannot itself be reversed',
    `INSERT INTO stock_txn (txn_no,company_id,warehouse_id,location_id,item_id,txn_type,qty,posted_by,reason,reverses_id)
     VALUES ('TXR4',1,1,1,1,'RECEIVE',25,2,'Reversing the reversal',$1)`, [rev], 'itself a reversal');

  // ------------------------------------------------- gapless numbering ------
  const n1 = (await db.query(`SELECT next_doc_no(1,'GRN') n`)).rows[0].n;
  const n2 = (await db.query(`SELECT next_doc_no(1,'GRN') n`)).rows[0].n;
  eq('document numbers start at 000001', n1, 'GRN-000001');
  eq('document numbers increment by one', n2, 'GRN-000002');
  await db.query('BEGIN');
  await db.query(`SELECT next_doc_no(1,'GRN')`);
  await db.query('ROLLBACK');
  const n3 = (await db.query(`SELECT next_doc_no(1,'GRN') n`)).rows[0].n;
  eq('a rolled-back transaction leaves no gap in the numbering', n3, 'GRN-000003');
  await rejects(db, 'an unknown document type is refused',
    `SELECT next_doc_no(1,'NOPE')`, [], 'sequence');

  // ------------------------------------------------- maker and checker ------
  await db.query(
    `INSERT INTO stock_request (company_id, request_no, warehouse_id, requested_by, department_id, reason)
     VALUES (1,'MR-000001',1,$1,1,'Monthly replenishment')`, [S.dept]);
  await rejects(db, 'a requester cannot approve their own request',
    `UPDATE stock_request SET approved_by=$1, approved_at=now(), status='APPROVED' WHERE request_no='MR-000001'`,
    [S.dept], 'maker_checker');
  await accepts(db, 'a different user can approve the request',
    `UPDATE stock_request SET approved_by=$1, approved_at=now(), status='APPROVED' WHERE request_no='MR-000001'`,
    [S.manager]);
  await db.query(
    `INSERT INTO stock_request_line (request_id, item_id, requested_qty)
     VALUES ((SELECT id FROM stock_request WHERE request_no='MR-000001'),1,50)`);
  await rejects(db, 'approving more than was requested is refused',
    `UPDATE stock_request_line SET approved_qty=60 WHERE item_id=1`, [], 'check');
  await accepts(db, 'approving less than requested is allowed (short supply)',
    `UPDATE stock_request_line SET approved_qty=40 WHERE item_id=1`, []);
  await rejects(db, 'issuing more than was approved is refused',
    `UPDATE stock_request_line SET issued_qty=45 WHERE item_id=1`, [], 'check');

  // ---------------------------------------------------- count variances -----
  await db.query(
    `INSERT INTO stock_count (company_id, count_no, warehouse_id, counted_by)
     VALUES (1,'SC-000001',1,$1)`, [S.store]);
  await rejects(db, 'a count variance without an explanation is refused',
    `INSERT INTO stock_count_line (count_id, item_id, location_id, system_qty, physical_qty)
     VALUES ((SELECT id FROM stock_count WHERE count_no='SC-000001'),1,1,100,96)`,
    [], 'variance_needs_explanation');
  await accepts(db, 'a count variance with an explanation is accepted',
    `INSERT INTO stock_count_line (count_id, item_id, location_id, system_qty, physical_qty, explanation)
     VALUES ((SELECT id FROM stock_count WHERE count_no='SC-000001'),1,1,100,96,'Four units damaged and removed')`, []);
  await accepts(db, 'a matching count line needs no explanation',
    `INSERT INTO stock_count_line (count_id, item_id, location_id, system_qty, physical_qty)
     VALUES ((SELECT id FROM stock_count WHERE count_no='SC-000001'),1,2,10,10)`, []);
  eq('variance is computed by the database, not the client',
    (await db.query(`SELECT variance::text v FROM stock_count_line WHERE physical_qty=96`)).rows[0].v, '-4.000');

  // ------------------------------------------- adjustment approval bands ----
  await db.query(
    `INSERT INTO stock_adjustment (company_id, adj_no, warehouse_id, location_id, item_id, qty, value, reason, raised_by)
     VALUES (1,'ADJ-000001',1,1,1,-40,1520,'Water damage in Zone B after a pipe leak',$1)`, [S.store]);
  eq('the value band selects the right approver role',
    (await db.query(`SELECT r.code FROM role r WHERE r.id = fn_required_approver(1, 1520)`)).rows[0].code,
    'OPS_MANAGER');
  await rejects(db, 'a Warehouse Manager cannot approve above their band',
    `UPDATE stock_adjustment SET approved_by=$1, approved_at=now() WHERE adj_no='ADJ-000001'`,
    [S.manager], 'requires approval by role');
  // Raised by the very person whose role the value band requires — so only the
  // maker/checker rule can refuse it, which is exactly what we want to prove.
  await db.query(
    `INSERT INTO stock_adjustment (company_id, adj_no, warehouse_id, location_id, item_id, qty, value, reason, raised_by)
     VALUES (1,'ADJ-000003',1,1,1,-30,1140,'Pallet crushed by forklift in Zone A',$1)`, [S.ops]);
  await rejects(db, 'the person who raised it cannot approve it, whatever their rank',
    `UPDATE stock_adjustment SET approved_by=$1, approved_at=now() WHERE adj_no='ADJ-000003'`,
    [S.ops], 'maker_checker');
  await accepts(db, 'the Operations Manager can approve within their band',
    `UPDATE stock_adjustment SET approved_by=$1, approved_at=now(), status='APPROVED' WHERE adj_no='ADJ-000001'`,
    [S.ops]);
  await db.query(
    `INSERT INTO stock_adjustment (company_id, adj_no, warehouse_id, location_id, item_id, qty, value, reason, raised_by)
     VALUES (1,'ADJ-000002',1,1,1,-2,76,'Two helmets cracked in storage',$1)`, [S.store]);
  await rejects(db, 'an unapproved adjustment cannot reach the ledger',
    `UPDATE stock_adjustment SET posted_txn_id=$1 WHERE adj_no='ADJ-000002'`, [t1], 'adj_post_requires_approval');
  await accepts(db, 'a Super Administrator overrides bands via approve.any',
    `UPDATE stock_adjustment SET approved_by=$1, approved_at=now(), status='APPROVED' WHERE adj_no='ADJ-000002'`,
    [S.admin]);

  // ------------------------------------------------ balances and FEFO -------
  const onHand = (await db.query('SELECT fn_on_hand(1,1)::text q')).rows[0].q;
  const byView = (await db.query(
    'SELECT COALESCE(sum(qty),0)::text q FROM v_stock_by_warehouse WHERE item_id=1 AND warehouse_id=1')).rows[0].q;
  eq('fn_on_hand agrees with the balance view', onHand, byView);

  await db.query(
    `INSERT INTO stock_reservation (company_id, warehouse_id, item_id, qty, source_type, source_id, created_by)
     VALUES (1,1,1,30,'REQUEST',1,$1)`, [S.manager]);
  const oh = (await db.query('SELECT fn_on_hand(1,1)::text q')).rows[0].q;
  const av = (await db.query('SELECT fn_available(1,1)::text q')).rows[0].q;
  eq('a reservation does not change physical stock', oh, onHand);
  eq('a reservation reduces available stock by exactly its quantity',
    (Number(oh) - Number(av)).toFixed(3), '30.000');

  await post(db, { wh: S.wh1, loc: S.locB, item: S.gloves, batch: S.batchB, type: 'RECEIVE', qty: 40 });
  eq('FEFO selects the earliest-expiring batch',
    (await db.query('SELECT fn_fefo_batch(2,1) b')).rows[0].b, S.batchB);

  // ------------------------------------------------- the daily equation -----
  const m = (await db.query(
    `SELECT * FROM fn_day_movement(1, 1, current_date)`)).rows[0];
  const lhs = Number(m.opening) + Number(m.receipts) + Number(m.returns_in) + Number(m.transfers_in)
            - Number(m.issues) - Number(m.returns_out) - Number(m.transfers_out) + Number(m.adjustments);
  eq('opening + ins − outs ± adjustments equals closing', lhs.toFixed(3), Number(m.closing).toFixed(3));
  const live = (await db.query(
    `SELECT COALESCE(sum(qty),0)::text q FROM stock_txn WHERE company_id=1 AND warehouse_id=1`)).rows[0].q;
  eq('closing stock equals the sum of the whole ledger', Number(m.closing).toFixed(3), Number(live).toFixed(3));

  // ------------------------------------------------------ misc guardrails ---
  await rejects(db, 'an expiry-controlled item must also be batch-controlled',
    `INSERT INTO item (company_id, sku, name, category_id, uom_code, is_batched, is_expiry_controlled)
     VALUES (1,'BAD-1','Bad item',1,'PC',false,true)`, [], 'check');
  await rejects(db, 'an attachment checksum must be a real sha256',
    `INSERT INTO attachment (company_id, entity, entity_id, kind, filename, content_type, byte_size, storage_key, sha256, uploaded_by)
     VALUES (1,'stock_txn',1,'PHOTO','a.jpg','image/jpeg',100,'k','not-a-hash',2)`, [], 'check');
  await accepts(db, 'a replayed offline transaction is recorded once',
    `INSERT INTO idempotency_key (key, company_id, user_id, request_hash) VALUES ('abc',1,2,'h')`, []);
  await rejects(db, 'the same offline key cannot post twice',
    `INSERT INTO idempotency_key (key, company_id, user_id, request_hash) VALUES ('abc',1,2,'h')`, [], 'duplicate');
  await rejects(db, 'a material request must name a department or a project',
    `INSERT INTO stock_request (company_id, request_no, warehouse_id, requested_by)
     VALUES (1,'MR-000099',1,5)`, [], 'check');
  await rejects(db, 'a user cannot be created in a role that does not exist',
    `INSERT INTO app_user (company_id, username, full_name, role_id) VALUES (1,'ghost','Ghost',9999)`,
    [], 'foreign key');

  // -------------------------------------------------------------- report ----
  console.log(results.map(r => r[0] + r[1]).join('\n'));
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} assertions\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nSUITE CRASHED:', e.message, '\n', e.stack); process.exit(1); });
