import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { Command, FileSystem } from "@effect/platform";
import { CommandExecutor } from "@effect/platform";
import { AgentRunner, spawnFailed, maxTurnsExceeded, filesystemError, rateLimited } from "./AgentRunner";
import type { RunError } from "./AgentRunner";
import { decodeAgentEventLine } from "./AgentEventCodec";

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
              // Map the stream's PlatformError to RunError before runForEach
              // so the fiber's error channel is uniformly RunError.
              const stdoutFiber = yield* Effect.fork(
                Stream.runForEach(
                  process.stdout.pipe(
                    Stream.decodeText("utf-8"),
                    Stream.splitLines,
                    Stream.filter((l) => l.trim().length > 0),
                    Stream.mapError(
                      (cause): RunError => spawnFailed(role, 1, String(cause)),
                    ),
                  ),
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
                      // Decode for in-memory `events`. Lines that don't match
                      // any known variant are skipped silently — the raw line is
                      // already on disk in logPath.
                      const decoded = yield* Effect.option(
                        decodeAgentEventLine(line),
                      );
                      if (Option.isSome(decoded)) {
                        const event = decoded.value;
                        events.push(event);
                        // Track rate-limit signal so the result handler can fail fast.
                        if (
                          event.type === "rate_limit_event" &&
                          event.rate_limit_info.status === "rejected"
                        ) {
                          rateLimitResetsAt = Option.some(event.rate_limit_info.resetsAt);
                        }
                      }
                    }),
                ),
              );

              // Drain stderr: accumulate bytes and tee to disk.
              // Map the stream's PlatformError to RunError before runForEach.
              const stderrFiber = yield* Effect.fork(
                Stream.runForEach(
                  process.stderr.pipe(
                    Stream.mapError(
                      (cause): RunError =>
                        filesystemError(stderrLogPath, cause),
                    ),
                  ),
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
                ),
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
            return yield* Effect.fail(
              spawnFailed(role, 0, "No result event found in stdout"),
            );
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
