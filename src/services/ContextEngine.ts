import { Command, CommandExecutor, FileSystem } from "@effect/platform"
import { Context, Effect, Layer } from "effect"
import { RalphPaths, type RalphConfig } from "./Config.ts"

export interface FeatureContext {
  readonly feature: string
  readonly spec: string
  readonly plan: string
  readonly progress: string
  readonly scratchpad: string
  readonly gitStatus: string
  readonly iteration: number
  readonly previousOutput: string | null
}

export interface BuildPromptArgs {
  readonly feature: string
  readonly iteration: number
  readonly previousOutput: string | null
  readonly config: RalphConfig
}

export class ContextEngine extends Context.Tag("ContextEngine")<
  ContextEngine,
  {
    readonly gather: (
      args: BuildPromptArgs,
    ) => Effect.Effect<FeatureContext, never>
    readonly render: (
      ctx: FeatureContext,
      cfg: RalphConfig,
    ) => string
    readonly appendProgress: (
      feature: string,
      entry: string,
    ) => Effect.Effect<void>
    readonly readFeatureFile: (
      feature: string,
      file: string,
    ) => Effect.Effect<string>
    readonly writeFeatureFile: (
      feature: string,
      file: string,
      contents: string,
    ) => Effect.Effect<void>
  }
>() {}

const readOr = (fs: FileSystem.FileSystem, p: string, fallback: string) =>
  fs.exists(p).pipe(
    Effect.orElseSucceed(() => false),
    Effect.flatMap((exists) =>
      exists
        ? fs.readFileString(p).pipe(Effect.orElseSucceed(() => fallback))
        : Effect.succeed(fallback),
    ),
  )

export const ContextEngineLive = Layer.effect(
  ContextEngine,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* RalphPaths
    const executor = yield* CommandExecutor.CommandExecutor

    const runGit = (args: ReadonlyArray<string>) =>
      Command.string(Command.make("git", ...args)).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
        Effect.orElseSucceed(() => ""),
      )

    const truncate = (s: string, max: number): string => {
      if (s.length <= max) return s
      const head = Math.floor(max * 0.6)
      const tail = max - head - 40
      return (
        s.slice(0, head) +
        `\n\n... [truncated ${s.length - max} chars] ...\n\n` +
        s.slice(s.length - Math.max(tail, 0))
      )
    }

    return {
      gather: ({ feature, iteration, previousOutput }) =>
        Effect.gen(function* () {
          const spec = yield* readOr(
            fs,
            paths.featureFile(feature, "SPEC.md"),
            "(no SPEC.md yet — describe the feature in this file)",
          )
          const plan = yield* readOr(
            fs,
            paths.featureFile(feature, "PLAN.md"),
            "(no PLAN.md yet — the agent should populate it)",
          )
          const progress = yield* readOr(
            fs,
            paths.featureFile(feature, "PROGRESS.md"),
            "(no progress entries yet)",
          )
          const scratchpad = yield* readOr(
            fs,
            paths.featureFile(feature, "SCRATCHPAD.md"),
            "(empty)",
          )
          const gitStatus = yield* runGit(["status", "--short"])
          return {
            feature,
            spec,
            plan,
            progress,
            scratchpad,
            gitStatus,
            iteration,
            previousOutput,
          }
        }),

      render: (ctx, cfg) => {
        const budget = cfg.contextBudgetChars
        const perSection = Math.floor(budget / 5)
        const progressTail = truncate(ctx.progress, perSection)
        const specText = truncate(ctx.spec, perSection)
        const planText = truncate(ctx.plan, perSection)
        const scratchpadText = truncate(ctx.scratchpad, perSection)
        const prevOutput = ctx.previousOutput
          ? truncate(ctx.previousOutput, perSection)
          : "(no previous iteration)"

        return [
          `# Ralph Loop — Feature: ${ctx.feature}`,
          `Iteration: ${ctx.iteration}`,
          ``,
          `You are running inside a "ralph loop": an autonomous feature-implementation`,
          `loop. Each iteration you get the same context refreshed from disk. Make`,
          `concrete, incremental progress each turn and record what you did.`,
          ``,
          `## Operating contract`,
          `- Edit source files directly using your normal tools.`,
          `- Update \`.ralph/features/${ctx.feature}/PLAN.md\` if the plan should change.`,
          `- Append a short bullet list of what you actually changed to`,
          `  \`.ralph/features/${ctx.feature}/PROGRESS.md\` under a new \`## Iteration ${ctx.iteration}\` heading.`,
          `- You may use \`.ralph/features/${ctx.feature}/SCRATCHPAD.md\` for free-form notes.`,
          `- When (and only when) the feature is fully implemented and tests pass,`,
          `  append the exact marker \`${cfg.completionMarker}\` on its own line at the end of PROGRESS.md.`,
          `- Do NOT emit the marker early. Keep iterating until the spec is satisfied.`,
          `- Do not delete existing progress entries.`,
          ``,
          `## SPEC.md`,
          specText,
          ``,
          `## PLAN.md`,
          planText,
          ``,
          `## PROGRESS.md (previous iterations)`,
          progressTail,
          ``,
          `## SCRATCHPAD.md`,
          scratchpadText,
          ``,
          `## git status`,
          ctx.gitStatus || "(clean)",
          ``,
          `## Previous iteration output (tail)`,
          prevOutput,
          ``,
          `## This iteration`,
          `Pick the next smallest actionable step from PLAN.md (or create the plan if`,
          `it is missing). Implement it. Run or update tests where relevant. Then`,
          `append a concise \`## Iteration ${ctx.iteration}\` section to PROGRESS.md`,
          `summarizing what you changed and what's next.`,
          ``,
        ].join("\n")
      },

      appendProgress: (feature, entry) =>
        Effect.gen(function* () {
          const dir = paths.featureDir(feature)
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(
            Effect.orElseSucceed(() => void 0),
          )
          const file = paths.featureFile(feature, "PROGRESS.md")
          const prev = yield* readOr(fs, file, "")
          const next = prev + (prev.endsWith("\n") || prev === "" ? "" : "\n") + entry
          yield* fs.writeFileString(file, next).pipe(Effect.orDie)
        }),

      readFeatureFile: (feature, file) =>
        readOr(fs, paths.featureFile(feature, file), ""),

      writeFeatureFile: (feature, file, contents) =>
        Effect.gen(function* () {
          const dir = paths.featureDir(feature)
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(
            Effect.orElseSucceed(() => void 0),
          )
          yield* fs.writeFileString(
            paths.featureFile(feature, file),
            contents,
          ).pipe(Effect.orDie)
        }),
    }
  }),
)
