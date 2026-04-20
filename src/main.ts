import { Command as CliCmd } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { featureCommand } from "./commands/feature.ts"
import { initCommand } from "./commands/init.ts"
import { promptCommand } from "./commands/prompt.ts"
import { runCommand } from "./commands/run.ts"
import { statusCommand } from "./commands/status.ts"
import { AgentRunnerLive } from "./services/AgentRunner.ts"
import {
  ConfigServiceLive,
  RalphPathsLive,
} from "./services/Config.ts"
import { ContextEngineLive } from "./services/ContextEngine.ts"
import { LoopRunnerLive } from "./services/LoopRunner.ts"

const root = CliCmd.make("ralph", {}, () =>
  Console.log(
    "ralph — context-engineered ralph loop runner for Claude / Cursor agents.\n" +
      "Run `ralph --help` for commands.",
  ),
).pipe(
  CliCmd.withDescription(
    "Context-engineered ralph loop runner for Claude Code / Cursor agents.",
  ),
  CliCmd.withSubcommands([
    initCommand,
    featureCommand,
    promptCommand,
    runCommand,
    statusCommand,
  ]),
)

const cli = CliCmd.run(root, {
  name: "ralph",
  version: "0.1.0",
})

const BaseLayer = RalphPathsLive.pipe(Layer.provideMerge(BunContext.layer))
const CoreLayer = Layer.mergeAll(
  ConfigServiceLive,
  ContextEngineLive,
  AgentRunnerLive,
).pipe(Layer.provideMerge(BaseLayer))
const RalphServices = LoopRunnerLive.pipe(
  Layer.provideMerge(CoreLayer),
)

const main = cli(process.argv).pipe(Effect.provide(RalphServices))

BunRuntime.runMain(main)
