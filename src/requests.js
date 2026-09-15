'use strict';
/**
 * Material requests.
 *
 * The lifecycle is Requested → Approved → Reserved → Issued → Completed.
 * Approval is where availability is checked and a short supply is cut back
 * honestly rather than promised and then not delivered. Reserving does not move
 * stock — it only reduces what everyone else can see as available.
 */
const { require: requirePerm, requireWarehouse, audit } = require('./auth');
const { BusinessError, postTxn } = require('./stock');

const num = v => (v === null || v === undefined ? 0 : Number(v));
const docNo = async (t, companyId, type) =>
  (await t.query('SELECT next_doc_no($1,$2) AS n', [companyId, type])).rows[0].n;

async function create(db, ctx, input) {
  requirePerm(ctx, 'request.create');
  if (!input.lines || !input.lines.length) throw new BusinessError('A request needs at least one line.');
  if (!input.departmentId && !input.projectId) {
    throw new BusinessError('A request must name a department, a project, or both.');
  }
  return db.tx(async t => {
    const no = await docNo(t, ctx.companyId, 'MR');
    const r = await t.query(
      `INSERT INTO stock_request (company_id, request_no, warehouse_id, requested_by,
         department_id, project_id, priority, required_by, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, request_no`,
      [ctx.companyId, no, input.warehouseId, ctx.userId, input.departmentId || null,
       input.projectId || null, input.priority || 'NORMAL', input.requiredBy || null, input.reason || null]);
    for (const l of input.lines) {
      await t.query(
        'INSERT INTO stock_request_line (request_id, item_id, requested_qty) VALUES ($1,$2,$3)',
        [r.rows[0].id, l.itemId, l.qty]);
    }
    await audit(t, ctx.companyId, ctx.userId, 'Create request', 'stock_request',
      r.rows[0].id, null, `${input.lines.length} line(s)`, input.reason);
    return { requestId: r.rows[0].id, requestNo: r.rows[0].request_no, status: 'REQUESTED' };
  });
}

/**
 * Approve. Each line is approved up to what is actually available, never
 * beyond — a request approved in full for stock that is not there just moves
 * the disappointment to the storekeeper.
 */
async function approve(db, ctx, requestId) {
  requirePerm(ctx, 'request.approve');
  return db.tx(async t => {
    const r = (await t.query('SELECT * FROM stock_request WHERE id=$1 AND company_id=$2',
      [requestId, ctx.companyId])).rows[0];
    if (!r) throw new BusinessError('That request no longer exists.', 404);
    if (r.status !== 'REQUESTED') throw new BusinessError(`This request is already ${r.status.toLowerCase()}.`, 409);
    if (Number(r.requested_by) === Number(ctx.userId)) {
      throw new BusinessError('You cannot approve a request you raised yourself.', 403);
    }
    requireWarehouse(ctx, r.warehouse_id);

    const lines = (await t.query('SELECT * FROM stock_request_line WHERE request_id=$1', [requestId])).rows;
    const short = [];
    for (const l of lines) {
      const avail = num((await t.query('SELECT fn_available($1,$2) AS q',
        [l.item_id, r.warehouse_id])).rows[0].q);
      const approved = Math.max(0, Math.min(num(l.requested_qty), avail));
      await t.query('UPDATE stock_request_line SET approved_qty=$1 WHERE id=$2', [approved, l.id]);
      if (approved < num(l.requested_qty)) {
        const item = (await t.query('SELECT sku, name FROM item WHERE id=$1', [l.item_id])).rows[0];
        short.push({ sku: item.sku, name: item.name, requested: num(l.requested_qty), approved });
      }
    }
    await t.query(
      `UPDATE stock_request SET status='APPROVED', approved_by=$1, approved_at=now() WHERE id=$2`,
      [ctx.userId, requestId]);
    await audit(t, ctx.companyId, ctx.userId, 'Approve request', 'stock_request', requestId,
      'REQUESTED', 'APPROVED', short.length ? `${short.length} line(s) reduced to available stock` : 'approved in full');
    return { requestNo: r.request_no, status: 'APPROVED', shortLines: short };
  });
}

/** Reserve. No ledger movement — this only changes what fn_available reports. */
async function reserve(db, ctx, requestId) {
  requirePerm(ctx, 'request.approve');
  return db.tx(async t => {
    const r = (await t.query('SELECT * FROM stock_request WHERE id=$1 AND company_id=$2',
      [requestId, ctx.companyId])).rows[0];
    if (!r) throw new BusinessError('That request no longer exists.', 404);
    if (r.status !== 'APPROVED') throw new BusinessError('Only an approved request can reserve stock.', 409);

    const lines = (await t.query(
      'SELECT * FROM stock_request_line WHERE request_id=$1 AND approved_qty > 0', [requestId])).rows;
    for (const l of lines) {
      await t.query(
        `INSERT INTO stock_reservation (company_id, warehouse_id, item_id, qty, source_type, source_id, created_by)
         VALUES ($1,$2,$3,$4,'REQUEST',$5,$6)`,
        [ctx.companyId, r.warehouse_id, l.item_id, num(l.approved_qty) - num(l.issued_qty), requestId, ctx.userId]);
    }
    await t.query(`UPDATE stock_request SET status='RESERVED' WHERE id=$1`, [requestId]);
    await audit(t, ctx.companyId, ctx.userId, 'Reserve stock', 'stock_request', requestId,
      'APPROVED', 'RESERVED', `${lines.length} line(s)`);
    return { requestNo: r.request_no, status: 'RESERVED', reservedLines: lines.length };
  });
}

