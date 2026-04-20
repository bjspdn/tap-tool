import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer, Schema } from "effect"

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()(
  "ConfigParseError",
  { path: Schema.String, message: Schema.String },
) {}

export const AgentKind = Schema.Literal("claude", "cursor-agent", "echo")
export type AgentKind = typeof AgentKind.Type

export const RalphConfig = Schema.Struct({
  agent: Schema.optionalWith(AgentKind, { default: () => "claude" as const }),
  agentArgs: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [] as ReadonlyArray<string>,
  }),
  maxIterations: Schema.optionalWith(Schema.Int, { default: () => 25 }),
  iterationTimeoutMs: Schema.optionalWith(Schema.Int, {
    default: () => 15 * 60 * 1000,
  }),
  autoCommit: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  completionMarker: Schema.optionalWith(Schema.String, {
    default: () => "RALPH_DONE",
  }),
  contextBudgetChars: Schema.optionalWith(Schema.Int, {
    default: () => 16000,
  }),
})
export type RalphConfig = typeof RalphConfig.Type

const DEFAULT_CONFIG: RalphConfig = {
  agent: "claude",
  agentArgs: [],
  maxIterations: 25,
  iterationTimeoutMs: 15 * 60 * 1000,
  autoCommit: false,
  completionMarker: "RALPH_DONE",
  contextBudgetChars: 16000,
}

export class RalphPaths extends Context.Tag("RalphPaths")<
  RalphPaths,
  {
    readonly root: string
    readonly ralphDir: string
    readonly configFile: string
    readonly featureDir: (name: string) => string
    readonly featureFile: (name: string, file: string) => string
    readonly logsDir: (name: string) => string
  }
>() {}

export const RalphPathsLive = Layer.effect(
  RalphPaths,
  Effect.gen(function* () {
    const path = yield* Path.Path
    const root = process.cwd()
    const ralphDir = path.join(root, ".ralph")
    return {
      root,
      ralphDir,
      configFile: path.join(ralphDir, "config.json"),
      featureDir: (name) => path.join(ralphDir, "features", name),
      featureFile: (name, file) =>
        path.join(ralphDir, "features", name, file),
      logsDir: (name) => path.join(ralphDir, "features", name, "logs"),
    }
  }),
)

export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<RalphConfig, ConfigParseError>
    readonly save: (cfg: RalphConfig) => Effect.Effect<void>
    readonly default: RalphConfig
  }
>() {}

export const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* RalphPaths
    const decode = Schema.decodeUnknown(RalphConfig)

    return {
      default: DEFAULT_CONFIG,
      load: Effect.gen(function* () {
        const exists = yield* fs.exists(paths.configFile).pipe(
          Effect.orElseSucceed(() => false),
        )
        if (!exists) return DEFAULT_CONFIG
        const raw = yield* fs.readFileString(paths.configFile).pipe(
          Effect.mapError(
            (e) =>
              new ConfigParseError({
                path: paths.configFile,
                message: String(e),
              }),
          ),
        )
        const parsed = yield* Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: (e) =>
            new ConfigParseError({
              path: paths.configFile,
              message: `Invalid JSON: ${String(e)}`,
            }),
        })
        return yield* decode(parsed).pipe(
          Effect.mapError(
            (e) =>
              new ConfigParseError({
                path: paths.configFile,
                message: String(e),
              }),
          ),
        )
      }),
      save: (cfg) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(paths.ralphDir, { recursive: true }).pipe(
            Effect.orElseSucceed(() => void 0),
          )
          yield* fs.writeFileString(
            paths.configFile,
            JSON.stringify(cfg, null, 2) + "\n",
          )
        }).pipe(Effect.orDie),
    }
  }),
)
