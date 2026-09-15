'use strict';
/**
 * Stock movement services.
 *
 * Each function below is one database transaction. None of them calculates a
 * balance and writes it anywhere — they append to the ledger and let the
 * database refuse anything that would break an invariant. Where a check appears
 * here as well (available stock, FEFO), it exists to produce a useful message,
 * not to provide the guarantee. The guarantee is in the schema.
 */
const { AuthError, require: requirePerm, requireWarehouse, audit } = require('./auth');
const { qty, cost, money } = require('./money');

class BusinessError extends Error {
  constructor(message, status = 400, detail) { super(message); this.status = status; this.detail = detail; }
}

const docNo = async (t, companyId, type) =>
  (await t.query('SELECT next_doc_no($1,$2) AS n', [companyId, type])).rows[0].n;

const num = v => (v === null || v === undefined ? 0 : Number(v));

/** Shared insert. Every movement in the system goes through this one function. */
async function postTxn(t, ctx, o) {
  const txnNo = await docNo(t, ctx.companyId, 'TXN');
  const r = await t.query(
    `INSERT INTO stock_txn
       (txn_no, company_id, warehouse_id, location_id, item_id, batch_id, txn_type, qty,
        unit_cost, source_type, source_id, ref_no, party_type, party_ref, reason, note,
        posted_by, posted_at, reverses_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18, now()),$19)
     RETURNING id, txn_no, posted_at`,
    [txnNo, ctx.companyId, o.warehouseId, o.locationId, o.itemId, o.batchId || null,
     o.type, o.qty, o.unitCost || 0, o.sourceType || null, o.sourceId || null, o.refNo || null,
     o.partyType || null, o.partyRef || null, o.reason || null, o.note || null,
     ctx.userId, o.postedAt || null, o.reversesId || null]);
  return r.rows[0];
}

/** Translate the database's refusals into something a storekeeper can act on. */
function rethrow(e) {
  const m = e.message || '';
  if (/insufficient stock/i.test(m)) {
    throw new BusinessError('There is not enough stock in that location to cover this movement.', 409, m);
  }
  if (/period .* is closed|closed; post a correction/i.test(m)) {
    throw new BusinessError('That month has been closed. Post the correction in the current period instead.', 409, m);
  }
  if (/batch is required/i.test(m)) {
    throw new BusinessError('This item is batch controlled — select or create a batch first.', 400, m);
  }
  if (/expiry date/i.test(m)) {
    throw new BusinessError('This item is expiry controlled — the batch needs an expiry date.', 400, m);
  }
  if (/does not belong to warehouse/i.test(m)) {
    throw new BusinessError('That location is in a different warehouse.', 400, m);
  }
  if (/does not balance/i.test(m)) {
    throw new BusinessError('Both legs of a transfer must be posted together.', 500, m);
  }
  if (/txn_sign/i.test(m)) {
    throw new BusinessError('The quantity sign does not match the transaction type.', 400, m);
  }
  if (/variance_needs_explanation/i.test(m)) {
    throw new BusinessError('Every counted difference needs a written explanation.', 400, m);
  }
  if (/maker_checker/i.test(m)) {
    throw new BusinessError('You cannot approve something you raised yourself.', 403, m);
  }
  if (/requires approval by role/i.test(m)) {
    throw new BusinessError('That value is above your approval limit.', 403, m);
  }
  throw e;
}

