/**
 * The model-facing prose about what a task stop DOES (ADR-0057).
 *
 * **One source, because the same sentence reaches the model on two surfaces**: the tool's
 * `description` (pi's tool declaration) and the guideline pi puts into the system prompt. Two
 * copies of the same sentence are two things that can drift, and the drift stays invisible
 * until a model reads one of them and acts on the other.
 *
 * The wording is deliberately a description of the two EDGES rather than of the mechanism: the
 * model has to be able to tell "this task never started, so it is simply withdrawn" from "this
 * task is running, so it gets a signal and a grace period". Before ADR-0057 the second was
 * the only one, and a stop on a queued task used to be an illegal-transition error.
 */

/**
 * ADR-0057: what a stop does, in one sentence.
 *
 * A task that is still WAITING for a concurrency slot is withdrawn from the queue and never
 * starts; a task that is already RUNNING is signaled by the dispatcher and goes through
 * `stopping` to `canceled`. Those are two different edges — libuv's cancel API makes the same
 * split, returning 0 for a work item still in the queue and a busy code for one a worker has
 * already taken.
 */
export const TASK_STOP_SEMANTICS: string =
  "A task that is still waiting for a concurrency slot is withdrawn from the queue and never starts; " +
  "a task that is already running is signaled by the dispatcher and goes through stopping to canceled.";
