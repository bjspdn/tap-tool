import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as nodePath from "node:path";
import * as os from "node:os";
import { AgentRunner } from "../../AgentRunner";
import { ContextEngine } from "../../ContextEngine";
import { EvalParser } from "../../EvalParser";
import { FeatureContractLive } from "../../FeatureContract";
import { RunTask } from "../../RunTask";
import { LoopRunner, LoopRunnerLive } from "../index";
import { brand } from "../../brand";

// ---------------------------------------------------------------------------
// Shared tmp root — os.tmpdir() keeps LoopRunnerLive's commitTask from walking
// up to the project .git/ tree.
// ---------------------------------------------------------------------------

const tmpRoot = brand<"AbsolutePath">(
  nodePath.join(os.tmpdir(), `looprunner-live-${crypto.randomUUID()}`),
);

afterAll(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(tmpRoot, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Result event fixture — used by agentRunner fakes
// ---------------------------------------------------------------------------

const makeResultEvent = (): Extract<AgentEvent, { type: "result" }> => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  session_id: "sess-summarizer-test",
});

// ---------------------------------------------------------------------------
// ContextEngine stubs
// ---------------------------------------------------------------------------

/**
 * ContextEngine that provides a working renderSummarizer. Composer/Reviewer
 * renderers die — they must not be called because RunTaskFake intercepts RunTask.
 */
const ContextEngineWithSummarizer = Layer.succeed(
  ContextEngine,
  ContextEngine.of({
    renderComposer: () =>
      Effect.die("renderComposer must not be called when RunTaskFake is active"),
    renderReviewer: () =>
      Effect.die("renderReviewer must not be called when RunTaskFake is active"),
    renderSummarizer: (_input) =>
      Effect.succeed("# Summarizer prompt (test stub)\n"),
  }),
);

// ---------------------------------------------------------------------------
// EvalParser dead fake — EvalParser is never accessed when RunTaskFake is used
// ---------------------------------------------------------------------------

const EvalParserDead = Layer.succeed(
  EvalParser,
  EvalParser.of({
    parse: () => Effect.die("EvalParser must not be called in LoopRunnerLive tests"),
  }),
);

// ---------------------------------------------------------------------------
// RunTaskFake — same pattern as LoopRunner.retry.test.ts
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
 * RunTask dead fake — for scenarios where the loop never advances to a task
 * (e.g. NoReadyTasks on the first iteration).
 */
const RunTaskDead = Layer.succeed(
  RunTask,
  RunTask.of({
    run: () => Effect.die("RunTask must not be called in this scenario"),
  }),
);

// ---------------------------------------------------------------------------
// AgentRunner recorder — records all role calls; optionally writes SUMMARY.md
// or fails on Summarizer dispatch.
// ---------------------------------------------------------------------------

type RecorderOpts = {
  readonly writeSummary: boolean;
  readonly failSummarizer?: boolean;
};

const makeAgentRunnerRecorder = (
  opts: RecorderOpts,
): { layer: Layer.Layer<AgentRunner, never, never>; calledRoles: string[] } => {
  const calledRoles: string[] = [];

  const layer = Layer.succeed(
    AgentRunner,
    AgentRunner.of({
      run: (runOpts) => {
        const role = runOpts.role as string;
        calledRoles.push(role);

        return Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;

          if (role === "Summarizer") {
            if (opts.failSummarizer) {
              // Simulate a Summarizer spawn failure — absorbed by dispatchTerminalSummary.
              return yield* Effect.fail({
                _tag: "AgentSpawnFailed" as const,
                role: "Composer" as AgentRole,
                exitCode: 1,
                stderr: "test: simulated summarizer failure",
              });
            }

            if (opts.writeSummary) {
              const summaryPath = nodePath.join(runOpts.cwd as string, "SUMMARY.md");
              yield* fs.writeFileString(summaryPath, "# Test Summary\n").pipe(Effect.orDie);
            }

            const resultEvent = makeResultEvent();
            return { events: [resultEvent], result: resultEvent };
          }

          // Any non-Summarizer role reaching the AgentRunner is a test bug —
          // RunTaskFake should have intercepted it.
          return yield* Effect.die(`AgentRunner called with unexpected role "${role}"`);
        });
      },
    }),
  );

  return { layer, calledRoles };
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
  feature: "live-dispatch-test",
  goal: "test terminal dispatch matrix",
  description: "LoopRunnerLive terminal dispatch matrix feature",
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

