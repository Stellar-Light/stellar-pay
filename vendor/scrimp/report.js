import { money, ratio } from './money.js';

/**
 * AC-E2-8. The demo's headline numbers.
 *
 *   spent          — actually paid
 *   wouldHaveSpent — paid + refused (what an unwrapped client would have paid)
 *   saved          — the difference
 *   savedPct       — saved as a percentage of wouldHaveSpent, 0 when nothing was attempted
 *   purchases      — calls that reached the payer
 *   suppressed     — calls a rule refused
 *   wasteRate      — fraction (0..1) of *attributed* purchases labelled wasted
 *
 * `wasteRate` only counts purchases whose task has ended; purchases made outside
 * a task, or inside one still open, are not yet attributable and are excluded
 * from the denominator. Both quotients are zero-guarded — an empty report is all
 * zeros, never NaN.
 */
export function buildReport(purchases, { taskId } = {}) {
  const rows = taskId === undefined ? purchases : purchases.filter((record) => record.taskId === taskId);

  let spent = 0;
  let wouldHaveSpent = 0;
  let executed = 0;
  let suppressed = 0;
  let attributed = 0;
  let wasted = 0;

  for (const record of rows) {
    const amount = Number(record.amount) || 0;
    wouldHaveSpent += amount;

    if (record.suppressedReason !== null && record.suppressedReason !== undefined) {
      suppressed += 1;
      continue;
    }

    spent += amount;
    executed += 1;

    if (record.contributed === null || record.contributed === undefined) continue;
    attributed += 1;
    if (!record.contributed) wasted += 1;
  }

  spent = money(spent);
  wouldHaveSpent = money(wouldHaveSpent);
  const saved = money(wouldHaveSpent - spent);

  return {
    spent,
    wouldHaveSpent,
    saved,
    savedPct: wouldHaveSpent > 0 ? ratio((saved / wouldHaveSpent) * 100) : 0,
    purchases: executed,
    suppressed,
    wasteRate: attributed > 0 ? ratio(wasted / attributed) : 0,
  };
}
