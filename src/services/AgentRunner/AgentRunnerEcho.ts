import { Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { AgentRunner, spawnFailed, maxTurnsExceeded, filesystemError, rateLimited } from "./AgentRunner";
import type { AgentRunnerEchoScript, RunError } from "./AgentRunner";

// ---------------------------------------------------------------------------
// AgentRunnerEcho
// ---------------------------------------------------------------------------

/**
 * Echo layer — deterministic fake for tests. Driven by an in-memory script.
 * Writes `evalFileContent` to `opts.evalPath` when role is Reviewer and the field is present.
 * Writes scripted events as JSONL lines to `opts.logPath` so log-file assertions pass.
 * Does NOT spawn any real process.
 * Requires FileSystem in the `run` Effect's environment (not at layer construction time),
 * so the layer itself has no construction-time requirements.
 */
export const AgentRunnerEcho = (
  script: AgentRunnerEchoScript,
): Layer.Layer<AgentRunner, never, never> =>
  Layer.succeed(
    AgentRunner,
    AgentRunner.of({
      run: (opts) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { role } = opts;
          const roleScript = script[role];

          // Step 1 — Reviewer only: write evalFileContent to evalPath when supplied.
          if (role === "Reviewer") {
            const rs = script.Reviewer;
            if (rs.evalFileContent !== undefined && opts.evalPath !== undefined) {
              yield* fs
                .writeFileString(opts.evalPath as string, rs.evalFileContent)
                .pipe(
                  Effect.mapError(
                    (cause): RunError =>
                      filesystemError(opts.evalPath as AbsolutePath, cause),
                  ),
                );
            }
          }

          // Step 2 — tee scripted events as JSONL lines to logPath.
          for (const event of roleScript.events) {
            yield* fs
              .writeFileString(
                opts.logPath as string,
                JSON.stringify(event) + "\n",
                { flag: "a" },
              )
              .pipe(
                Effect.mapError(
                  (cause): RunError => filesystemError(opts.logPath, cause),
                ),
              );
          }

          // Step 3 — honour the scripted exit.
          const exit = roleScript.exit;

          if (exit._tag === "maxTurns") {
            return yield* Effect.fail(maxTurnsExceeded(role));
          }

          if (exit._tag === "rateLimited") {
            return yield* Effect.fail(rateLimited(role, exit.resetsAt));
          }

          if (exit._tag === "spawnFail") {
            return yield* Effect.fail(
              spawnFailed(role, exit.exitCode, exit.stderr),
            );
          }

          // exit._tag === "ok" — find the result event in the scripted events.
          const resultEvent = roleScript.events.find(
            (e): e is Extract<AgentEvent, { type: "result" }> =>
              e.type === "result",
          );

          if (!resultEvent) {
            // Script author bug — invariant violation, not a recoverable failure.
            return yield* Effect.die(
              new Error(
                `AgentRunnerEcho: script for role "${role}" exit is "ok" but contains no result event`,
              ),
            );
          }

          return {
            events: roleScript.events,
            result: resultEvent,
          };
        }),
    }),
  );
