import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import {
  AgentRunner,
  AgentRunnerEcho,
  type AgentRunnerEchoScript,
  decodeAgentEventLine,
} from "../AgentRunner";

// ---------------------------------------------------------------------------
// Brand helper
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
// Shared tmp dir
// ---------------------------------------------------------------------------

const tmpDir = brand<"AbsolutePath">(
  `.tap/tmp/agentrunner-ratelimit-test-${crypto.randomUUID()}`,
);

afterAll(async () => {
  await Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(tmpDir, { recursive: true }).pipe(Effect.catchAll(() => Effect.void)),
    ).pipe(Effect.provide(BunContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const runWithScript = (
  script: AgentRunnerEchoScript,
  opts: AgentRunOptions,
) => {
  const layer = Layer.merge(AgentRunnerEcho(script), BunContext.layer);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(tmpDir, { recursive: true });
    return yield* AgentRunner.pipe(Effect.flatMap((runner) => runner.run(opts)));
  }).pipe(Effect.provide(layer));
};

// ---------------------------------------------------------------------------
// Case (a): rate_limit_event (status:rejected, resetsAt:1777050000) + result
//           is_error:true api_error_status:429 → RateLimited with known resetsAt
// ---------------------------------------------------------------------------

describe("AgentRunner rate-limit detection", () => {
  test("(a) rateLimited exit with resetsAt=1777050000 → RateLimited error carrying the timestamp", async () => {
    const opts = makeOpts({
      role: "Composer",
      logPath: brand<"AbsolutePath">(`${tmpDir}/case-a-composer.jsonl`),
      stderrLogPath: brand<"AbsolutePath">(`${tmpDir}/case-a-composer.stderr.log`),
    });

    const script: AgentRunnerEchoScript = {
      Composer: {
        events: [],
        exit: { _tag: "rateLimited", resetsAt: 1777050000 },
      },
      Reviewer: {
        events: [],
        exit: { _tag: "ok" },
      },
    };

    const exit = await Effect.runPromiseExit(runWithScript(script, opts));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("RateLimited");
      if (err._tag === "RateLimited") {
        expect(err.role).toBe("Composer");
        expect(err.resetsAt).toBe(1777050000);
      }
    } else {
      throw new Error(`Unexpected cause: ${JSON.stringify(exit)}`);
    }
  });

  // -------------------------------------------------------------------------
  // Case (b): result is_error:true api_error_status:429 with no prior
  //           rate_limit_event → RateLimited with resetsAt=0 (unknown)
  // -------------------------------------------------------------------------

  test("(b) rateLimited exit with resetsAt=0 → RateLimited error with resetsAt=0 (unknown reset time)", async () => {
    const opts = makeOpts({
      role: "Composer",
      logPath: brand<"AbsolutePath">(`${tmpDir}/case-b-composer.jsonl`),
      stderrLogPath: brand<"AbsolutePath">(`${tmpDir}/case-b-composer.stderr.log`),
    });

    const script: AgentRunnerEchoScript = {
      Composer: {
        events: [],
        exit: { _tag: "rateLimited", resetsAt: 0 },
      },
      Reviewer: {
        events: [],
        exit: { _tag: "ok" },
      },
    };

    const exit = await Effect.runPromiseExit(runWithScript(script, opts));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("RateLimited");
      if (err._tag === "RateLimited") {
        expect(err.role).toBe("Composer");
        expect(err.resetsAt).toBe(0);
      }
    } else {
      throw new Error(`Unexpected cause: ${JSON.stringify(exit)}`);
    }
  });

  // -------------------------------------------------------------------------
  // Codec roundtrip: rate_limit_event decodes correctly
  // -------------------------------------------------------------------------

  test("decodeAgentEventLine handles rate_limit_event variant", async () => {
    const rateLimitLine = JSON.stringify({
      type: "rate_limit_event",
      session_id: "sess-rl",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1777050000,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
      },
    });

    const decoded = await Effect.runPromise(decodeAgentEventLine(rateLimitLine));
    expect(decoded.type).toBe("rate_limit_event");
    if (decoded.type === "rate_limit_event") {
      expect(decoded.rate_limit_info.status).toBe("rejected");
      expect(decoded.rate_limit_info.resetsAt).toBe(1777050000);
      expect(decoded.rate_limit_info.rateLimitType).toBe("five_hour");
    }
  });

  // -------------------------------------------------------------------------
  // Codec roundtrip: result with api_error_status decodes correctly
  // -------------------------------------------------------------------------

  test("decodeAgentEventLine handles result with api_error_status=429", async () => {
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      num_turns: 1,
      session_id: "sess-rl",
      total_cost_usd: 0,
      result: "You've hit your limit",
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const decoded = await Effect.runPromise(decodeAgentEventLine(resultLine));
    expect(decoded.type).toBe("result");
    if (decoded.type === "result") {
      expect(decoded.is_error).toBe(true);
      expect(decoded.api_error_status).toBe(429);
    }
  });
});
