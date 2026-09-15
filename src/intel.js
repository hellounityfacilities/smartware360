'use strict';
/**
 * Intelligence.
 *
 * Every function returns its inputs alongside its conclusion. A recommendation
 * a manager cannot interrogate is a recommendation they are right to ignore,
 * and none of this is presented as certainty — it is arithmetic on the
 * warehouse's own history.
 */
const { require: requirePerm } = require('./auth');
const { money, qty, cost } = require('./money');
const { setting } = require('./reports');

const num = v => (v === null || v === undefined ? 0 : Number(v));
const value = (q, c) => money.extend(qty.parse(num(q).toFixed(3)), cost.parse(num(c).toFixed(4)));

/** Average daily issue rate over a window, straight from the ledger. */
const USAGE_SQL = `
  SELECT COALESCE(-sum(qty), 0) / $4::numeric AS avg_daily
    FROM stock_txn
   WHERE item_id=$1 AND txn_type='ISSUE'
     AND ($2::bigint IS NULL OR warehouse_id=$2)
     AND posted_at > now() - ($3 || ' days')::interval`;

/**
 * Reorder engine.
 *   reorder point = average daily usage × supplier lead time + safety stock
 *   safety stock  = half of lead-time demand
 * Both numbers are returned so the arithmetic can be checked by hand.
 */
async function reorder(db, ctx, { warehouseId, window = 90 } = {}) {
  requirePerm(ctx, 'purchase.view');
  const r = await db.query(
    `WITH usage AS (
       SELECT i.id AS item_id,
              COALESCE(-sum(t.qty) FILTER (WHERE t.txn_type='ISSUE'), 0) / $3::numeric AS avg_daily
         FROM item i
         LEFT JOIN stock_txn t ON t.item_id = i.id
              AND ($2::bigint IS NULL OR t.warehouse_id=$2)
              AND t.posted_at > now() - ($3 || ' days')::interval
        WHERE i.company_id=$1 AND i.is_active
        GROUP BY i.id)
     SELECT i.id, i.sku, i.name, i.name_ar, i.uom_code, i.reorder_qty, i.standard_cost,
            s.name AS supplier, COALESCE(s.lead_time_days, 7) AS lead_days,
            u.avg_daily,
            COALESCE(fn_available(i.id,$2),0) AS available
       FROM item i
       JOIN usage u ON u.item_id = i.id
       LEFT JOIN supplier s ON s.id = i.default_supplier_id
      WHERE i.company_id=$1 AND i.is_active
      ORDER BY i.name`,
    [ctx.companyId, warehouseId || null, String(window)]);

  const out = [];
  for (const x of r.rows) {
    const avgDaily = +num(x.avg_daily).toFixed(3);
    const lead = num(x.lead_days);
    const safety = Math.ceil(avgDaily * lead * 0.5);
    const rop = Math.ceil(avgDaily * lead + safety);
    const avail = num(x.available);
    if (avail > rop) continue;

    const suggest = Math.max(num(x.reorder_qty), Math.ceil(rop * 1.6 - avail));
    const cover = avgDaily > 0 ? Math.floor(avail / avgDaily) : null;
    out.push({
      itemId: x.id, sku: x.sku, name: x.name, uom: x.uom_code, supplier: x.supplier,
      available: avail, avgDaily, leadDays: lead, safetyStock: safety, reorderPoint: rop,
      daysOfCover: cover, suggestedQty: suggest,
      estimatedValue: money.format(value(suggest, x.standard_cost)),
      urgency: cover !== null && cover < lead ? 'URGENT' : 'NORMAL',
      workings: `${avgDaily} per day × ${lead} day lead time + ${safety} safety = reorder point ${rop}. ` +
                `Available ${avail}.`
    });
  }
  return out.sort((a, b) =>
    (a.daysOfCover === null ? 1e9 : a.daysOfCover) - (b.daysOfCover === null ? 1e9 : b.daysOfCover));
}

/** Straight-line projection. Deliberately simple, and labelled as such. */
async function forecast(db, ctx, { warehouseId, horizon = 30 } = {}) {
  requirePerm(ctx, 'intel.view');
  const items = await reorderBase(db, ctx, warehouseId);
  return {
    basis: 'Projected from 90 days of issue history at a constant rate. Seasonality and new ' +
           'project mobilisations are not modelled — treat the dates as a warning window.',
    items: items
      .filter(x => x.avgDaily > 0)
      .map(x => ({
        sku: x.sku, name: x.name, available: x.available, avgDaily: x.avgDaily,
        in7: Math.max(0, Math.round(x.available - x.avgDaily * 7)),
        in14: Math.max(0, Math.round(x.available - x.avgDaily * 14)),
        in30: Math.max(0, Math.round(x.available - x.avgDaily * 30)),
        daysToZero: Math.floor(x.available / x.avgDaily)
      }))
      .sort((a, b) => a.daysToZero - b.daysToZero)
      .slice(0, horizon)
  };
}

