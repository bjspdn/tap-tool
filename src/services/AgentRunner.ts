import { Command, CommandExecutor } from "@effect/platform"
import { Context, Duration, Effect, Layer, Schema, Stream } from "effect"
import type { RalphConfig } from "./Config.ts"

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
  exitCode: Schema.optional(Schema.Int),
}) {}

export interface AgentInvocation {
  readonly prompt: string
  readonly cwd: string
  readonly feature: string
  readonly iteration: number
  readonly config: RalphConfig
  readonly onStdout?: (chunk: string) => void
  readonly onStderr?: (chunk: string) => void
}

export interface AgentResult {
  readonly exitCode: number
  readonly output: string
  readonly stderr: string
  readonly durationMs: number
}

export class AgentRunner extends Context.Tag("AgentRunner")<
  AgentRunner,
  {
    readonly run: (i: AgentInvocation) => Effect.Effect<AgentResult, AgentError>
    readonly describe: (cfg: RalphConfig) => string
  }
>() {}

const buildCommand = (cfg: RalphConfig, prompt: string) => {
  switch (cfg.agent) {
    case "claude": {
      const base = Command.make(
        "claude",
        "-p",
        "--permission-mode",
        "bypassPermissions",
        ...cfg.agentArgs,
      )
      return Command.feed(base, prompt)
    }
    case "cursor-agent": {
      const base = Command.make(
        "cursor-agent",
        "-p",
        "--force",
        "--output-format",
        "text",
        ...cfg.agentArgs,
      )
      return Command.feed(base, prompt)
    }
    case "echo": {
      const base = Command.make("cat", ...cfg.agentArgs)
      return Command.feed(base, prompt)
    }
  }
}

export const AgentRunnerLive = Layer.effect(
  AgentRunner,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    const describe = (cfg: RalphConfig) =>
      `${cfg.agent}${cfg.agentArgs.length ? " " + cfg.agentArgs.join(" ") : ""}`

    const run = (inv: AgentInvocation): Effect.Effect<AgentResult, AgentError> =>
      Effect.gen(function* () {
        const start = Date.now()
        const cmd = buildCommand(inv.config, inv.prompt).pipe(
          Command.workingDirectory(inv.cwd),
          Command.stderr("pipe"),
          Command.stdout("pipe"),
        )

        const collect = Effect.scoped(
          Effect.gen(function* () {
            const proc = yield* Command.start(cmd)
            const stdoutEff = proc.stdout.pipe(
              Stream.decodeText("utf-8"),
              Stream.tap((chunk) =>
                Effect.sync(() => inv.onStdout?.(chunk)),
              ),
              Stream.runFold("", (acc, c) => acc + c),
            )
            const stderrEff = proc.stderr.pipe(
              Stream.decodeText("utf-8"),
              Stream.tap((chunk) =>
                Effect.sync(() => inv.onStderr?.(chunk)),
              ),
              Stream.runFold("", (acc, c) => acc + c),
            )
            return yield* Effect.all(
              [stdoutEff, stderrEff, proc.exitCode],
              { concurrency: 3 },
            )
          }),
        ).pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor))

        const result = yield* collect.pipe(
          Effect.timeout(Duration.millis(inv.config.iterationTimeoutMs)),
          Effect.mapError((e) =>
            typeof e === "object" && e !== null && "_tag" in e &&
            (e as { _tag?: string })._tag === "TimeoutException"
              ? new AgentError({
                  message: `agent timed out after ${inv.config.iterationTimeoutMs}ms`,
                })
              : new AgentError({ message: String(e) }),
          ),
        )

        const [out, err, code] = result
        return {
          exitCode: code,
          output: out,
          stderr: err,
          durationMs: Date.now() - start,
        }
      })

    return { run, describe }
  }),
)
