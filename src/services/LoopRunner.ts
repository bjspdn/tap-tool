import { Command, CommandExecutor, FileSystem } from "@effect/platform"
import { Context, Effect, Layer } from "effect"
import { AgentRunner, type AgentResult } from "./AgentRunner.ts"
import { RalphPaths, type RalphConfig } from "./Config.ts"
import { ContextEngine } from "./ContextEngine.ts"

export interface LoopOptions {
  readonly feature: string
  readonly config: RalphConfig
  readonly dryRun: boolean
  readonly onIterationStart?: (i: number) => Effect.Effect<void>
  readonly onIterationEnd?: (
    i: number,
    r: AgentResult,
  ) => Effect.Effect<void>
}

export interface LoopSummary {
  readonly feature: string
  readonly iterations: number
  readonly completed: boolean
  readonly stoppedReason: string
}

export class LoopRunner extends Context.Tag("LoopRunner")<
  LoopRunner,
  {
    readonly run: (o: LoopOptions) => Effect.Effect<LoopSummary>
  }
>() {}

const padIteration = (i: number) => i.toString().padStart(3, "0")

export const LoopRunnerLive = Layer.effect(
  LoopRunner,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* RalphPaths
    const ctxEngine = yield* ContextEngine
    const agent = yield* AgentRunner
    const executor = yield* CommandExecutor.CommandExecutor

    const runCmd = (args: ReadonlyArray<string>) =>
      Command.string(Command.make(args[0]!, ...args.slice(1))).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
        Effect.orElseSucceed(() => ""),
      )

    return {
      run: (opts) =>
        Effect.gen(function* () {
          const { feature, config, dryRun } = opts

          const logsDir = paths.logsDir(feature)
          yield* fs.makeDirectory(logsDir, { recursive: true }).pipe(
            Effect.orElseSucceed(() => void 0),
          )

          let previousOutput: string | null = null
          let stoppedReason = "max iterations reached"
          let completed = false
          let i = 1

          for (; i <= config.maxIterations; i++) {
            if (opts.onIterationStart) {
              yield* opts.onIterationStart(i)
            }

            const context = yield* ctxEngine.gather({
              feature,
              iteration: i,
              previousOutput,
              config,
            })
            const prompt = ctxEngine.render(context, config)

            const promptFile = `${logsDir}/iter-${padIteration(i)}-prompt.md`
            yield* fs.writeFileString(promptFile, prompt).pipe(
              Effect.orElseSucceed(() => void 0),
            )

            const result: AgentResult = dryRun
              ? {
                  exitCode: 0,
                  output: `[dry-run] would invoke ${agent.describe(config)} with ${prompt.length} chars; prompt written to ${promptFile}`,
                  stderr: "",
                  durationMs: 0,
                }
              : yield* agent
                  .run({
                    prompt,
                    cwd: paths.root,
                    feature,
                    iteration: i,
                    config,
                  })
                  .pipe(
                    Effect.catchAll((e) =>
                      Effect.succeed<AgentResult>({
                        exitCode: 1,
                        output: "",
                        stderr: `agent error: ${e.message}`,
                        durationMs: 0,
                      }),
                    ),
                  )

            const outFile = `${logsDir}/iter-${padIteration(i)}-output.log`
            yield* fs.writeFileString(
              outFile,
              `exit=${result.exitCode} duration=${result.durationMs}ms\n\n` +
                `=== stdout ===\n${result.output}\n\n` +
                `=== stderr ===\n${result.stderr}\n`,
            ).pipe(Effect.orElseSucceed(() => void 0))

            if (opts.onIterationEnd) yield* opts.onIterationEnd(i, result)

            if (config.autoCommit && !dryRun) {
              yield* runCmd(["git", "add", "-A"])
              yield* runCmd([
                "git",
                "commit",
                "-m",
                `ralph(${feature}): iteration ${i}`,
                "--allow-empty",
              ])
            }

            previousOutput = result.output

            const progress = yield* ctxEngine.readFeatureFile(
              feature,
              "PROGRESS.md",
            )
            if (progress.includes(config.completionMarker)) {
              completed = true
              stoppedReason = `completion marker '${config.completionMarker}' found`
              break
            }

            if (result.exitCode !== 0) {
              stoppedReason = `agent exited with code ${result.exitCode}`
              if (result.exitCode >= 2) break
            }
          }

          if (dryRun && !completed) {
            stoppedReason = "dry-run complete"
          }

          return {
            feature,
            iterations: Math.min(i, config.maxIterations),
            completed,
            stoppedReason,
          }
        }),
    }
  }),
)