async function reorderBase(db, ctx, warehouseId) {
  const r = await db.query(
    `SELECT i.id, i.sku, i.name, i.standard_cost, COALESCE(s.lead_time_days,7) AS lead_days,
            COALESCE(fn_available(i.id,$2),0) AS available,
            COALESCE((SELECT -sum(t.qty)/90.0 FROM stock_txn t
                       WHERE t.item_id=i.id AND t.txn_type='ISSUE'
                         AND ($2::bigint IS NULL OR t.warehouse_id=$2)
                         AND t.posted_at > now() - interval '90 days'), 0) AS avg_daily
       FROM item i LEFT JOIN supplier s ON s.id=i.default_supplier_id
      WHERE i.company_id=$1 AND i.is_active`,
    [ctx.companyId, warehouseId || null]);
  return r.rows.map(x => ({
    id: x.id, sku: x.sku, name: x.name, standardCost: num(x.standard_cost),
    leadDays: num(x.lead_days), available: num(x.available),
    avgDaily: +num(x.avg_daily).toFixed(3)
  }));
}

async function deadStock(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'intel.view');
  const days = await setting(db, ctx.companyId, 'dead_stock_days', '90');
  const r = await db.query(
    `SELECT i.id, i.sku, i.name, i.uom_code, i.standard_cost,
            fn_on_hand(i.id,$2) AS qty,
            (SELECT max(posted_at) FROM stock_txn t
              WHERE t.item_id=i.id AND (t.qty < 0 OR t.txn_type='RECEIVE')) AS last_moved
       FROM item i
      WHERE i.company_id=$1 AND fn_on_hand(i.id,$2) > 0
        AND COALESCE((SELECT max(posted_at) FROM stock_txn t
                       WHERE t.item_id=i.id AND (t.qty < 0 OR t.txn_type='RECEIVE')),
                     '1900-01-01') < now() - ($3 || ' days')::interval`,
    [ctx.companyId, warehouseId || null, days]);

  let total = money.zero;
  const rows = r.rows.map(x => {
    const v = value(x.qty, x.standard_cost);
    total = money.add(total, v);
    const idle = x.last_moved
      ? Math.floor((Date.now() - new Date(x.last_moved)) / 86400000) : null;
    return {
      sku: x.sku, name: x.name, qty: num(x.qty), uom: x.uom_code,
      idleDays: idle, value: money.format(v),
      recommendation: idle === null ? 'Never moved since receipt — verify it is still needed'
        : idle > 240 ? 'Write off after physical inspection'
        : v > 300000n ? 'Return to supplier or negotiate a buy-back'
        : 'Reuse on the next project mobilisation'
    };
  }).sort((a, b) => b.idleDays - a.idleDays);

  return { thresholdDays: Number(days), moneyTrapped: money.format(total), items: rows };
}

async function expiring(db, ctx, { warehouseId, days = 90 } = {}) {
  requirePerm(ctx, 'intel.view');
  const r = await db.query(
    `SELECT i.sku, i.name, i.uom_code, i.standard_cost, v.batch_no, v.expires_on, v.qty,
            (v.expires_on - current_date) AS days_left
       FROM v_stock_by_batch v JOIN item i ON i.id = v.item_id
      WHERE v.qty > 0 AND v.expires_on IS NOT NULL
        AND v.expires_on <= current_date + ($2 || ' days')::interval
        AND ($1::bigint IS NULL OR v.warehouse_id=$1)
      ORDER BY v.expires_on`,
    [warehouseId || null, String(days)]);
  return r.rows.map(x => ({
    sku: x.sku, name: x.name, batch: x.batch_no, expiresOn: new Date(x.expires_on).toISOString().slice(0, 10),
    daysLeft: num(x.days_left), qty: num(x.qty), uom: x.uom_code,
    value: money.format(value(x.qty, x.standard_cost)),
    action: num(x.days_left) < 0 ? 'Quarantine and raise a disposal adjustment'
      : num(x.days_left) <= 7 ? 'Issue immediately or return to supplier'
      : 'Issue first under FEFO'
  }));
}

