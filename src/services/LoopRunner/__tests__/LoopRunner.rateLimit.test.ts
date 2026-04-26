import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as nodePath from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { AgentRunner } from "../../AgentRunner";
import { ContextEngine } from "../../ContextEngine";
import { EvalParser } from "../../EvalParser";
import { FeatureContractLive } from "../../FeatureContract";
import { RunTask } from "../../RunTask";
import { LoopRunner, LoopRunnerLive } from "../index";
import { brand } from "../../brand";

// ---------------------------------------------------------------------------
// Dead fakes — same pattern as LoopRunner.retry.test.ts
// ---------------------------------------------------------------------------

const AgentRunnerDead = Layer.succeed(
  AgentRunner,
  AgentRunner.of({
    run: () => Effect.die("AgentRunner must not be called in LoopRunner rate-limit tests"),
  }),
);

const ContextEngineDead = Layer.succeed(
  ContextEngine,
  ContextEngine.of({
    renderComposer: () => Effect.die("ContextEngine must not be called in LoopRunner rate-limit tests"),
    renderReviewer: () => Effect.die("ContextEngine must not be called in LoopRunner rate-limit tests"),
  }),
);

const EvalParserDead = Layer.succeed(
  EvalParser,
  EvalParser.of({
    parse: () => Effect.die("EvalParser must not be called in LoopRunner rate-limit tests"),
  }),
);

// ---------------------------------------------------------------------------
// RunTaskFake that returns a RateLimited error
// ---------------------------------------------------------------------------

const makeRateLimitedFake = (
  role: AgentRole,
  resetsAt: number,
): Layer.Layer<RunTask, never, never> =>
  Layer.succeed(
    RunTask,
    RunTask.of({
      run: () =>
        Effect.fail({
          _tag: "RateLimited" as const,
          role,
          resetsAt,
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const makeTask = (
  id: string,
  status: TaskStatus = "pending",
  attempts = 0,
  maxAttempts = 3,
): Task => ({
  id: brand<"TaskId">(id),
  title: `Task ${id}`,
  description: `Description for task ${id}`,
  files: [],
  depends_on: [],
  status,
  attempts,
  maxAttempts,
});

const makeFeature = (tasks: Task[], featureName = "test-ratelimit"): Feature => ({
  feature: featureName,
  goal: "test rate-limit halting",
  description: "test rate-limit feature description",
  constraints: [],
  stories: [
    {
      id: brand<"StoryId">("S1"),
      title: "Story 1",
      description: "story one description",
      tasks,
    },
  ],
});

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
  ).pipe(Layer.provideMerge(NodeContext.layer));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const saveContract = (path: AbsolutePath, feature: Feature) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = brand<"AbsolutePath">(nodePath.dirname(path));
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path, JSON.stringify(feature, null, 2) + "\n");
  }).pipe(Effect.provide(NodeContext.layer));

const readContract = (path: AbsolutePath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path);
    return JSON.parse(raw) as Feature;
  }).pipe(Effect.provide(NodeContext.layer));

const runLoop = (
  contractPath: AbsolutePath,
  runTaskLayer: Layer.Layer<RunTask, never, never>,
) =>
  Effect.flatMap(LoopRunner, (lr) => lr.run(contractPath)).pipe(
    Effect.provide(makeTestLayer(runTaskLayer)),
  );

// ---------------------------------------------------------------------------
// Tmp root — placed under os.tmpdir() so git status returns non-zero
// (not in the tap-tool git tree, avoiding commit pollution)
// ---------------------------------------------------------------------------

const tmpRoot = brand<"AbsolutePath">(
  nodePath.join(os.tmpdir(), `tap-ratelimit-test-${crypto.randomUUID()}`),
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
// Tests
// ---------------------------------------------------------------------------

describe("LoopRunner rate-limit halting", () => {
  test("RateLimited error: stoppedReason is RateLimited, task stays pending/in_progress (not failed), attempts unchanged", async () => {
    const contractPath = brand<"AbsolutePath">(
      nodePath.join(tmpRoot as string, "ratelimit", "FEATURE_CONTRACT.json"),
    );

    const initialTask = makeTask("T1", "pending", 0, 3);
    const feature = makeFeature([initialTask]);
    await Effect.runPromise(saveContract(contractPath, feature));

    const runTaskLayer = makeRateLimitedFake("Composer", 1777050000);

    const summary = await Effect.runPromise(runLoop(contractPath, runTaskLayer));

    // stoppedReason is RateLimited with the correct role and resetsAt
    expect(summary.stoppedReason._tag).toBe("RateLimited");
    if (summary.stoppedReason._tag === "RateLimited") {
      expect(summary.stoppedReason.role).toBe("Composer");
      expect(summary.stoppedReason.resetsAt).toBe(1777050000);
    }

    // Task is NOT in tasksFailed
    expect(summary.tasksFailed).not.toContain(brand<"TaskId">("T1"));

    // Task IS in tasksPending (status is pending or in_progress, not failed/done)
    expect(summary.tasksPending).toContain(brand<"TaskId">("T1"));

    // On-disk contract: status is in_progress (not failed), attempts is 0 (unchanged)
    const onDisk = await Effect.runPromise(readContract(contractPath));
    const onDiskTask = onDisk.stories[0]!.tasks.find((t) => t.id === "T1");
    expect(onDiskTask).toBeDefined();
    expect(onDiskTask!.status).toBe("in_progress");
    expect(onDiskTask!.attempts).toBe(0);
  });
});