// ---------------------------------------------------------------- receiving --
async function receive(db, ctx, input) {
  requirePerm(ctx, 'stock.receive');
  requireWarehouse(ctx, input.warehouseId);
  if (!input.lines || !input.lines.length) throw new BusinessError('A receipt needs at least one line.');

  return db.tx(async t => {
    try {
      const grn = await docNo(t, ctx.companyId, 'GRN');
      const r = await t.query(
        `INSERT INTO goods_receipt (company_id, grn_no, warehouse_id, supplier_id, po_no,
           delivery_note, invoice_no, status, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'COMPLETED',$8,$9) RETURNING id`,
        [ctx.companyId, grn, input.warehouseId, input.supplierId, input.poNo || null,
         input.deliveryNote || null, input.invoiceNo || null, input.note || null, ctx.userId]);
      const receiptId = r.rows[0].id;
      const posted = [];

      for (const line of input.lines) {
        const batchId = await resolveBatch(t, line);
        await t.query(
          `INSERT INTO goods_receipt_line (receipt_id, item_id, ordered_qty, received_qty,
             unit_cost, batch_id, location_id, condition)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [receiptId, line.itemId, line.orderedQty || null, line.qty, line.unitCost || 0,
           batchId, line.locationId, line.condition || 'GOOD']);

        // Quarantined goods are recorded on the receipt but do not enter stock.
        if ((line.condition || 'GOOD') === 'QUARANTINE') continue;

        posted.push(await postTxn(t, ctx, {
          warehouseId: input.warehouseId, locationId: line.locationId, itemId: line.itemId,
          batchId, type: 'RECEIVE', qty: line.qty, unitCost: line.unitCost || 0,
          sourceType: 'GRN', sourceId: receiptId, refNo: grn,
          partyType: 'Supplier', partyRef: String(input.supplierId), note: line.note
        }));

        if (line.unitCost) {
          await t.query(
            `INSERT INTO item_supplier (item_id, supplier_id, last_price)
             VALUES ($1,$2,$3) ON CONFLICT (item_id, supplier_id) DO UPDATE SET last_price=$3`,
            [line.itemId, input.supplierId, line.unitCost]);
        }
      }

      await audit(t, ctx.companyId, ctx.userId, 'Receive', 'goods_receipt', receiptId,
        null, `${posted.length} line(s)`, input.poNo || null);
      return { receiptId, grnNo: grn, transactions: posted };
    } catch (e) { rethrow(e); }
  });
}

async function resolveBatch(t, line) {
  if (line.batchId) return line.batchId;
  if (!line.batchNo) return null;
  const found = await t.query('SELECT id FROM batch WHERE item_id=$1 AND batch_no=$2',
    [line.itemId, line.batchNo]);
  if (found.rows.length) return found.rows[0].id;
  const made = await t.query(
    'INSERT INTO batch (item_id, batch_no, manufactured_on, expires_on) VALUES ($1,$2,$3,$4) RETURNING id',
    [line.itemId, line.batchNo, line.manufacturedOn || null, line.expiresOn || null]);
  return made.rows[0].id;
}

// ------------------------------------------------------------------ issuing --
async function issue(db, ctx, input) {
  requirePerm(ctx, 'stock.issue');
  requireWarehouse(ctx, input.warehouseId);

  return db.tx(async t => {
    try {
      const avail = await available(t, input.itemId, input.warehouseId);
      if (input.qty > avail) {
        const onHand = await onHandQty(t, input.itemId, input.warehouseId);
        throw new BusinessError(
          `Only ${qty.display(qty.parse(avail))} available. ` +
          `${qty.display(qty.parse(onHand))} is physically here, of which ` +
          `${qty.display(qty.parse(onHand - avail))} is reserved for approved requests.`, 409);
      }

      const batchId = await pickBatch(t, input);
      const ref = input.refNo || await docNo(t, ctx.companyId, 'ISS');
      const tx = await postTxn(t, ctx, {
        warehouseId: input.warehouseId, locationId: input.locationId, itemId: input.itemId,
        batchId, type: 'ISSUE', qty: -Math.abs(input.qty),
        sourceType: input.sourceType || 'ISSUE', sourceId: input.sourceId || null, refNo: ref,
        partyType: input.partyType, partyRef: input.partyRef, note: input.note
      });
      await audit(t, ctx.companyId, ctx.userId, 'Issue', 'stock_txn', tx.id,
        null, -Math.abs(input.qty), `${input.partyType}: ${input.partyRef}`);
      return tx;
    } catch (e) { rethrow(e); }
  });
}

/**
 * FEFO. If the caller named a batch we honour it but report that an earlier one
 * existed — the storekeeper may have a good reason, and the record should show
 * the choice was made rather than missed.
 */
async function pickBatch(t, input) {
  const r = await t.query('SELECT is_batched FROM item WHERE id=$1', [input.itemId]);
  if (!r.rows[0] || !r.rows[0].is_batched) return null;
  const fefo = (await t.query('SELECT fn_fefo_batch($1,$2) AS b',
    [input.itemId, input.warehouseId])).rows[0].b;
  if (!input.batchId) {
    if (!fefo) throw new BusinessError('No batch of this item is in stock in that warehouse.', 409);
    return fefo;
  }
  if (fefo && Number(fefo) !== Number(input.batchId) && !input.fefoOverrideReason) {
    const b = await t.query('SELECT batch_no, expires_on FROM batch WHERE id=$1', [fefo]);
    const on = new Date(b.rows[0].expires_on).toISOString().slice(0, 10);
    throw new BusinessError(
      `Batch ${b.rows[0].batch_no} expires on ${on} and should be issued first. ` +
      `Supply a reason to override FEFO.`, 409);
  }
  return input.batchId;
}

// ----------------------------------------------------------------- transfer --
async function transfer(db, ctx, input) {
  requirePerm(ctx, 'stock.transfer');
  requireWarehouse(ctx, input.fromWarehouseId);

  return db.tx(async t => {
    try {
      if (Number(input.fromLocationId) === Number(input.toLocationId)) {
        throw new BusinessError('The source and destination locations are the same.');
      }
      const ref = await docNo(t, ctx.companyId, 'TRF');
      const common = { itemId: input.itemId, batchId: input.batchId || null, refNo: ref, sourceType: 'TRANSFER' };
      const out = await postTxn(t, ctx, Object.assign({}, common, {
        warehouseId: input.fromWarehouseId, locationId: input.fromLocationId,
        type: 'TRANSFER_OUT', qty: -Math.abs(input.qty), note: input.note
      }));
      const into = await postTxn(t, ctx, Object.assign({}, common, {
        warehouseId: input.toWarehouseId, locationId: input.toLocationId,
        type: 'TRANSFER_IN', qty: Math.abs(input.qty), note: input.note
      }));
      await audit(t, ctx.companyId, ctx.userId, 'Transfer', 'stock_txn', ref,
        input.fromLocationId, input.toLocationId, input.note);
      return { refNo: ref, out, in: into };
    } catch (e) { rethrow(e); }
  });
}

// -------------------------------------------------------------- adjustments --
async function raiseAdjustment(db, ctx, input) {
  requirePerm(ctx, 'stock.adjust');
  return db.tx(async t => {
    try {
      const item = (await t.query('SELECT standard_cost FROM item WHERE id=$1', [input.itemId])).rows[0];
      const value = money.format(money.extend(
        qty.parse(Math.abs(input.qty)), cost.parse(item.standard_cost)));
      const no = await docNo(t, ctx.companyId, 'ADJ');
      const r = await t.query(
        `INSERT INTO stock_adjustment (company_id, adj_no, warehouse_id, location_id, item_id,
           batch_id, qty, value, reason, raised_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, adj_no, value`,
        [ctx.companyId, no, input.warehouseId, input.locationId, input.itemId,
         input.batchId || null, input.qty, value, input.reason, ctx.userId]);
      const approver = (await t.query(
        `SELECT r.code, r.name FROM role r WHERE r.id = fn_required_approver($1,$2)`,
        [ctx.companyId, value])).rows[0];
      await audit(t, ctx.companyId, ctx.userId, 'Raise adjustment', 'stock_adjustment',
        r.rows[0].id, null, input.qty, input.reason);
      return Object.assign(r.rows[0], { requiredApprover: approver ? approver.name : null });
    } catch (e) { rethrow(e); }
  });
}

/**
 * Approving an adjustment records the approval and posts it in the same
 * transaction. The schema will not let the posting exist without the approval,
 * so the two can never drift apart.
 */
async function approveAdjustment(db, ctx, adjustmentId) {
  requirePerm(ctx, 'adjustment.approve');
  return db.tx(async t => {
    try {
      const a = (await t.query(
        `SELECT * FROM stock_adjustment WHERE id=$1 AND company_id=$2`,
        [adjustmentId, ctx.companyId])).rows[0];
      if (!a) throw new BusinessError('That adjustment no longer exists.', 404);
      if (a.status !== 'REQUESTED') throw new BusinessError(`This adjustment is already ${a.status.toLowerCase()}.`, 409);

      await t.query(
        `UPDATE stock_adjustment SET approved_by=$1, approved_at=now(), status='APPROVED' WHERE id=$2`,
        [ctx.userId, adjustmentId]);

      const tx = await postTxn(t, ctx, {
        warehouseId: a.warehouse_id, locationId: a.location_id, itemId: a.item_id,
        batchId: a.batch_id, type: 'ADJUST', qty: Number(a.qty),
        sourceType: 'ADJUSTMENT', sourceId: a.id, refNo: a.adj_no, reason: a.reason
      });
      await t.query('UPDATE stock_adjustment SET posted_txn_id=$1 WHERE id=$2', [tx.id, adjustmentId]);
      await audit(t, ctx.companyId, ctx.userId, 'Approve adjustment', 'stock_adjustment',
        adjustmentId, 'REQUESTED', 'APPROVED', a.reason);
      return { adjustment: a.adj_no, transaction: tx };
    } catch (e) { rethrow(e); }
  });
}

async function rejectAdjustment(db, ctx, adjustmentId, reason) {
  requirePerm(ctx, 'adjustment.approve');
  return db.tx(async t => {
    const a = (await t.query('SELECT raised_by, status FROM stock_adjustment WHERE id=$1 AND company_id=$2',
      [adjustmentId, ctx.companyId])).rows[0];
    if (!a) throw new BusinessError('That adjustment no longer exists.', 404);
    if (Number(a.raised_by) === Number(ctx.userId)) {
      throw new BusinessError('You cannot decide on an adjustment you raised yourself.', 403);
    }
    await t.query(`UPDATE stock_adjustment SET status='REJECTED' WHERE id=$1`, [adjustmentId]);
    await audit(t, ctx.companyId, ctx.userId, 'Reject adjustment', 'stock_adjustment',
      adjustmentId, a.status, 'REJECTED', reason);
    return { rejected: true };
  });
}

// ------------------------------------------------------------------ counting --
async function openCount(db, ctx, { warehouseId, zone }) {
  requirePerm(ctx, 'stock.count');
  requireWarehouse(ctx, warehouseId);
  return db.tx(async t => {
    const no = await docNo(t, ctx.companyId, 'SC');
    const c = await t.query(
      `INSERT INTO stock_count (company_id, count_no, warehouse_id, zone, counted_by, status)
       VALUES ($1,$2,$3,$4,$5,'DRAFT') RETURNING id, count_no`,
      [ctx.companyId, no, warehouseId, zone || null, ctx.userId]);
    const sheet = await t.query(
      `SELECT v.item_id, v.location_id, v.qty AS system_qty, i.sku, i.name, i.name_ar, l.code AS location
         FROM v_stock_by_location v
         JOIN location l ON l.id = v.location_id
         JOIN item i ON i.id = v.item_id
        WHERE v.warehouse_id=$1 AND ($2::text IS NULL OR l.zone=$2)
        ORDER BY l.code, i.sku`,
      [warehouseId, zone || null]);
    return { countId: c.rows[0].id, countNo: c.rows[0].count_no, lines: sheet.rows };
  });
}

async function closeCount(db, ctx, countId, lines) {
  requirePerm(ctx, 'stock.count');
  return db.tx(async t => {
    try {
      const c = (await t.query('SELECT * FROM stock_count WHERE id=$1 AND company_id=$2',
        [countId, ctx.companyId])).rows[0];
      if (!c) throw new BusinessError('That count no longer exists.', 404);
      if (c.closed_at) throw new BusinessError('This count is already closed.', 409);

      let exact = 0, posted = 0;
      for (const line of lines) {
        const systemQty = num(line.systemQty);
        const physical = num(line.physicalQty);
        await t.query(
          `INSERT INTO stock_count_line (count_id, item_id, location_id, batch_id,
             system_qty, physical_qty, explanation)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [countId, line.itemId, line.locationId, line.batchId || null,
           systemQty, physical, line.explanation || null]);

        if (physical === systemQty) { exact++; continue; }
        await postTxn(t, ctx, {
          warehouseId: c.warehouse_id, locationId: line.locationId, itemId: line.itemId,
          batchId: line.batchId || null, type: 'COUNT_ADJUST', qty: physical - systemQty,
          sourceType: 'COUNT', sourceId: countId, refNo: c.count_no,
          reason: `Physical count variance — ${line.explanation}`
        });
        posted++;
      }

      const accuracy = lines.length ? (exact / lines.length * 100).toFixed(2) : '100.00';
      await t.query(
        `UPDATE stock_count SET closed_at=now(), closed_by=$1, status='CLOSED', accuracy_pct=$2 WHERE id=$3`,
        [ctx.userId, accuracy, countId]);
      await audit(t, ctx.companyId, ctx.userId, 'Close count', 'stock_count', countId,
        null, `${accuracy}% accurate`, `${posted} variance(s) posted`);
      return { countNo: c.count_no, accuracy: Number(accuracy), variances: posted, lines: lines.length };
    } catch (e) { rethrow(e); }
  });
}

// ------------------------------------------------------------------ helpers --
const onHandQty = async (t, itemId, warehouseId) =>
  num((await t.query('SELECT fn_on_hand($1,$2) AS q', [itemId, warehouseId])).rows[0].q);
const available = async (t, itemId, warehouseId) =>
  num((await t.query('SELECT fn_available($1,$2) AS q', [itemId, warehouseId])).rows[0].q);

/** Reverse a posted transaction. The schema enforces the mirroring. */
async function reverse(db, ctx, txnId, reason) {
  requirePerm(ctx, 'stock.adjust');
  if (!reason || reason.trim().length < 5) {
    throw new BusinessError('A reversal needs a reason of at least five characters.');
  }
  return db.tx(async t => {
    try {
      const o = (await t.query('SELECT * FROM stock_txn WHERE id=$1 AND company_id=$2',
        [txnId, ctx.companyId])).rows[0];
      if (!o) throw new BusinessError('That transaction does not exist.', 404);
      const tx = await postTxn(t, ctx, {
        warehouseId: o.warehouse_id, locationId: o.location_id, itemId: o.item_id,
        batchId: o.batch_id, type: 'ADJUST', qty: -Number(o.qty),
        refNo: o.txn_no, reason: `Reversal of ${o.txn_no} — ${reason}`, reversesId: o.id
      });
      await audit(t, ctx.companyId, ctx.userId, 'Reverse transaction', 'stock_txn', txnId,
        o.qty, -Number(o.qty), reason);
      return tx;
    } catch (e) {
      if (/already|duplicate|txn_single_reversal/i.test(e.message)) {
        throw new BusinessError('That transaction has already been reversed.', 409);
      }
      rethrow(e);
    }
  });
}

module.exports = {
  BusinessError, receive, issue, transfer, reverse,
  raiseAdjustment, approveAdjustment, rejectAdjustment,
  openCount, closeCount, postTxn, onHandQty, available
};
