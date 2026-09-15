'use strict';
/**
 * The REST API.
 *
 * Every route that touches company data resolves a session first. Permission
 * checks live in the services rather than here, so a permission cannot be
 * bypassed by calling a service from somewhere else later.
 */
const { createRouter, dispatch, listen, HttpError } = require('./http');
const auth = require('./auth');
const stock = require('./stock');
const requests = require('./requests');
const reports = require('./reports');
const intel = require('./intel');

function createApp(db, options = {}) {
  const router = createRouter();
  const deps = { db, log: options.log || (() => {}) };

  /** Resolve the caller, or refuse. */
  const who = req => auth.context(db, req.session);

  const need = (body, ...fields) => {
    for (const f of fields) {
      if (body[f] === undefined || body[f] === null || body[f] === '') {
        throw new HttpError(`"${f}" is required.`, 400);
      }
    }
  };

  // ------------------------------------------------------------- service ----
  router.get('/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok', time: new Date().toISOString() };
  });

  // ---------------------------------------------------------------- auth ----
  router.post('/api/session', async req => {
    need(req.body, 'company', 'username', 'password');
    const r = await auth.login(db, {
      companyCode: req.body.company, username: req.body.username, password: req.body.password,
      device: req.device, ip: req.ip
    });
    return {
      sessionId: r.sessionId,
      user: { name: r.user.name, role: r.user.role, permissions: [...r.user.permissions] }
    };
  }, { status: 201 });

  router.del('/api/session', async req => {
    await auth.logout(db, req.session);
    return { signedOut: true };
  });

  router.get('/api/me', async req => {
    const ctx = await who(req);
    return {
      name: ctx.name, username: ctx.username, role: ctx.role,
      permissions: [...ctx.permissions], warehouses: ctx.warehouses
    };
  });

  // ------------------------------------------------------------ reference ---
  router.get('/api/warehouses', async req => {
    const ctx = await who(req);
    const r = await db.query(
      'SELECT id, code, name, name_ar, site FROM warehouse WHERE company_id=$1 AND is_active ORDER BY code',
      [ctx.companyId]);
    return ctx.warehouses
      ? r.rows.filter(w => ctx.warehouses.includes(Number(w.id)))
      : r.rows;
  });

  router.get('/api/locations', async req => {
    const ctx = await who(req);
    auth.require(ctx, 'inventory.view');
    const r = await db.query(
      `SELECT l.id, l.code, l.zone, l.rack, l.shelf, l.bin, l.capacity,
              COALESCE((SELECT sum(qty) FROM v_stock_by_location v WHERE v.location_id=l.id AND v.qty>0),0) AS occupied
         FROM location l JOIN warehouse w ON w.id=l.warehouse_id
        WHERE w.company_id=$1 AND ($2::bigint IS NULL OR l.warehouse_id=$2) AND l.is_active
        ORDER BY l.code`,
      [ctx.companyId, req.numParam('warehouse')]);
    return r.rows;
  });

  router.get('/api/items', async req => {
    const ctx = await who(req);
    auth.require(ctx, 'inventory.view');
    const q = (req.query.q || '').trim();
    const r = await db.query(
      `SELECT i.id, i.sku, i.barcode, i.name, i.name_ar, i.uom_code, i.part_no, i.brand,
              i.min_qty, i.max_qty, i.standard_cost, i.is_batched, i.is_expiry_controlled,
              c.name AS category
         FROM item i JOIN category c ON c.id=i.category_id
        WHERE i.company_id=$1 AND i.is_active
          AND ($2 = '' OR i.sku ILIKE '%'||$2||'%' OR i.name ILIKE '%'||$2||'%'
               OR i.name_ar LIKE '%'||$2||'%' OR i.barcode = $2 OR i.part_no ILIKE '%'||$2||'%')
        ORDER BY i.name LIMIT 200`,
      [ctx.companyId, q]);
    return r.rows;
  });

  /** Scan: one code in, everything the storekeeper needs out. */
  router.get('/api/scan/:code', async req => {
    const ctx = await who(req);
    auth.require(ctx, 'inventory.view');
    const wh = req.numParam('warehouse');
    const r = await db.query(
      `SELECT i.* FROM item i
        WHERE i.company_id=$1 AND i.is_active
          AND (i.barcode=$2 OR i.sku=$2 OR lower(i.part_no)=lower($2))
        LIMIT 1`, [ctx.companyId, req.params.code]);
    if (!r.rows.length) throw new HttpError('No item matches that code.', 404);
    const i = r.rows[0];
    const [onHand, reserved, locs, batches, last] = await Promise.all([
      db.query('SELECT fn_on_hand($1,$2) q', [i.id, wh]),
      db.query('SELECT fn_reserved($1,$2) q', [i.id, wh]),
      db.query(`SELECT l.code, v.qty FROM v_stock_by_location v JOIN location l ON l.id=v.location_id
                 WHERE v.item_id=$1 AND ($2::bigint IS NULL OR v.warehouse_id=$2) ORDER BY v.qty DESC`, [i.id, wh]),
      db.query(`SELECT batch_no, expires_on, qty FROM v_stock_by_batch
                 WHERE item_id=$1 AND ($2::bigint IS NULL OR warehouse_id=$2)
                 ORDER BY expires_on NULLS LAST`, [i.id, wh]),
      db.query(`SELECT txn_no, txn_type, qty, posted_at FROM stock_txn
                 WHERE item_id=$1 ORDER BY posted_at DESC LIMIT 1`, [i.id])
    ]);
    return {
      item: { id: i.id, sku: i.sku, name: i.name, nameAr: i.name_ar, uom: i.uom_code,
              minQty: Number(i.min_qty), isBatched: i.is_batched, isExpiryControlled: i.is_expiry_controlled },
      onHand: Number(onHand.rows[0].q), reserved: Number(reserved.rows[0].q),
      available: Number(onHand.rows[0].q) - Number(reserved.rows[0].q),
      locations: locs.rows, batches: batches.rows, lastTransaction: last.rows[0] || null
    };
  });

  // -------------------------------------------------------------- stock -----
  router.post('/api/receipts', async req => {
    const ctx = await who(req);
    need(req.body, 'warehouseId', 'supplierId', 'lines');
    return stock.receive(db, ctx, req.body);
  }, { status: 201 });

  router.post('/api/issues', async req => {
    const ctx = await who(req);
    need(req.body, 'warehouseId', 'itemId', 'locationId', 'qty', 'partyType', 'partyRef');
    return stock.issue(db, ctx, req.body);
  }, { status: 201 });

  router.post('/api/transfers', async req => {
    const ctx = await who(req);
    need(req.body, 'itemId', 'qty', 'fromWarehouseId', 'fromLocationId', 'toWarehouseId', 'toLocationId');
    return stock.transfer(db, ctx, req.body);
  }, { status: 201 });

  router.post('/api/transactions/:id/reverse', async req => {
    const ctx = await who(req);
    need(req.body, 'reason');
    return stock.reverse(db, ctx, req.params.id, req.body.reason);
  }, { status: 201 });

  // --------------------------------------------------------- adjustments ----
  router.post('/api/adjustments', async req => {
    const ctx = await who(req);
    need(req.body, 'warehouseId', 'locationId', 'itemId', 'qty', 'reason');
    return stock.raiseAdjustment(db, ctx, req.body);
  }, { status: 201 });

  router.get('/api/adjustments', async req => {
    const ctx = await who(req);
    auth.require(ctx, 'inventory.view');
    const r = await db.query(
      `SELECT a.id, a.adj_no, a.qty, a.value, a.reason, a.status, a.raised_at,
              i.sku, i.name, u.full_name AS raised_by, w.code AS warehouse,
              (SELECT name FROM role WHERE id = fn_required_approver(a.company_id, a.value)) AS required_approver
         FROM stock_adjustment a
         JOIN item i ON i.id=a.item_id JOIN app_user u ON u.id=a.raised_by
         JOIN warehouse w ON w.id=a.warehouse_id
        WHERE a.company_id=$1 AND ($2::text IS NULL OR a.status::text=$2)
        ORDER BY a.raised_at DESC`,
      [ctx.companyId, req.query.status || null]);
    return r.rows;
  });

  router.post('/api/adjustments/:id/approve', async req => {
    const ctx = await who(req);
    return stock.approveAdjustment(db, ctx, req.params.id);
  });

  router.post('/api/adjustments/:id/reject', async req => {
    const ctx = await who(req);
    return stock.rejectAdjustment(db, ctx, req.params.id, req.body.reason);
  });

  // ------------------------------------------------------------- counts -----
  router.post('/api/counts', async req => {
    const ctx = await who(req);
    need(req.body, 'warehouseId');
    return stock.openCount(db, ctx, req.body);
  }, { status: 201 });

  router.post('/api/counts/:id/close', async req => {
    const ctx = await who(req);
    need(req.body, 'lines');
    return stock.closeCount(db, ctx, req.params.id, req.body.lines);
  });

  // ----------------------------------------------------------- requests -----
  router.post('/api/requests', async req => {
    const ctx = await who(req);
    need(req.body, 'warehouseId', 'lines');
    return requests.create(db, ctx, req.body);
  }, { status: 201 });

  router.get('/api/requests', async req => {
    const ctx = await who(req);
    auth.require(ctx, 'inventory.view');
    return requests.list(db, ctx, { warehouseId: req.numParam('warehouse'), status: req.query.status });
  });

  router.post('/api/requests/:id/approve', async req => {
    const ctx = await who(req);
    return requests.approve(db, ctx, req.params.id);
  });
  router.post('/api/requests/:id/reserve', async req => {
    const ctx = await who(req);
    return requests.reserve(db, ctx, req.params.id);
  });
  router.post('/api/requests/:id/issue', async req => {
    const ctx = await who(req);
    return requests.issueAgainst(db, ctx, req.params.id);
  });
  router.post('/api/requests/:id/cancel', async req => {
    const ctx = await who(req);
    return requests.cancel(db, ctx, req.params.id, req.body.reason);
  });

  // ------------------------------------------------------------ reports -----
  const wh = req => req.numParam('warehouse');

  router.get('/api/reports/balances', async req =>
    reports.balances(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/reports/day', async req =>
    reports.dayPosition(db, await who(req), { warehouseId: wh(req), day: req.query.day }));
  router.get('/api/reports/movement', async req =>
    reports.movement(db, await who(req), { warehouseId: wh(req), from: req.query.from, to: req.query.to }));
  router.get('/api/reports/valuation', async req =>
    reports.valuation(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/reports/accuracy', async req =>
    reports.accuracy(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/reports/variances', async req =>
    reports.variances(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/reports/consumption', async req =>
    reports.consumption(db, await who(req), { warehouseId: wh(req), days: req.numParam('days') || 90 }));
  router.get('/api/reports/activity', async req =>
    reports.userActivity(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/reports/utilisation', async req =>
    reports.utilisation(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/reports/health', async req =>
    reports.health(db, await who(req), { warehouseId: wh(req) }));

  // ------------------------------------------------------- intelligence -----
  router.get('/api/intel/reorder', async req =>
    intel.reorder(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/intel/forecast', async req =>
    intel.forecast(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/intel/dead-stock', async req =>
    intel.deadStock(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/intel/expiring', async req =>
    intel.expiring(db, await who(req), { warehouseId: wh(req), days: req.numParam('days') || 90 }));
  router.get('/api/intel/abc-xyz', async req =>
    intel.abcXyz(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/intel/risk', async req =>
    intel.risk(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/intel/anomalies', async req =>
    intel.anomalies(db, await who(req), { warehouseId: wh(req) }));
  router.get('/api/intel/tomorrow', async req =>
    intel.tomorrow(db, await who(req), { warehouseId: wh(req) }));

  // -------------------------------------------------------------- audit -----
  router.get('/api/audit', async req => {
    const ctx = await who(req);
    auth.require(ctx, 'audit.view');
    const r = await db.query(
      `SELECT a.at, a.action, a.entity, a.entity_id, a.old_value, a.new_value, a.reason,
              a.device, u.full_name AS user
         FROM audit_log a LEFT JOIN app_user u ON u.id=a.user_id
        WHERE a.company_id=$1 ORDER BY a.at DESC, a.id DESC LIMIT $2`,
      [ctx.companyId, Math.min(req.numParam('limit') || 200, 1000)]);
    return r.rows;
  });

  // ----------------------------------------------------------- settings -----
  router.get('/api/settings', async req => {
    const ctx = await who(req);
    auth.require(ctx, 'settings.manage');
    const r = await db.query('SELECT key, value FROM company_setting WHERE company_id=$1 ORDER BY key',
      [ctx.companyId]);
    return Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  });

  router.put('/api/settings/:key', async req => {
    const ctx = await who(req);
    auth.require(ctx, 'settings.manage');
    need(req.body, 'value');
    const old = await db.query('SELECT value FROM company_setting WHERE company_id=$1 AND key=$2',
      [ctx.companyId, req.params.key]);
    await db.query(
      `INSERT INTO company_setting (company_id, key, value) VALUES ($1,$2,$3)
       ON CONFLICT (company_id, key) DO UPDATE SET value=$3, updated_at=now()`,
      [ctx.companyId, req.params.key, String(req.body.value)]);
    await auth.audit(db, ctx.companyId, ctx.userId, 'Change setting', 'company_setting',
      req.params.key, old.rows[0] ? old.rows[0].value : null, req.body.value, req.body.reason);
    return { key: req.params.key, value: String(req.body.value) };
  });

  return {
    router,
    deps,
    /** Direct invocation, used by tests. Accepts a query string in the path. */
    call: (method, path, { body, query, headers } = {}) => {
      const [p, qs] = String(path).split('?');
      const merged = Object.assign(
        qs ? Object.fromEntries(new URLSearchParams(qs)) : {}, query || {});
      return dispatch(router, deps, { method, path: p, body, query: merged, headers });
    },
    listen: port => listen(router, deps, port),
    routeCount: router.routes.length
  };
}

module.exports = { createApp };
