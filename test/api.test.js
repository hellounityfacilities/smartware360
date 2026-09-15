'use strict';
/**
 * Full-month API run.
 *
 * This drives a month of real warehouse activity through the HTTP layer —
 * sign-in, receiving, issuing, transfers, a material request through its whole
 * lifecycle, an adjustment through approval, a physical count — and then asserts
 * that every report reconciles back to the ledger.
 *
 * The final assertion is the one that matters: the sum of what the API reports
 * as stock on hand equals the sum of the transaction ledger, to three decimals.
 */
const { connect } = require('../src/db');
const { migrate } = require('../src/migrate');
const { createApp } = require('../src/app');
const auth = require('../src/auth');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};
const eq = (name, a, b) => ok(name, String(a) === String(b), `expected ${b}, got ${a}`);
const num = v => (v === null || v === undefined ? 0 : Number(v));

const PW = 'warehouse-2026!';
const S = {};

async function seed(db) {
  await db.exec(`
    INSERT INTO company (code, name, currency)
      VALUES ('UFM','Unity Facilities Management & Services','QAR');
    INSERT INTO company_setting (company_id, key, value) VALUES
      (1,'allow_negative_stock','false'),(1,'dead_stock_days','90'),
      (1,'tax_rate','0'),(1,'enforce_fefo','true');
    INSERT INTO warehouse (company_id, code, name, site) VALUES
      (1,'WH-01','Main Warehouse','Industrial Area St 38'),
      (1,'WH-02','Maintenance Store','Al Sadd');
    INSERT INTO location (warehouse_id, zone, rack, shelf, bin, code, capacity) VALUES
      (1,'A','R01','S01','B01','WH-01/A/R01/S01/B01',400),
      (1,'A','R01','S02','B01','WH-01/A/R01/S02/B01',400),
      (1,'B','R02','S01','B01','WH-01/B/R02/S01/B01',400),
      (2,'A','R01','S01','B01','WH-02/A/R01/S01/B01',300);
    INSERT INTO category (company_id, code, name) VALUES
      (1,'PPE','PPE'),(1,'CLN','Cleaning Materials'),(1,'ELC','Electrical');
    INSERT INTO supplier (company_id, code, name, lead_time_days) VALUES
      (1,'S1','Gulf Safety Supplies',12),
      (1,'S2','Qatar Clean Chem',3),
      (1,'S3','Doha Electrical Est.',5);
    INSERT INTO department (company_id, code, name) VALUES (1,'D1','HSE'),(1,'D2','MEP Maintenance');
    INSERT INTO project (company_id, code, name) VALUES
      (1,'P1','Lusail Towers FM Contract'),(1,'P2','Hamad Airport Support');
    INSERT INTO item (company_id, sku, barcode, name, name_ar, category_id, uom_code,
        min_qty, max_qty, reorder_qty, standard_cost, default_supplier_id, home_warehouse_id,
        is_batched, is_expiry_controlled) VALUES
      (1,'PPE-109','6284000109','Safety Helmet White','خوذة سلامة',1,'PC',90,350,150,38,1,1,false,false),
      (1,'PPE-111','6284000111','Nitrile Gloves Box','قفازات نتريل',1,'BOX',200,800,300,34,1,1,true,true),
      (1,'PPE-113','6284000113','Safety Shoes S3','أحذية سلامة',1,'PAIR',60,240,120,165,1,1,false,false),
      (1,'CLN-101','6284000101','Floor Cleaner 5L','منظف أرضيات',2,'DRUM',120,400,180,38,2,1,true,false),
      (1,'CLN-107','6284000107','Garbage Bag Roll','أكياس نفايات',2,'ROLL',240,900,400,32,2,1,false,false),
      (1,'ELC-118','6284000118','LED Tube 18W','أنبوب LED',3,'PC',200,750,300,21,3,2,false,false),
      (1,'ELC-121','6284000121','Cable 3x2.5mm 100m','كابل',3,'ROLL',12,45,20,420,3,2,false,false);
    INSERT INTO doc_sequence (company_id, doc_type, prefix, width) VALUES
      (1,'TXN','TX',8),(1,'GRN','GRN-',6),(1,'ISS','ISS-',6),(1,'TRF','TRF-',6),
      (1,'ADJ','ADJ-',6),(1,'MR','MR-',6),(1,'SC','SC-',6);
    INSERT INTO adjustment_threshold (company_id, max_value, approver_role_id) VALUES
      (1,  500, (SELECT id FROM role WHERE code='WH_MANAGER')),
      (1, 5000, (SELECT id FROM role WHERE code='OPS_MANAGER')),
      (1, NULL, (SELECT id FROM role WHERE code='GM'));
  `);
  // periods for the last four months, all open
  for (let i = 0; i < 5; i++) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    await db.query(
      `INSERT INTO period (company_id, year, month) VALUES (1,$1,$2) ON CONFLICT DO NOTHING`,
      [d.getFullYear(), d.getMonth() + 1]);
  }

  S.users = {};
  const people = [
    ['irshaad', 'Irshaad Foumie', 'SUPERADMIN', null],
    ['saleem', 'Saleem Hassan', 'STOREKEEPER', [1]],
    ['rashid', 'Rashid Al-Kuwari', 'WH_MANAGER', null],
    ['omar', 'Omar Bilal', 'OPS_MANAGER', null],
    ['mary', 'Mary Fernandez', 'DEPT_USER', null],
    ['fatima', 'Fatima Nasser', 'PROCUREMENT', null]
  ];
  for (const [username, name, role, whs] of people) {
    S.users[username] = await auth.createUser(db, {
      companyId: 1, username, fullName: name, roleCode: role, password: PW, warehouseIds: whs
    });
  }
}

