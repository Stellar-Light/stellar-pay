import { SuppressionRule } from './rule.js';

/**
 * AC-E2-5.1 — `duplicate`.
 *
 * The same (method, url, body) was already bought inside the *current* task.
 * Nothing can have changed that the agent cares about within one unit of work,
 * so replay the recorded response instead of paying again.
 *
 * Cross-task repeats are the `fresh` rule's business, not this one's.
 */
export class DuplicateRule extends SuppressionRule {
  constructor(options = {}) {
    super('duplicate', options);
  }

  evaluate({ request, task, store }) {
    const entry = store.getResponse(request.key);
    if (!entry || entry.taskId !== task.id) return null;
    return { reason: this.name, replay: entry };
  }
}
