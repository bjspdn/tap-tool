import { Effect, Either, Layer, Match, Option, Ref } from "effect";
import { FileSystem } from "@effect/platform";
import * as nodePath from "node:path";
import { brand } from "../brand";
import { AgentRunner } from "../AgentRunner";
import { ContextEngine, type SummarizerRenderInput } from "../ContextEngine";
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
// Dashboard state helpers
// ---------------------------------------------------------------------------

/** Recompute aggregated totals from the current stories array. */
const recomputeTotals = (
  stories: ReadonlyArray<DashboardStoryState>,
): DashboardTotals => {
  const allTasks = stories.flatMap((s) => s.tasks);
  return {
    tokensUsed: allTasks.reduce((acc, t) => acc + t.tokensUsed, 0),
    costUsd: allTasks.reduce((acc, t) => acc + t.costUsd, 0),
    tasksDone: allTasks.filter((t) => t.status === "done").length,
    tasksFailed: allTasks.filter((t) => t.status === "failed").length,
    tasksPending: allTasks.filter(
      (t) => t.status === "pending" || t.status === "in_progress",
    ).length,
  };
};

/**
 * Return a new `DashboardState` with the task matching `taskId` replaced by
 * `fn(existingTask)`. Totals are recomputed from the updated stories.
 */
const updateDashTask = (
  state: DashboardState,
  taskId: TaskId,
  fn: (t: DashboardTaskState) => DashboardTaskState,
): DashboardState => {
  const stories = state.stories.map((story) => ({
    ...story,
    tasks: story.tasks.map((t) => (t.taskId === taskId ? fn(t) : t)),
  }));
  return { ...state, stories, totals: recomputeTotals(stories) };
};

/**
 * Build a state-update helper that forwards to `Ref.update` when a Ref is
 * present, or is a no-op when none was supplied (non-TTY / legacy callers).
 */
const makeDashUpdater =
  (dashboardRef: Ref.Ref<DashboardState> | undefined) =>
  (fn: (s: DashboardState) => DashboardState): Effect.Effect<void> =>
    dashboardRef ? Ref.update(dashboardRef, fn) : Effect.void;

// ---------------------------------------------------------------------------
// dispatchTerminalSummary
// ---------------------------------------------------------------------------

/**
 * Context passed to `dispatchTerminalSummary` from the LoopRunner's run body.
 * Groups the filesystem anchors needed to build `SummarizerRenderInput`.
 */
type SummaryDispatchCtx = {
  readonly feature: Feature;
  readonly featureRoot: AbsolutePath;
  readonly specsPath: AbsolutePath;
  readonly contractPath: AbsolutePath;
};

/**
 * Dispatches the Summarizer role after a terminal loop state.
 *
 * Predicates on `summary.stoppedReason._tag`:
 *   - `AllDone` | `TaskExhausted` → renders the Summarizer prompt and dispatches
 *     via AgentRunner so the agent writes SUMMARY.md to `<featureRoot>/SUMMARY.md`.
 *   - All other variants (`RateLimited`, `MaxIterations`, `NoReadyTasks`) → no-op.
 *
 * All dispatch failures — including render errors, agent spawn failures, and
 * unexpected defects — are absorbed (logged, not propagated) so loop termination
 * is never gated on Summarizer availability.
 */
const dispatchTerminalSummary = (
  summary: LoopSummary,
  ctx: SummaryDispatchCtx,
): Effect.Effect<void, never, AgentRunner | ContextEngine | FileSystem.FileSystem> => {
  const { stoppedReason } = summary;

  // Only dispatch on terminal-eligible variants; no-op otherwise.
  if (stoppedReason._tag !== "AllDone" && stoppedReason._tag !== "TaskExhausted") {
    return Effect.void;
  }

  const summaryPath = brand<"AbsolutePath">(
    nodePath.join(ctx.featureRoot as string, "SUMMARY.md"),
  );
  const logsDir = brand<"AbsolutePath">(
    nodePath.join(ctx.featureRoot as string, "logs"),
  );
  const summarizerLogPath = brand<"AbsolutePath">(
    nodePath.join(logsDir as string, "summarizer.jsonl"),
  );
  const summarizerStderrLogPath = brand<"AbsolutePath">(
    nodePath.join(logsDir as string, "summarizer.stderr.log"),
  );

  // Format stoppedReason as a human-readable string for the Summarizer prompt.
  const stoppedReasonStr =
    stoppedReason._tag === "AllDone"
      ? "AllDone"
      : `Exhausted (failed tasks: ${stoppedReason.failedTaskIds.join(", ")})`;

  const renderInput: SummarizerRenderInput = {
    feature: ctx.feature,
    specsPath: ctx.specsPath,
    contractPath: ctx.contractPath,
    summaryPath,
    stoppedReason: stoppedReasonStr,
    tasksDone: summary.tasksDone,
    tasksFailed: summary.tasksFailed,
  };

  return Effect.gen(function* () {
    const engine = yield* ContextEngine;
    const runner = yield* AgentRunner;
    const fs = yield* FileSystem.FileSystem;

    // Ensure the summarizer logs directory exists before dispatch.
    yield* fs.makeDirectory(logsDir, { recursive: true });

    // renderSummarizer is optional on the service interface for backward
    // compatibility with legacy test mocks that only stub Composer/Reviewer.
    const render = engine.renderSummarizer;
    if (!render) {
      yield* Effect.sync(() =>
        console.error(
          "[loop-runner] renderSummarizer not available in ContextEngine; skipping summary dispatch",
        ),
      );
      return;
    }

    const prompt = yield* render(renderInput);

    // Dispatch via the same runner.run envelope used by Composer and Reviewer
    // (the runRole pattern from commit e9d49c4). "Summarizer" is cast because
    // AgentRole = "Composer" | "Reviewer" and updating that type is outside
    // this task's file scope; the runtime value is correct for the CLI dispatcher.
    yield* runner.run({
      role: "Summarizer" as unknown as AgentRole,
      stdin: prompt,
      cwd: ctx.featureRoot,
      attempt: 1,
      logPath: summarizerLogPath,
      stderrLogPath: summarizerStderrLogPath,
    });
  }).pipe(
    // Absorb all failures and defects — Summarizer dispatch must never gate
    // loop termination. The terminal status returned by LoopRunner is authoritative.
    Effect.catchAllCause((cause) =>
      Effect.sync(() =>
        console.error(
          `[loop-runner] summarizer dispatch failed (non-fatal): ${cause}`,
        ),
      ),
    ),
  );
};