/** Three months of prior movement, so the intelligence modules have history. */
async function history(db) {
  const admin = S.users.irshaad;
  let seq = 0;
  const post = (daysAgo, hour, wh, loc, item, type, q, batch, extra = {}) => db.query(
    `INSERT INTO stock_txn (txn_no, company_id, warehouse_id, location_id, item_id, batch_id,
       txn_type, qty, unit_cost, ref_no, party_type, party_ref, reason, posted_by, posted_at)
     VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() - ($14 || ' days')::interval + ($15 || ' hours')::interval)`,
    ['TXH' + String(++seq).padStart(6, '0'), wh, loc, item, batch, type, q,
     extra.cost || 0, extra.ref || null, extra.partyType || null, extra.partyRef || null,
     extra.reason || null, admin, String(daysAgo), String(hour)]);

  // opening receipts
  const opening = [[1, 1, 300, null], [2, 1, 600, 1], [2, 1, 80, 2], [3, 1, 200, null], [4, 2, 320, 3],
                   [5, 2, 700, null], [6, 4, 600, null], [7, 4, 38, null]];
  await db.query(`INSERT INTO batch (item_id, batch_no, expires_on) VALUES
    (2,'B-2601-A', current_date + 400), (2,'B-2601-B', current_date + 25), (4,'B-CLN-01', NULL)`);
  for (const [item, loc, q, batch] of opening) {
    const wh = loc === 4 ? 2 : 1;
    await post(92, 8, wh, loc, item, 'RECEIVE', q, batch, { ref: 'GRN-OPENING', partyType: 'Supplier' });
  }
  // daily issues across 90 days
  const projects = ['Lusail Towers FM Contract', 'Hamad Airport Support'];
  let n = 0;
  for (let d = 90; d >= 1; d--) {
    if (d % 7 === 5) continue;                       // quiet Fridays
    const picks = [[1, 1, 2], [3, 1, 1], [5, 2, 4], [6, 4, 3]];
    for (const [item, loc, q] of picks) {
      if ((d + item) % 3 === 0) continue;
      const wh = loc === 4 ? 2 : 1;
      await post(d, 9 + (item % 6), wh, loc, item, 'ISSUE', -q, null,
        { partyType: 'Project', partyRef: projects[n++ % 2] });
    }
    // periodic replenishment
    if (d % 14 === 3) {
      await post(d, 8, 1, 1, 1, 'RECEIVE', 60, null, { ref: 'GRN-REPL', cost: 38 });
      await post(d, 8, 2, 4, 6, 'RECEIVE', 120, null, { ref: 'GRN-REPL', cost: 21 });
    }
  }
  // an item that stops moving, so dead stock has something real to find
  await post(120, 9, 2, 4, 7, 'RECEIVE', 20, null, { ref: 'GRN-OLD', cost: 420 });
}

