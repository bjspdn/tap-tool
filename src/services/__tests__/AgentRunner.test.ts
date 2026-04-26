import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Exit, Layer, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import * as NodeContext from "@effect/platform-node/NodeContext";
import {
  AgentRunner,
  AgentRunnerEcho,
  type AgentRunnerEchoScript,
  AgentEventSchema,
  decodeAgentEventLine,
} from "../AgentRunner";

// ---------------------------------------------------------------------------
// Brand helper — exactly one `as` cast lives here
// ---------------------------------------------------------------------------

const brand = <B extends string>(s: string): string & { readonly __brand: B } =>
  s as string & { readonly __brand: B };

// ---------------------------------------------------------------------------
// AgentRunOptions factory
// ---------------------------------------------------------------------------

const makeOpts = (
  overrides: Partial<AgentRunOptions> & Pick<AgentRunOptions, "role" | "logPath" | "stderrLogPath">,
): AgentRunOptions => ({
  stdin: "test stdin",
  cwd: brand<"AbsolutePath">(process.cwd()),
  attempt: 1,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Test 1 fixtures — one event per AgentEvent variant
// ---------------------------------------------------------------------------

const systemEvent: AgentEvent = {
  type: "system",
  subtype: "init",
  session_id: "sess-001",
  model: "claude-opus-4-5",
  tools: ["Read", "Write"],
};

const assistantEvent: AgentEvent = {
  type: "assistant",
  session_id: "sess-001",
  message: {
    id: "msg-abc",
    role: "assistant",
    model: "claude-opus-4-5",
    content: [
      { type: "text", text: "I will implement the function." },
      {
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: { file_path: "src/foo.ts" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "file contents here",
        is_error: false,
      },
    ],
  },
};

const userEvent: AgentEvent = {
  type: "user",
  session_id: "sess-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Please implement task S5.T3." }],
  },
};

const resultEvent: AgentEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 3,
  session_id: "sess-001",
  total_cost_usd: 0.0042,
};

// ---------------------------------------------------------------------------
// Test 2 + 3 shared script helpers
// ---------------------------------------------------------------------------

const makeComposerAssistant = (): AgentEvent => ({
  type: "assistant",
  session_id: "sess-composer",
  message: {
    id: "msg-c1",
    role: "assistant",
    content: [{ type: "text", text: "Implementing the feature." }],
  },
});

const makeComposerResult = (): AgentEvent => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  session_id: "sess-composer",
});

const makeReviewerAssistant = (): AgentEvent => ({
  type: "assistant",
  session_id: "sess-reviewer",
  message: {
    id: "msg-r1",
    role: "assistant",
    content: [{ type: "text", text: "Reviewing the implementation." }],
  },
});

const makeReviewerResult = (): AgentEvent => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  session_id: "sess-reviewer",
});

const EVAL_CONTENT =
  "<eval:verdict>PASS</eval:verdict>\n" +
  "<eval:rationale>canned</eval:rationale>\n" +
  "<eval:issues>\n" +
  "</eval:issues>\n";

// ---------------------------------------------------------------------------
// Describe block
// ---------------------------------------------------------------------------