// ---------------------------------------------------------------------------
// LoopRunnerLive
// ---------------------------------------------------------------------------

/**
 * Live layer for LoopRunner.
 *
 * FeatureContract, RunTask, FileSystem, and CommandExecutor are NOT captured at
 * layer-construction time — they are acquired via `yield*` inside the `run`
 * Effect.gen body. This mirrors the AgentRunnerEcho pattern so that
 * LoopRunnerLive composes with NodeContext.layer + other Live layers without
 * leaving residual R on the layer itself.
 */
export const LoopRunnerLive: Layer.Layer<LoopRunner, never, never> = Layer.succeed(
  LoopRunner,
  LoopRunner.of({
    run: (contractPath, dashboardRef) =>
      Effect.gen(function* () {
        const fc = yield* FeatureContract;
        const rt = yield* RunTask;
        // Capture the outer AgentRunner so the per-task hook can delegate to it.
        const agentRunner = yield* AgentRunner;

        let feature = yield* fc.load(contractPath);

        const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
        const specsPath = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "SPECS.md"));

        const updateDash = makeDashUpdater(dashboardRef);

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

          // Dashboard: mark task in_progress and record start time.
          yield* updateDash((state) =>
            updateDashTask(state, task.id, (t) => ({
              ...t,
              status: "in_progress",
              phase: Option.some("Composer" as AgentRole),
              startedAt: Option.some(Date.now()),
            })),
          );

          const priorEvalPath = yield* resolvePriorEvalPath(featureRoot, task.id, attempt);
          const gitStatus = yield* captureGitStatus(featureRoot);

          // Build a per-task AgentRunner hook that intercepts each role call within
          // RunTask.run. After Composer completes (and before Reviewer starts) the hook
          // transitions phase → Reviewer. After each role call it accumulates token/cost
          // data from the AgentRunner result into the dashboard Ref.
          const hookedAgentRunner = AgentRunner.of({
            run: (opts) =>
              Effect.gen(function* () {
                const result = yield* agentRunner.run(opts);

                // Phase transition: Composer → Reviewer (fires once, between the two roles)
                if (opts.role === "Composer") {
                  yield* updateDash((state) =>
                    updateDashTask(state, task.id, (t) => ({
                      ...t,
                      phase: Option.some("Reviewer" as AgentRole),
                    })),
                  );
                }

                // Accumulate token/cost from each agent run
                const tokens =
                  (result.result.usage?.input_tokens ?? 0) +
                  (result.result.usage?.output_tokens ?? 0);
                const cost = result.result.total_cost_usd ?? 0;
                if (tokens > 0 || cost > 0) {
                  yield* updateDash((state) =>
                    updateDashTask(state, task.id, (t) => ({
                      ...t,
                      tokensUsed: t.tokensUsed + tokens,
                      costUsd: t.costUsd + cost,
                    })),
                  );
                }

                return result;
              }),
          });

          const outcome = yield* rt
            .run(task, feature, {
              featureRoot,
              specsPath,
              contractPath,
              attempt,
              priorEvalPath,
              gitStatus,
            })
            .pipe(
              Effect.provideService(AgentRunner, hookedAgentRunner),
              Effect.either,
            );

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
                // Dashboard: mark task done; record elapsed duration from TaskResult.
                // Token/cost data is accumulated via the hookedAgentRunner interceptor
                // above (one call per role) and preserved by the ...t spread below.
                const dur = Either.isRight(outcome)
                  ? Option.some(outcome.right.durationMs)
                  : Option.none<number>();
                yield* updateDash((state) =>
                  updateDashTask(state, task.id, (t) => ({
                    ...t,
                    status: "done",
                    phase: Option.none(),
                    durationMs: dur,
                  })),
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
                // Dashboard: clear phase between retry attempts; status stays in_progress.
                yield* updateDash((state) =>
                  updateDashTask(state, task.id, (t) => ({
                    ...t,
                    phase: Option.none(),
                  })),
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
                // Dashboard: mark task failed and clear active phase.
                yield* updateDash((state) =>
                  updateDashTask(state, task.id, (t) => ({
                    ...t,
                    status: "failed",
                    phase: Option.none(),
                  })),
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

        const reason: StoppedReason =
          stoppedReason ?? { _tag: "MaxIterations", cap: MAX_ITERATIONS };

        // Dashboard: record terminal reason now that the loop has stopped.
        yield* updateDash((state) => ({
          ...state,
          stoppedReason: Option.some(reason),
        }));

        const allTasks = feature.stories.flatMap((s) => s.tasks);
        const summary = buildLoopSummary(feature, iterations, reason);

        if (summary.tasksFailed.length > 0) {
          yield* Effect.sync(() => console.log(formatResumeHint(summary, allTasks)));
        }

        // Dispatch Summarizer on terminal-eligible states. Failures are absorbed
        // inside the helper — terminal status stays authoritative regardless.
        yield* dispatchTerminalSummary(summary, { feature, featureRoot, specsPath, contractPath });

        return summary;
      }),
  }),
);
