import { describe, test, expect, afterAll, spyOn } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import * as nodePath from "node:path";
import * as os from "node:os";
import { AgentRunner } from "../../AgentRunner";
import { ContextEngine } from "../../ContextEngine";
import { EvalParser } from "../../EvalParser";
import { FeatureContractLive } from "../../FeatureContract";
import { RunTask } from "../../RunTask";
import type { RunTaskPaths } from "../../RunTask";
import { LoopRunner, LoopRunnerLive } from "../index";
import { brand } from "../../brand";

// ---------------------------------------------------------------------------
// RunTaskFakeWithCalls
//
// Records every (task, paths) pair the loop hands it.  The `calls` array is
// mutated in-place so callers can inspect it after `Effect.runPromise`.
// ---------------------------------------------------------------------------

type RecordedCall = { task: Task; paths: RunTaskPaths };

const makeRunTaskFake = (
  outcomes: ReadonlyArray<TaskResult | RunTaskError>,
): { layer: Layer.Layer<RunTask, never, never>; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  let index = 0;
  const arr = Array.from(outcomes);

  const layer = Layer.succeed(
    RunTask,
    RunTask.of({
      run: (task, _feature, paths) => {
        calls.push({ task, paths });
        if (index >= arr.length) {
          throw new Error(
            `RunTaskFake exhausted: call ${index + 1}, only ${arr.length} outcomes scripted`,
          );
        }
        const outcome = arr[index++]!;
        if ("verdict" in outcome) {
          return Effect.succeed(outcome);
        }
        return Effect.fail(outcome);
      },
    }),
  );

  return { layer, calls };
};

// ---------------------------------------------------------------------------
// Dead fakes for AgentRunner / ContextEngine / EvalParser.
// LoopRunner.run's declared R channel includes these services because
// RunTask.run propagates them through Effect.gen.  RunTaskFake intercepts
// every RunTask.run call so these layers are type-level scaffolding only.
// ---------------------------------------------------------------------------

const AgentRunnerDead = Layer.succeed(
  AgentRunner,
  AgentRunner.of({
    run: () => Effect.die("AgentRunner must not be called in LoopRunner retry tests"),
  }),
);

const ContextEngineDead = Layer.succeed(
  ContextEngine,
  ContextEngine.of({
    renderComposer: () => Effect.die("ContextEngine must not be called in LoopRunner retry tests"),
    renderReviewer: () => Effect.die("ContextEngine must not be called in LoopRunner retry tests"),
  }),
);

const EvalParserDead = Layer.succeed(
  EvalParser,
  EvalParser.of({
    parse: () => Effect.die("EvalParser must not be called in LoopRunner retry tests"),
  }),
);

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const makeTask = (
  id: string,
  depends_on: string[] = [],
  status: TaskStatus = "pending",
  attempts = 0,
  maxAttempts = 3,
): Task => ({
  id: brand<"TaskId">(id),
  title: `Task ${id}`,
  files: [],
  acceptance: [],
  depends_on: depends_on.map((d) => brand<"TaskId">(d)),
  status,
  attempts,
  maxAttempts,
});

const makeFeature = (tasks: Task[], featureName = "test"): Feature => ({
  feature: featureName,
  goal: "test goal",
  constraints: [],
  stories: [
    {
      id: brand<"StoryId">("S1"),
      title: "Story 1",
      acceptance: [],
      tasks,
    },
  ],
});

const makePassResult = (taskId: string): TaskResult => ({
  taskId: brand<"TaskId">(taskId),
  attempt: 1,
  verdict: "PASS",
  rationale: "fake pass",
  issues: [],
  composerLogPath: brand<"AbsolutePath">("/fake/composer.jsonl"),
  reviewerLogPath: brand<"AbsolutePath">("/fake/reviewer.jsonl"),
  evalResultPath: brand<"AbsolutePath">("/fake/EVAL_RESULT.md"),
  durationMs: 0,
});

const makeFailResult = (taskId: string): TaskResult => ({
  ...makePassResult(taskId),
  verdict: "FAIL",
  rationale: "fake fail",
});

// ---------------------------------------------------------------------------
// Tmp roots
// ---------------------------------------------------------------------------

/**
 * Standard tmp root for most fixtures — placed under os.tmpdir() so a stray
 * commit from LoopRunnerLive's commitTask cannot walk up to the project
 * `.git/` and pollute history.
 */
const tmpRoot = brand<"AbsolutePath">(
  nodePath.join(os.tmpdir(), `looprunner-retry-${crypto.randomUUID()}`),
);

/**
 * Non-repo tmp root — explicitly placed under os.tmpdir() so that
 * `git status --short` returns a non-zero exit code (not a git repo) and
 * captureGitStatus returns "".
 */
