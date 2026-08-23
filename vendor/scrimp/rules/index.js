import { DuplicateRule } from './duplicate.js';
import { FreshRule } from './fresh.js';
import { QuarantineRule } from './quarantined.js';
import { BudgetRule } from './budget.js';

export { SuppressionRule } from './rule.js';
export { DuplicateRule, FreshRule, QuarantineRule, BudgetRule };

/**
 * AC-E2-5. The four rules in evaluation order: cheapest, most certain
 * suppression first. Pass per-rule options through, e.g.
 * `defaultRules({ fresh: { ttlByEndpoint: { '/price': 5_000 } } })`.
 */
export function defaultRules({ duplicate = {}, fresh = {}, quarantined = {}, budget = {} } = {}) {
  return [
    new DuplicateRule(duplicate),
    new FreshRule(fresh),
    new QuarantineRule(quarantined),
    new BudgetRule(budget),
  ];
}
