import { Effect, Layer, Option } from "effect";
import * as nodePath from "node:path";
import { brand } from "../brand";
import { FeatureContract } from "../FeatureContract";
import { RunTask } from "../RunTask";
import { captureGitStatus } from "./gitStatus";
import { commitTask } from "./gitCommit";
import { archivePriorEval } from "./archive";
import { LoopRunner, MAX_ITERATIONS } from "./LoopRunner";

// ---------------------------------------------------------------------------
// LoopRunnerLive
// ---------------------------------------------------------------------------

/**
 * Live layer for LoopRunner.
 *
 * FeatureContract, RunTask, FileSystem, and CommandExecutor are NOT captured at
 * layer-construction time — they are acquired via `yield*` inside the `run`
 * Effect.gen body. This mirrors the AgentRunnerEcho pattern so that
 * LoopRunnerLive composes with BunContext.layer + other Live layers without
 * leaving residual R on the layer itself.
 */
export const LoopRunnerLive: Layer.Layer<LoopRunner, never, never> = Layer.succeed(
  LoopRunner,
  LoopRunner.of({
    run: (contractPath) =>
      Effect.gen(function* () {
        const fc = yield* FeatureContract;
        const rt = yield* RunTask;

        // ------------------------------------------------------------------
        // Load and validate contract
        // ------------------------------------------------------------------
        let feature = yield* fc.load(contractPath);

        const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
        const specsPath = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "SPECS.md"));
        const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));
        const evalResultPath = brand<"AbsolutePath">(nodePath.join(evalDir as string, "EVAL_RESULT.md"));

        // ------------------------------------------------------------------
        // Attempt loop
        // ------------------------------------------------------------------
        let iterations = 0;
        let stoppedReason: StoppedReason | null = null;

        while (iterations < MAX_ITERATIONS) {
          iterations++;

          // Pick the next schedulable task
          const maybeTask = fc.nextReady(feature);

          if (Option.isNone(maybeTask)) {
            // Determine whether we finished or got stuck
            const allTasks = feature.stories.flatMap((s) => s.tasks);
            const remaining = allTasks
              .filter((t) => t.status === "pending" || t.status === "in_progress")
              .map((t) => t.id);

            stoppedReason =
              remaining.length === 0
                ? { _tag: "AllDone" }
                : { _tag: "NoReadyTasks", remaining };
            break;
          }

          const task = maybeTask.value;
          // `attempt` is 1-indexed and refers to the upcoming run.
          // We defer fc.incrementAttempt until after RunTask resolves so that a
          // rate-limit halt leaves the attempt counter unchanged — the operator
          // resumes with the same budget intact.
          const attempt = task.attempts + 1;

          // ----------------------------------------------------------------
          // Mark in_progress and persist (attempt not yet incremented on disk)
          // ----------------------------------------------------------------
          feature = fc.markStatus(feature, task.id, "in_progress");
          yield* fc.save(contractPath, feature);

          // ----------------------------------------------------------------
          // Prior-eval archiving (attempt > 1 = retry)
          // ----------------------------------------------------------------
          let priorEvalPath: Option.Option<AbsolutePath>;
          if (attempt > 1) {
            const iter = String(attempt - 1).padStart(3, "0");
            const archivePath = brand<"AbsolutePath">(
              nodePath.join(
                evalDir as string,
                "archive",
                task.id,
                `iter-${iter}-EVAL_RESULT.md`,
              ),
            );
            yield* archivePriorEval(evalResultPath, archivePath);
            priorEvalPath = Option.some(archivePath);
          } else {
            priorEvalPath = Option.none();
          }

          // ----------------------------------------------------------------
          // Capture git status (non-fatal — returns "" on failure)
          // ----------------------------------------------------------------
          const gitStatus = yield* captureGitStatus(featureRoot);

          // ----------------------------------------------------------------
          // Run the task pipeline; wrap in Either to handle FAIL gracefully
          // ----------------------------------------------------------------
          const outcome = yield* rt
            .run(task, feature, {
              featureRoot,
              specsPath,
              contractPath,
              attempt,
              priorEvalPath,
              gitStatus,
            })
            .pipe(Effect.either);

          // Rate-limit: halt the loop without consuming the retry budget.
          // We do NOT increment the attempt counter and do NOT mark the task
          // failed — status stays in_progress so the operator can resume once
          // the rate limit clears. Persist current in-memory state to capture
          // the in_progress status already written above.
          if (outcome._tag === "Left" && outcome.left._tag === "RateLimited") {
            yield* fc.save(contractPath, feature);
            stoppedReason = {
              _tag: "RateLimited",
              role: outcome.left.role,
              resetsAt: outcome.left.resetsAt,
            };
            break;
          }

          // Non-rate-limited outcomes consume the attempt budget.
          feature = fc.incrementAttempt(feature, task.id);

          const isPass =
            outcome._tag === "Right" && outcome.right.verdict === "PASS";
          const isExhausted = attempt >= task.maxAttempts;

          if (isPass) {
            // PASS → mark done + save + commit (best-effort) + continue loop
            feature = fc.markStatus(feature, task.id, "done");
            yield* fc.save(contractPath, feature);
            yield* commitTask(featureRoot, task, contractPath);
          } else {
            // FAIL (or RunTask error) → retry or halt
            if (isExhausted) {
              feature = fc.markStatus(feature, task.id, "failed");
              yield* fc.save(contractPath, feature);
              stoppedReason = { _tag: "TaskExhausted", failedTaskIds: [task.id] };
              break;
            }
            // Attempt budget remains — persist incremented attempt counter.
            yield* fc.save(contractPath, feature);
          }
        }

        // MAX_ITERATIONS safety cap
        if (stoppedReason === null) {
          stoppedReason = { _tag: "MaxIterations", cap: MAX_ITERATIONS };
        }

        // ------------------------------------------------------------------
        // Build LoopSummary
        // ------------------------------------------------------------------
        const allTasks = feature.stories.flatMap((s) => s.tasks);
        const tasksDone = allTasks.filter((t) => t.status === "done").map((t) => t.id);
        const tasksFailed = allTasks.filter((t) => t.status === "failed").map((t) => t.id);
        const tasksPending = allTasks
          .filter((t) => t.status === "pending" || t.status === "in_progress")
          .map((t) => t.id);

        const summary: LoopSummary = {
          feature: feature.feature,
          iterations,
          completed: stoppedReason._tag === "AllDone",
          stoppedReason,
          tasksDone,
          tasksFailed,
          tasksPending,
        };

        // ------------------------------------------------------------------
        // Resume hint (printed when tasks failed)
        // ------------------------------------------------------------------
        if (tasksFailed.length > 0) {
          const failedLines = allTasks
            .filter((t) => t.status === "failed")
            .map((t) => `  · ${t.id}  "${t.title}"`)
            .join("\n");

          const n = tasksFailed.length;
          const hint = [
            `[loop-runner] feature "${feature.feature}" halted — ${n} task${n === 1 ? "" : "s"} failed, ${tasksDone.length} done, ${tasksPending.length} pending.`,
            "",
            "Failed tasks (exhausted maxAttempts):",
            failedLines,
            "",
            "To resume:",
            `  1. Edit .tap/features/${feature.feature}/FEATURE_CONTRACT.json`,
            `  2. For each failed task, set "status": "pending" and "attempts": 0`,
            `     (or bump "maxAttempts" if you want more retries without a reset)`,
            `  3. Optionally amend the task's "acceptance" array with what the last`,
            `     EVAL_RESULT.md flagged — see eval/archive/<taskId>/`,
            `  4. Re-run: bun run scripts/bootstrap.ts ${feature.feature}`,
          ].join("\n");

          yield* Effect.sync(() => console.log(hint));
        }

        return summary;
      }),
  }),
);
