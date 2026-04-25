import { describe, test, expect, afterAll } from "bun:test";
import * as path from "node:path";
import { Effect, Exit, Layer, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { AgentRunnerEcho, type AgentRunnerEchoScript } from "../AgentRunner";
import { ContextEngineLive } from "../ContextEngine";
import { EvalParserLive } from "../EvalParser";
import { runTask, RunTask, RunTaskLive, type RunTaskPaths } from "../RunTask";
import { brand } from "../brand";

// ---------------------------------------------------------------------------
// Tmp root
// ---------------------------------------------------------------------------

const TMP_ROOT = brand<"AbsolutePath">(
  path.resolve(process.cwd(), `.tap/tmp/runtask-test-${crypto.randomUUID()}`),
);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: brand<"TaskId">("S6.T2"),
  title: "Integration test for runTask",
  description: "Integration test for runTask orchestration service.",
  files: [brand<"AbsolutePath">("src/services/__tests__/RunTask.test.ts")],
  depends_on: [],
  status: "in_progress",
  attempts: 1,
  maxAttempts: 3,
  ...overrides,
});

const makeFeature = (overrides: Partial<Feature> = {}): Feature => ({
  feature: "composer-reviewer",
  goal: "Deliver the Composer + Reviewer sub-agent vertical slice.",
  description: "Delivers the Composer + Reviewer sub-agent vertical slice.",
  constraints: [
    "Services are Effect Context.Tag + Layer pairs.",
    "No `any`, no `as unknown as`.",
  ],
  stories: [],
  ...overrides,
});

const makePaths = (featureRoot: AbsolutePath, attempt = 1): RunTaskPaths => ({
  featureRoot,
  specsPath: brand<"AbsolutePath">(".tap/features/composer-reviewer/SPECS.md"),
  contractPath: brand<"AbsolutePath">(".tap/features/composer-reviewer/FEATURE_CONTRACT.json"),
  attempt,
  priorEvalPath: Option.none(),
  gitStatus: "",
});

// ---------------------------------------------------------------------------
// Shared event factories (mirroring AgentRunner.test.ts)
// ---------------------------------------------------------------------------

const makeResultEvent = (sessionId: string): AgentEvent => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  session_id: sessionId,
});

const makeAssistantEvent = (sessionId: string): AgentEvent => ({
  type: "assistant",
  session_id: sessionId,
  message: {
    id: "msg-1",
    role: "assistant",
    content: [{ type: "text", text: "Implementing the task." }],
  },
});

// ---------------------------------------------------------------------------
// Canned eval blocks
// ---------------------------------------------------------------------------

const CANNED_PASS =
  "<eval:verdict>PASS</eval:verdict>\n" +
  "<eval:summary>canned pass</eval:summary>\n" +
  "<eval:comments>\n" +
  "</eval:comments>\n";

const CANNED_FAIL =
  "<eval:verdict>FAIL</eval:verdict>\n" +
  "<eval:summary>canned fail</eval:summary>\n" +
  "<eval:comments>\n" +
  '- file: "src/a.ts"\n' +
  '  severity: "blocker"\n' +
  '  comment: "p1"\n' +
  '- file: "src/b.ts"\n' +
  '  severity: "suggestion"\n' +
  '  comment: "p2"\n' +
  "</eval:comments>\n";

// Borrowed from EvalParser.test.ts MALFORMED_YAML fixture shape
const MALFORMED_YAML =
  "<eval:verdict>FAIL</eval:verdict>\n" +
  "<eval:summary>malformed body below</eval:summary>\n" +
  "<eval:comments>\n" +
  '- file: "unterminated string\n' +
  '  severity: "blocker"\n' +
  '  comment: "x"\n' +
  "</eval:comments>\n";

// ---------------------------------------------------------------------------
// Layer composer
// ---------------------------------------------------------------------------

const makeTestLayer = (script: AgentRunnerEchoScript) =>
  Layer.mergeAll(
    ContextEngineLive,
    EvalParserLive,
    AgentRunnerEcho(script),
  ).pipe(Layer.provideMerge(BunContext.layer));

