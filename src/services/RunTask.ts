import { Clock, Context, Effect, Layer, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { AgentRunner, filesystemError } from "./AgentRunner";
import { ContextEngine } from "./ContextEngine";
import { EvalParser } from "./EvalParser";
import { brand } from "./brand";

// ---------------------------------------------------------------------------
// RunTaskPaths
// ---------------------------------------------------------------------------

/**
 * Filesystem anchors for a single task invocation.
 * All path fields use the `AbsolutePath` brand from `Contract.d.ts` for
 * type-safe propagation into `TaskResult`. `attempt` is 1-indexed and supplied
 * by the caller (future LoopRunner owns retry state).
 */
export type RunTaskPaths = {
  readonly featureRoot: AbsolutePath;
  readonly specsPath: AbsolutePath;
  readonly contractPath: AbsolutePath;
  readonly attempt: number;
  readonly priorEvalPath: Option.Option<AbsolutePath>;
  readonly gitStatus: string;
};

// ---------------------------------------------------------------------------
// Local error-mapping helper — wraps any FileSystem error as a FilesystemError
// tagged variant carrying the branded path.
// ---------------------------------------------------------------------------

const withFsError = (path: AbsolutePath) =>
  Effect.mapError((cause: unknown) =>
    filesystemError(path, cause),
  );

// ---------------------------------------------------------------------------
// computeTaskPaths — pure path derivation, no side effects
// ---------------------------------------------------------------------------

const computeTaskPaths = (featureRoot: AbsolutePath, taskId: TaskId, attempt: number) => {
  // Invariant: attempt < 1000 — LoopRunner enforces via maxAttempts
  const iter = String(attempt).padStart(3, "0");
  const logsDir = `${featureRoot}/logs/${taskId}`;
  const evalDir = `${featureRoot}/eval`;

  return {
    composerLogPath: brand<"AbsolutePath">(`${logsDir}/iter-${iter}-composer.jsonl`),
    composerStderrLogPath: brand<"AbsolutePath">(`${logsDir}/iter-${iter}-composer.stderr.log`),
    reviewerLogPath: brand<"AbsolutePath">(`${logsDir}/iter-${iter}-reviewer.jsonl`),
    reviewerStderrLogPath: brand<"AbsolutePath">(`${logsDir}/iter-${iter}-reviewer.stderr.log`),
    evalResultPath: brand<"AbsolutePath">(`${evalDir}/EVAL_RESULT.md`),
    logsDir: brand<"AbsolutePath">(logsDir),
    evalDir: brand<"AbsolutePath">(evalDir),
  };
};

// ---------------------------------------------------------------------------
// ensureDirs — creates an array of directories in parallel, discarding output
// ---------------------------------------------------------------------------

const ensureDirs = (fs: FileSystem.FileSystem, dirs: ReadonlyArray<AbsolutePath>) =>
  Effect.all(
    dirs.map((dir) => fs.makeDirectory(dir, { recursive: true }).pipe(withFsError(dir))),
    { discard: true },
  );

// ---------------------------------------------------------------------------
// readAndParseEval — existence check + read + parse in a single pipeline
// ---------------------------------------------------------------------------

const readAndParseEval = (evalResultPath: AbsolutePath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parser = yield* EvalParser;
    const exists = yield* fs.exists(evalResultPath).pipe(withFsError(evalResultPath));
    if (!exists) {
      return yield* Effect.fail({
        _tag: "EvalResultMissing",
        expectedPath: evalResultPath,
      } as const);
    }
    const raw = yield* fs.readFileString(evalResultPath).pipe(withFsError(evalResultPath));
    return yield* parser.parse(raw);
  });

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

/**
 * Orchestrates one Composer → Reviewer → verdict pipeline for a single task.
 * Yields a `TaskResult` on success or a tagged `RunTaskError` on any failure.
 * Requires `AgentRunner`, `ContextEngine`, `EvalParser`, and
 * `FileSystem.FileSystem` from the caller's Layer graph.
 */
export const runTask = (
  task: Task,
  feature: Feature,
  paths: RunTaskPaths,
): Effect.Effect<
  TaskResult,
  RunTaskError,
  AgentRunner | ContextEngine | EvalParser | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    // Step 1 — Acquire services.
    const fs = yield* FileSystem.FileSystem;
    const engine = yield* ContextEngine;
    const runner = yield* AgentRunner;

    // Step 2 — Compute paths.
    const {
      composerLogPath,
      composerStderrLogPath,
      reviewerLogPath,
      reviewerStderrLogPath,
      evalResultPath,
      logsDir,
      evalDir,
    } = computeTaskPaths(paths.featureRoot, task.id, paths.attempt);

    // Step 3 — Ensure directories exist.
    yield* ensureDirs(fs, [logsDir, evalDir]);

    // Step 4 — Start clock.
    const startMs = yield* Clock.currentTimeMillis;

    // Step 5 — Render Composer contract.
    const composerPrompt = yield* engine.renderComposer({
      task,
      feature,
      specsPath: paths.specsPath,
      contractPath: paths.contractPath,
      attempt: paths.attempt,
      priorEval: paths.priorEvalPath,
      gitStatus: paths.gitStatus,
    });

    // Step 6 — Run Composer.
    yield* runner.run({
      role: "Composer",
      stdin: composerPrompt,
      cwd: paths.featureRoot,
      attempt: paths.attempt,
      logPath: composerLogPath,
      stderrLogPath: composerStderrLogPath,
    });

    // Step 7 — Render Reviewer contract.
    const reviewerPrompt = yield* engine.renderReviewer({
      task,
      feature,
      specsPath: paths.specsPath,
      contractPath: paths.contractPath,
      attempt: paths.attempt,
      evalPath: evalResultPath,
    });

    // Step 8 — Run Reviewer.
    yield* runner.run({
      role: "Reviewer",
      stdin: reviewerPrompt,
      cwd: paths.featureRoot,
      attempt: paths.attempt,
      logPath: reviewerLogPath,
      stderrLogPath: reviewerStderrLogPath,
      evalPath: evalResultPath,
    });

    // Step 9 — Read and parse eval result.
    const { verdict, summary, comments } = yield* readAndParseEval(evalResultPath);

    // Step 10 — Duration.
    const durationMs = (yield* Clock.currentTimeMillis) - startMs;

    // Step 11 — Assemble and return TaskResult.
    return {
      taskId: task.id,
      attempt: paths.attempt,
      verdict,
      summary,
      comments,
      composerLogPath,
      reviewerLogPath,
      evalResultPath,
      durationMs,
    } satisfies TaskResult;
  });

// ---------------------------------------------------------------------------
// RunTask Tag + Live layer
// ---------------------------------------------------------------------------

/**
 * Context.Tag for the runTask pipeline.
 * Consumers yield* RunTask then call rt.run(...) inside an Effect.gen.
 */
export class RunTask extends Context.Tag("RunTask")<
  RunTask,
  {
    readonly run: (
      task: Task,
      feature: Feature,
      paths: RunTaskPaths,
    ) => Effect.Effect<
      TaskResult,
      RunTaskError,
      AgentRunner | ContextEngine | EvalParser | FileSystem.FileSystem
    >;
  }
>() {}

/**
 * Live layer — delegates directly to the plain `runTask` function.
 */
export const RunTaskLive: Layer.Layer<RunTask, never, never> = Layer.succeed(
  RunTask,
  RunTask.of({ run: runTask }),
);
