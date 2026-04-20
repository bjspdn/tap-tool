import { Args, Command as CliCmd, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { AgentRunner } from "../services/AgentRunner.ts"
import { ConfigService, type AgentKind } from "../services/Config.ts"
import { LoopRunner } from "../services/LoopRunner.ts"

const featureName = Args.text({ name: "feature" }).pipe(
  Args.withDescription("Feature to iterate on"),
)

const maxOpt = Options.integer("max").pipe(
  Options.withAlias("n"),
  Options.withDescription("Override max iterations"),
  Options.optional,
)

const agentOpt = Options.choice("agent", [
  "claude",
  "cursor-agent",
  "echo",
] as const).pipe(
  Options.withDescription("Override agent to invoke"),
  Options.optional,
)

const dryRun = Options.boolean("dry-run").pipe(
  Options.withDescription(
    "Do not invoke the agent; render prompts to .ralph/features/<f>/logs/ only.",
  ),
)

const autoCommit = Options.boolean("auto-commit").pipe(
  Options.withDescription(
    "git add -A && git commit after every iteration (overrides config).",
  ),
)

const timeoutOpt = Options.integer("timeout-ms").pipe(
  Options.withDescription("Per-iteration timeout (ms)"),
  Options.optional,
)

export const runCommand = CliCmd.make(
  "run",
  {
    feature: featureName,
    max: maxOpt,
    agent: agentOpt,
    dryRun,
    autoCommit,
    timeout: timeoutOpt,
  },
  ({ feature, max, agent, dryRun, autoCommit, timeout }) =>
    Effect.gen(function* () {
      const cfgSvc = yield* ConfigService
      const runner = yield* LoopRunner
      const agentSvc = yield* AgentRunner

      const base = yield* cfgSvc.load.pipe(
        Effect.catchAll(() => Effect.succeed(cfgSvc.default)),
      )

      const config = {
        ...base,
        maxIterations: Option.getOrElse(max, () => base.maxIterations),
        agent: Option.getOrElse(agent, () => base.agent) as AgentKind,
        autoCommit: autoCommit || base.autoCommit,
        iterationTimeoutMs: Option.getOrElse(
          timeout,
          () => base.iterationTimeoutMs,
        ),
      }

      yield* Console.log(
        `ralph: feature=${feature} agent=${agentSvc.describe(config)} max=${config.maxIterations}${dryRun ? " [dry-run]" : ""}`,
      )

      const summary = yield* runner.run({
        feature,
        config,
        dryRun,
        onIterationStart: (i) =>
          Console.log(
            `\n── iteration ${i}/${config.maxIterations} ──`,
          ),
        onIterationEnd: (i, r) =>
          Console.log(
            `   done exit=${r.exitCode} duration=${r.durationMs}ms output_chars=${r.output.length}`,
          ),
      })

      yield* Console.log(
        `\nralph finished: iterations=${summary.iterations} completed=${summary.completed} reason="${summary.stoppedReason}"`,
      )
    }),
).pipe(
  CliCmd.withDescription(
    "Run a ralph loop on <feature>: refresh context, call agent, repeat until completion marker or max iterations.",
  ),
)
