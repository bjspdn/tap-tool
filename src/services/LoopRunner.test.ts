import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentRunnerLive } from "./AgentRunner.ts"
import {
  ConfigServiceLive,
  RalphPaths,
  type RalphConfig,
} from "./Config.ts"
import { ContextEngine, ContextEngineLive } from "./ContextEngine.ts"
import { LoopRunner, LoopRunnerLive } from "./LoopRunner.ts"

const tempLayer = () =>
  Layer.effect(
    RalphPaths,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tmp = yield* fs.makeTempDirectory()
      return {
        root: tmp,
        ralphDir: path.join(tmp, ".ralph"),
        configFile: path.join(tmp, ".ralph", "config.json"),
        featureDir: (name) => path.join(tmp, ".ralph", "features", name),
        featureFile: (name, file) =>
          path.join(tmp, ".ralph", "features", name, file),
        logsDir: (name) => path.join(tmp, ".ralph", "features", name, "logs"),
      }
    }),
  )

const testLayer = tempLayer().pipe(
  Layer.provideMerge(BunContext.layer),
)
const appLayer = Layer.mergeAll(
  ConfigServiceLive,
  ContextEngineLive,
  AgentRunnerLive,
).pipe(Layer.provideMerge(testLayer))
const fullLayer = LoopRunnerLive.pipe(Layer.provideMerge(appLayer))

test("dry-run loop writes one prompt per iteration", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* ContextEngine
      const loop = yield* LoopRunner
      yield* engine.writeFeatureFile("demo", "SPEC.md", "build a demo")
      const config: RalphConfig = {
        agent: "echo",
        agentArgs: [],
        maxIterations: 3,
        iterationTimeoutMs: 10000,
        autoCommit: false,
        completionMarker: "RALPH_DONE",
        contextBudgetChars: 4000,
      }
      return yield* loop.run({ feature: "demo", config, dryRun: true })
    }).pipe(Effect.provide(fullLayer)),
  )
  expect(result.iterations).toBe(3)
  expect(result.completed).toBe(false)
  expect(result.stoppedReason).toBe("dry-run complete")
})

test("loop stops when completion marker appears in PROGRESS.md", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* ContextEngine
      const loop = yield* LoopRunner
      yield* engine.writeFeatureFile("done", "SPEC.md", "already done")
      yield* engine.writeFeatureFile(
        "done",
        "PROGRESS.md",
        "# Progress\n\n## Iteration 1\n- did it\nRALPH_DONE\n",
      )
      const config: RalphConfig = {
        agent: "echo",
        agentArgs: [],
        maxIterations: 10,
        iterationTimeoutMs: 10000,
        autoCommit: false,
        completionMarker: "RALPH_DONE",
        contextBudgetChars: 4000,
      }
      return yield* loop.run({ feature: "done", config, dryRun: false })
    }).pipe(Effect.provide(fullLayer)),
  )
  expect(result.completed).toBe(true)
  expect(result.iterations).toBe(1)
  expect(result.stoppedReason).toContain("completion marker")
})
