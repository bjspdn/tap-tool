import { Command as CliCmd, Options } from "@effect/cli"
import { FileSystem } from "@effect/platform"
import { Console, Effect } from "effect"
import { ConfigService, RalphPaths } from "../services/Config.ts"

const force = Options.boolean("force").pipe(
  Options.withAlias("f"),
  Options.withDescription("Overwrite an existing .ralph/config.json"),
)

export const initCommand = CliCmd.make(
  "init",
  { force },
  ({ force }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* RalphPaths
      const cfg = yield* ConfigService

      const exists = yield* fs.exists(paths.configFile).pipe(
        Effect.orElseSucceed(() => false),
      )
      if (exists && !force) {
        yield* Console.log(
          `ralph already initialized at ${paths.configFile} (use --force to overwrite)`,
        )
        return
      }

      yield* fs.makeDirectory(paths.ralphDir, { recursive: true }).pipe(
        Effect.orElseSucceed(() => void 0),
      )
      yield* fs.makeDirectory(`${paths.ralphDir}/features`, {
        recursive: true,
      }).pipe(Effect.orElseSucceed(() => void 0))

      yield* cfg.save(cfg.default)
      yield* Console.log(`Initialized ralph project at ${paths.ralphDir}`)
      yield* Console.log(
        `Next: \`ralph feature add <name>\` then \`ralph run <name>\``,
      )
    }),
).pipe(
  CliCmd.withDescription(
    "Create a .ralph/ directory with default config so this repo can host ralph loops.",
  ),
)
