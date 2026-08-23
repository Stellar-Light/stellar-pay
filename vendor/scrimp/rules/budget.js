import { SuppressionRule } from './rule.js';
import { money } from '../money.js';

/**
 * AC-E2-5.4 — `budget`.
 *
 * The task was given a spend ceiling and this call would break it. A task with
 * no budget is never suppressed by this rule.
 *
 * Spending a budget down to exactly zero is allowed; only a call that would
 * push past the ceiling is refused.
 */
export class BudgetRule extends SuppressionRule {
  constructor(options = {}) {
    super('budget', options);
  }

  evaluate({ task, price }) {
    if (task.budget === null || task.budget === undefined) return null;
    if (money(task.spent + price) <= money(task.budget)) return null;
    return { reason: this.name };
  }
}
