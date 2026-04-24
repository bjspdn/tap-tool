import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import * as nodePath from "node:path";
import * as os from "node:os";
import { AgentRunner } from "../../AgentRunner";
import { ContextEngine } from "../../ContextEngine";
import { EvalParser } from "../../EvalParser";
import { FeatureContractLive } from "../../FeatureContract";
import { RunTask } from "../../RunTask";
import { LoopRunner, LoopRunnerLive, MAX_ITERATIONS } from "../index";
import { brand } from "../../brand";

// ---------------------------------------------------------------------------
// RunTaskFake
// ---------------------------------------------------------------------------

/**
 * Inline fake for RunTask. Consumes scripted outcomes FIFO.
 * Returns Effect.succeed for TaskResult (identified by `verdict` field),
 * Effect.fail for RunTaskError. Throws (defect) if outcomes are exhausted.
 */
const RunTaskFake = (
  outcomes: ReadonlyArray<TaskResult | RunTaskError>,
): Layer.Layer<RunTask, never, never> => {
  let index = 0;
  const arr = Array.from(outcomes);
  return Layer.succeed(
    RunTask,
    RunTask.of({
      run: (_task, _feature, _paths) => {
        if (index >= arr.length) {
          throw new Error(
            `RunTaskFake exhausted: call ${index + 1}, only ${arr.length} outcomes scripted`,
          );
        }
        const outcome = arr[index++]!;
        // Discriminate: TaskResult always has `verdict`; RunTaskError variants have `_tag`.
        if ("verdict" in outcome) {
          return Effect.succeed(outcome);
        }
        return Effect.fail(outcome);
      },
    }),
  );
};

// ---------------------------------------------------------------------------
// Dead fakes for AgentRunner / ContextEngine / EvalParser.
//
// LoopRunner.run's declared R channel includes these services because
// RunTask.run's declared return type propagates them through Effect.gen
// (see LoopRunner.ts comment — contract-reality escape hatch). RunTaskFake
// intercepts every RunTask.run call before those services are ever accessed,
// so these layers are type-level scaffolding only and will never execute.
// ---------------------------------------------------------------------------

const AgentRunnerDead = Layer.succeed(
  AgentRunner,
  AgentRunner.of({
    run: () => Effect.die("AgentRunner must not be called in LoopRunner scheduling tests"),
  }),
);

const ContextEngineDead = Layer.succeed(
  ContextEngine,
  ContextEngine.of({
    renderComposer: () => Effect.die("ContextEngine must not be called in LoopRunner scheduling tests"),
    renderReviewer: () => Effect.die("ContextEngine must not be called in LoopRunner scheduling tests"),
  }),
);

const EvalParserDead = Layer.succeed(
  EvalParser,
  EvalParser.of({
    parse: () => Effect.die("EvalParser must not be called in LoopRunner scheduling tests"),
  }),
);

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const makeTask = (
  id: string,
  depends_on: string[],
  status: TaskStatus,
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
// Tmp root for this test run — placed under os.tmpdir() so a stray commit
// from LoopRunnerLive's commitTask cannot walk up to the project `.git/`.
// ---------------------------------------------------------------------------

const tmpRoot = brand<"AbsolutePath">(
  nodePath.join(os.tmpdir(), `looprunner-sched-${crypto.randomUUID()}`),
);

// ---------------------------------------------------------------------------
// Layer factory — BunContext.layer + FeatureContractLive + RunTaskFake + LoopRunnerLive
// (plus dead fakes to satisfy LoopRunner.run's declared R channel types)
// ---------------------------------------------------------------------------

const makeTestLayer = (outcomes: ReadonlyArray<TaskResult | RunTaskError>) =>
  Layer.mergeAll(
    LoopRunnerLive,
    RunTaskFake(outcomes),
    FeatureContractLive,
    AgentRunnerDead,
    ContextEngineDead,
    EvalParserDead,
  ).pipe(Layer.provideMerge(BunContext.layer));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a Feature contract JSON to disk (used before running the loop). */
const saveContract = (path: AbsolutePath, feature: Feature) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = brand<"AbsolutePath">(nodePath.dirname(path));
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path, JSON.stringify(feature, null, 2) + "\n");
  }).pipe(Effect.provide(BunContext.layer));

