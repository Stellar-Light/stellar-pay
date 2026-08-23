/**
 * Numeric helpers.
 *
 * Prices are floats (0.001 USDC and friends), so every running total is snapped
 * back to a fixed precision. Without this, ten purchases of 0.1 sum to
 * 0.9999999999999999 and the demo's headline percentage reads 99.99%.
 */

const MONEY_PRECISION = 1e10;
const RATIO_PRECISION = 1e4;

export function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * MONEY_PRECISION) / MONEY_PRECISION;
}

export function ratio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * RATIO_PRECISION) / RATIO_PRECISION;
}
