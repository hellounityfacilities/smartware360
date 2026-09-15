'use strict';
/**
 * Reporting.
 *
 * Every figure here is a query over the ledger. Nothing is cached, nothing is
 * maintained incrementally, so a report can never disagree with the
 * transactions it claims to summarise.
 */
const { require: requirePerm } = require('./auth');
const { money, qty, cost } = require('./money');

const num = v => (v === null || v === undefined ? 0 : Number(v));

/** Value a quantity at standard cost, in minor units, without touching a float. */
const value = (q, c) => money.extend(qty.parse(num(q).toFixed(3)), cost.parse(num(c).toFixed(4)));

async function balances(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'inventory.view');
  const r = await db.query(
    `SELECT i.id, i.sku, i.name, i.name_ar, i.uom_code, i.min_qty, i.max_qty, i.reorder_qty,
            i.standard_cost, c.name AS category,
            COALESCE(fn_on_hand(i.id, $2), 0)   AS on_hand,
            COALESCE(fn_reserved(i.id, $2), 0)  AS reserved,
            COALESCE(fn_available(i.id, $2), 0) AS available,
            (SELECT l.code FROM v_stock_by_location v JOIN location l ON l.id=v.location_id
              WHERE v.item_id=i.id AND ($2::bigint IS NULL OR v.warehouse_id=$2)
              ORDER BY v.qty DESC LIMIT 1) AS primary_location
       FROM item i JOIN category c ON c.id = i.category_id
      WHERE i.company_id=$1 AND i.is_active
      ORDER BY i.name`,
    [ctx.companyId, warehouseId || null]);

  return r.rows.map(x => Object.assign(x, {
    stock_value: money.format(value(x.on_hand, x.standard_cost)),
    status: classify(x)
  }));
}

function classify(x) {
  const on = num(x.on_hand), av = num(x.available);
  if (on <= 0) return 'OUT';
  if (av <= num(x.min_qty) * 0.4) return 'CRITICAL';
  if (av <= num(x.reorder_qty)) return 'LOW';
  if (num(x.max_qty) > 0 && on > num(x.max_qty) * 1.15) return 'OVERSTOCK';
  return 'HEALTHY';
}

async function dayPosition(db, ctx, { warehouseId, day } = {}) {
  requirePerm(ctx, 'dashboard.view');
  const d = day || new Date().toISOString().slice(0, 10);
  const r = await db.query('SELECT * FROM fn_day_movement($1,$2,$3)',
    [ctx.companyId, warehouseId || null, d]);
  const m = r.rows[0];
  // Proven in the schema suite, asserted again here: the equation the dashboard
  // shows is the equation the ledger produces.
  const check = num(m.opening) + num(m.receipts) + num(m.returns_in) + num(m.transfers_in)
              - num(m.issues) - num(m.returns_out) - num(m.transfers_out) + num(m.adjustments);
  return Object.assign({ date: d, balances: check.toFixed(3) === num(m.closing).toFixed(3) }, m);
}

async function movement(db, ctx, { warehouseId, from, to, limit = 200 } = {}) {
  requirePerm(ctx, 'report.view');
  const r = await db.query(
    `SELECT t.txn_no, t.posted_at, t.txn_type, t.qty, t.ref_no, t.party_type, t.party_ref,
            t.reason, i.sku, i.name, l.code AS location, u.full_name AS posted_by,
            t.reverses_id IS NOT NULL AS is_reversal
       FROM stock_txn t
       JOIN item i ON i.id = t.item_id
       JOIN location l ON l.id = t.location_id
       JOIN app_user u ON u.id = t.posted_by
      WHERE t.company_id=$1
        AND ($2::bigint IS NULL OR t.warehouse_id=$2)
        AND ($3::date IS NULL OR t.posted_at >= $3::timestamptz)
        AND ($4::date IS NULL OR t.posted_at < ($4::date + 1)::timestamptz)
      ORDER BY t.posted_at DESC, t.id DESC
      LIMIT $5`,
    [ctx.companyId, warehouseId || null, from || null, to || null, Math.min(limit, 1000)]);
  return r.rows;
}

async function valuation(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'report.financial');
  const rows = await balances(db, ctx, { warehouseId });
  const byCategory = {};
  let total = money.zero;
  for (const x of rows) {
    const v = value(x.on_hand, x.standard_cost);
    if (v <= 0n) continue;
    total = money.add(total, v);
    const k = x.category;
    byCategory[k] = byCategory[k] || { category: k, skus: 0, units: 0, value: money.zero };
    byCategory[k].skus++;
    byCategory[k].units += num(x.on_hand);
    byCategory[k].value = money.add(byCategory[k].value, v);
  }
  return {
    total: money.format(total),
    categories: Object.values(byCategory)
      .sort((a, b) => (b.value > a.value ? 1 : -1))
      .map(c => Object.assign(c, {
        value: money.format(c.value),
        share: total > 0n ? (Number(c.value * 1000n / total) / 10).toFixed(1) + '%' : '0%'
      }))
  };
}

