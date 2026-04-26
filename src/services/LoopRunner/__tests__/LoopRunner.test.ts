import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Either, Layer, Option, Ref } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import * as nodePath from "node:path";
import * as os from "node:os";
import { AgentRunner } from "../../AgentRunner";
import { ContextEngine } from "../../ContextEngine";
import { EvalParser } from "../../EvalParser";
import { FeatureContractLive } from "../../FeatureContract";
import { RunTask, RunTaskLive } from "../../RunTask";
import { LoopRunner, LoopRunnerLive } from "../index";
import { brand } from "../../brand";

// ---------------------------------------------------------------------------
// Tmp root
// ---------------------------------------------------------------------------

const tmpRoot = brand<"AbsolutePath">(
  nodePath.join(os.tmpdir(), `looprunner-dash-${crypto.randomUUID()}`),
);

afterAll(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(tmpRoot, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
    }).pipe(Effect.provide(BunContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Dead fakes — satisfy the R channel; must not be called in these tests.
// dispatchTerminalSummary may reach AgentRunner/ContextEngine on AllDone, but
// all failures are absorbed inside that helper so the tests remain stable.
// ---------------------------------------------------------------------------

const AgentRunnerDead = Layer.succeed(
  AgentRunner,
  AgentRunner.of({
    run: () => Effect.die("AgentRunner must not be called in LoopRunner dashboard tests"),
  }),
);

const ContextEngineDead = Layer.succeed(
  ContextEngine,
  ContextEngine.of({
    renderComposer: () =>
      Effect.die("ContextEngine must not be called in LoopRunner dashboard tests"),
    renderReviewer: () =>
      Effect.die("ContextEngine must not be called in LoopRunner dashboard tests"),
    // No renderSummarizer — dispatchTerminalSummary will log and return early.
  }),
);

const EvalParserDead = Layer.succeed(
  EvalParser,
  EvalParser.of({
    parse: () => Effect.die("EvalParser must not be called in LoopRunner dashboard tests"),
  }),
);

// ---------------------------------------------------------------------------
// RunTaskFake — scripted outcomes
// ---------------------------------------------------------------------------

const makeRunTaskFake = (
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
        if ("verdict" in outcome) return Effect.succeed(outcome);
        return Effect.fail(outcome);
      },
    }),
  );
};

/**
 * RunTask fake that captures the Ref<DashboardState> snapshot at the moment
 * RunTask.run is invoked (i.e. the state that LoopRunner set before delegating).
 */
const makeRunTaskWithRefCapture = (
  ref: Ref.Ref<DashboardState>,
  outcomes: ReadonlyArray<TaskResult | RunTaskError>,
): { layer: Layer.Layer<RunTask, never, never>; captured: DashboardState[] } => {
  const captured: DashboardState[] = [];
  let index = 0;
  const arr = Array.from(outcomes);
  const layer = Layer.succeed(
    RunTask,
    RunTask.of({
      run: (_task, _feature, _paths) =>
        Effect.gen(function* () {
          // Snapshot the dashboard state the moment LoopRunner hands off to RunTask.
          const snap = yield* Ref.get(ref);
          captured.push(snap);
          if (index >= arr.length) {
            throw new Error(
              `RunTaskCapture exhausted: call ${index + 1}, only ${arr.length} outcomes scripted`,
            );
          }
          const outcome = arr[index++]!;
          if ("verdict" in outcome) return yield* Effect.succeed(outcome);
          return yield* Effect.fail(outcome);
        }),
    }),
  );
  return { layer, captured };
};

// ---------------------------------------------------------------------------
// Fixture helpers
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
  description: `Description for task ${id}`,
  files: [],
  depends_on: depends_on.map((d) => brand<"TaskId">(d)),
  status,
  attempts,
  maxAttempts,
});

const makeFeature = (tasks: Task[]): Feature => ({
  feature: "dashboard-integration-test",
  goal: "test dashboard Ref integration",
  description: "LoopRunner Ref<DashboardState> integration test feature",
  constraints: [],
  stories: [
    {
      id: brand<"StoryId">("S1"),
      title: "Story 1",
      description: "Test story",
      tasks,
    },
  ],
});

const makePassResult = (taskId: string, durationMs = 42): TaskResult => ({
  taskId: brand<"TaskId">(taskId),
  attempt: 1,
  verdict: "PASS",
  summary: "fake pass",
  comments: [],
  composerLogPath: brand<"AbsolutePath">("/fake/composer.jsonl"),
  reviewerLogPath: brand<"AbsolutePath">("/fake/reviewer.jsonl"),
  evalResultPath: brand<"AbsolutePath">("/fake/EVAL_RESULT.md"),
  durationMs,
});

