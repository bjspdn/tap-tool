import { Effect, Layer, Match, Option } from "effect";
import * as nodePath from "node:path";
import { brand } from "../brand";
import { FeatureContract } from "../FeatureContract";
import { RunTask } from "../RunTask";
import { captureGitStatus } from "./gitStatus";
import { commitTask } from "./gitCommit";
import { resolvePriorEvalPath } from "./priorEval";
import {
  decideIteration,
  decideTerminal,
  buildLoopSummary,
} from "./iterationPolicy";
import { formatResumeHint, formatIterationFailure } from "./loopReporter";
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

        let feature = yield* fc.load(contractPath);

        const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
        const specsPath = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "SPECS.md"));

        let iterations = 0;
        let stoppedReason: StoppedReason | null = null;

        while (iterations < MAX_ITERATIONS) {
          iterations++;

          const maybeTask = fc.nextReady(feature);
          if (Option.isNone(maybeTask)) {
            stoppedReason = decideTerminal(feature);
            break;
          }
          const task = maybeTask.value;
          const attempt = task.attempts + 1;

          feature = fc.markStatus(feature, task.id, "in_progress");
          yield* fc.save(contractPath, feature);

          const priorEvalPath = yield* resolvePriorEvalPath(featureRoot, task.id, attempt);
          const gitStatus = yield* captureGitStatus(featureRoot);

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

          const decision = decideIteration(attempt, task.maxAttempts, outcome);

          // Match.exhaustive ensures a new Decision tag breaks the build.
          const result = yield* Match.value(decision).pipe(
            Match.tag("RateLimited", ({ role, resetsAt }) =>
              Effect.gen(function* () {
                yield* fc.save(contractPath, feature);
                return { halt: { _tag: "RateLimited", role, resetsAt } as StoppedReason };
              }),
            ),
            Match.tag("Pass", () =>
              Effect.gen(function* () {
                feature = fc.incrementAttempt(feature, task.id);
                feature = fc.markStatus(feature, task.id, "done");
                yield* fc.save(contractPath, feature);
                yield* commitTask(
                  brand<"AbsolutePath">(process.cwd()),
                  task,
                  contractPath,
                ).pipe(
                  Effect.catchAll((err) =>
                    Effect.sync(() =>
                      console.error(
                        `[loop-runner] commit failed for task=${err.taskId} _tag=${err._tag} exit=${err.exitCode} stderr=${err.stderr}`,
                      ),
                    ),
                  ),
                );
                return { halt: null as StoppedReason | null };
              }),
            ),
            Match.tag("Retry", () =>
              Effect.gen(function* () {
                feature = fc.incrementAttempt(feature, task.id);
                yield* fc.save(contractPath, feature);
                yield* Effect.sync(() =>
                  console.error(formatIterationFailure(iterations, task, attempt, outcome)),
                );
                return { halt: null as StoppedReason | null };
              }),
            ),
            Match.tag("Exhausted", () =>
              Effect.gen(function* () {
                feature = fc.incrementAttempt(feature, task.id);
                feature = fc.markStatus(feature, task.id, "failed");
                yield* fc.save(contractPath, feature);
                yield* Effect.sync(() =>
                  console.error(formatIterationFailure(iterations, task, attempt, outcome)),
                );
                return {
                  halt: {
                    _tag: "TaskExhausted",
                    failedTaskIds: [task.id],
                  } as StoppedReason,
                };
              }),
            ),
            Match.exhaustive,
          );

          if (result.halt !== null) {
            stoppedReason = result.halt;
            break;
          }
        }

        if (stoppedReason === null) {
          stoppedReason = { _tag: "MaxIterations", cap: MAX_ITERATIONS };
        }

        const allTasks = feature.stories.flatMap((s) => s.tasks);
        const summary = buildLoopSummary(feature, iterations, stoppedReason);

        if (summary.tasksFailed.length > 0) {
          yield* Effect.sync(() => console.log(formatResumeHint(summary, allTasks)));
        }

        return summary;
      }),
  }),
);