const makePassResult = (taskId: string): TaskResult => ({
  taskId: brand<"TaskId">(taskId),
  attempt: 1,
  verdict: "PASS",
  summary: "fake pass",
  comments: [],
  composerLogPath: brand<"AbsolutePath">("/fake/composer.jsonl"),
  reviewerLogPath: brand<"AbsolutePath">("/fake/reviewer.jsonl"),
  evalResultPath: brand<"AbsolutePath">("/fake/EVAL_RESULT.md"),
  durationMs: 0,
});

const makeFailResult = (taskId: string): TaskResult => ({
  ...makePassResult(taskId),
  verdict: "FAIL",
  summary: "fake fail",
});

const saveContract = (path: AbsolutePath, feature: Feature) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = brand<"AbsolutePath">(nodePath.dirname(path));
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path, JSON.stringify(feature, null, 2) + "\n");
  }).pipe(Effect.provide(NodeContext.layer));

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

const makeTestLayer = (
  runTaskLayer: Layer.Layer<RunTask, never, never>,
  agentRunnerLayer: Layer.Layer<AgentRunner, never, never>,
  contextEngineLayer: Layer.Layer<ContextEngine, never, never>,
) =>
  Layer.mergeAll(
    LoopRunnerLive,
    runTaskLayer,
    FeatureContractLive,
    agentRunnerLayer,
    contextEngineLayer,
    EvalParserDead,
  ).pipe(Layer.provideMerge(NodeContext.layer));

const runLoop = (
  contractPath: AbsolutePath,
  runTaskLayer: Layer.Layer<RunTask, never, never>,
  agentRunnerLayer: Layer.Layer<AgentRunner, never, never>,
  contextEngineLayer: Layer.Layer<ContextEngine, never, never>,
) =>
  Effect.flatMap(LoopRunner, (lr) => lr.run(contractPath)).pipe(
    Effect.provide(makeTestLayer(runTaskLayer, agentRunnerLayer, contextEngineLayer)),
  );

// ---------------------------------------------------------------------------
// Terminal dispatch matrix tests
// ---------------------------------------------------------------------------