async function accuracy(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'report.view');
  const r = await db.query(
    `SELECT count(*)::int AS lines,
            count(*) FILTER (WHERE l.variance = 0)::int AS exact,
            count(DISTINCT c.id)::int AS counts
       FROM stock_count c JOIN stock_count_line l ON l.count_id = c.id
      WHERE c.company_id=$1 AND c.status='CLOSED'
        AND ($2::bigint IS NULL OR c.warehouse_id=$2)`,
    [ctx.companyId, warehouseId || null]);
  const x = r.rows[0];
  return {
    counts: x.counts, lines: x.lines, exact: x.exact,
    accuracyPct: x.lines ? +(x.exact / x.lines * 100).toFixed(2) : 100
  };
}

async function variances(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'report.view');
  const r = await db.query(
    `SELECT c.count_no, c.closed_at, i.sku, i.name, l.code AS location,
            cl.system_qty, cl.physical_qty, cl.variance, cl.explanation, u.full_name AS counted_by
       FROM stock_count_line cl
       JOIN stock_count c ON c.id = cl.count_id
       JOIN item i ON i.id = cl.item_id
       JOIN location l ON l.id = cl.location_id
       JOIN app_user u ON u.id = c.counted_by
      WHERE c.company_id=$1 AND cl.variance <> 0
        AND ($2::bigint IS NULL OR c.warehouse_id=$2)
      ORDER BY c.closed_at DESC NULLS LAST, abs(cl.variance) DESC`,
    [ctx.companyId, warehouseId || null]);
  return r.rows;
}

async function consumption(db, ctx, { warehouseId, days = 90 } = {}) {
  requirePerm(ctx, 'report.view');
  const r = await db.query(
    `SELECT t.party_type, t.party_ref,
            count(*)::int AS transactions,
            -sum(t.qty) AS units,
            sum(-t.qty * i.standard_cost) AS value
       FROM stock_txn t JOIN item i ON i.id = t.item_id
      WHERE t.company_id=$1 AND t.txn_type='ISSUE'
        AND t.posted_at > now() - ($3 || ' days')::interval
        AND ($2::bigint IS NULL OR t.warehouse_id=$2)
        AND t.party_ref IS NOT NULL
      GROUP BY t.party_type, t.party_ref
      ORDER BY value DESC`,
    [ctx.companyId, warehouseId || null, String(days)]);
  return r.rows.map(x => Object.assign(x, { value: num(x.value).toFixed(2) }));
}

async function userActivity(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'report.view');
  const r = await db.query(
    `SELECT u.full_name, r.name AS role, count(*)::int AS transactions,
            count(*) FILTER (WHERE t.txn_type='RECEIVE')::int AS receipts,
            count(*) FILTER (WHERE t.txn_type='ISSUE')::int AS issues,
            count(*) FILTER (WHERE t.txn_type IN ('ADJUST','COUNT_ADJUST'))::int AS adjustments,
            max(t.posted_at) AS last_activity
       FROM stock_txn t JOIN app_user u ON u.id=t.posted_by JOIN role r ON r.id=u.role_id
      WHERE t.company_id=$1 AND ($2::bigint IS NULL OR t.warehouse_id=$2)
      GROUP BY u.full_name, r.name ORDER BY transactions DESC`,
    [ctx.companyId, warehouseId || null]);
  return r.rows;
}

async function utilisation(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'inventory.view');
  const r = await db.query(
    `SELECT w.code AS warehouse, l.zone, l.rack,
            sum(l.capacity) AS capacity,
            COALESCE(sum(v.qty), 0) AS occupied
       FROM location l
       JOIN warehouse w ON w.id = l.warehouse_id
       LEFT JOIN (SELECT location_id, sum(qty) qty FROM v_stock_by_location
                   WHERE qty > 0 GROUP BY location_id) v ON v.location_id = l.id
      WHERE w.company_id=$1 AND ($2::bigint IS NULL OR l.warehouse_id=$2)
      GROUP BY w.code, l.zone, l.rack ORDER BY w.code, l.zone, l.rack`,
    [ctx.companyId, warehouseId || null]);
  return r.rows.map(x => {
    const pct = num(x.capacity) ? num(x.occupied) / num(x.capacity) * 100 : 0;
    return Object.assign(x, {
      utilisation: +pct.toFixed(1),
      status: pct > 92 ? 'FULL' : pct > 75 ? 'NEAR_FULL' : pct < 30 ? 'SPACE_AVAILABLE' : 'HEALTHY'
    });
  });
}

