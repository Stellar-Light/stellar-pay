/**
 * AC-E2-2. A task brackets one unit of agent work.
 *
 * `spent` counts what was actually paid inside the task (suppressed attempts
 * cost nothing), which is what the `budget` rule meters against.
 */
export class Task {
  constructor(id, { budget = null, startedAt = 0 } = {}) {
    this.id = id;
    this.budget = budget;
    this.startedAt = startedAt;
    this.spent = 0;
  }
}
