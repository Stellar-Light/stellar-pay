/**
 * AC-E2-7. Purchase receipts.
 *
 * A record exists for every attempted purchase, executed or suppressed. It is
 * append-only: `consumed` and `contributed` are filled in later, through the
 * store, but no record is ever removed or rewritten.
 *
 * `contributed` stays `null` until the enclosing task ends. Purchases made
 * outside a task, and suppressed attempts (which cost nothing), stay `null`
 * forever and are excluded from waste statistics.
 */

let sequence = 0;

export function createPurchaseRecord({
  taskId = null,
  provider,
  endpoint,
  method,
  url,
  amount = 0,
  txHash = null,
  suppressedReason = null,
  timestamp,
}) {
  return {
    id: `pr_${++sequence}`,
    taskId,
    provider,
    endpoint,
    method,
    url,
    amount,
    txHash,
    suppressedReason,
    consumed: false,
    contributed: null,
    timestamp,
  };
}
