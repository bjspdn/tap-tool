import { Either } from "effect";

/**
 * Formats the multi-line "how to resume" message printed when one or more
 * tasks have exhausted their attempts. Pure — no side effects.
 *
 * Output format (mirrors LoopRunnerLive lines 222–245):
 *
 *   [loop-runner] feature "<name>" halted — N task(s) failed, X done, Y pending.
 *
 *   Failed tasks (exhausted maxAttempts):
 *     · <id>  "<title>"
 *     ...
 *
 *   To resume:
 *     1. Edit .tap/features/<name>/FEATURE_CONTRACT.json
 *     2. For each failed task, set "status": "pending" and "attempts": 0
 *        (or bump "maxAttempts" if you want more retries without a reset)
 *     3. Optionally tighten the task's "description" based on what the last
 *        EVAL_RESULT.md flagged — see eval/archive/<taskId>/
 *     4. Re-run: bun run scripts/bootstrap.ts <name>
 *
 * `allTasks` is the flat list across stories — caller passes
 * `feature.stories.flatMap(s => s.tasks)`.
 */
export const formatResumeHint = (
  summary: LoopSummary,
  allTasks: ReadonlyArray<Task>,
): string => {
  const failedTasks = allTasks.filter((t) => t.status === "failed");
  const failedLines = failedTasks
    .map((t) => `  · ${t.id}  "${t.title}"`)
    .join("\n");

  const n = summary.tasksFailed.length;

  return [
    `[loop-runner] feature "${summary.feature}" halted — ${n} task${n === 1 ? "" : "s"} failed, ${summary.tasksDone.length} done, ${summary.tasksPending.length} pending.`,
    "",
    "Failed tasks (exhausted maxAttempts):",
    failedLines,
    "",
    "To resume:",
    `  1. Edit .tap/features/${summary.feature}/FEATURE_CONTRACT.json`,
    `  2. For each failed task, set "status": "pending" and "attempts": 0`,
    `     (or bump "maxAttempts" if you want more retries without a reset)`,
    `  3. Optionally tighten the task's "description" based on what the last`,
    `     EVAL_RESULT.md flagged — see eval/archive/<taskId>/`,
    `  4. Re-run: bun run scripts/bootstrap.ts ${summary.feature}`,
  ].join("\n");
};

/**
 * Formats a single iteration's failure log line. Pure.
 *
 * Two cases (from LoopRunnerLive lines 162–181):
 *  1. outcome is Left (RunTask error):
 *     `[loop-runner] iter <i> task <id> attempt <a>/<max> failed: _tag=<tag> <safe-json>`
 *     where safe-json is JSON.stringify with `cause` fields truncated to 200 chars.
 *  2. outcome is Right with verdict=FAIL:
 *     `[loop-runner] iter <i> task <id> attempt <a>/<max> verdict=FAIL\n  summary: <s>\n  comments: <n>`
 *
 * Returns `""` if outcome is Right with verdict=PASS (defensive default; caller
 * should not call this on a pass).
 */
export const formatIterationFailure = (
  iteration: number,
  task: Task,
  attempt: number,
  outcome: Either.Either<TaskResult, RunTaskError>,
): string => {
  if (outcome._tag === "Left") {
    const safe = JSON.parse(
      JSON.stringify(outcome.left, (k, v: unknown) => {
        if (k === "cause") return String(v).slice(0, 200);
        return v;
      }),
    ) as unknown;
    return `[loop-runner] iter ${iteration} task ${task.id} attempt ${attempt}/${task.maxAttempts} failed: _tag=${outcome.left._tag} ${JSON.stringify(safe)}`;
  }

  if (outcome.right.verdict === "FAIL") {
    return `[loop-runner] iter ${iteration} task ${task.id} attempt ${attempt}/${task.maxAttempts} verdict=FAIL\n  summary: ${outcome.right.summary}\n  comments: ${outcome.right.comments.length}`;
  }

  // PASS — caller should not invoke this on a pass; return empty string defensively.
  return "";
};
