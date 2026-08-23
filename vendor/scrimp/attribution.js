/**
 * AC-E2-4. Outcome attribution — the thing a cache cannot do.
 *
 * When a task ends, every purchase it made is labelled:
 *   contributed = the body was read AND the task succeeded
 *   wasted      = the body was never read, OR the task failed
 *
 * Suppressed attempts are skipped: they never cost anything, so folding them
 * into the waste statistics would flatter or distort the numbers. Their
 * `contributed` stays null.
 *
 * Labels are folded into per-(provider, endpoint) aggregates held by the store,
 * so evidence accumulates across tasks rather than resetting with each one.
 */
export function attributeTask(store, taskId, succeeded) {
  let contributed = 0;
  let wasted = 0;

  for (const record of store.getPurchasesForTask(taskId)) {
    if (record.suppressedReason !== null) continue;

    const didContribute = record.consumed === true && succeeded === true;
    store.setContributed(record.id, didContribute);
    store.recordOutcome(store.getPurchase(record.id));

    if (didContribute) contributed += 1;
    else wasted += 1;
  }

  return { taskId, succeeded, contributed, wasted };
}