// ---------------------------------------------------------------------------
// afterAll cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  await Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(TMP_ROOT, { recursive: true, force: true }),
    ).pipe(Effect.provide(BunContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RunTask", () => {
  // -------------------------------------------------------------------------
  // Test 1 — PASS happy path
  // -------------------------------------------------------------------------

  test("PASS happy path — TaskResult with verdict=PASS, empty issues, all paths on disk", async () => {
    const featureRoot = brand<"AbsolutePath">(`${TMP_ROOT}/test-pass`);
    const task = makeTask();
    const feature = makeFeature();
    const paths = makePaths(featureRoot, 1);

    const script: AgentRunnerEchoScript = {
      Composer: {
        events: [makeAssistantEvent("sess-c"), makeResultEvent("sess-c")],
        exit: { _tag: "ok" },
      },
      Reviewer: {
        events: [makeAssistantEvent("sess-r"), makeResultEvent("sess-r")],
        exit: { _tag: "ok" },
        evalFileContent: CANNED_PASS,
      },
    };

    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(featureRoot, { recursive: true });
      return yield* runTask(task, feature, paths);
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(script))),
    );

    expect(result.verdict).toBe("PASS");
    expect(result.comments).toHaveLength(0);
    expect(result.taskId).toBe(task.id);
    expect(result.attempt).toBe(paths.attempt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify all three paths exist on disk
    const [composerExists, reviewerExists, evalExists] = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const composerExists = yield* fs.exists(result.composerLogPath);
        const reviewerExists = yield* fs.exists(result.reviewerLogPath);
        const evalExists = yield* fs.exists(result.evalResultPath);
        return [composerExists, reviewerExists, evalExists] as const;
      }).pipe(Effect.provide(BunContext.layer)),
    );

    expect(composerExists).toBe(true);
    expect(reviewerExists).toBe(true);
    expect(evalExists).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2 — FAIL path (two issues mapped)
  // -------------------------------------------------------------------------

  test("FAIL path — TaskResult with verdict=FAIL and two EvalComments correctly mapped", async () => {
    const featureRoot = brand<"AbsolutePath">(`${TMP_ROOT}/test-fail`);
    const task = makeTask();
    const feature = makeFeature();
    const paths = makePaths(featureRoot, 1);

    const script: AgentRunnerEchoScript = {
      Composer: {
        events: [makeAssistantEvent("sess-c"), makeResultEvent("sess-c")],
        exit: { _tag: "ok" },
      },
      Reviewer: {
        events: [makeAssistantEvent("sess-r"), makeResultEvent("sess-r")],
        exit: { _tag: "ok" },
        evalFileContent: CANNED_FAIL,
      },
    };

    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(featureRoot, { recursive: true });
      return yield* runTask(task, feature, paths);
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(script))),
    );

    expect(result.verdict).toBe("FAIL");
    expect(result.comments).toHaveLength(2);

    const comment0 = result.comments[0];
    if (!comment0) throw new Error("expected comment 0");
    expect(comment0.file).toBe("src/a.ts");
    expect(comment0.severity).toBe("blocker");
    expect(comment0.comment).toBe("p1");

    const comment1 = result.comments[1];
    if (!comment1) throw new Error("expected comment 1");
    expect(comment1.file).toBe("src/b.ts");
    expect(comment1.severity).toBe("suggestion");
    expect(comment1.comment).toBe("p2");
  });

  // -------------------------------------------------------------------------
  // Test 3 — Composer max-turns (Reviewer never invoked)
  // -------------------------------------------------------------------------

  test("Composer max-turns — AgentMaxTurnsExceeded with role=Composer, Reviewer log absent", async () => {
    const featureRoot = brand<"AbsolutePath">(`${TMP_ROOT}/test-max-turns`);
    const task = makeTask();
    const feature = makeFeature();
    const paths = makePaths(featureRoot, 1);

    const script: AgentRunnerEchoScript = {
      Composer: {
        events: [],
        exit: { _tag: "maxTurns" },
      },
      Reviewer: {
        // valid ok script — should never be consumed
        events: [makeAssistantEvent("sess-r"), makeResultEvent("sess-r")],
        exit: { _tag: "ok" },
        evalFileContent: CANNED_PASS,
      },
    };

    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(featureRoot, { recursive: true });
      return yield* runTask(task, feature, paths);
    });

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(makeTestLayer(script))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("AgentMaxTurnsExceeded");
      if (err._tag === "AgentMaxTurnsExceeded") {
        expect(err.role).toBe("Composer");
      }
    } else {
      throw new Error(`Unexpected exit: ${JSON.stringify(exit)}`);
    }

    // Reviewer log must NOT exist — pipeline short-circuited before Reviewer
    const reviewerLogPath = brand<"AbsolutePath">(
      `${featureRoot}/logs/${task.id}/iter-001-reviewer.jsonl`,
    );
    const reviewerExists = await Effect.runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.exists(reviewerLogPath),
      ).pipe(Effect.provide(BunContext.layer)),
    );
    expect(reviewerExists).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4 — Reviewer eval missing
  // -------------------------------------------------------------------------

  test("Reviewer eval missing — EvalResultMissing with expected path", async () => {
    const featureRoot = brand<"AbsolutePath">(`${TMP_ROOT}/test-eval-missing`);
    const task = makeTask();
    const feature = makeFeature();
    const paths = makePaths(featureRoot, 1);

    // Reviewer script has no evalFileContent → Echo never writes the eval file
    const script: AgentRunnerEchoScript = {
      Composer: {
        events: [makeAssistantEvent("sess-c"), makeResultEvent("sess-c")],
        exit: { _tag: "ok" },
      },
      Reviewer: {
        events: [makeAssistantEvent("sess-r"), makeResultEvent("sess-r")],
        exit: { _tag: "ok" },
        // deliberately omitted: evalFileContent
      },
    };

    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(featureRoot, { recursive: true });
      return yield* runTask(task, feature, paths);
    });

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(makeTestLayer(script))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("EvalResultMissing");
      if (err._tag === "EvalResultMissing") {
        const expectedEvalPath = brand<"AbsolutePath">(
          `${featureRoot}/eval/EVAL_RESULT.md`,
        );
        expect(err.expectedPath).toBe(expectedEvalPath);
      }
    } else {
      throw new Error(`Unexpected exit: ${JSON.stringify(exit)}`);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5 — Reviewer eval parse fail
  // -------------------------------------------------------------------------

  test("Reviewer eval parse fail — EvalParseFailed with rawContent verbatim", async () => {
    const featureRoot = brand<"AbsolutePath">(`${TMP_ROOT}/test-eval-parse-fail`);
    const task = makeTask();
    const feature = makeFeature();
    const paths = makePaths(featureRoot, 1);

    const script: AgentRunnerEchoScript = {
      Composer: {
        events: [makeAssistantEvent("sess-c"), makeResultEvent("sess-c")],
        exit: { _tag: "ok" },
      },
      Reviewer: {
        events: [makeAssistantEvent("sess-r"), makeResultEvent("sess-r")],
        exit: { _tag: "ok" },
        evalFileContent: MALFORMED_YAML,
      },
    };

    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(featureRoot, { recursive: true });
      return yield* runTask(task, feature, paths);
    });

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(makeTestLayer(script))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("EvalParseFailed");
      if (err._tag === "EvalParseFailed") {
        expect(err.rawContent).toBe(MALFORMED_YAML);
      }
    } else {
      throw new Error(`Unexpected exit: ${JSON.stringify(exit)}`);
    }
  });

  // -------------------------------------------------------------------------
  // Test 6 — RunTask Tag wiring
  // -------------------------------------------------------------------------

  test("RunTask Tag — Tag-based run delegates to runTask, returns PASS TaskResult", async () => {
    const featureRoot = brand<"AbsolutePath">(`${TMP_ROOT}/test-tag-wiring`);
    const task = makeTask();
    const feature = makeFeature();
    const paths = makePaths(featureRoot, 1);

    const script: AgentRunnerEchoScript = {
      Composer: {
        events: [makeAssistantEvent("sess-c"), makeResultEvent("sess-c")],
        exit: { _tag: "ok" },
      },
      Reviewer: {
        events: [makeAssistantEvent("sess-r"), makeResultEvent("sess-r")],
        exit: { _tag: "ok" },
        evalFileContent: CANNED_PASS,
      },
    };

    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(featureRoot, { recursive: true });
      const rt = yield* RunTask;
      return yield* rt.run(task, feature, paths);
    });

    const testLayer = makeTestLayer(script).pipe(Layer.provideMerge(RunTaskLive));

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(testLayer)),
    );

    expect(result.verdict).toBe("PASS");
    expect(result.taskId).toBe(task.id);
    expect(result.attempt).toBe(paths.attempt);
  });
});
