import { attributeTask } from './attribution.js';
import { money } from './money.js';
import { createPurchaseRecord } from './records.js';
import { buildReport } from './report.js';
import { describeRequest } from './request.js';
import {
  SUPPRESSION_HEADER,
  bufferResponse,
  instrumentResponse,
  responseFromEntry,
  suppressedResponse,
} from './response.js';
import { defaultRules } from './rules/index.js';
import { MemoryStore } from './store/index.js';
import { Task } from './task.js';

/**
 * AC-E2-1. A drop-in wrapper around any fetch-shaped paid client.
 *
 * `scrimp.fetch(url, init)` has the same signature and the same return type as
 * the payer it wraps. It is bound in the constructor, so it can be detached and
 * handed to code that expects a bare `fetch`.
 */
export class ScrimpClient {
  #active = null;
  #ended = new Set();

  constructor({
    payer,
    store = new MemoryStore(),
    rules,
    priceOf,
    providerOf,
    endpointOf,
    txHashOf,
    now = () => Date.now(),
  } = {}) {
    if (typeof payer !== 'function') {
      throw new TypeError('ScrimpClient requires a fetch-shaped `payer` function: (url, init) => Promise<Response>');
    }

    this.payer = payer;
    this.store = store;
    this.rules = rules ?? defaultRules();
    this.priceOf = priceOf ?? (() => 0);
    this.txHashOf = txHashOf ?? defaultTxHashOf;
    this.now = now;
    this.naming = { providerOf, endpointOf };

    this.fetch = this.fetch.bind(this);
  }

  /* --- tasks (AC-E2-2) --- */

  get activeTask() {
    return this.#active;
  }

  beginTask(taskId, { budget = null } = {}) {
    if (!taskId) throw new TypeError('beginTask requires a taskId');
    if (this.#active) {
      throw new Error(`Cannot begin task "${taskId}": task "${this.#active.id}" is still open.`);
    }
    if (this.#ended.has(taskId)) {
      throw new Error(`Task "${taskId}" has already ended; task ids must be unique.`);
    }
    this.#active = new Task(taskId, { budget, startedAt: this.now() });
    return this.#active;
  }

  /** Ends the task and attributes every purchase it made (AC-E2-4). */
  endTask(taskId, { succeeded = true } = {}) {
    if (!this.#active || this.#active.id !== taskId) {
      const detail = this.#ended.has(taskId) ? 'it has already ended' : 'no such task is open';
      throw new Error(`Cannot end task "${taskId}": ${detail}.`);
    }
    this.#active = null;
    this.#ended.add(taskId);
    return attributeTask(this.store, taskId, succeeded);
  }

  /* --- the wrapped call --- */

  async fetch(url, init = {}) {
    const request = describeRequest(url, init, this.naming);
    const price = money(Number(this.priceOf(url, init)) || 0);
    const task = this.#active;

    // AC-E2-2: purchases outside a task are recorded, never suppressed.
    if (task) {
      const verdict = this.#evaluate({ request, price, task });
      if (verdict) return this.#suppress(verdict, { request, price, task });
    }

    return this.#purchase({ request, price, task, url, init });
  }

  #evaluate(context) {
    const now = this.now();
    for (const rule of this.rules) {
      if (!rule || rule.enabled === false) continue;
      const verdict = rule.evaluate({ ...context, store: this.store, now });
      if (verdict) return { ...verdict, reason: verdict.reason ?? rule.name };
    }
    return null;
  }

  /** AC-E2-6: record the refusal, answer the caller, never touch the payer. */
  #suppress(verdict, { request, price, task }) {
    const record = this.#append({ request, price, task, suppressedReason: verdict.reason });
    const response = verdict.replay
      ? responseFromEntry(verdict.replay, { [SUPPRESSION_HEADER]: verdict.reason })
      : suppressedResponse(verdict.reason);
    return instrumentResponse(response, () => this.store.markConsumed(record.id));
  }

  async #purchase({ request, price, task, url, init }) {
    let response;
    let failure = null;
    try {
      response = await this.payer(url, init);
    } catch (error) {
      failure = error;
    }

    const timestamp = this.now();
    const ok = failure === null && response?.ok === true;
    this.store.recordCallResult(request.key, { ok, timestamp });

    const record = this.#append({
      request,
      price,
      task,
      timestamp,
      txHash: failure ? null : this.txHashOf(response, url, init),
    });
    if (task) task.spent = money(task.spent + price);

    // A thrown payer is still a purchase attempt on the ledger and still a
    // failure against the provider's health, but the error belongs to the
    // caller: a drop-in `fetch` rejects the way the real one would.
    if (failure) throw failure;

    const entry = await bufferResponse(response);
    entry.timestamp = timestamp;
    entry.taskId = task ? task.id : null;

    // Only successful responses are replayable. Caching an error would let one
    // bad answer suppress every retry of it.
    if (ok) this.store.saveResponse(request.key, entry);

    return instrumentResponse(responseFromEntry(entry), () => this.store.markConsumed(record.id));
  }

  #append({ request, price, task, timestamp = this.now(), txHash = null, suppressedReason = null }) {
    const record = createPurchaseRecord({
      taskId: task ? task.id : null,
      provider: request.provider,
      endpoint: request.endpoint,
      method: request.method,
      url: request.url,
      amount: price,
      txHash,
      suppressedReason,
      timestamp,
    });
    this.store.appendPurchase(record);
    return record;
  }

  /* --- readouts --- */

  /** AC-E2-7: the append-only receipt ledger, JSON-serializable. */
  purchases() {
    return this.store.getPurchases();
  }

  /** AC-E2-4: per-(provider, endpoint) outcome statistics. */
  stats() {
    return this.store.getStats();
  }

  /** AC-E2-8. */
  report(options = {}) {
    return buildReport(this.store.getPurchases(), options);
  }

  /** AC-E2-5: each rule is independently toggleable at runtime. */
  setRuleEnabled(name, enabled) {
    const rule = this.rules.find((candidate) => candidate?.name === name);
    if (!rule) throw new Error(`No suppression rule named "${name}".`);
    rule.enabled = Boolean(enabled);
    return rule;
  }
}

function defaultTxHashOf(response) {
  const headers = response?.headers;
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get('x-payment-tx-hash') ?? headers.get('x-scrimp-tx-hash') ?? null;
}
