/**
 * Scrimp core — outcome-attributed spend control for agentic payments.
 *
 * Everyone else stops your agent from spending too much.
 * Scrimp stops it from spending on nothing.
 *
 * The core is network-free by design (PRD E2): it wraps whatever paid client you
 * already have, so it works against any payer and depends on none.
 */

export { ScrimpClient } from './client.js';
export { Task } from './task.js';
export { attributeTask } from './attribution.js';
export { buildReport } from './report.js';
export { createPurchaseRecord } from './records.js';
export { describeRequest, requestKey } from './request.js';
export { SUPPRESSION_HEADER, bufferResponse, instrumentResponse, responseFromEntry, suppressedResponse } from './response.js';
export { money, ratio } from './money.js';

export {
  SuppressionRule,
  DuplicateRule,
  FreshRule,
  QuarantineRule,
  BudgetRule,
  defaultRules,
} from './rules/index.js';

export { Store, MemoryStore, SessionStore } from './store/index.js';