/**
 * ABC by consumption value, XYZ by demand variability across three months.
 * The combined class carries the stocking policy.
 */
async function abcXyz(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'intel.view');
  const r = await db.query(
    `SELECT i.id, i.sku, i.name, i.standard_cost,
            COALESCE(-sum(t.qty) FILTER (WHERE t.posted_at > now() - interval '90 days'),0) AS q90,
            COALESCE(-sum(t.qty) FILTER (WHERE t.posted_at > now() - interval '30 days'),0) AS m1,
            COALESCE(-sum(t.qty) FILTER (WHERE t.posted_at <= now() - interval '30 days'
                                          AND t.posted_at > now() - interval '60 days'),0) AS m2,
            COALESCE(-sum(t.qty) FILTER (WHERE t.posted_at <= now() - interval '60 days'
                                          AND t.posted_at > now() - interval '90 days'),0) AS m3
       FROM item i
       LEFT JOIN stock_txn t ON t.item_id=i.id AND t.txn_type='ISSUE'
            AND ($2::bigint IS NULL OR t.warehouse_id=$2)
      WHERE i.company_id=$1 AND i.is_active
      GROUP BY i.id ORDER BY i.id`,
    [ctx.companyId, warehouseId || null]);

  const rows = r.rows.map(x => {
    const months = [num(x.m1), num(x.m2), num(x.m3)];
    const mean = months.reduce((a, b) => a + b, 0) / 3;
    const sd = Math.sqrt(months.reduce((s, v) => s + (v - mean) ** 2, 0) / 3);
    const cv = mean > 0 ? sd / mean : 2;
    return {
      sku: x.sku, name: x.name,
      annualValue: value(num(x.q90) * 4, x.standard_cost),
      cv: +cv.toFixed(2)
    };
  }).sort((a, b) => (b.annualValue > a.annualValue ? 1 : -1));

  const total = rows.reduce((s, x) => money.add(s, x.annualValue), 0n) || 1n;
  let cum = 0n;
  const ADVICE = {
    AX: 'Tight control, frequent review, never stock out',
    AY: 'Buffer stock, watch demand swings',
    AZ: 'High value and unpredictable — buy to order',
    BX: 'Standard reorder rules work well',
    BY: 'Periodic review, moderate safety stock',
    BZ: 'Review before each purchase',
    CX: 'Bulk buy, low review frequency',
    CY: 'Bulk buy, tolerate variability',
    CZ: 'Minimum attention — candidate for rationalisation'
  };
  return rows.map(x => {
    cum = money.add(cum, x.annualValue);
    const pct = Number(cum * 1000n / total) / 1000;
    const abc = pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C';
    const xyz = x.cv < 0.5 ? 'X' : x.cv < 1 ? 'Y' : 'Z';
    return {
      sku: x.sku, name: x.name, class: abc + xyz, abc, xyz, cv: x.cv,
      annualValue: money.format(x.annualValue), guidance: ADVICE[abc + xyz]
    };
  });
}