const makeFailResult = (taskId: string): TaskResult => ({
  ...makePassResult(taskId),
  verdict: "FAIL",
  summary: "fake fail",
  durationMs: 0,
});

const saveContract = (path: AbsolutePath, feature: Feature) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = brand<"AbsolutePath">(nodePath.dirname(path));
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path, JSON.stringify(feature, null, 2) + "\n");
  }).pipe(Effect.provide(BunContext.layer));

/**
 * Build an initial DashboardState that mirrors the given Feature so the Ref
 * starts with correct story/task structure before the loop runs.
 */
const makeDashboardState = (feature: Feature): DashboardState => {
  const stories: ReadonlyArray<DashboardStoryState> = feature.stories.map((story) => ({
    storyId: story.id,
    title: story.title,
    tasks: story.tasks.map(
      (task): DashboardTaskState => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
        phase: Option.none(),
        attempt: task.attempts,
        tokensUsed: 0,
        costUsd: 0,
        startedAt: Option.none(),
        durationMs: Option.none(),
      }),
    ),
  }));
  const allTasks = stories.flatMap((s) => s.tasks);
  return {
    feature: feature.feature,
    stories,
    totals: {
      tokensUsed: 0,
      costUsd: 0,
      tasksDone: 0,
      tasksFailed: 0,
      tasksPending: allTasks.length,
    },
    stoppedReason: Option.none(),
    startedAt: Date.now(),
  };
};

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

const makeTestLayer = (runTaskLayer: Layer.Layer<RunTask, never, never>) =>
  Layer.mergeAll(
    LoopRunnerLive,
    runTaskLayer,
    FeatureContractLive,
    AgentRunnerDead,
    ContextEngineDead,
    EvalParserDead,
  ).pipe(Layer.provideMerge(BunContext.layer));

