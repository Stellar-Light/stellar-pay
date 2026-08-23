/**
 * AC-E2-9. The Store interface.
 *
 * A store holds everything that has to outlive a single task: the append-only
 * purchase ledger, the per-(provider, endpoint) outcome statistics, the buffered
 * responses the `duplicate`/`fresh` rules replay, and the per-provider result
 * history the `quarantined` rule reads.
 *
 * Subclass this and implement all of it. `MemoryStore` is the reference
 * implementation; `SessionStore` is the declared-but-unimplemented boundary
 * where an MPP Session would plug in (AC-E4-3).
 */
export class Store {
  /* --- purchase ledger (append-only) --- */

  /** @param {object} record */
  appendPurchase(record) {
    notImplemented('appendPurchase');
  }

  /** @returns {object[]} every record, oldest first */
  getPurchases() {
    notImplemented('getPurchases');
  }

  /** @returns {object|null} */
  getPurchase(id) {
    notImplemented('getPurchase');
  }

  /** @returns {object[]} */
  getPurchasesForTask(taskId) {
    notImplemented('getPurchasesForTask');
  }

  /** Idempotent: the body of a purchase was read (AC-E2-3). */
  markConsumed(id) {
    notImplemented('markConsumed');
  }

  /** @param {boolean} value outcome attribution verdict (AC-E2-4). */
  setContributed(id, value) {
    notImplemented('setContributed');
  }

  /* --- aggregated outcomes, per (provider, endpoint) --- */

  /** Fold one attributed purchase record into the running statistics. */
  recordOutcome(record) {
    notImplemented('recordOutcome');
  }

  /** @returns {object[]} */
  getStats() {
    notImplemented('getStats');
  }

  /* --- replay cache, keyed by request key --- */

  saveResponse(key, entry) {
    notImplemented('saveResponse');
  }

  /** @returns {object|undefined} */
  getResponse(key) {
    notImplemented('getResponse');
  }

  /* --- provider health, for the quarantine rule --- */

  /** @param {{ ok: boolean, timestamp: number }} result */
  recordCallResult(key, result) {
    notImplemented('recordCallResult');
  }

  /** @returns {Array<{ ok: boolean, timestamp: number }>} oldest first */
  getCallResults(key) {
    notImplemented('getCallResults');
  }

  clear() {
    notImplemented('clear');
  }
}

function notImplemented(method) {
  throw new Error(`Store.${method}() is not implemented — subclass Store and implement it.`);
}