/** Run LoopRunner.run with the given contract + outcomes. */
const runLoop = (
  contractPath: AbsolutePath,
  outcomes: ReadonlyArray<TaskResult | RunTaskError>,
) =>
  Effect.flatMap(LoopRunner, (lr) => lr.run(contractPath)).pipe(
    Effect.provide(makeTestLayer(outcomes)),
  );

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(tmpRoot, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
    }).pipe(Effect.provide(BunContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoopRunner scheduling", () => {
  // -------------------------------------------------------------------------
  // Fixture 1: T1→T2 chain, both PASS → AllDone
  // -------------------------------------------------------------------------

  test("T1→T2 dependency chain: PASS,PASS → AllDone with both tasks done", async () => {
    const contractPath = brand<"AbsolutePath">(`${tmpRoot}/chain/FEATURE_CONTRACT.json`);
    const feature = makeFeature([
      makeTask("T1", [], "pending"),
      makeTask("T2", ["T1"], "pending"),
    ]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const summary = await Effect.runPromise(
      runLoop(contractPath, [makePassResult("T1"), makePassResult("T2")]),
    );

    expect(summary.completed).toBe(true);
    expect(summary.stoppedReason._tag).toBe("AllDone");
    expect(summary.tasksDone).toContain(brand<"TaskId">("T1"));
    expect(summary.tasksDone).toContain(brand<"TaskId">("T2"));
    expect(summary.tasksFailed).toHaveLength(0);
    expect(summary.tasksPending).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fixture 2: T1 pending + T2 already done → AllDone (only T1 ran)
  // -------------------------------------------------------------------------

  test("T1 pending + T2 already done: only T1 runs → AllDone", async () => {
    const contractPath = brand<"AbsolutePath">(`${tmpRoot}/done/FEATURE_CONTRACT.json`);
    const feature = makeFeature([
      makeTask("T1", [], "pending"),
      makeTask("T2", ["T1"], "done", 1), // already done
    ]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const summary = await Effect.runPromise(
      runLoop(contractPath, [makePassResult("T1")]),
    );

    expect(summary.completed).toBe(true);
    expect(summary.stoppedReason._tag).toBe("AllDone");
    expect(summary.tasksDone).toContain(brand<"TaskId">("T1"));
    expect(summary.tasksDone).toContain(brand<"TaskId">("T2"));
    expect(summary.tasksFailed).toHaveLength(0);
    expect(summary.tasksPending).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fixture 3: Ready T1 + T2 blocked on failed T3 → NoReadyTasks
  // -------------------------------------------------------------------------

  test("ready T1 + T2 blocked on failed T3 → NoReadyTasks with T2 in remaining", async () => {
    const contractPath = brand<"AbsolutePath">(`${tmpRoot}/blocked/FEATURE_CONTRACT.json`);
    const feature = makeFeature([
      makeTask("T1", [], "pending"),          // ready
      makeTask("T2", ["T3"], "pending"),      // blocked on T3 (failed)
      makeTask("T3", [], "failed", 3, 3),     // already failed
    ]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const summary = await Effect.runPromise(
      runLoop(contractPath, [makePassResult("T1")]),
    );

    expect(summary.stoppedReason._tag).toBe("NoReadyTasks");
    if (summary.stoppedReason._tag === "NoReadyTasks") {
      expect(summary.stoppedReason.remaining).toContain(brand<"TaskId">("T2"));
      expect(summary.stoppedReason.remaining).not.toContain(brand<"TaskId">("T1"));
    }
    expect(summary.completed).toBe(false);
    expect(summary.tasksDone).toContain(brand<"TaskId">("T1"));
    expect(summary.tasksPending).toContain(brand<"TaskId">("T2"));
  });

  // -------------------------------------------------------------------------
  // Fixture 4: MaxIterations — one task with maxAttempts > MAX_ITERATIONS,
  // always FAIL. Loop hits the safety cap.
  //
  // We also pre-create the eval result file so that archivePriorEval (triggered
  // on attempt > 1) can read it on iterations 2–MAX_ITERATIONS.
  // ---------------------------------------------------------------------------

  test(`task always fails with maxAttempts=${MAX_ITERATIONS + 100} → MaxIterations with cap=${MAX_ITERATIONS}`, async () => {
    const contractPath = brand<"AbsolutePath">(`${tmpRoot}/maxiter/FEATURE_CONTRACT.json`);
    const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
    const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));
    const evalResultPath = brand<"AbsolutePath">(nodePath.join(evalDir as string, "EVAL_RESULT.md"));

    const feature = makeFeature([
      makeTask("T1", [], "pending", 0, MAX_ITERATIONS + 100),
    ]);
    await Effect.runPromise(saveContract(contractPath, feature));

    // Pre-create the eval result so archivePriorEval succeeds on retry iterations.
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(evalDir, { recursive: true });
        yield* fs.writeFileString(evalResultPath, "# placeholder eval for retry archiving\n");
      }).pipe(Effect.provide(BunContext.layer)),
    );

    // Exactly MAX_ITERATIONS FAIL outcomes — the loop runs MAX_ITERATIONS times before the
    // while-condition fails (iterations < MAX_ITERATIONS), then sets stoppedReason=MaxIterations.
    const outcomes: ReadonlyArray<TaskResult | RunTaskError> = Array.from(
      { length: MAX_ITERATIONS },
      (): TaskResult => makeFailResult("T1"),
    );

    const summary = await Effect.runPromise(runLoop(contractPath, outcomes));

    expect(summary.stoppedReason._tag).toBe("MaxIterations");
    if (summary.stoppedReason._tag === "MaxIterations") {
      expect(summary.stoppedReason.cap).toBe(100);
    }
    expect(summary.completed).toBe(false);
  });
});