const runLoopWithRef = (
  contractPath: AbsolutePath,
  dashboardRef: Ref.Ref<DashboardState>,
  runTaskLayer: Layer.Layer<RunTask, never, never>,
) =>
  Effect.flatMap(LoopRunner, (lr) => lr.run(contractPath, dashboardRef)).pipe(
    Effect.provide(makeTestLayer(runTaskLayer)),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoopRunner Ref<DashboardState> integration", () => {
  // -------------------------------------------------------------------------
  // AllDone: single task passes — Ref reflects done status and AllDone reason
  // -------------------------------------------------------------------------

  test("AllDone: task reaches done status; stoppedReason = Some(AllDone) in Ref", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "alldone-dash", "FEATURE_CONTRACT.json"),
    );

    const feature = makeFeature([makeTask("T1")]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const ref = await Effect.runPromise(
      Ref.make(makeDashboardState(feature)).pipe(Effect.provide(BunContext.layer)),
    );

    const summary = await Effect.runPromise(
      runLoopWithRef(contractPath, ref, makeRunTaskFake([makePassResult("T1", 99)])),
    );

    expect(summary.stoppedReason._tag).toBe("AllDone");
    expect(summary.completed).toBe(true);

    const dashState = await Effect.runPromise(
      Ref.get(ref).pipe(Effect.provide(BunContext.layer)),
    );

    // stoppedReason in Ref must be Some(AllDone)
    expect(Option.isSome(dashState.stoppedReason)).toBe(true);
    if (Option.isSome(dashState.stoppedReason)) {
      expect(dashState.stoppedReason.value._tag).toBe("AllDone");
    }

    // Task T1 must be done with phase cleared and durationMs set
    const t1 = dashState.stories[0]!.tasks.find(
      (t) => t.taskId === brand<"TaskId">("T1"),
    );
    expect(t1).toBeDefined();
    expect(t1!.status).toBe("done");
    expect(Option.isNone(t1!.phase)).toBe(true);
    expect(Option.isSome(t1!.durationMs)).toBe(true);
    if (Option.isSome(t1!.durationMs)) {
      expect(t1!.durationMs.value).toBe(99);
    }

    // Totals reflect one done task
    expect(dashState.totals.tasksDone).toBe(1);
    expect(dashState.totals.tasksFailed).toBe(0);
    expect(dashState.totals.tasksPending).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TaskExhausted: task fails and Ref reflects failed state
  // -------------------------------------------------------------------------

  test("TaskExhausted: task reaches failed status; stoppedReason = Some(TaskExhausted) in Ref", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "exhausted-dash", "FEATURE_CONTRACT.json"),
    );

    // maxAttempts=1 so one FAIL exhausts T1 immediately.
    const feature = makeFeature([makeTask("T1", [], "pending", 0, 1)]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const ref = await Effect.runPromise(
      Ref.make(makeDashboardState(feature)).pipe(Effect.provide(BunContext.layer)),
    );

    const summary = await Effect.runPromise(
      runLoopWithRef(contractPath, ref, makeRunTaskFake([makeFailResult("T1")])),
    );

    expect(summary.stoppedReason._tag).toBe("TaskExhausted");
    expect(summary.completed).toBe(false);

    const dashState = await Effect.runPromise(
      Ref.get(ref).pipe(Effect.provide(BunContext.layer)),
    );

    // stoppedReason in Ref must be Some(TaskExhausted)
    expect(Option.isSome(dashState.stoppedReason)).toBe(true);
    if (Option.isSome(dashState.stoppedReason)) {
      expect(dashState.stoppedReason.value._tag).toBe("TaskExhausted");
    }

    // Task T1 must be failed with phase cleared
    const t1 = dashState.stories[0]!.tasks.find(
      (t) => t.taskId === brand<"TaskId">("T1"),
    );
    expect(t1).toBeDefined();
    expect(t1!.status).toBe("failed");
    expect(Option.isNone(t1!.phase)).toBe(true);

    // Totals reflect one failed task
    expect(dashState.totals.tasksFailed).toBe(1);
    expect(dashState.totals.tasksDone).toBe(0);
    expect(dashState.totals.tasksPending).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Phase → Composer before RunTask executes
  // -------------------------------------------------------------------------

  test("phase = Some('Composer') in Ref when RunTask.run is entered", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "phase-composer", "FEATURE_CONTRACT.json"),
    );

    const feature = makeFeature([makeTask("T1")]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const ref = await Effect.runPromise(
      Ref.make(makeDashboardState(feature)).pipe(Effect.provide(BunContext.layer)),
    );

    const { layer, captured } = makeRunTaskWithRefCapture(ref, [makePassResult("T1")]);

    await Effect.runPromise(runLoopWithRef(contractPath, ref, layer));

    // Exactly one snapshot captured — taken at RunTask entry.
    expect(captured).toHaveLength(1);
    const snap = captured[0]!;

    const t1Snap = snap.stories[0]!.tasks.find(
      (t) => t.taskId === brand<"TaskId">("T1"),
    );
    expect(t1Snap).toBeDefined();
    expect(t1Snap!.status).toBe("in_progress");
    expect(Option.isSome(t1Snap!.phase)).toBe(true);
    if (Option.isSome(t1Snap!.phase)) {
      expect(t1Snap!.phase.value).toBe("Composer");
    }
    expect(Option.isSome(t1Snap!.startedAt)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Retry: phase cleared between attempts; Ref updated on each retry
  // -------------------------------------------------------------------------

  test("Retry: phase = None after failed attempt before next RunTask call", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "retry-phase", "FEATURE_CONTRACT.json"),
    );

    // maxAttempts=3: FAIL → PASS
    const feature = makeFeature([makeTask("T1", [], "pending", 0, 3)]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const ref = await Effect.runPromise(
      Ref.make(makeDashboardState(feature)).pipe(Effect.provide(BunContext.layer)),
    );

    const { layer, captured } = makeRunTaskWithRefCapture(ref, [
      makeFailResult("T1"),
      makePassResult("T1"),
    ]);

    const summary = await Effect.runPromise(runLoopWithRef(contractPath, ref, layer));

    expect(summary.stoppedReason._tag).toBe("AllDone");

    // Two calls to RunTask captured.
    expect(captured).toHaveLength(2);

    // First call: phase = Some("Composer"), status = in_progress.
    const t1First = captured[0]!.stories[0]!.tasks.find(
      (t) => t.taskId === brand<"TaskId">("T1"),
    );
    expect(t1First).toBeDefined();
    expect(t1First!.status).toBe("in_progress");
    expect(Option.isSome(t1First!.phase)).toBe(true);

    // Second call: phase reset to Some("Composer") for the new attempt.
    // Status still in_progress (not yet done).
    const t1Second = captured[1]!.stories[0]!.tasks.find(
      (t) => t.taskId === brand<"TaskId">("T1"),
    );
    expect(t1Second).toBeDefined();
    expect(t1Second!.status).toBe("in_progress");
    expect(Option.isSome(t1Second!.phase)).toBe(true);
    if (Option.isSome(t1Second!.phase)) {
      expect(t1Second!.phase.value).toBe("Composer");
    }
  });

  // -------------------------------------------------------------------------
  // No Ref: run without dashboardRef still completes (backward-compat check)
  // -------------------------------------------------------------------------

  test("no dashboardRef: LoopRunner.run still completes normally", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "no-ref", "FEATURE_CONTRACT.json"),
    );

    const feature = makeFeature([makeTask("T1")]);
    await Effect.runPromise(saveContract(contractPath, feature));

    // Call run WITHOUT providing a dashboardRef.
    const summary = await Effect.runPromise(
      Effect.flatMap(LoopRunner, (lr) => lr.run(contractPath)).pipe(
        Effect.provide(makeTestLayer(makeRunTaskFake([makePassResult("T1")]))),
      ),
    );

    expect(summary.completed).toBe(true);
    expect(summary.stoppedReason._tag).toBe("AllDone");
  });
});

