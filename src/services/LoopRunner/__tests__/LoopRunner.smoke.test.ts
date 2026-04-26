import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { FileSystem } from "@effect/platform";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as nodePath from "node:path";
import * as os from "node:os";
import { AgentRunnerEcho, type AgentRunnerEchoScript } from "../../AgentRunner";
import { ContextEngineLive } from "../../ContextEngine";
import { EvalParserLive } from "../../EvalParser";
import { FeatureContractLive } from "../../FeatureContract";
import { RunTaskLive } from "../../RunTask";
import { LoopRunner, LoopRunnerLive } from "../index";
import { brand } from "../../brand";

// ---------------------------------------------------------------------------
// Canned PASS eval content — written by AgentRunnerEcho on Reviewer invocation.
// EvalParser requires: <eval:verdict>PASS</eval:verdict>, <eval:summary>,
// <eval:comments> (empty is valid for PASS).
// ---------------------------------------------------------------------------

const PASS_EVAL_CONTENT =
  "<eval:verdict>PASS</eval:verdict>\n" +
  "<eval:summary>All criteria satisfied in smoke test.</eval:summary>\n" +
  "<eval:comments>\n" +
  "</eval:comments>\n";

// ---------------------------------------------------------------------------
// AgentRunnerEcho script — Composer ok + Reviewer ok with PASS eval content.
// One script drives all tasks and all attempts (Echo replays same script each call).
// ---------------------------------------------------------------------------

const makeResultEvent = (sessionId: string): AgentEvent => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  session_id: sessionId,
});

const script: AgentRunnerEchoScript = {
  Composer: {
    events: [makeResultEvent("sess-composer")],
    exit: { _tag: "ok" },
  },
  Reviewer: {
    events: [makeResultEvent("sess-reviewer")],
    exit: { _tag: "ok" },
    evalFileContent: PASS_EVAL_CONTENT,
  },
};

// ---------------------------------------------------------------------------
// Tmp root — placed under os.tmpdir() so a stray `git commit` from the real
// LoopRunnerLive pipeline cannot walk up to the project `.git/` and pollute
// project history.
// ---------------------------------------------------------------------------

const tmpRoot = brand<"AbsolutePath">(
  nodePath.join(os.tmpdir(), `looprunner-smoke-${crypto.randomUUID()}`),
);

// ---------------------------------------------------------------------------
// Full-stack layer: no RunTaskFake — exercises the real RunTaskLive pipeline.
// ContextEngineLive reads templates from .tap/prompts/ at layer construction time
// (Layer.effect); FeatureContractLive captures FileSystem at construction too.
// Both requirements are satisfied by NodeContext.layer via Layer.provideMerge.
// ---------------------------------------------------------------------------

const smokeLayer = Layer.mergeAll(
  LoopRunnerLive,
  FeatureContractLive,
  RunTaskLive,
  ContextEngineLive,
  EvalParserLive,
  AgentRunnerEcho(script),
).pipe(Layer.provideMerge(NodeContext.layer));

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const makeTask = (id: string, depends_on: string[] = []): Task => ({
  id: brand<"TaskId">(id),
  title: `Task ${id}`,
  description: `Description for smoke-test task ${id}`,
  files: [],
  depends_on: depends_on.map((d) => brand<"TaskId">(d)),
  status: "pending",
  attempts: 0,
  maxAttempts: 3,
});

const makeFeature = (tasks: Task[]): Feature => ({
  feature: "smoke-test",
  goal: "Smoke test feature goal.",
  description: "Smoke test feature description.",
  constraints: ["No real constraints."],
  stories: [
    {
      id: brand<"StoryId">("S1"),
      title: "Story 1",
      description: "Smoke test story description.",
      tasks,
    },
  ],
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(tmpRoot, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Smoke test — end-to-end with real RunTaskLive + AgentRunnerEcho
// ---------------------------------------------------------------------------

describe("LoopRunner smoke test (end-to-end)", () => {
  test(
    "2-task contract T1→T2 passes end-to-end: AllDone, both done on disk, logs written",
    async () => {
      const featureRoot = tmpRoot;
      const contractPath = brand<"AbsolutePath">(
        nodePath.join(featureRoot as string, "FEATURE_CONTRACT.json"),
      );
      const specsPath = brand<"AbsolutePath">(
        nodePath.join(featureRoot as string, "SPECS.md"),
      );

      const feature = makeFeature([makeTask("T1"), makeTask("T2", ["T1"])]);

      // Write fixture files to disk before running the loop.
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(featureRoot, { recursive: true });
          yield* fs.writeFileString(
            contractPath,
            JSON.stringify(feature, null, 2) + "\n",
          );
          yield* fs.writeFileString(
            specsPath,
            "# Smoke test SPECS\nMinimal specs file for LoopRunner smoke test.\n",
          );
        }).pipe(Effect.provide(NodeContext.layer)),
      );

      // Run the full loop via the real service stack.
      const summary = await Effect.runPromise(
        Effect.flatMap(LoopRunner, (lr) => lr.run(contractPath)).pipe(
          Effect.provide(smokeLayer),
        ),
      );

      // --- LoopSummary assertions ---
      expect(summary.completed).toBe(true);
      expect(summary.stoppedReason._tag).toBe("AllDone");
      expect(summary.tasksDone).toContain(brand<"TaskId">("T1"));
      expect(summary.tasksDone).toContain(brand<"TaskId">("T2"));
      expect(summary.tasksFailed).toHaveLength(0);
      expect(summary.tasksPending).toHaveLength(0);

      // --- Final contract on disk ---
      const onDisk = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const raw = yield* fs.readFileString(contractPath);
          return JSON.parse(raw) as Feature;
        }).pipe(Effect.provide(NodeContext.layer)),
      );

      const onDiskT1 = onDisk.stories[0]!.tasks.find((t) => t.id === "T1");
      const onDiskT2 = onDisk.stories[0]!.tasks.find((t) => t.id === "T2");
      expect(onDiskT1).toBeDefined();
      expect(onDiskT1!.status).toBe("done");
      expect(onDiskT1!.attempts).toBe(1);
      expect(onDiskT2).toBeDefined();
      expect(onDiskT2!.status).toBe("done");
      expect(onDiskT2!.attempts).toBe(1);

      // --- Log files exist for both tasks (iter-001 = attempt 1) ---
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          for (const taskId of ["T1", "T2"]) {
            const composerLog = brand<"AbsolutePath">(
              nodePath.join(
                featureRoot as string,
                "logs",
                taskId,
                "iter-001-composer.jsonl",
              ),
            );
            const reviewerLog = brand<"AbsolutePath">(
              nodePath.join(
                featureRoot as string,
                "logs",
                taskId,
                "iter-001-reviewer.jsonl",
              ),
            );
            const composerExists = yield* fs.exists(composerLog);
            const reviewerExists = yield* fs.exists(reviewerLog);
            expect(composerExists).toBe(true);
            expect(reviewerExists).toBe(true);
          }
        }).pipe(Effect.provide(NodeContext.layer)),
      );
    },
    // Generous timeout — real filesystem + layer construction via ContextEngineLive
    30_000,
  );
});