/** Per-SKU supply risk, with the reasons that produced the score. */
async function risk(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'intel.view');
  const base = await reorderBase(db, ctx, warehouseId);
  const classes = await abcXyz(db, ctx, { warehouseId });
  const classOf = Object.fromEntries(classes.map(c => [c.sku, c.abc]));

  return base.map(x => {
    const cover = x.avgDaily > 0 ? Math.floor(x.available / x.avgDaily) : null;
    const factors = [];
    let score = 0;
    if (cover !== null && cover < x.leadDays) {
      score += 35; factors.push(`Cover of ${cover} days is shorter than the ${x.leadDays}-day supplier lead time.`);
    } else if (cover !== null && cover < x.leadDays * 2) {
      score += 18; factors.push(`Only ${cover} days of cover against a ${x.leadDays}-day lead time.`);
    }
    if (x.available <= 0) { score += 20; factors.push('Item is out of stock.'); }
    if (x.leadDays >= 14) { score += 12; factors.push(`Long supplier lead time (${x.leadDays} days).`); }
    if (classOf[x.sku] === 'A') { score += 10; factors.push('Class A item — high share of inventory spend.'); }
    return {
      sku: x.sku, name: x.name, score: Math.min(100, score),
      band: score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW',
      daysOfCover: cover, factors
    };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
}

/** Deviations from the warehouse's own history — questions to ask, not findings. */
async function anomalies(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'intel.view');
  const out = [];

  const spikes = await db.query(
    `SELECT i.sku, i.name,
            COALESCE(-sum(t.qty) FILTER (WHERE t.posted_at > now() - interval '30 days'),0) AS recent,
            COALESCE(-sum(t.qty) FILTER (WHERE t.posted_at > now() - interval '90 days'),0)/3.0 AS baseline
       FROM item i JOIN stock_txn t ON t.item_id=i.id AND t.txn_type='ISSUE'
      WHERE i.company_id=$1 AND ($2::bigint IS NULL OR t.warehouse_id=$2)
      GROUP BY i.sku, i.name`,
    [ctx.companyId, warehouseId || null]);
  for (const s of spikes.rows) {
    if (num(s.baseline) > 4 && num(s.recent) > num(s.baseline) * 1.3) {
      out.push({
        severity: 'WARN',
        title: `${s.name} consumption is up ${Math.round((num(s.recent) / num(s.baseline) - 1) * 100)}% this month`,
        detail: `30-day issues are ${num(s.recent)} against a monthly average of ${num(s.baseline).toFixed(0)}. ` +
                `Flagged as a deviation, which is not evidence of misuse.`
      });
    }
  }

  const bigAdj = await db.query(
    `SELECT a.adj_no, a.qty, a.value, a.reason, i.name, u.full_name, a.raised_at
       FROM stock_adjustment a JOIN item i ON i.id=a.item_id JOIN app_user u ON u.id=a.raised_by
      WHERE a.company_id=$1 AND a.value > 2000 AND a.raised_at > now() - interval '30 days'`,
    [ctx.companyId]);
  for (const a of bigAdj.rows) {
    out.push({
      severity: 'CRITICAL',
      title: `Large adjustment on ${a.name}`,
      detail: `${a.adj_no}: ${num(a.qty) > 0 ? '+' : ''}${num(a.qty)} valued at ${a.value}, ` +
              `raised by ${a.full_name}. Reason recorded: ${a.reason}`
    });
  }

  const night = await db.query(
    `SELECT count(*)::int c FROM stock_txn
      WHERE company_id=$1 AND posted_at > now() - interval '14 days'
        AND (extract(hour FROM posted_at) < 5 OR extract(hour FROM posted_at) >= 22)`,
    [ctx.companyId]);
  if (num(night.rows[0].c) > 0) {
    out.push({
      severity: 'WARN',
      title: `${night.rows[0].c} transactions recorded outside working hours`,
      detail: 'Movements posted between 22:00 and 05:00 in the last 14 days. Check the shift ' +
              'roster before treating this as an exception.'
    });
  }
  return out;
}

/** What is likely to need a decision tomorrow. */
async function tomorrow(db, ctx, { warehouseId } = {}) {
  requirePerm(ctx, 'dashboard.view');
  const [ro, ex, dead] = await Promise.all([
    reorder(db, ctx, { warehouseId }),
    expiring(db, ctx, { warehouseId, days: 30 }),
    deadStock(db, ctx, { warehouseId })
  ]);
  const critical = ro.filter(x => x.daysOfCover !== null && x.daysOfCover <= 3);
  const lines = [];
  if (critical.length) lines.push({
    headline: `${critical.length} item${critical.length > 1 ? 's' : ''} may reach critical stock within 3 days`,
    detail: critical.slice(0, 4).map(x => `${x.name} — ${x.daysOfCover} day(s) of cover left`).join(' · ')
  });
  if (ro.length) lines.push({
    headline: `${ro.length} purchase recommendation${ro.length > 1 ? 's' : ''} waiting to be raised`,
    detail: `Estimated commitment ${money.format(ro.reduce(
      (s, x) => money.add(s, money.parse(x.estimatedValue)), 0n))}.`
  });
  if (ex.length) lines.push({
    headline: `${ex.length} batch${ex.length > 1 ? 'es' : ''} expire within 30 days`,
    detail: `Issue these first under FEFO.`
  });
  if (dead.items.length) lines.push({
    headline: `${dead.moneyTrapped} is tied up in stock that is not moving`,
    detail: `${dead.items.length} SKUs past the ${dead.thresholdDays}-day inactivity threshold.`
  });
  return {
    basis: 'Calculated from this warehouse\'s own transaction history. Estimates, not guarantees.',
    lines
  };
}

module.exports = { reorder, forecast, deadStock, expiring, abcXyz, risk, anomalies, tomorrow };