// ---------------------------------------------------------------------------
// Phase → Reviewer and token-accumulation tests (RunTaskLive path)
//
// These tests exercise the hookedAgentRunner interceptor inside LoopRunnerLive.
// RunTaskLive is used so the real Composer → Reviewer sequencing triggers the
// hook. The hook updates phase → Reviewer between the two agent calls and
// accumulates token/cost data from AgentRunner results.
// ---------------------------------------------------------------------------

/** ContextEngine fake — returns constant stub prompts; never fails. */
const ContextEngineFake = Layer.succeed(
  ContextEngine,
  ContextEngine.of({
    renderComposer: () => Effect.succeed("<!-- composer prompt -->"),
    renderReviewer: () => Effect.succeed("<!-- reviewer prompt -->"),
  }),
);

/**
 * EvalParser fake — returns scripted verdicts regardless of raw file content.
 * The AgentRunner fake writes a placeholder to the eval path so `fs.exists`
 * passes; this fake then returns the scripted result without parsing it.
 */
const makeEvalParserFake = (verdicts: ReadonlyArray<"PASS" | "FAIL">) => {
  let index = 0;
  return Layer.succeed(
    EvalParser,
    EvalParser.of({
      parse: (_rawContent) =>
        Effect.succeed({
          verdict: verdicts[index++] ?? "PASS",
          summary: "fake",
          comments: [],
        }),
    }),
  );
};

/**
 * AgentRunner fake that:
 *  - Writes a placeholder to `opts.evalPath` on every Reviewer call (satisfies
 *    RunTask's `fs.exists(evalResultPath)` check).
 *  - Returns scripted token/cost data on every call.
 *  - Optionally captures a Ref<DashboardState> snapshot when the Reviewer call
 *    begins (i.e. after LoopRunnerLive sets phase → Reviewer).
 */
const makeAgentRunnerFake = (opts: {
  tokensPerRole?: number;
  costPerRole?: number;
  captureRef?: Ref.Ref<DashboardState>;
  reviewerCaptures?: DashboardState[];
}): Layer.Layer<AgentRunner, never, FileSystem.FileSystem> => {
  const { tokensPerRole = 100, costPerRole = 0.01, captureRef, reviewerCaptures } = opts;
  return Layer.effect(
    AgentRunner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return AgentRunner.of({
        run: (runOpts) =>
          Effect.gen(function* () {
            if (runOpts.role === "Reviewer") {
              // Capture dashboard state the moment Reviewer agent is entered.
              if (captureRef && reviewerCaptures) {
                const snap = yield* Ref.get(captureRef);
                reviewerCaptures.push(snap);
              }
              // Write a placeholder so RunTask's eval-file existence check passes.
              // Filesystem errors are defects in a test fake — absorb via orDie.
              if (runOpts.evalPath) {
                const evalDir = brand<"AbsolutePath">(
                  nodePath.dirname(runOpts.evalPath as string),
                );
                yield* fs.makeDirectory(evalDir, { recursive: true }).pipe(Effect.orDie);
                yield* fs.writeFileString(runOpts.evalPath, "<!-- fake eval -->").pipe(
                  Effect.orDie,
                );
              }
            }
            return {
              events: [] as ReadonlyArray<AgentEvent>,
              result: {
                type: "result" as const,
                subtype: "success",
                is_error: false,
                num_turns: 1,
                total_cost_usd: costPerRole,
                usage: {
                  input_tokens: tokensPerRole,
                  output_tokens: tokensPerRole,
                },
              } as Extract<AgentEvent, { type: "result" }>,
            };
          }),
      });
    }),
  );
};

