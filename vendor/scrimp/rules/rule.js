/**
 * AC-E2-5 / AC-E4-2. The suppression rule interface.
 *
 * A rule is any object with:
 *   - `name`     — string, appears in the `x-scrimp-suppressed` header
 *   - `enabled`  — boolean, so each rule is independently toggleable
 *   - `evaluate(context)` — returns `null` to allow the purchase, or a verdict
 *
 * A verdict is `{ reason, replay? }`. With `replay` set to a buffered response
 * entry, Scrimp hands the recorded body back to the caller; without it, the
 * caller gets a 402 carrying the suppression header and no data.
 *
 * The context is:
 *   `{ request, price, task, store, now }`
 * where `request` is `{ url, method, body, provider, endpoint, key }`, `task` is
 * the open task (`{ id, budget, spent, ... }`), `store` is the active Store, and
 * `now` is the current epoch-ms reading from the client's clock.
 *
 * Rules only ever run inside a task (AC-E2-2), and only until the first verdict.
 * Subclassing is a convenience, not a requirement — a plain object works, which
 * is what lets a consumer drop in their own rule.
 */
export class SuppressionRule {
  constructor(name, { enabled = true } = {}) {
    this.name = name;
    this.enabled = enabled;
  }

  evaluate(context) {
    throw new Error(`Rule "${this.name}" must implement evaluate(context).`);
  }
}
