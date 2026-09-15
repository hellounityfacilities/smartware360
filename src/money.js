'use strict';
/**
 * Money.
 *
 * Inventory valuation multiplies a quantity by a unit cost thousands of times
 * per report. Do that in floating point and the total drifts — not by much, but
 * by enough that a finance manager reconciling to two decimal places finds a
 * number nobody can explain. So money is carried as BigInt minor units (fils
 * for QAR) and only becomes a string at the edge.
 *
 * Quantities are separate: they carry three decimals, because a warehouse
 * issues 2.5 litres and 0.750 kg, and are also held as scaled integers.
 */

const MONEY_SCALE = 100n;      // 2 decimal places — QAR fils
const QTY_SCALE   = 1000n;     // 3 decimal places
const COST_SCALE  = 10000n;    // 4 decimal places — unit costs carry more

function parseScaled(value, scale, what) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined) {
    throw new TypeError(`${what} is required`);
  }
  const s = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new TypeError(`${what} "${value}" is not a number`);
  }
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const places = String(scale).length - 1;
  if (frac.length > places) {
    throw new RangeError(`${what} "${value}" has more than ${places} decimal places`);
  }
  const padded = (frac + '0'.repeat(places)).slice(0, places);
  const n = BigInt(whole) * scale + BigInt(padded || '0');
  return neg ? -n : n;
}

function formatScaled(n, scale) {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const places = String(scale).length - 1;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(places, '0');
  return `${neg ? '-' : ''}${whole}${places ? '.' + frac : ''}`;
}

const money = {
  scale: MONEY_SCALE,
  parse: v => parseScaled(v, MONEY_SCALE, 'amount'),
  format: n => formatScaled(n, MONEY_SCALE),
  zero: 0n,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  sum: list => list.reduce((a, b) => a + b, 0n),
  /** Value of a quantity at a unit cost. Rounds half away from zero, once. */
  extend(qtyScaled, costScaled) {
    const product = qtyScaled * costScaled;                 // scale 1000*10000
    const divisor = (QTY_SCALE * COST_SCALE) / MONEY_SCALE; // → scale 100
    return roundDiv(product, divisor);
  },
  /** Percentage of an amount, e.g. a configurable tax rate. */
  percent(amountScaled, ratePercent) {
    const rate = parseScaled(ratePercent, MONEY_SCALE, 'rate');
    return roundDiv(amountScaled * rate, MONEY_SCALE * 100n);
  }
};

const qty = {
  scale: QTY_SCALE,
  parse: v => parseScaled(v, QTY_SCALE, 'quantity'),
  format: n => formatScaled(n, QTY_SCALE),
  /** Trim trailing zeros for display: 12.000 → "12", 2.500 → "2.5" */
  display(n) {
    const s = formatScaled(n, QTY_SCALE);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }
};

const cost = {
  scale: COST_SCALE,
  parse: v => parseScaled(v, COST_SCALE, 'unit cost'),
  format: n => formatScaled(n, COST_SCALE)
};

/** Integer division rounding half away from zero — no banker's rounding surprises. */
function roundDiv(numerator, denominator) {
  const neg = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n + d / 2n) / d;
  return neg ? -q : q;
}

module.exports = { money, qty, cost, roundDiv, parseScaled, formatScaled };
