import { Effect, Either, Fiber, Layer, Option, Stream } from "effect";
import { Command, FileSystem } from "@effect/platform";
import { CommandExecutor } from "@effect/platform";
import { AgentRunner, spawnFailed, maxTurnsExceeded, filesystemError, rateLimited } from "./AgentRunner";
import type { RunError } from "./AgentRunner";
import { decodeAgentEventLine } from "./AgentEventCodec";
import { teeStream } from "../streamTee";

// ---------------------------------------------------------------------------
// AgentRunnerLive
// ---------------------------------------------------------------------------

/**
 * Live layer — spawns `claude -p --agent <role> --output-format stream-json --verbose
 * --dangerously-skip-permissions`, feeds stdin, tees stdout NDJSON to logPath, tees
 * stderr bytes to stderrLogPath, and returns all collected events + the final result event.
 *
 * Never spawns with `detached: true`. Interruption delivers SIGTERM to the child via the
 * Command executor's scope-finalizer.
 */
export const AgentRunnerLive: Layer.Layer<
  AgentRunner,
  never,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> = Layer.effect(
  AgentRunner,
  Effect.gen(function* () {
    // FileSystem and CommandExecutor are captured at layer construction time.
    // The run closure holds them, so run's Effect<..., RunError, FileSystem> resolves
    // to Effect<..., RunError, never> internally — the FileSystem in the Tag's R is
    // a structural upper bound, not a per-call requirement for the Live layer.
    const fs = yield* FileSystem.FileSystem;
    const executor = yield* CommandExecutor.CommandExecutor;

    const run = (opts: AgentRunOptions): Effect.Effect<
      {
        readonly events: ReadonlyArray<AgentEvent>;
        readonly result: Extract<AgentEvent, { type: "result" }>;
      },
      RunError,
      FileSystem.FileSystem
    > =>
      // Wrap in Effect.provideService so the returned Effect has R = FileSystem
      // (matching the Tag) while the actual implementation uses the captured fs.
      Effect.provideService(
        Effect.gen(function* () {
          const { role, cwd, stdin, logPath, stderrLogPath } = opts;

          const cmd = Command.make(
            "claude",
            "-p",
            "--agent",
            role,
            "--output-format",
            "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
          ).pipe(
            Command.feed(stdin),
            Command.workingDirectory(cwd as string),
            Command.stdout("pipe"),
            Command.stderr("pipe"),
          );

          const events: AgentEvent[] = [];
          const parseFailures: Array<{ line: string; error: string }> = [];
          let rateLimitResetsAt: Option.Option<number> = Option.none();
          const stderrChunks: Uint8Array[] = [];
          const stderrStr = (): string =>
            Buffer.concat(stderrChunks).toString("utf-8");

          const exitCode: number = yield* Effect.scoped(
            Effect.gen(function* () {
              const process = yield* executor.start(cmd).pipe(
                Effect.mapError(
                  (cause): RunError => spawnFailed(role, 1, String(cause)),
                ),
              );

              // Drain stdout: split lines → tee to disk → decode as AgentEvent.
              const stdoutFiber = yield* teeStream(
                process.stdout.pipe(
                  Stream.decodeText("utf-8"),
                  Stream.splitLines,
                  Stream.filter((l) => l.trim().length > 0),
                ),
                (cause): RunError => spawnFailed(role, 1, String(cause)),
                (line) =>
                  Effect.gen(function* () {
                    yield* fs
                      .writeFileString(logPath as string, line + "\n", {
                        flag: "a",
                      })
                      .pipe(
                        Effect.mapError(
                          (cause): RunError =>
                            filesystemError(logPath, cause),
                        ),
                      );
                    // Decode for in-memory `events`. Parse failures are
                    // collected (not silently dropped) so a missing result
                    // event can surface the underlying schema mismatch.
                    const decoded = yield* Effect.either(
                      decodeAgentEventLine(line),
                    );
                    if (Either.isRight(decoded)) {
                      const event = decoded.right;
                      events.push(event);
                      if (
                        event.type === "rate_limit_event" &&
                        event.rate_limit_info.status === "rejected"
                      ) {
                        rateLimitResetsAt = Option.some(event.rate_limit_info.resetsAt);
                      }
                    } else {
                      parseFailures.push({
                        line: line.length > 240 ? line.slice(0, 240) + "…" : line,
                        error: String(decoded.left),
                      });
                    }
                  }),
              );

              // Drain stderr: accumulate bytes and tee to disk.
              const stderrFiber = yield* teeStream(
                process.stderr,
                (cause): RunError => filesystemError(stderrLogPath, cause),
                (chunk) =>
                  Effect.gen(function* () {
                    stderrChunks.push(chunk);
                    yield* fs
                      .writeFileString(
                        stderrLogPath as string,
                        Buffer.from(chunk).toString("utf-8"),
                        { flag: "a" },
                      )
                      .pipe(
                        Effect.mapError(
                          (cause): RunError =>
                            filesystemError(stderrLogPath, cause),
                        ),
                      );
                  }),
              );

              yield* Fiber.join(stdoutFiber);
              yield* Fiber.join(stderrFiber);

              const code = yield* process.exitCode.pipe(
                Effect.mapError(
                  (cause): RunError => spawnFailed(role, 1, String(cause)),
                ),
              );
              // ExitCode is a Brand<number, "ExitCode">. Strip the brand at
              // this boundary — the only place we compare it as a plain number.
              return code as unknown as number;
            }),
          );

          if (exitCode !== 0) {
            return yield* Effect.fail(spawnFailed(role, exitCode, stderrStr()));
          }

          const resultEvent = events.find(
            (e): e is Extract<AgentEvent, { type: "result" }> =>
              e.type === "result",
          );

          if (!resultEvent) {
            const first = parseFailures[0];
            const detail = first
              ? `No result event decoded. ${parseFailures.length} line(s) failed schema decode; first failure:\n  error: ${first.error}\n  line:  ${first.line}`
              : "No result event found in stdout (no parse failures — stream may have been empty or truncated)";
            return yield* Effect.fail(spawnFailed(role, 0, detail));
          }

          // Rate-limit takes priority: either a preceding rate_limit_event set the
          // timestamp, or the result itself carries api_error_status 429.
          if (
            Option.isSome(rateLimitResetsAt) ||
            (resultEvent.is_error && resultEvent.api_error_status === 429)
          ) {
            const resetsAt = Option.isSome(rateLimitResetsAt)
              ? rateLimitResetsAt.value
              : 0;
            return yield* Effect.fail(rateLimited(role, resetsAt));
          }

          if (resultEvent.subtype === "error_max_turns") {
            return yield* Effect.fail(maxTurnsExceeded(role));
          }

          return {
            events: events as ReadonlyArray<AgentEvent>,
            result: resultEvent,
          };
        }),
        FileSystem.FileSystem,
        fs,
      );

    return AgentRunner.of({ run });
  }),
);
