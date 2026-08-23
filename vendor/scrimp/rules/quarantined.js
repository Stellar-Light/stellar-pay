import { SuppressionRule } from './rule.js';

/**
 * AC-E2-5.3 — `quarantined`.
 *
 * A call that just failed N times in a row is not worth paying for again yet.
 * There is no body to replay, so the caller gets a 402 with the suppression
 * header and no data.
 *
 * The chain is walked backwards from the newest result and stops at the first
 * success or the first result older than the window — so a single success, or
 * simply enough elapsed time, lifts the quarantine without any separate
 * expiry bookkeeping.
 *
 * Scoped to the request key, not the provider. That distinction is load-bearing.
 * Provider-scoped quarantine over-blocks: a provider whose coverage is broken for
 * one asset would have its whole catalogue refused, and the agent would come back
 * with a different answer — cheaper, and wrong. Suppression must never change the
 * result, so the evidence is kept at exactly the granularity at which it was
 * observed. The cost is that a wholly-dead provider takes N failures per distinct
 * call to notice rather than N in total, which is the right side to err on.
 */
export class QuarantineRule extends SuppressionRule {
  constructor({ threshold = 3, windowMs = 60_000, ...options } = {}) {
    super('quarantined', options);
    this.threshold = threshold;
    this.windowMs = windowMs;
  }

  evaluate({ request, store, now }) {
    if (!(this.threshold > 0)) return null;

    const results = store.getCallResults(request.key);
    let consecutive = 0;
    for (let i = results.length - 1; i >= 0; i -= 1) {
      const result = results[i];
      if (result.ok) break;
      if (now - result.timestamp > this.windowMs) break;
      consecutive += 1;
      if (consecutive >= this.threshold) return { reason: this.name };
    }
    return null;
  }
}