describe("LoopRunnerLive terminal dispatch matrix", () => {
  // -------------------------------------------------------------------------
  // AllDone → Summarizer dispatched, SUMMARY.md written
  // -------------------------------------------------------------------------

  test(
    "AllDone: dispatchTerminalSummary fires Summarizer; SUMMARY.md written to featureRoot",
    async () => {
      const contractPath = brand<"AbsolutePath">(
        nodePath.join(tmpRoot as string, "alldone", "FEATURE_CONTRACT.json"),
      );
      const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
      const expectedSummaryPath = brand<"AbsolutePath">(
        nodePath.join(featureRoot as string, "SUMMARY.md"),
      );

      const feature = makeFeature([makeTask("T1")]);
      await Effect.runPromise(saveContract(contractPath, feature));

      const recorder = makeAgentRunnerRecorder({ writeSummary: true });

      const summary = await Effect.runPromise(
        runLoop(
          contractPath,
          makeRunTaskFake([makePassResult("T1")]),
          recorder.layer,
          ContextEngineWithSummarizer,
        ),
      );

      // Loop ended with AllDone
      expect(summary.stoppedReason._tag).toBe("AllDone");
      expect(summary.completed).toBe(true);

      // Summarizer was dispatched
      expect(recorder.calledRoles).toContain("Summarizer");

      // SUMMARY.md written to featureRoot
      const summaryExists = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(expectedSummaryPath as string);
        }).pipe(Effect.provide(NodeContext.layer)),
      );
      expect(summaryExists).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // TaskExhausted → Summarizer dispatched, SUMMARY.md written
  // -------------------------------------------------------------------------

  test(
    "TaskExhausted (Exhausted): dispatchTerminalSummary fires Summarizer; SUMMARY.md written",
    async () => {
      const contractPath = brand<"AbsolutePath">(
        nodePath.join(tmpRoot as string, "exhausted", "FEATURE_CONTRACT.json"),
      );
      const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
      const expectedSummaryPath = brand<"AbsolutePath">(
        nodePath.join(featureRoot as string, "SUMMARY.md"),
      );

      // maxAttempts=1 so a single FAIL exhausts the task immediately.
      const feature = makeFeature([makeTask("T1", [], "pending", 0, 1)]);
      await Effect.runPromise(saveContract(contractPath, feature));

      const recorder = makeAgentRunnerRecorder({ writeSummary: true });

      const summary = await Effect.runPromise(
        runLoop(
          contractPath,
          makeRunTaskFake([makeFailResult("T1")]),
          recorder.layer,
          ContextEngineWithSummarizer,
        ),
      );

      // Loop ended with TaskExhausted
      expect(summary.stoppedReason._tag).toBe("TaskExhausted");
      expect(summary.completed).toBe(false);
      expect(summary.tasksFailed).toContain(brand<"TaskId">("T1"));

      // Summarizer was dispatched
      expect(recorder.calledRoles).toContain("Summarizer");

      // SUMMARY.md written to featureRoot
      const summaryExists = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(expectedSummaryPath as string);
        }).pipe(Effect.provide(NodeContext.layer)),
      );
      expect(summaryExists).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // RateLimited → Summarizer skipped
  // -------------------------------------------------------------------------

  test("RateLimited: dispatchTerminalSummary skips; Summarizer not dispatched", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "ratelimited", "FEATURE_CONTRACT.json"),
    );

    const feature = makeFeature([makeTask("T1")]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const recorder = makeAgentRunnerRecorder({ writeSummary: false });

    const rateLimitedError: RunTaskError = {
      _tag: "RateLimited",
      role: "Composer",
      resetsAt: 1777050000,
    };

    const summary = await Effect.runPromise(
      runLoop(
        contractPath,
        makeRunTaskFake([rateLimitedError]),
        recorder.layer,
        ContextEngineWithSummarizer,
      ),
    );

    // Loop ended with RateLimited
    expect(summary.stoppedReason._tag).toBe("RateLimited");

    // Summarizer must NOT have been dispatched
    expect(recorder.calledRoles).not.toContain("Summarizer");
  });

  // -------------------------------------------------------------------------
  // NoReadyTasks → Summarizer skipped
  // -------------------------------------------------------------------------

  test("NoReadyTasks: dispatchTerminalSummary skips; Summarizer not dispatched", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "noready", "FEATURE_CONTRACT.json"),
    );

    // T1 depends on T2 which is "failed". nextReady returns None immediately,
    // decideTerminal returns NoReadyTasks because T1 is pending but not schedulable.
    const feature = makeFeature([
      makeTask("T2", [], "failed"),
      makeTask("T1", ["T2"]),
    ]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const recorder = makeAgentRunnerRecorder({ writeSummary: false });

    const summary = await Effect.runPromise(
      runLoop(
        contractPath,
        RunTaskDead,
        recorder.layer,
        ContextEngineWithSummarizer,
      ),
    );

    // Loop ended with NoReadyTasks
    expect(summary.stoppedReason._tag).toBe("NoReadyTasks");

    // Summarizer must NOT have been dispatched
    expect(recorder.calledRoles).not.toContain("Summarizer");
  });

  // -------------------------------------------------------------------------
  // Summarizer failure absorbed — terminal status unchanged
  // -------------------------------------------------------------------------

  test(
    "Summarizer failure absorbed: stoppedReason stays AllDone; no exception propagated",
    async () => {
      const contractPath = brand<"AbsolutePath">(
        nodePath.join(tmpRoot as string, "summfail", "FEATURE_CONTRACT.json"),
      );
      const featureRoot = brand<"AbsolutePath">(nodePath.dirname(contractPath));
      const summaryPath = brand<"AbsolutePath">(
        nodePath.join(featureRoot as string, "SUMMARY.md"),
      );

      const feature = makeFeature([makeTask("T1")]);
      await Effect.runPromise(saveContract(contractPath, feature));

      // Summarizer fails (spawnFailed) — dispatchTerminalSummary must absorb it.
      const recorder = makeAgentRunnerRecorder({ writeSummary: false, failSummarizer: true });

      // Must not throw — Summarizer failure should be swallowed.
      const summary = await Effect.runPromise(
        runLoop(
          contractPath,
          makeRunTaskFake([makePassResult("T1")]),
          recorder.layer,
          ContextEngineWithSummarizer,
        ),
      );

      // Terminal status unchanged despite Summarizer failure
      expect(summary.stoppedReason._tag).toBe("AllDone");
      expect(summary.completed).toBe(true);

      // Summarizer was attempted (it failed, but it was called)
      expect(recorder.calledRoles).toContain("Summarizer");

      // SUMMARY.md was NOT written (the agent failed before writing it)
      const summaryExists = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(summaryPath as string);
        }).pipe(Effect.provide(NodeContext.layer)),
      );
      expect(summaryExists).toBe(false);
    },
  );
});
