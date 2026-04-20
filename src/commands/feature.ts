import { Args, Command as CliCmd, Options } from "@effect/cli"
import { FileSystem } from "@effect/platform"
import { Console, Effect } from "effect"
import { RalphPaths } from "../services/Config.ts"
import {
  PLAN_TEMPLATE,
  PROGRESS_TEMPLATE,
  SCRATCHPAD_TEMPLATE,
  SPEC_TEMPLATE,
} from "../templates.ts"

const featureName = Args.text({ name: "name" }).pipe(
  Args.withDescription("Feature identifier (kebab-case recommended)"),
)

const specOption = Options.text("spec").pipe(
  Options.withAlias("s"),
  Options.withDescription("Inline spec text to seed SPEC.md"),
  Options.optional,
)

const addCommand = CliCmd.make(
  "add",
  { name: featureName, spec: specOption },
  ({ name, spec }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* RalphPaths
      const dir = paths.featureDir(name)
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(
        Effect.orElseSucceed(() => void 0),
      )

      const specPath = paths.featureFile(name, "SPEC.md")
      const planPath = paths.featureFile(name, "PLAN.md")
      const progressPath = paths.featureFile(name, "PROGRESS.md")
      const scratchpadPath = paths.featureFile(name, "SCRATCHPAD.md")

      const writeIfMissing = (p: string, contents: string) =>
        Effect.gen(function* () {
          const exists = yield* fs.exists(p).pipe(
            Effect.orElseSucceed(() => false),
          )
          if (!exists) yield* fs.writeFileString(p, contents).pipe(Effect.orDie)
        })

      const specContent =
        spec._tag === "Some" ? `# Feature: ${name}\n\n${spec.value}\n` : SPEC_TEMPLATE(name)

      yield* writeIfMissing(specPath, specContent)
      yield* writeIfMissing(planPath, PLAN_TEMPLATE(name))
      yield* writeIfMissing(progressPath, PROGRESS_TEMPLATE(name))
      yield* writeIfMissing(scratchpadPath, SCRATCHPAD_TEMPLATE())

      yield* Console.log(`Added feature '${name}' at ${dir}`)
      yield* Console.log(
        `  - Edit SPEC.md to refine the goal`,
      )
      yield* Console.log(`  - Run: ralph run ${name}`)
    }),
).pipe(CliCmd.withDescription("Scaffold a new feature folder"))

const listCommand = CliCmd.make("list", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* RalphPaths
    const featuresDir = `${paths.ralphDir}/features`
    const exists = yield* fs.exists(featuresDir).pipe(
      Effect.orElseSucceed(() => false),
    )
    if (!exists) {
      yield* Console.log("(no features yet — run `ralph init` and `ralph feature add <name>`)")
      return
    }
    const entries = yield* fs.readDirectory(featuresDir).pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    )
    if (entries.length === 0) {
      yield* Console.log("(no features)")
      return
    }
    for (const e of entries) {
      yield* Console.log(`- ${e}`)
    }
  }),
).pipe(CliCmd.withDescription("List features in this repo"))

export const featureCommand = CliCmd.make("feature", {}, () =>
  Console.log(
    "use: ralph feature add <name> [--spec ...] | ralph feature list",
  ),
).pipe(
  CliCmd.withDescription("Manage ralph features"),
  CliCmd.withSubcommands([addCommand, listCommand]),
)