describe("AgentRunner", () => {
  // -------------------------------------------------------------------------
  // Test 1 — NDJSON schema roundtrip (pure, no service needed)
  // -------------------------------------------------------------------------

  describe("NDJSON schema roundtrip", () => {
    test("every variant round-trips through decodeAgentEventLine", async () => {
      const fixtures: AgentEvent[] = [systemEvent, assistantEvent, userEvent, resultEvent];

      for (const event of fixtures) {
        const line = JSON.stringify(event);
        const decoded = await Effect.runPromise(decodeAgentEventLine(line));

        // type is preserved
        expect(decoded.type).toBe(event.type);

        // variant-specific field checks
        if (event.type === "system" && decoded.type === "system") {
          expect(decoded.subtype).toBe(event.subtype);
          expect(decoded.session_id).toBe(event.session_id);
          expect(decoded.model).toBe(event.model);
          expect(decoded.tools).toEqual(event.tools);
        }

        if (event.type === "assistant" && decoded.type === "assistant") {
          expect(decoded.session_id).toBe(event.session_id);
          expect(decoded.message.id).toBe(event.message.id);
          expect(decoded.message.role).toBe("assistant");
          expect(decoded.message.model).toBe(event.message.model);
          expect(decoded.message.content).toHaveLength(3);

          const [textBlock, toolUseBlock, toolResultBlock] = decoded.message.content;

          expect(textBlock?.type).toBe("text");
          if (textBlock?.type === "text") {
            expect(textBlock.text).toBe("I will implement the function.");
          }

          expect(toolUseBlock?.type).toBe("tool_use");
          if (toolUseBlock?.type === "tool_use") {
            expect(toolUseBlock.id).toBe("tool-1");
            expect(toolUseBlock.name).toBe("Read");
            expect(toolUseBlock.input).toEqual({ file_path: "src/foo.ts" });
          }

          expect(toolResultBlock?.type).toBe("tool_result");
          if (toolResultBlock?.type === "tool_result") {
            expect(toolResultBlock.tool_use_id).toBe("tool-1");
            expect(toolResultBlock.content).toBe("file contents here");
            expect(toolResultBlock.is_error).toBe(false);
          }
        }

        if (event.type === "user" && decoded.type === "user") {
          expect(decoded.session_id).toBe(event.session_id);
          expect(decoded.message.role).toBe("user");
          const [content0] = decoded.message.content;
          if (content0?.type === "text") {
            expect(content0.text).toBe("Please implement task S5.T3.");
          }
        }

        if (event.type === "result" && decoded.type === "result") {
          expect(decoded.subtype).toBe("success");
          expect(decoded.is_error).toBe(false);
          expect(decoded.num_turns).toBe(3);
          expect(decoded.session_id).toBe(event.session_id);
          expect(decoded.total_cost_usd).toBe(0.0042);
        }
      }
    });

    test("decoding directly via Schema.decodeUnknown(AgentEventSchema) yields same result", async () => {
      const fixtures: AgentEvent[] = [systemEvent, assistantEvent, userEvent, resultEvent];
      const decodeUnknown = Schema.decodeUnknown(AgentEventSchema);

      for (const event of fixtures) {
        const parsed: unknown = JSON.parse(JSON.stringify(event));

        const fromLine = await Effect.runPromise(decodeAgentEventLine(JSON.stringify(event)));
        const fromSchema = await Effect.runPromise(decodeUnknown(parsed));

        expect(fromLine.type).toBe(fromSchema.type);
        expect(fromLine).toEqual(fromSchema);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test 2 — Echo happy path (Composer ok + Reviewer ok with evalFileContent)
  // -------------------------------------------------------------------------

  describe("Echo happy path", () => {
    const tmpDir = brand<"AbsolutePath">(
      `.tap/tmp/agentrunner-test-${crypto.randomUUID()}`,
    );
    const composerLog = brand<"AbsolutePath">(`${tmpDir}/iter-001-composer.jsonl`);
    const composerStderr = brand<"AbsolutePath">(`${tmpDir}/iter-001-composer.stderr.log`);
    const reviewerLog = brand<"AbsolutePath">(`${tmpDir}/iter-001-reviewer.jsonl`);
    const reviewerStderr = brand<"AbsolutePath">(`${tmpDir}/iter-001-reviewer.stderr.log`);
    const evalPath = brand<"AbsolutePath">(`${tmpDir}/EVAL_RESULT.md`);

    afterAll(async () => {
      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.remove(tmpDir, { recursive: true }),
        ).pipe(Effect.provide(NodeContext.layer)),
      );
    });

    test("Composer ok + Reviewer ok writes logs and eval file to disk", async () => {
      const composerAssistant = makeComposerAssistant();
      const composerResult = makeComposerResult();
      const reviewerAssistant = makeReviewerAssistant();
      const reviewerResult = makeReviewerResult();

      const script: AgentRunnerEchoScript = {
        Composer: {
          events: [composerAssistant, composerResult],
          exit: { _tag: "ok" },
        },
        Reviewer: {
          events: [reviewerAssistant, reviewerResult],
          exit: { _tag: "ok" },
          evalFileContent: EVAL_CONTENT,
        },
      };

      const composerOpts = makeOpts({
        role: "Composer",
        logPath: composerLog,
        stderrLogPath: composerStderr,
      });
      const reviewerOpts = makeOpts({
        role: "Reviewer",
        logPath: reviewerLog,
        stderrLogPath: reviewerStderr,
        evalPath,
      });

      const layer = Layer.merge(AgentRunnerEcho(script), NodeContext.layer);

      const program = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(tmpDir, { recursive: true });

        const composerOut = yield* AgentRunner.pipe(
          Effect.flatMap((runner) => runner.run(composerOpts)),
        );
        const reviewerOut = yield* AgentRunner.pipe(
          Effect.flatMap((runner) => runner.run(reviewerOpts)),
        );

        return { composerOut, reviewerOut };
      });

      const { composerOut, reviewerOut } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      );

      // Both results carry success
      expect(composerOut.result.type).toBe("result");
      expect(composerOut.result.subtype).toBe("success");
      expect(reviewerOut.result.type).toBe("result");
      expect(reviewerOut.result.subtype).toBe("success");

      // Composer log exists, is non-empty, and lines parse as AgentEvents
      const fs = await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.succeed(fs)).pipe(
          Effect.provide(NodeContext.layer),
        ),
      );

      const composerLogContent = await Effect.runPromise(
        fs.readFileString(composerLog).pipe(Effect.provide(NodeContext.layer)),
      );
      expect(composerLogContent.length).toBeGreaterThan(0);
      const composerLines = composerLogContent
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(composerLines.length).toBeGreaterThan(0);
      for (const line of composerLines) {
        const parsed: unknown = JSON.parse(line);
        expect(parsed).toBeDefined();
      }
      expect(composerLines).toHaveLength(script.Composer.events.length);

      // Reviewer log exists similarly
      const reviewerLogContent = await Effect.runPromise(
        fs.readFileString(reviewerLog).pipe(Effect.provide(NodeContext.layer)),
      );
      expect(reviewerLogContent.length).toBeGreaterThan(0);
      const reviewerLines = reviewerLogContent
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(reviewerLines.length).toBeGreaterThan(0);
      expect(reviewerLines).toHaveLength(script.Reviewer.events.length);

      // Eval file exists with canned content verbatim
      const evalContent = await Effect.runPromise(
        fs.readFileString(evalPath).pipe(Effect.provide(NodeContext.layer)),
      );
      expect(evalContent).toBe(EVAL_CONTENT);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3 — Echo error_max_turns (both roles)
  // -------------------------------------------------------------------------

  describe("Echo error_max_turns", () => {
    const maxTurnsScript: AgentRunnerEchoScript = {
      Composer: { events: [], exit: { _tag: "maxTurns" } },
      Reviewer: { events: [], exit: { _tag: "maxTurns" } },
    };

    test("Composer maxTurns yields AgentMaxTurnsExceeded with role=Composer", async () => {
      const tmpDir2 = brand<"AbsolutePath">(
        `.tap/tmp/agentrunner-test-${crypto.randomUUID()}`,
      );
      const opts = makeOpts({
        role: "Composer",
        logPath: brand<"AbsolutePath">(`${tmpDir2}/composer.jsonl`),
        stderrLogPath: brand<"AbsolutePath">(`${tmpDir2}/composer.stderr.log`),
      });

      const layer = Layer.merge(AgentRunnerEcho(maxTurnsScript), NodeContext.layer);

      const program = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(tmpDir2, { recursive: true });
        return yield* AgentRunner.pipe(
          Effect.flatMap((runner) => runner.run(opts)),
        );
      });

      const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const err = exit.cause.error;
        expect(err._tag).toBe("AgentMaxTurnsExceeded");
        if (err._tag === "AgentMaxTurnsExceeded") {
          expect(err.role).toBe("Composer");
        }
      } else {
        throw new Error(`Unexpected cause: ${JSON.stringify(exit)}`);
      }

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.remove(tmpDir2, { recursive: true }),
        ).pipe(Effect.provide(NodeContext.layer)),
      );
    });

    test("Reviewer maxTurns yields AgentMaxTurnsExceeded with role=Reviewer", async () => {
      const tmpDir3 = brand<"AbsolutePath">(
        `.tap/tmp/agentrunner-test-${crypto.randomUUID()}`,
      );
      const opts = makeOpts({
        role: "Reviewer",
        logPath: brand<"AbsolutePath">(`${tmpDir3}/reviewer.jsonl`),
        stderrLogPath: brand<"AbsolutePath">(`${tmpDir3}/reviewer.stderr.log`),
        evalPath: brand<"AbsolutePath">(`${tmpDir3}/EVAL_RESULT.md`),
      });

      const layer = Layer.merge(AgentRunnerEcho(maxTurnsScript), NodeContext.layer);

      const program = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(tmpDir3, { recursive: true });
        return yield* AgentRunner.pipe(
          Effect.flatMap((runner) => runner.run(opts)),
        );
      });

      const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const err = exit.cause.error;
        expect(err._tag).toBe("AgentMaxTurnsExceeded");
        if (err._tag === "AgentMaxTurnsExceeded") {
          expect(err.role).toBe("Reviewer");
        }
      } else {
        throw new Error(`Unexpected cause: ${JSON.stringify(exit)}`);
      }

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.remove(tmpDir3, { recursive: true }),
        ).pipe(Effect.provide(NodeContext.layer)),
      );
    });
  });
});