/**
 * Warehouse health. A weighted score with every component and its reason
 * returned, because a number on its own tells a manager nothing about what to
 * do next.
 */
async function health(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'dashboard.view');
  const rows = await balances(db, ctx, { warehouseId });
  const n = rows.length || 1;
  const low = rows.filter(x => ['LOW', 'CRITICAL'].includes(x.status)).length;
  const out = rows.filter(x => x.status === 'OUT').length;
  const over = rows.filter(x => x.status === 'OVERSTOCK').length;

  const dead = num((await db.query(
    `SELECT count(*)::int c FROM item i
      WHERE i.company_id=$1 AND fn_on_hand(i.id,$2) > 0
        AND COALESCE((SELECT max(posted_at) FROM stock_txn t
                       WHERE t.item_id=i.id AND (t.qty < 0 OR t.txn_type='RECEIVE')),
                     '1900-01-01') < now() - ($3 || ' days')::interval`,
    [ctx.companyId, warehouseId || null,
     await setting(db, ctx.companyId, 'dead_stock_days', '90')])).rows[0].c);

  const expired = num((await db.query(
    `SELECT count(*)::int c FROM v_stock_by_batch v
      WHERE v.qty > 0 AND v.expires_on < current_date
        AND ($1::bigint IS NULL OR v.warehouse_id=$1)`, [warehouseId || null])).rows[0].c);

  const pending = num((await db.query(
    `SELECT (SELECT count(*) FROM stock_request WHERE company_id=$1 AND status='REQUESTED')
          + (SELECT count(*) FROM stock_adjustment WHERE company_id=$1 AND status='REQUESTED') AS c`,
    [ctx.companyId])).rows[0].c);

  const acc = (await accuracy(db, ctx, { warehouseId })).accuracyPct;
  const util = await utilisation(db, ctx, { warehouseId });
  const cap = util.reduce((s, u) => s + num(u.capacity), 0);
  const occ = util.reduce((s, u) => s + num(u.occupied), 0);
  const utilPct = cap ? occ / cap * 100 : 0;

  const parts = [
    { key: 'Stock accuracy', weight: 22, score: acc / 100,
      why: `Physical counts matched the system on ${acc.toFixed(1)}% of counted lines.` },
    { key: 'Availability', weight: 20, score: 1 - Math.min(1, low / n * 1.5),
      why: `${low} of ${n} SKUs are at or below reorder level.` },
    { key: 'Out of stock', weight: 12, score: 1 - Math.min(1, out / n * 3),
      why: `${out} SKUs are at zero.` },
    { key: 'Dead stock', weight: 12, score: 1 - Math.min(1, dead / n * 3),
      why: `${dead} SKUs have not moved inside the inactivity threshold.` },
    { key: 'Overstock', weight: 8, score: 1 - Math.min(1, over / n * 3),
      why: `${over} SKUs hold more than their maximum level.` },
    { key: 'Expiry control', weight: 8, score: expired ? 0.2 : 1,
      why: expired ? `${expired} batches are already expired.` : 'No expired batches in stock.' },
    { key: 'Open approvals', weight: 10, score: 1 - Math.min(1, pending / 12),
      why: `${pending} requests and adjustments are waiting for approval.` },
    { key: 'Storage utilisation', weight: 8,
      score: utilPct > 95 ? 0.4 : utilPct < 25 ? 0.6 : 1,
      why: `Racking is ${utilPct.toFixed(0)}% utilised.` }
  ];

  const score = Math.round(parts.reduce((s, p) => s + p.weight * Math.max(0, Math.min(1, p.score)), 0));
  return {
    score,
    band: score >= 90 ? 'Excellent' : score >= 80 ? 'Good' : score >= 65 ? 'Fair' : 'Needs attention',
    parts: parts.map(p => Object.assign(p, { score: +(p.score * 100).toFixed(0) })),
    weakest: parts.slice().sort((a, b) => a.score - b.score).slice(0, 2).map(p => p.why)
  };
}

const setting = async (db, companyId, key, dflt) =>
  (await db.query('SELECT fn_setting($1,$2,$3) AS v', [companyId, key, dflt])).rows[0].v;

module.exports = {
  balances, classify, dayPosition, movement, valuation, accuracy, variances,
  consumption, userActivity, utilisation, health, setting
};