const nonRepoTmpRoot = brand<"AbsolutePath">(
  nodePath.join(os.tmpdir(), `looprunner-retry-nonrepo-${crypto.randomUUID()}`),
);

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

const makeTestLayer = (fake: { layer: Layer.Layer<RunTask, never, never> }) =>
  Layer.mergeAll(
    LoopRunnerLive,
    fake.layer,
    FeatureContractLive,
    AgentRunnerDead,
    ContextEngineDead,
    EvalParserDead,
  ).pipe(Layer.provideMerge(BunContext.layer));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const saveContract = (path: AbsolutePath, feature: Feature) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = brand<"AbsolutePath">(nodePath.dirname(path));
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path, JSON.stringify(feature, null, 2) + "\n");
  }).pipe(Effect.provide(BunContext.layer));

const seedEvalResult = (evalDir: AbsolutePath, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(evalDir, { recursive: true });
    const evalResultPath = brand<"AbsolutePath">(nodePath.join(evalDir as string, "EVAL_RESULT.md"));
    yield* fs.writeFileString(evalResultPath, content);
  }).pipe(Effect.provide(BunContext.layer));

const runLoop = (
  contractPath: AbsolutePath,
  fake: { layer: Layer.Layer<RunTask, never, never> },
) =>
  Effect.flatMap(LoopRunner, (lr) => lr.run(contractPath)).pipe(
    Effect.provide(makeTestLayer(fake)),
  );

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(tmpRoot, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
      yield* fs
        .remove(nonRepoTmpRoot, { recursive: true })
        .pipe(Effect.catchAll(() => Effect.void));
    }).pipe(Effect.provide(BunContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoopRunner retry-state", () => {
  // -------------------------------------------------------------------------
  // Fixture 1: FAIL iter 1, PASS iter 2 → priorEvalPath archiving
  // -------------------------------------------------------------------------

  test("FAIL then PASS: archives EVAL_RESULT.md and threads priorEvalPath on retry", async () => {
    const contractPath = brand<"AbsolutePath">(`${tmpRoot}/archive/FEATURE_CONTRACT.json`);
    const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
    const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));
    const evalResultPath = brand<"AbsolutePath">(nodePath.join(evalDir as string, "EVAL_RESULT.md"));
    const expectedArchivePath = brand<"AbsolutePath">(
      nodePath.join(evalDir as string, "archive", "T1", "iter-001-EVAL_RESULT.md"),
    );
    const evalContent = "# pre-seeded eval result for archive test\n";

    const feature = makeFeature([makeTask("T1", [], "pending", 0, 3)]);
    await Effect.runPromise(saveContract(contractPath, feature));
    await Effect.runPromise(seedEvalResult(evalDir, evalContent));

    const fake = makeRunTaskFake([makeFailResult("T1"), makePassResult("T1")]);

    const summary = await Effect.runPromise(runLoop(contractPath, fake));

    // Loop completed
    expect(summary.completed).toBe(true);
    expect(summary.stoppedReason._tag).toBe("AllDone");

    // Archive file exists with the pre-seeded content
    const archivedContent = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(expectedArchivePath);
      }).pipe(Effect.provide(BunContext.layer)),
    );
    expect(archivedContent).toBe(evalContent);

    // Iter 2 (calls[1]) received priorEvalPath pointing at the archive
    expect(fake.calls).toHaveLength(2);
    const iter2Call = fake.calls[1]!;
    expect(Option.isSome(iter2Call.paths.priorEvalPath)).toBe(true);
    if (Option.isSome(iter2Call.paths.priorEvalPath)) {
      expect(iter2Call.paths.priorEvalPath.value).toBe(expectedArchivePath);
    }

    // Iter 1 had no prior eval
    const iter1Call = fake.calls[0]!;
    expect(Option.isNone(iter1Call.paths.priorEvalPath)).toBe(true);

    // evalResultPath on disk still has the original content (archive was a copy)
    const currentEval = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(evalResultPath);
      }).pipe(Effect.provide(BunContext.layer)),
    );
    expect(currentEval).toBe(evalContent);
  });

  // -------------------------------------------------------------------------
  // Fixture 2: FAIL, FAIL, FAIL → TaskExhausted, on-disk status/attempts check
  // -------------------------------------------------------------------------

  test("3 FAILs with maxAttempts=3 → TaskExhausted; on-disk status=failed, attempts=3", async () => {
    const contractPath = brand<"AbsolutePath">(`${tmpRoot}/exhaust/FEATURE_CONTRACT.json`);
    const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
    const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));

    const feature = makeFeature([makeTask("T1", [], "pending", 0, 3)]);
    await Effect.runPromise(saveContract(contractPath, feature));
    // Pre-seed eval so archive steps on attempts 2 and 3 succeed
    await Effect.runPromise(seedEvalResult(evalDir, "# eval for exhaust fixture\n"));

    const fake = makeRunTaskFake([
      makeFailResult("T1"),
      makeFailResult("T1"),
      makeFailResult("T1"),
    ]);

    const summary = await Effect.runPromise(runLoop(contractPath, fake));

    expect(summary.completed).toBe(false);
    expect(summary.stoppedReason._tag).toBe("TaskExhausted");
    if (summary.stoppedReason._tag === "TaskExhausted") {
      expect(summary.stoppedReason.failedTaskIds).toContain(brand<"TaskId">("T1"));
    }
    expect(summary.tasksFailed).toContain(brand<"TaskId">("T1"));

    // On-disk contract reflects final state
    const onDisk = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const raw = yield* fs.readFileString(contractPath);
        return JSON.parse(raw) as Feature;
      }).pipe(Effect.provide(BunContext.layer)),
    );
    const onDiskTask = onDisk.stories[0]!.tasks.find((t) => t.id === "T1");
    expect(onDiskTask).toBeDefined();
    expect(onDiskTask!.status).toBe("failed");
    expect(onDiskTask!.attempts).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Fixture 3: AgentMaxTurnsExceeded counts as FAIL; second iter succeeds
  // -------------------------------------------------------------------------

  test("AgentMaxTurnsExceeded then PASS: agent error counts against attempts; loop completes", async () => {
    const contractPath = brand<"AbsolutePath">(
      `${tmpRoot}/agentturn/FEATURE_CONTRACT.json`,
    );
    const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
    const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));

    const feature = makeFeature([makeTask("T1", [], "pending", 0, 3)]);
    await Effect.runPromise(saveContract(contractPath, feature));
    // Pre-seed eval for archive step on attempt 2
    await Effect.runPromise(seedEvalResult(evalDir, "# eval for agentturn fixture\n"));

    const agentError: RunTaskError = { _tag: "AgentMaxTurnsExceeded", role: "Composer" };
    const fake = makeRunTaskFake([agentError, makePassResult("T1")]);

    const summary = await Effect.runPromise(runLoop(contractPath, fake));

    expect(summary.completed).toBe(true);
    expect(summary.stoppedReason._tag).toBe("AllDone");
    expect(summary.tasksDone).toContain(brand<"TaskId">("T1"));

    // Two iterations were run: one failed (agent error), one passed
    expect(fake.calls).toHaveLength(2);
    // First attempt was attempt 1, second was attempt 2
    expect(fake.calls[0]!.paths.attempt).toBe(1);
    expect(fake.calls[1]!.paths.attempt).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Fixture 4: gitStatus "" in non-repo directory
  // -------------------------------------------------------------------------

  test("gitStatus is '' when featureRoot is outside git tree", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(nonRepoTmpRoot as string, "FEATURE_CONTRACT.json"),
    );

    const feature = makeFeature([makeTask("T1", [], "pending", 0, 3)]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const fake = makeRunTaskFake([makePassResult("T1")]);

    const summary = await Effect.runPromise(runLoop(contractPath, fake));

    expect(summary.completed).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.paths.gitStatus).toBe("");
  });

  // -------------------------------------------------------------------------
  // Fixture 5: Exhaustion halt prints resume-hint with task id, "To resume:",
  //             "status", and "attempts"
  // -------------------------------------------------------------------------

  test("exhaustion halt prints resume hint containing task id, 'To resume:', 'status', 'attempts'", async () => {
    const contractPath = brand<"AbsolutePath">(
      `${tmpRoot}/resumehint/FEATURE_CONTRACT.json`,
    );
    const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
    const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));

    const feature = makeFeature([makeTask("T1", [], "pending", 0, 3)]);
    await Effect.runPromise(saveContract(contractPath, feature));
    await Effect.runPromise(seedEvalResult(evalDir, "# eval for resumehint fixture\n"));

    const fake = makeRunTaskFake([
      makeFailResult("T1"),
      makeFailResult("T1"),
      makeFailResult("T1"),
    ]);

    // Capture console.log output
    const logLines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });

    try {
      await Effect.runPromise(runLoop(contractPath, fake));
    } finally {
      spy.mockRestore();
    }

    const captured = logLines.join("\n");
    expect(captured).toContain("T1");
    expect(captured).toContain("To resume:");
    expect(captured).toContain("status");
    expect(captured).toContain("attempts");
  });
});
