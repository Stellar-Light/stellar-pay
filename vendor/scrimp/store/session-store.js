import { Store } from './store.js';

/**
 * AC-E2-9 / AC-E4-3. Declared, deliberately unimplemented.
 *
 * Scrimp's hot path is probe/purchase state: one write per attempted call, plus
 * a buffered response body, plus a per-provider health tick. At agent speed that
 * is exactly the high-frequency, low-value, off-chain-until-settlement workload
 * an MPP Session is built for — commits accumulate in the session and settle
 * once, instead of one on-chain write per purchase record.
 *
 * That makes the Store interface the plug-in boundary between Scrimp's
 * accounting and MPP's channel state, and this class is that seam, committed so
 * the shape is reviewable. Implementing it is out of scope by design (PRD NG3):
 * the core must stay network-free and unit-testable against a fake payer.
 *
 * To implement: back `appendPurchase` with session commits, keep `saveResponse`
 * in a local cache (bodies do not belong in channel state), and derive
 * `getCallResults` from settlement outcomes.
 */
export class SessionStore extends Store {
  constructor(options = {}) {
    super();
    this.options = options;
  }

  appendPurchase() {
    notImplemented('appendPurchase');
  }

  getPurchases() {
    notImplemented('getPurchases');
  }

  getPurchase() {
    notImplemented('getPurchase');
  }

  getPurchasesForTask() {
    notImplemented('getPurchasesForTask');
  }

  markConsumed() {
    notImplemented('markConsumed');
  }

  setContributed() {
    notImplemented('setContributed');
  }

  recordOutcome() {
    notImplemented('recordOutcome');
  }

  getStats() {
    notImplemented('getStats');
  }

  saveResponse() {
    notImplemented('saveResponse');
  }

  getResponse() {
    notImplemented('getResponse');
  }

  recordCallResult() {
    notImplemented('recordCallResult');
  }

  getCallResults() {
    notImplemented('getCallResults');
  }

  clear() {
    notImplemented('clear');
  }
}

function notImplemented(method) {
  throw new Error(
    `SessionStore.${method}() is not implemented, see AC-E4-3 — MPP Session is the intended home for ` +
      'high-volume purchase state, but implementing it is out of scope (PRD NG3). Use MemoryStore.',
  );
}
