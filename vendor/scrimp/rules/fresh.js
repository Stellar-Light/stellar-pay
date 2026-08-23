import { SuppressionRule } from './rule.js';

/**
 * AC-E2-5.2 — `fresh`.
 *
 * The same request was bought in an *earlier* task and the answer is still
 * within its endpoint's time-to-live, so replay rather than re-buy.
 *
 * TTL is per-endpoint: a price feed goes stale in seconds, a company profile in
 * days. `ttlByEndpoint` overrides `ttl`; a TTL of 0 disables the rule for that
 * endpoint. The boundary is inclusive — an entry whose age is exactly the TTL is
 * still fresh.
 */
export class FreshRule extends SuppressionRule {
  constructor({ ttl = 60_000, ttlByEndpoint = {}, ...options } = {}) {
    super('fresh', options);
    this.ttl = ttl;
    this.ttlByEndpoint = ttlByEndpoint;
  }

  ttlFor(endpoint) {
    return this.ttlByEndpoint[endpoint] ?? this.ttl;
  }

  evaluate({ request, task, store, now }) {
    const ttl = this.ttlFor(request.endpoint);
    if (!(ttl > 0)) return null;

    const entry = store.getResponse(request.key);
    if (!entry) return null;
    if (entry.taskId === task.id) return null; // same-task hits belong to `duplicate`
    if (now - entry.timestamp > ttl) return null;

    return { reason: this.name, replay: entry };
  }
}
