import { Either } from "effect";

// ---------------------------------------------------------------------------
// iterationPolicy
//
// Pure classification functions extracted from LoopRunnerLive. No Effect, no
// I/O. Each function takes plain data and returns a plain value so that it can
// be unit-tested without constructing layers or running Effects.
// ---------------------------------------------------------------------------

/**
 * Classifies one iteration's outcome into a Decision tag.
 *
 * Order of evaluation:
 *   1. RateLimited (Left): preserves attempt budget — caller halts loop
 *      without incrementing the attempt counter.
 *   2. PASS (Right verdict=PASS): success — caller marks the task done.
 *   3. Otherwise (verdict=FAIL or any non-rate-limit RunTaskError):
 *        - if attemptJustRun >= maxAttempts → Exhausted
 *        - else → Retry
 *
 * @param attemptJustRun  1-indexed attempt number that RunTask just executed
 *                        (= task.attempts + 1 at the moment of dispatch).
 * @param maxAttempts     Task budget.
 * @param outcome         Either<TaskResult, RunTaskError> as returned by
 *                        `rt.run(...).pipe(Effect.either)`.
 */
export const decideIteration = (
  attemptJustRun: number,
  maxAttempts: number,
  outcome: Either.Either<TaskResult, RunTaskError>,
): Decision => {
  // RateLimited takes priority over everything — budget is not consumed.
  if (outcome._tag === "Left" && outcome.left._tag === "RateLimited") {
    return {
      _tag: "RateLimited",
      role: outcome.left.role,
      resetsAt: outcome.left.resetsAt,
    };
  }

  // Right + PASS → success.
  if (outcome._tag === "Right" && outcome.right.verdict === "PASS") {
    return { _tag: "Pass" };
  }

  // Everything else (FAIL verdict or non-rate-limit error) → check budget.
  return attemptJustRun >= maxAttempts
    ? { _tag: "Exhausted" }
    : { _tag: "Retry" };
};

/**
 * Terminal classification when `nextReady` returns `None`.
 *
 * - All non-done tasks are gone (no pending/in_progress remaining) → AllDone.
 * - Some tasks are still pending or in_progress but none is schedulable
 *   (e.g. all dependencies failed) → NoReadyTasks with the ids of those tasks.
 */
export const decideTerminal = (feature: Feature): StoppedReason => {
  const allTasks = feature.stories.flatMap((s) => s.tasks);
  const remaining = allTasks
    .filter((t) => t.status === "pending" || t.status === "in_progress")
    .map((t) => t.id);

  return remaining.length === 0
    ? { _tag: "AllDone" }
    : { _tag: "NoReadyTasks", remaining };
};

/**
 * Pure aggregation: classify all tasks into done / failed / pending and
 * assemble a `LoopSummary`.
 *
 * `tasksPending` includes both `"pending"` and `"in_progress"` statuses,
 * matching the behaviour of the original LoopRunnerLive implementation.
 */
export const buildLoopSummary = (
  feature: Feature,
  iterations: number,
  stoppedReason: StoppedReason,
): LoopSummary => {
  const allTasks = feature.stories.flatMap((s) => s.tasks);

  return {
    feature: feature.feature,
    iterations,
    completed: stoppedReason._tag === "AllDone",
    stoppedReason,
    tasksDone: allTasks.filter((t) => t.status === "done").map((t) => t.id),
    tasksFailed: allTasks.filter((t) => t.status === "failed").map((t) => t.id),
    tasksPending: allTasks
      .filter((t) => t.status === "pending" || t.status === "in_progress")
      .map((t) => t.id),
  };
};
