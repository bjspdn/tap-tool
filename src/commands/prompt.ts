import { Args, Command as CliCmd, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/Config.ts"
import { ContextEngine } from "../services/ContextEngine.ts"

const featureName = Args.text({ name: "feature" }).pipe(
  Args.withDescription("Feature to render a prompt for"),
)

const iterationOpt = Options.integer("iteration").pipe(
  Options.withAlias("i"),
  Options.withDefault(1),
  Options.withDescription("Iteration number to render (affects prompt framing)"),
)

export const promptCommand = CliCmd.make(
  "prompt",
  { feature: featureName, iteration: iterationOpt },
  ({ feature, iteration }) =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      const engine = yield* ContextEngine
      const config = yield* cfg.load.pipe(
        Effect.catchAll(() => Effect.succeed(cfg.default)),
      )
      const ctx = yield* engine.gather({
        feature,
        iteration,
        previousOutput: null,
        config,
      })
      const rendered = engine.render(ctx, config)
      yield* Console.log(rendered)
    }),
).pipe(
  CliCmd.withDescription(
    "Print the prompt ralph would send to the agent for <feature> (stdout only, no agent call).",
  ),
)