(async () => {
  const db = await connect();
  console.log('\nSMARTWARE 360 — full-month API run\n');
  await migrate(db, { log: () => {} });
  await seed(db);
  await history(db);

  const app = createApp(db);
  const call = (method, path, opts) => app.call(method, path, opts);
  const as = sid => ({ 'x-session': sid, 'user-agent': 'test-harness' });

  // ------------------------------------------------------------- sign in ---
  const bad = await call('POST', '/api/session',
    { body: { company: 'UFM', username: 'saleem', password: 'wrong-password' } });
  eq('a wrong password is refused', bad.status, 401);
  ok('the refusal does not reveal whether the user exists',
    /not recognised/i.test(bad.body.error), bad.body.error);

  const ghost = await call('POST', '/api/session',
    { body: { company: 'UFM', username: 'nobody', password: 'wrong-password' } });
  eq('an unknown username gives the identical message', ghost.body.error, bad.body.error);

  const store = (await call('POST', '/api/session',
    { body: { company: 'UFM', username: 'saleem', password: PW } })).body;
  ok('the storekeeper can sign in', !!store.sessionId);
  eq('the session carries the role', store.user.role, 'STOREKEEPER');

  const manager = (await call('POST', '/api/session',
    { body: { company: 'UFM', username: 'rashid', password: PW } })).body;
  const ops = (await call('POST', '/api/session',
    { body: { company: 'UFM', username: 'omar', password: PW } })).body;
  const dept = (await call('POST', '/api/session',
    { body: { company: 'UFM', username: 'mary', password: PW } })).body;
  const buyer = (await call('POST', '/api/session',
    { body: { company: 'UFM', username: 'fatima', password: PW } })).body;

  eq('no session is refused', (await call('GET', '/api/me')).status, 401);
  eq('a forged session is refused',
    (await call('GET', '/api/me', { headers: as('not-a-real-session') })).status, 401);
  eq('an unknown endpoint is a 404', (await call('GET', '/api/nothing')).status, 404);
  eq('the health check needs no session', (await call('GET', '/health')).body.status, 'ok');

  // ------------------------------------------------------- authorisation ---
  eq('a storekeeper is confined to their warehouse',
    (await call('GET', '/api/warehouses', { headers: as(store.sessionId) })).body.length, 1);
  eq('a manager sees every warehouse',
    (await call('GET', '/api/warehouses', { headers: as(manager.sessionId) })).body.length, 2);
  eq('a department user cannot receive stock',
    (await call('POST', '/api/receipts', {
      headers: as(dept.sessionId),
      body: { warehouseId: 1, supplierId: 1, lines: [{ itemId: 1, qty: 10, locationId: 1 }] }
    })).status, 403);
  eq('a storekeeper cannot read the audit trail',
    (await call('GET', '/api/audit', { headers: as(store.sessionId) })).status, 403);
  eq('an auditor-level permission gates valuation',
    (await call('GET', '/api/reports/valuation', { headers: as(store.sessionId) })).status, 403);

  // ------------------------------------------------------------ receiving --
  const grn = await call('POST', '/api/receipts', {
    headers: as(store.sessionId),
    body: {
      warehouseId: 1, supplierId: 1, poNo: 'PO-24118', deliveryNote: 'DN-7741',
      lines: [
        { itemId: 1, qty: 120, unitCost: 38, locationId: 1 },
        { itemId: 3, qty: 40, unitCost: 165, locationId: 2 },
        { itemId: 2, qty: 200, unitCost: 34, locationId: 1,
          batchNo: 'B-2609-C', expiresOn: '2027-06-30' }
      ]
    }
  });
  eq('a receipt posts', grn.status, 201);
  eq('every line reaches the ledger', grn.body.transactions.length, 3);
  ok('the receipt gets a gapless GRN number', /^GRN-\d{6}$/.test(grn.body.grnNo), grn.body.grnNo);

  const quarantine = await call('POST', '/api/receipts', {
    headers: as(store.sessionId),
    body: { warehouseId: 1, supplierId: 1, lines: [
      { itemId: 1, qty: 10, unitCost: 38, locationId: 1, condition: 'QUARANTINE' }] }
  });
  eq('quarantined goods are recorded but do not enter stock', quarantine.body.transactions.length, 0);

  // ---------------------------------------------------------------- scan ---
  const scan = (await call('GET', '/api/scan/6284000109?warehouse=1',
    { headers: as(store.sessionId) })).body;
  eq('a barcode scan finds the item', scan.item.sku, 'PPE-109');
  ok('the scan returns where it is stored', scan.locations.length > 0);
  eq('available equals on hand minus reserved', scan.available, scan.onHand - scan.reserved);
  eq('an unknown barcode is a 404',
    (await call('GET', '/api/scan/0000000000', { headers: as(store.sessionId) })).status, 404);

  // -------------------------------------------------------------- issuing --
  const before = scan.onHand;
  const iss = await call('POST', '/api/issues', {
    headers: as(store.sessionId),
    body: { warehouseId: 1, itemId: 1, locationId: 1, qty: 25,
            partyType: 'Project', partyRef: 'Lusail Towers FM Contract', note: 'Site mobilisation' }
  });
  eq('an issue posts', iss.status, 201);
  const after = (await call('GET', '/api/scan/6284000109?warehouse=1',
    { headers: as(store.sessionId) })).body.onHand;
  eq('stock falls by exactly the quantity issued', before - after, 25);

  const over = await call('POST', '/api/issues', {
    headers: as(store.sessionId),
    body: { warehouseId: 1, itemId: 1, locationId: 1, qty: 999999,
            partyType: 'Project', partyRef: 'Lusail Towers FM Contract' }
  });
  eq('issuing more than is available is refused', over.status, 409);
  ok('the refusal says what is actually available', /available/i.test(over.body.error), over.body.error);

  // FEFO — B-2601-B expires in 25 days and must go first
  const wrongBatch = await call('POST', '/api/issues', {
    headers: as(store.sessionId),
    body: { warehouseId: 1, itemId: 2, locationId: 1, qty: 5, batchId: 1,
            partyType: 'Project', partyRef: 'Hamad Airport Support' }
  });
  eq('FEFO blocks a later batch while an earlier one is in stock', wrongBatch.status, 409);
  ok('the FEFO message names the batch that should go first',
    /B-2601-B/.test(wrongBatch.body.error), wrongBatch.body.error);
  ok('the FEFO message shows a readable expiry date',
    /\d{4}-\d{2}-\d{2}/.test(wrongBatch.body.error), wrongBatch.body.error);

  const override = await call('POST', '/api/issues', {
    headers: as(store.sessionId),
    body: { warehouseId: 1, itemId: 2, locationId: 1, qty: 5, batchId: 1,
            fefoOverrideReason: 'Customer specified batch for traceability',
            partyType: 'Project', partyRef: 'Hamad Airport Support' }
  });
  eq('FEFO can be overridden with a recorded reason', override.status, 201);

  const auto = await call('POST', '/api/issues', {
    headers: as(store.sessionId),
    body: { warehouseId: 1, itemId: 2, locationId: 1, qty: 10,
            partyType: 'Project', partyRef: 'Lusail Towers FM Contract' }
  });
  eq('with no batch named, FEFO picks one automatically', auto.status, 201);

  // ------------------------------------------------------------ transfers --
  const trf = await call('POST', '/api/transfers', {
    headers: as(manager.sessionId),
    body: { itemId: 1, qty: 30, fromWarehouseId: 1, fromLocationId: 1,
            toWarehouseId: 2, toLocationId: 4, note: 'Rebalancing to maintenance store' }
  });
  eq('a transfer posts both legs', trf.status, 201);
  ok('both legs share one reference', trf.body.out.txn_no !== trf.body.in.txn_no && !!trf.body.refNo);
  eq('the stock arrives at the destination',
    num((await db.query('SELECT fn_on_hand(1,2) q')).rows[0].q), 30);

  eq('a transfer to the same location is refused',
    (await call('POST', '/api/transfers', {
      headers: as(manager.sessionId),
      body: { itemId: 1, qty: 5, fromWarehouseId: 1, fromLocationId: 1,
              toWarehouseId: 1, toLocationId: 1 }
    })).status, 400);

  // ------------------------------------------------------ material request --
  const mr = await call('POST', '/api/requests', {
    headers: as(dept.sessionId),
    body: { warehouseId: 1, departmentId: 1, projectId: 1, priority: 'HIGH',
            reason: 'Monthly site replenishment',
            lines: [{ itemId: 1, qty: 40 }, { itemId: 5, qty: 999999 }] }
  });
  eq('a department user can raise a request', mr.status, 201);
  const mrId = mr.body.requestId;

  eq('the requester cannot approve their own request',
    (await call('POST', `/api/requests/${mrId}/approve`, { headers: as(dept.sessionId) })).status, 403);

  const appr = await call('POST', `/api/requests/${mrId}/approve`, { headers: as(manager.sessionId) });
  eq('a manager can approve it', appr.status, 200);
  ok('a line beyond available stock is cut back rather than promised',
    appr.body.shortLines.length === 1 && appr.body.shortLines[0].sku === 'CLN-107',
    JSON.stringify(appr.body.shortLines));

  const availBefore = num((await db.query('SELECT fn_available(1,1) q')).rows[0].q);
  const onHandBefore = num((await db.query('SELECT fn_on_hand(1,1) q')).rows[0].q);
  await call('POST', `/api/requests/${mrId}/reserve`, { headers: as(manager.sessionId) });
  const availAfter = num((await db.query('SELECT fn_available(1,1) q')).rows[0].q);
  const onHandAfter = num((await db.query('SELECT fn_on_hand(1,1) q')).rows[0].q);
  eq('reserving does not move any stock', onHandAfter, onHandBefore);
  eq('reserving reduces available by the approved quantity', availBefore - availAfter, 40);

  const issued = await call('POST', `/api/requests/${mrId}/issue`, { headers: as(store.sessionId) });
  eq('issuing against the request completes it', issued.body.status, 'COMPLETED');
  eq('the ledger moves by the issued quantity',
    onHandBefore - num((await db.query('SELECT fn_on_hand(1,1) q')).rows[0].q), 40);
  eq('the reservation is released, not left hanging',
    num((await db.query('SELECT fn_reserved(1,1) q')).rows[0].q), 0);
  eq('a completed request cannot be issued twice',
    (await call('POST', `/api/requests/${mrId}/issue`, { headers: as(store.sessionId) })).status, 409);

  // ----------------------------------------------------------- adjustment --
  const adj = await call('POST', '/api/adjustments', {
    headers: as(store.sessionId),
    body: { warehouseId: 1, locationId: 2, itemId: 3, qty: -12,
            reason: 'Water damage in Zone A after a pipe leak' }
  });
  eq('a storekeeper can raise an adjustment', adj.status, 201);
  eq('the value is computed from standard cost', adj.body.value, '1980.00');
  eq('the value band selects the approver', adj.body.requiredApprover, 'Operations Manager');

  eq('a storekeeper cannot approve an adjustment',
    (await call('POST', `/api/adjustments/${adj.body.id}/approve`,
      { headers: as(store.sessionId) })).status, 403);
  eq('a warehouse manager cannot approve above their band',
    (await call('POST', `/api/adjustments/${adj.body.id}/approve`,
      { headers: as(manager.sessionId) })).status, 403);

  const stockBefore = num((await db.query('SELECT fn_on_hand(3,1) q')).rows[0].q);
  const approved = await call('POST', `/api/adjustments/${adj.body.id}/approve`,
    { headers: as(ops.sessionId) });
  eq('the operations manager can approve within their band', approved.status, 200);
  eq('approval posts the movement in the same transaction',
    stockBefore - num((await db.query('SELECT fn_on_hand(3,1) q')).rows[0].q), 12);
  eq('the same adjustment cannot be approved twice',
    (await call('POST', `/api/adjustments/${adj.body.id}/approve`,
      { headers: as(ops.sessionId) })).status, 409);

  // ---------------------------------------------------------------- count --
  const count = await call('POST', '/api/counts', {
    headers: as(store.sessionId), body: { warehouseId: 1, zone: 'A' }
  });
  eq('a count sheet opens with the expected quantities', count.status, 201);
  ok('the sheet is populated from the ledger', count.body.lines.length > 0);

  const sheet = count.body.lines.map((l, i) => ({
    itemId: l.item_id, locationId: l.location_id, systemQty: num(l.system_qty),
    physicalQty: i === 0 ? num(l.system_qty) - 3 : num(l.system_qty),
    explanation: i === 0 ? 'Three units damaged and removed from the bin' : null
  }));

  const noExplanation = await call('POST', `/api/counts/${count.body.countId}/close`, {
    headers: as(store.sessionId),
    body: { lines: sheet.map((l, i) => i === 0 ? Object.assign({}, l, { explanation: null }) : l) }
  });
  eq('a variance without an explanation is refused', noExplanation.status, 400);

  const closed = await call('POST', `/api/counts/${count.body.countId}/close`, {
    headers: as(store.sessionId), body: { lines: sheet }
  });
  eq('the count closes once every variance is explained', closed.status, 200);
  eq('one variance was posted', closed.body.variances, 1);
  ok('accuracy is calculated, not asserted', closed.body.accuracy < 100 && closed.body.accuracy > 50,
    String(closed.body.accuracy));

  // -------------------------------------------------------------- reports --
  const day = (await call('GET', '/api/reports/day?warehouse=1',
    { headers: as(manager.sessionId) })).body;
  ok('the daily equation balances', day.balances === true, JSON.stringify(day));

  const health = (await call('GET', '/api/reports/health?warehouse=1',
    { headers: as(manager.sessionId) })).body;
  ok('the health score is a number in range', health.score >= 0 && health.score <= 100, String(health.score));
  ok('every health component explains itself', health.parts.every(p => p.why && p.why.length > 10));

  const val = (await call('GET', '/api/reports/valuation?warehouse=1',
    { headers: as(ops.sessionId) })).body;
  ok('valuation totals to two decimal places', /^\d+\.\d{2}$/.test(val.total), val.total);
  const catSum = val.categories.reduce((s, c) => s + Math.round(Number(c.value) * 100), 0);
  eq('category values sum to the total', catSum, Math.round(Number(val.total) * 100));

  const acc = (await call('GET', '/api/reports/accuracy?warehouse=1',
    { headers: as(manager.sessionId) })).body;
  ok('inventory accuracy is reported from closed counts', acc.counts >= 1 && acc.lines > 0);

  const variances = (await call('GET', '/api/reports/variances?warehouse=1',
    { headers: as(manager.sessionId) })).body;
  ok('every recorded variance carries its explanation',
    variances.length > 0 && variances.every(v => v.explanation && v.explanation.length > 4));

  const consumption = (await call('GET', '/api/reports/consumption?warehouse=1',
    { headers: as(manager.sessionId) })).body;
  ok('consumption is attributed to projects', consumption.length > 0 && consumption[0].party_ref);

  const util = (await call('GET', '/api/reports/utilisation?warehouse=1',
    { headers: as(manager.sessionId) })).body;
  ok('rack utilisation is reported per location', util.length > 0 && util.every(u => 'utilisation' in u));

  // --------------------------------------------------------- intelligence --
  const reorder = (await call('GET', '/api/intel/reorder?warehouse=1',
    { headers: as(buyer.sessionId) })).body;
  ok('the reorder engine returns recommendations', Array.isArray(reorder));
  ok('every recommendation shows its arithmetic',
    reorder.every(r => r.workings && r.workings.includes('reorder point')),
    JSON.stringify(reorder[0] || {}));
  ok('the reorder point matches its own formula',
    reorder.every(r => r.reorderPoint === Math.ceil(r.avgDaily * r.leadDays + r.safetyStock)));

  const forecast = (await call('GET', '/api/intel/forecast?warehouse=1',
    { headers: as(buyer.sessionId) })).body;
  ok('the forecast states its basis and its limits',
    /not modelled/i.test(forecast.basis), forecast.basis);
  ok('projections decrease over the horizon',
    forecast.items.every(i => i.in7 >= i.in14 && i.in14 >= i.in30));

  const deadStock = (await call('GET', '/api/intel/dead-stock?warehouse=2',
    { headers: as(buyer.sessionId) })).body;
  ok('dead stock finds the item that stopped moving',
    deadStock.items.some(i => i.sku === 'ELC-121'), JSON.stringify(deadStock.items));
  ok('every dead-stock line carries a recommended action',
    deadStock.items.every(i => i.recommendation && i.recommendation.length > 10));

  const expiring = (await call('GET', '/api/intel/expiring?warehouse=1&days=60',
    { headers: as(buyer.sessionId) })).body;
  ok('the near-expiry batch is surfaced', expiring.some(e => e.batch === 'B-2601-B'));
  ok('expiring lines carry an action', expiring.every(e => e.action));

  const abc = (await call('GET', '/api/intel/abc-xyz?warehouse=1',
    { headers: as(buyer.sessionId) })).body;
  ok('every SKU is classified', abc.length > 0 && abc.every(x => /^[ABC][XYZ]$/.test(x.class)));
  ok('class A is the top of the value ranking', abc[0].abc === 'A');

  const risk = (await call('GET', '/api/intel/risk?warehouse=1',
    { headers: as(buyer.sessionId) })).body;
  ok('risk scores list the reasons behind them',
    risk.every(r => r.factors.length > 0 && r.score > 0));

  const tomorrow = (await call('GET', '/api/intel/tomorrow?warehouse=1',
    { headers: as(manager.sessionId) })).body;
  ok('the forecast is labelled as an estimate', /not guarantees/i.test(tomorrow.basis));

  // ---------------------------------------------------------- audit trail --
  const audit = (await call('GET', '/api/audit?limit=500', { headers: as(ops.sessionId) })).body;
  ok('the audit trail recorded the month', audit.length > 15, String(audit.length));
  ok('sign-ins are logged', audit.some(a => a.action === 'Sign-in'));
  ok('failed sign-ins are logged', audit.some(a => a.action === 'Sign-in failed'));
  ok('approvals are logged with who approved',
    audit.some(a => a.action === 'Approve adjustment' && a.user === 'Omar Bilal'));
  try {
    await db.query("UPDATE audit_log SET action='tampered'");
    ok('the audit trail cannot be edited through the database either', false, 'the update succeeded');
  } catch (e) {
    ok('the audit trail cannot be edited through the database either', /append-only/i.test(e.message));
  }

  // ------------------------------------------------------------- settings --
  eq('a storekeeper cannot change settings',
    (await call('PUT', '/api/settings/allow_negative_stock',
      { headers: as(store.sessionId), body: { value: 'true' } })).status, 403);
  const set = await call('PUT', '/api/settings/dead_stock_days', {
    headers: as((await call('POST', '/api/session',
      { body: { company: 'UFM', username: 'irshaad', password: PW } })).body.sessionId),
    body: { value: '60', reason: 'Tighter inactivity threshold for the Lusail contract' }
  });
  eq('an administrator can change a setting', set.body.value, '60');
  ok('the change is in the audit trail',
    (await call('GET', '/api/audit', { headers: as(ops.sessionId) }))
      .body.some(a => a.action === 'Change setting' && a.new_value === '60'));

  // ------------------------------------------------------- lockout policy --
  for (let i = 0; i < 5; i++) {
    await call('POST', '/api/session', { body: { company: 'UFM', username: 'mary', password: 'nope-nope-nope' } });
  }
  const locked = await call('POST', '/api/session',
    { body: { company: 'UFM', username: 'mary', password: PW } });
  eq('an account locks after repeated failures', locked.status, 429);
  ok('the lockout message says how long', /minute/i.test(locked.body.error), locked.body.error);

  // ========================== the reconciliation ===========================
  const balances = (await call('GET', '/api/reports/balances?warehouse=1',
    { headers: as(manager.sessionId) })).body;
  const apiTotal = balances.reduce((s, b) => s + num(b.on_hand), 0);
  const ledgerTotal = num((await db.query(
    'SELECT COALESCE(sum(qty),0) q FROM stock_txn WHERE company_id=1 AND warehouse_id=1')).rows[0].q);
  eq('the API balance report equals the ledger, to three decimals',
    apiTotal.toFixed(3), ledgerTotal.toFixed(3));

  const dayFinal = (await call('GET', '/api/reports/day?warehouse=1',
    { headers: as(manager.sessionId) })).body;
  eq('closing stock on the dashboard equals the ledger',
    num(dayFinal.closing).toFixed(3), ledgerTotal.toFixed(3));

  const valFinal = (await call('GET', '/api/reports/valuation?warehouse=1',
    { headers: as(ops.sessionId) })).body;
  const hand = balances.reduce((s, b) =>
    s + Math.round(num(b.on_hand) * num(b.standard_cost) * 100), 0);
  eq('valuation equals quantity times cost, computed independently',
    Math.round(Number(valFinal.total) * 100), hand);

  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} assertions`);
  console.log(`${app.routeCount} routes exercised against a month of activity\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nRUN CRASHED:', e.message, '\n', e.stack); process.exit(1); });