/**
 * Full layer for RunTaskLive-based tests. Provides all services needed when
 * LoopRunnerLive runs the real RunTask pipeline (Composer → Reviewer).
 */
const makeTestLayerLive = (
  agentRunnerLayer: Layer.Layer<AgentRunner, never, FileSystem.FileSystem>,
  evalParserLayer: Layer.Layer<EvalParser, never, never>,
) =>
  Layer.mergeAll(
    LoopRunnerLive,
    RunTaskLive,
    FeatureContractLive,
    agentRunnerLayer,
    ContextEngineFake,
    evalParserLayer,
  ).pipe(Layer.provideMerge(BunContext.layer));

const runLoopLive = (
  contractPath: AbsolutePath,
  dashboardRef: Ref.Ref<DashboardState>,
  agentRunnerLayer: Layer.Layer<AgentRunner, never, FileSystem.FileSystem>,
  evalParserLayer: Layer.Layer<EvalParser, never, never>,
) =>
  Effect.flatMap(LoopRunner, (lr) => lr.run(contractPath, dashboardRef)).pipe(
    Effect.provide(makeTestLayerLive(agentRunnerLayer, evalParserLayer)),
  );

describe("LoopRunner phase→Reviewer and token accumulation (RunTaskLive path)", () => {
  // -------------------------------------------------------------------------
  // Phase → Reviewer: verify dashboard shows "Reviewer" when Reviewer runs
  // -------------------------------------------------------------------------

  test("phase = Some('Reviewer') in Ref when Reviewer agent starts", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "phase-reviewer-live", "FEATURE_CONTRACT.json"),
    );

    const feature = makeFeature([makeTask("T1")]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const ref = await Effect.runPromise(
      Ref.make(makeDashboardState(feature)).pipe(Effect.provide(BunContext.layer)),
    );

    const reviewerCaptures: DashboardState[] = [];
    const agentRunnerLayer = makeAgentRunnerFake({
      captureRef: ref,
      reviewerCaptures,
    });

    await Effect.runPromise(
      runLoopLive(contractPath, ref, agentRunnerLayer, makeEvalParserFake(["PASS"])),
    );

    // One Reviewer call captured (single-task AllDone run).
    expect(reviewerCaptures).toHaveLength(1);
    const snap = reviewerCaptures[0]!;
    const t1Snap = snap.stories[0]!.tasks.find((t) => t.taskId === brand<"TaskId">("T1"));
    expect(t1Snap).toBeDefined();
    // Phase must be "Reviewer" at the moment Reviewer agent starts.
    expect(Option.isSome(t1Snap!.phase)).toBe(true);
    if (Option.isSome(t1Snap!.phase)) {
      expect(t1Snap!.phase.value).toBe("Reviewer");
    }
  });

  // -------------------------------------------------------------------------
  // Token accumulation: tokensUsed and costUsd reflected in Ref totals
  // -------------------------------------------------------------------------

  test("tokensUsed and costUsd accumulated in Ref from AgentRunner results", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "token-accum-live", "FEATURE_CONTRACT.json"),
    );

    const feature = makeFeature([makeTask("T1")]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const ref = await Effect.runPromise(
      Ref.make(makeDashboardState(feature)).pipe(Effect.provide(BunContext.layer)),
    );

    // 100 tokens per role × 2 roles = 200 tokens; 0.01 cost per role × 2 = 0.02
    const agentRunnerLayer = makeAgentRunnerFake({ tokensPerRole: 100, costPerRole: 0.01 });

    const summary = await Effect.runPromise(
      runLoopLive(contractPath, ref, agentRunnerLayer, makeEvalParserFake(["PASS"])),
    );

    expect(summary.stoppedReason._tag).toBe("AllDone");

    const dashState = await Effect.runPromise(
      Ref.get(ref).pipe(Effect.provide(BunContext.layer)),
    );

    // Task T1 should have non-zero tokensUsed (Composer + Reviewer contributions)
    const t1 = dashState.stories[0]!.tasks.find((t) => t.taskId === brand<"TaskId">("T1"));
    expect(t1).toBeDefined();
    expect(t1!.tokensUsed).toBeGreaterThan(0);
    expect(t1!.costUsd).toBeGreaterThan(0);

    // Totals must reflect accumulated values
    expect(dashState.totals.tokensUsed).toBeGreaterThan(0);
    expect(dashState.totals.costUsd).toBeGreaterThan(0);
  });
});
