'use strict';
/** Currency and quantity arithmetic. */
const { money, qty, cost, roundDiv } = require('../src/money');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};
const eq = (name, a, b) => ok(name, String(a) === String(b), `expected ${b}, got ${a}`);

console.log('\nSMARTWARE 360 — money arithmetic\n');

// parsing
eq('parses a whole amount', money.format(money.parse('100')), '100.00');
eq('parses two decimal places', money.format(money.parse('38.50')), '38.50');
eq('parses a negative amount', money.format(money.parse('-12.34')), '-12.34');
eq('parses a number, not only a string', money.format(money.parse(45.5)), '45.50');
ok('refuses text', (() => { try { money.parse('abc'); return false; } catch { return true; } })());
ok('refuses more precision than the currency has',
  (() => { try { money.parse('1.234'); return false; } catch { return true; } })());
ok('refuses null', (() => { try { money.parse(null); return false; } catch { return true; } })());

// quantities carry three decimals, costs four
eq('quantities keep three decimals', qty.format(qty.parse('2.5')), '2.500');
eq('quantities display without trailing zeros', qty.display(qty.parse('12.000')), '12');
eq('a fractional quantity still displays cleanly', qty.display(qty.parse('0.750')), '0.75');
eq('unit costs keep four decimals', cost.format(cost.parse('38.1234')), '38.1234');

// extension
eq('extends a simple line', money.format(money.extend(qty.parse('10'), cost.parse('38'))), '380.00');
eq('extends a fractional quantity',
  money.format(money.extend(qty.parse('2.5'), cost.parse('12.40'))), '31.00');
eq('rounds half away from zero',
  money.format(money.extend(qty.parse('3'), cost.parse('0.005'))), '0.02');
eq('rounds a long unit cost once, at the end',
  money.format(money.extend(qty.parse('7'), cost.parse('1.2345'))), '8.64');

// the reason any of this exists
(() => {
  // 0.1 + 0.2 in floating point is famously not 0.3; a thousand inventory lines
  // compound that into a total nobody can reconcile.
  const floatTotal = Array.from({ length: 1000 }, () => 0.1 + 0.2).reduce((a, b) => a + b, 0);
  const exactTotal = money.sum(Array.from({ length: 1000 },
    () => money.add(money.parse('0.10'), money.parse('0.20'))));
  ok('floating point drifts over a thousand lines', floatTotal !== 300);
  eq('integer money does not', money.format(exactTotal), '300.00');
})();

// valuation of a realistic warehouse line
eq('values 296 pairs of safety shoes at 165.00',
  money.format(money.extend(qty.parse('296'), cost.parse('165'))), '48840.00');

// configurable tax — zero by default, never assumed
eq('tax at 0% is zero', money.format(money.percent(money.parse('1000'), '0')), '0.00');
eq('tax at 5% computes cleanly', money.format(money.percent(money.parse('1000'), '5')), '50.00');
eq('tax rounds half away from zero', money.format(money.percent(money.parse('10.10'), '5')), '0.51');

// rounding helper
eq('roundDiv rounds up at the half', roundDiv(5n, 2n), 3n);
eq('roundDiv rounds negatives away from zero', roundDiv(-5n, 2n), -3n);
eq('roundDiv is exact when it divides', roundDiv(10n, 2n), 5n);

console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} assertions\n`);
process.exit(fail ? 1 : 0);
