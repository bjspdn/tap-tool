import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigService, ConfigServiceLive, RalphPaths } from "./Config.ts"
import { ContextEngine, ContextEngineLive } from "./ContextEngine.ts"

const withTempRoot = <A, E>(
  program: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ConfigService | ContextEngine | RalphPaths>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const tmp = yield* fs.makeTempDirectoryScoped()
    const tempPaths = Layer.succeed(RalphPaths, {
      root: tmp,
      ralphDir: path.join(tmp, ".ralph"),
      configFile: path.join(tmp, ".ralph", "config.json"),
      featureDir: (name) => path.join(tmp, ".ralph", "features", name),
      featureFile: (name, file) =>
        path.join(tmp, ".ralph", "features", name, file),
      logsDir: (name) => path.join(tmp, ".ralph", "features", name, "logs"),
    })
    const coreLayer = Layer.mergeAll(ConfigServiceLive, ContextEngineLive).pipe(
      Layer.provideMerge(tempPaths),
      Layer.provideMerge(BunContext.layer),
    )
    return yield* program(tmp).pipe(Effect.provide(coreLayer))
  }).pipe(Effect.scoped, Effect.provide(BunContext.layer))

test("render produces a prompt containing the feature name, spec, and iteration", async () => {
  const prompt = await Effect.runPromise(
    withTempRoot((_root) =>
      Effect.gen(function* () {
        const engine = yield* ContextEngine
        const cfg = yield* ConfigService
        yield* engine.writeFeatureFile(
          "alpha",
          "SPEC.md",
          "# Feature: alpha\n\nSay hello.\n",
        )
        yield* engine.writeFeatureFile(
          "alpha",
          "PLAN.md",
          "# Plan\n- [ ] say hi\n",
        )
        const ctx = yield* engine.gather({
          feature: "alpha",
          iteration: 3,
          previousOutput: null,
          config: cfg.default,
        })
        return engine.render(ctx, cfg.default)
      }),
    ),
  )

  expect(prompt).toContain("Feature: alpha")
  expect(prompt).toContain("Iteration: 3")
  expect(prompt).toContain("Say hello.")
  expect(prompt).toContain("RALPH_DONE")
  expect(prompt).toContain("say hi")
})

test("config load returns defaults when no config file exists", async () => {
  const cfg = await Effect.runPromise(
    withTempRoot(() =>
      Effect.gen(function* () {
        const svc = yield* ConfigService
        return yield* svc.load
      }),
    ),
  )
  expect(cfg.agent).toBe("claude")
  expect(cfg.completionMarker).toBe("RALPH_DONE")
  expect(cfg.maxIterations).toBeGreaterThan(0)
})

test("config save/load round trip", async () => {
  const cfg = await Effect.runPromise(
    withTempRoot(() =>
      Effect.gen(function* () {
        const svc = yield* ConfigService
        yield* svc.save({
          ...svc.default,
          agent: "cursor-agent",
          maxIterations: 7,
          completionMarker: "ALL_DONE",
        })
        return yield* svc.load
      }),
    ),
  )
  expect(cfg.agent).toBe("cursor-agent")
  expect(cfg.maxIterations).toBe(7)
  expect(cfg.completionMarker).toBe("ALL_DONE")
})