/**
 * Issue against the request. The reservation is released in the same
 * transaction as the movement, so available quantity never double-counts.
 */
async function issueAgainst(db, ctx, requestId) {
  requirePerm(ctx, 'stock.issue');
  return db.tx(async t => {
    const r = (await t.query('SELECT * FROM stock_request WHERE id=$1 AND company_id=$2',
      [requestId, ctx.companyId])).rows[0];
    if (!r) throw new BusinessError('That request no longer exists.', 404);
    if (!['APPROVED', 'RESERVED', 'PARTIAL'].includes(r.status)) {
      throw new BusinessError(`A request with status ${r.status.toLowerCase()} cannot be issued.`, 409);
    }
    requireWarehouse(ctx, r.warehouse_id);

    const lines = (await t.query(
      'SELECT * FROM stock_request_line WHERE request_id=$1 AND approved_qty > issued_qty', [requestId])).rows;
    if (!lines.length) throw new BusinessError('Every approved line has already been issued.', 409);

    const project = r.project_id
      ? (await t.query('SELECT name FROM project WHERE id=$1', [r.project_id])).rows[0].name : null;
    const dept = r.department_id
      ? (await t.query('SELECT name FROM department WHERE id=$1', [r.department_id])).rows[0].name : null;

    let issued = 0, partial = false;
    for (const l of lines) {
      let outstanding = num(l.approved_qty) - num(l.issued_qty);
      // Draw from bins in descending quantity, so a pick empties the fullest
      // location first rather than scattering small residues everywhere.
      const bins = (await t.query(
        `SELECT location_id, qty FROM v_stock_by_location
          WHERE item_id=$1 AND warehouse_id=$2 AND qty > 0 ORDER BY qty DESC`,
        [l.item_id, r.warehouse_id])).rows;

      for (const bin of bins) {
        if (outstanding <= 0) break;
        const take = Math.min(outstanding, num(bin.qty));
        const batch = (await t.query('SELECT fn_fefo_batch($1,$2) AS b',
          [l.item_id, r.warehouse_id])).rows[0].b;
        await postTxn(t, ctx, {
          warehouseId: r.warehouse_id, locationId: bin.location_id, itemId: l.item_id,
          batchId: batch, type: 'ISSUE', qty: -take,
          sourceType: 'REQUEST', sourceId: requestId, refNo: r.request_no,
          partyType: project ? 'Project' : 'Department', partyRef: project || dept,
          note: `Against ${r.request_no}${dept ? ' — ' + dept : ''}`
        });
        outstanding -= take;
        issued += take;
      }

      const nowIssued = num(l.approved_qty) - outstanding;
      await t.query('UPDATE stock_request_line SET issued_qty=$1 WHERE id=$2', [nowIssued, l.id]);
      if (outstanding > 0) partial = true;
    }

    await t.query(
      `UPDATE stock_reservation SET qty_released = qty, released_at = now()
        WHERE source_type='REQUEST' AND source_id=$1 AND released_at IS NULL`, [requestId]);

    const status = partial ? 'PARTIAL' : 'COMPLETED';
    await t.query('UPDATE stock_request SET status=$1 WHERE id=$2', [status, requestId]);
    await audit(t, ctx.companyId, ctx.userId, 'Issue against request', 'stock_request', requestId,
      r.status, status, `${issued} unit(s)`);
    return { requestNo: r.request_no, status, issuedQty: issued };
  });
}

async function cancel(db, ctx, requestId, reason) {
  return db.tx(async t => {
    const r = (await t.query('SELECT * FROM stock_request WHERE id=$1 AND company_id=$2',
      [requestId, ctx.companyId])).rows[0];
    if (!r) throw new BusinessError('That request no longer exists.', 404);
    if (['COMPLETED', 'CANCELLED'].includes(r.status)) {
      throw new BusinessError(`This request is already ${r.status.toLowerCase()}.`, 409);
    }
    await t.query(
      `UPDATE stock_reservation SET qty_released = qty, released_at = now()
        WHERE source_type='REQUEST' AND source_id=$1 AND released_at IS NULL`, [requestId]);
    await t.query(`UPDATE stock_request SET status='CANCELLED' WHERE id=$1`, [requestId]);
    await audit(t, ctx.companyId, ctx.userId, 'Cancel request', 'stock_request', requestId,
      r.status, 'CANCELLED', reason);
    return { requestNo: r.request_no, status: 'CANCELLED' };
  });
}

async function list(db, ctx, { warehouseId, status } = {}) {
  const r = await db.query(
    `SELECT r.id, r.request_no, r.status, r.priority, r.required_by, r.created_at,
            u.full_name AS requester, d.name AS department, p.name AS project,
            w.code AS warehouse, count(l.id)::int AS lines
       FROM stock_request r
       JOIN app_user u ON u.id = r.requested_by
       JOIN warehouse w ON w.id = r.warehouse_id
       LEFT JOIN department d ON d.id = r.department_id
       LEFT JOIN project p ON p.id = r.project_id
       LEFT JOIN stock_request_line l ON l.request_id = r.id
      WHERE r.company_id=$1
        AND ($2::bigint IS NULL OR r.warehouse_id=$2)
        AND ($3::text IS NULL OR r.status::text=$3)
      GROUP BY r.id, u.full_name, d.name, p.name, w.code
      ORDER BY r.created_at DESC`,
    [ctx.companyId, warehouseId || null, status || null]);
  return r.rows;
}

module.exports = { create, approve, reserve, issueAgainst, cancel, list };
