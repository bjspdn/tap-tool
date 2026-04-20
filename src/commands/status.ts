import { Args, Command as CliCmd } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/Config.ts"
import { ContextEngine } from "../services/ContextEngine.ts"

const featureName = Args.text({ name: "feature" }).pipe(Args.optional)

export const statusCommand = CliCmd.make(
  "status",
  { feature: featureName },
  ({ feature }) =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      const engine = yield* ContextEngine
      const config = yield* cfg.load.pipe(
        Effect.catchAll(() => Effect.succeed(cfg.default)),
      )

      const name = Option.getOrElse(feature, () => "")
      if (name === "") {
        yield* Console.log(
          `ralph config: agent=${config.agent} maxIterations=${config.maxIterations} marker=${config.completionMarker}`,
        )
        yield* Console.log(`(pass a feature name to see per-feature progress)`)
        return
      }
      const progress = yield* engine.readFeatureFile(name, "PROGRESS.md")
      if (!progress) {
        yield* Console.log(`no PROGRESS.md for feature '${name}'`)
        return
      }
      const lines = progress.split("\n")
      const iterCount = lines.filter((l) => /^## Iteration \d+/.test(l)).length
      const hasMarker = progress.includes(config.completionMarker)
      yield* Console.log(
        `feature=${name} iterations_recorded=${iterCount} completed=${hasMarker}`,
      )
      yield* Console.log("--- PROGRESS.md (last 30 lines) ---")
      yield* Console.log(lines.slice(-30).join("\n"))
    }),
).pipe(
  CliCmd.withDescription(
    "Show config or a feature's progress summary (counts iterations, looks for completion marker).",
  ),
)
