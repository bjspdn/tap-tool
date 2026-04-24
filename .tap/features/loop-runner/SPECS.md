# loop-runner

<feature:goal>
Replace the ad-hoc scheduling driver at `scripts/bootstrap.ts` with a proper Effect-based `LoopRunner` service that orchestrates the per-task attempt loop over a schema-validated `FeatureContract`. Resolves the five limitations listed in `scripts/bootstrap.ts` L11–L15 and the two `RunTask.ts` L129/L130 TODOs that block judged-retry from working end-to-end. Scoped as a single vertical slice because `LoopRunner` calls `FeatureContract` on every transition.
</feature:goal>

<feature:context>

**Code being replaced.** `scripts/bootstrap.ts` is a 200-line driver with ad-hoc JSON I/O, in-memory topo pick, and no schema validation, atomic writes, or retry-state threading. Its top-of-file JSDoc enumerates exactly the five gaps this feature closes.

**Downstream call site.** `src/services/RunTask.ts` already implements one Composer → Reviewer → verdict pipeline. Two TODOs at L129/L130 default `priorEval: Option.none()` and `gitStatus: ""` pending LoopRunner. This feature makes both real.

**Existing services (house style to match):** `src/services/AgentRunner/`, `src/services/ContextEngine.ts`, `src/services/EvalParser.ts` — all follow `Context.Tag` subclass + `Layer.effect` Live + `Layer.succeed` Fake + lowercase-verb error constructors + barrel `index.ts` for multi-file services.

**Ambient type files to extend:** `src/types/LoopRunner.d.ts` (currently a stub for `LoopOptions` / `LoopSummary`), `src/types/Contract.d.ts` (declares `Task`, `Story`, `Feature`, `Brand<T,B>`, `TaskId`, `StoryId`, `AbsolutePath`).

**Example contract.** `.tap/features/composer-reviewer/FEATURE_CONTRACT.json` is the on-disk shape `FeatureContract.load` must accept and round-trip.

**Bootstrappability constraint.** Every task must be buildable under the current driver (`scripts/bootstrap.ts` + `runTask` + agents/skills on disk today). No task may depend on `LoopRunner` or `FeatureContract` existing mid-flight. The build order and `depends_on` graph enforce this: S7 (retire bootstrap.ts) is the last task, after which bootstrap.ts becomes the shim.

</feature:context>

<feature:constraints>

- **Services are `Context.Tag` subclasses with Live and optional Fake layers.** Error channels are tagged unions (`_tag` discriminator) built via lowercase-verb constructor helpers (e.g. `filesystemError(path, cause)`).
- **Live layers may capture `FileSystem.FileSystem` at construction (`Layer.effect`); Fake layers acquire it per-call (`Layer.succeed` with `yield*` inside the method)** — matches `AgentRunnerEcho` pattern so fake + `BunContext.layer` compose with no residual `R`.
- **All absence uses `Option<T>` (from `effect`), never `T | undefined | null`.** All path fields use the ambient `AbsolutePath` brand.
- **All new types under `src/types/*.d.ts` as ambient globals.** If an import is needed, wrap the whole file in `declare global { ... }` (same pattern as `LoopRunner.d.ts`, `ContextEngine.d.ts`).
- **Tests in sibling `__tests__/` folders, named `<SourceName>.test.ts`.**
- **No `any`, no `as unknown as`.** Brand-construction uses a single narrow `brand<B>(s)` helper with one `as` cast at the boundary (pattern already in `src/services/brand.ts`).
- **Schema uses `effect`'s built-in `Schema` module** (via `import { Schema } from "effect"`) — `effect@3.21.1` exposes it; no separate `@effect/schema` pin needed.
- **Contract save is naked `writeFileString`.** Atomic temp-and-rename deferred to the future sandbox feature, because sandbox filesystem isolation (chroot/bwrap/container) may break cross-mount `rename`. Torn-write recovery = `git checkout` the contract.
- **`gitStatus` is captured via `CommandExecutor.string(Command.make("git","status","--short"))` in a narrow helper at `src/services/LoopRunner/gitStatus.ts`.** Non-zero exit (e.g. not a repo) returns empty string, not a failure. No new `Git` service — promote only if a second caller arrives.
- **Prior-eval threading is archive-per-attempt.** Before retry N, `archive(evalResultPath, archive/<taskId>/iter-NNN-EVAL_RESULT.md)`; the archived file's path is passed into `ComposerRenderInput.priorEval` as `Option.some(path)`. Keeps audit trail, survives crashes, reuses Composer's existing `prior_eval_path` handling.
- **Exhausted-attempts = halt-with-progress-preserved.** First task hitting `maxAttempts` marks `status: "failed"`, saves contract, halts the loop, prints a resume-hint to stdout. Re-running picks up from the preserved state (failed tasks are not schedulable; user resets status + attempts manually or bumps maxAttempts).
- **Dep-cycle detection at load time** (per `DESIGN.md` §4). `FeatureContract.load` walks the `depends_on` graph and raises a tagged `ContractCycleDetected` variant; never enter the loop with an invalid contract.
- **Serial execution v0.** No `maxConcurrency`; parallelism is a later feature.
- **No CLI in scope.** The `tap run <slug>` command is a separate feature. This feature ships the service plus a shrunken `scripts/bootstrap.ts` shim as the continuing entry point.
- **This feature does not add:** atomic writes (v1), CLI commands, parallel execution, dry-run mode, or VCS auto-commit. Resist scope creep.

</feature:constraints>

<feature:shape>

```
scripts/bootstrap.ts  (after S7 — ~15-line shim)
    │ parse argv(featureSlug)
    │ compose appLayer:
    │   LoopRunnerLive + FeatureContractLive + RunTaskLive +
    │   ContextEngineLive + EvalParserLive + AgentRunnerLive
    │   on top of BunContext.layer
    │ yield* LoopRunner.run(contractPath)
    │ print LoopSummary (+ resume hint if halted)
    ▼
┌───────────────────────────────────────────────────────────────────┐
│ LoopRunner.run(contractPath: AbsolutePath)                        │
│   → Effect<LoopSummary, LoopRunError, R>                          │
│                                                                   │
│  1. FeatureContract.load(contractPath)                            │
│     · JSON parse → Schema decode → cycle check                    │
│     · fail with Contract{Read,InvalidJson,Schema,Cycle}Failed     │
│  2. loop (bounded by MAX_ITERATIONS = 100 safety cap):            │
│     a. feature = current state                                    │
│     b. task = FeatureContract.nextReady(feature)  // Option<Task> │
│        · none → break with stoppedReason=AllDone|NoReadyTasks     │
│     c. attempt = task.attempts + 1                                │
│     d. feature = incrementAttempt(feature, task.id)               │
│              = markStatus(feature, task.id, "in_progress")        │
│        save(feature)                                              │
│     e. priorEvalPath = attempt > 1                                │
│        ? Option.some(archive(eval/EVAL_RESULT.md,                 │
│                              eval/archive/<task.id>/              │
│                              iter-{attempt-1:03}-EVAL_RESULT.md)) │
│        : Option.none()                                            │
│     f. gitStatus = captureGitStatus(featureRoot)                  │
│     g. outcome = RunTask.run(task, feature, {                     │
│          featureRoot, specsPath, contractPath, attempt,           │
│          priorEvalPath, gitStatus                                 │
│        })                                                         │
│     h. outcome matched:                                           │
│        · Success + PASS → markStatus("done") + save + continue    │
│        · Success + FAIL + attempt<max → save + continue           │
│        · Success + FAIL + attempt==max → markStatus("failed")     │
│                                          + save + halt            │
│        · Error (spawn/max-turns/eval-missing/etc)                 │
│            + attempt<max → save + continue                        │
│            + attempt==max → markStatus("failed") + save + halt    │
│  3. emit LoopSummary + print resume hint if tasksFailed non-empty │
└──┬────────────────┬──────────────┬──────────────┬─────────────────┘
   ▼                ▼              ▼              ▼
FeatureContract  RunTask    gitStatus.ts    archive.ts
  · load          (Tag)     (Effect fn)     (Effect fn)
  · save          wraps
  · nextReady     existing
  · markStatus    runTask
  · incrementAttempt
```

**Resume hint format (printed on halt):**

```
[loop-runner] feature "loop-runner" halted — 1 task failed, 3 done, 2 pending.

Failed tasks (exhausted maxAttempts):
  · S2.T3  "Implement FeatureContract.save"

To resume:
  1. Edit .tap/features/loop-runner/FEATURE_CONTRACT.json
  2. For each failed task, set "status": "pending" and "attempts": 0
     (or bump "maxAttempts" if you want more retries without a reset)
  3. Optionally amend the task's "acceptance" array with what the last
     EVAL_RESULT.md flagged — see eval/archive/<taskId>/
  4. Re-run: bun run scripts/bootstrap.ts loop-runner
```

**`LoopSummary` shape (populates the stub at `src/types/LoopRunner.d.ts`):**

```ts
interface LoopSummary {
  readonly feature: string;
  readonly iterations: number;
  readonly completed: boolean;
  readonly stoppedReason:
    | { readonly _tag: "AllDone" }
    | { readonly _tag: "TaskExhausted"; readonly failedTaskIds: ReadonlyArray<TaskId> }
    | { readonly _tag: "MaxIterations"; readonly cap: number }
    | { readonly _tag: "NoReadyTasks"; readonly remaining: ReadonlyArray<TaskId> };
  readonly tasksDone: ReadonlyArray<TaskId>;
  readonly tasksFailed: ReadonlyArray<TaskId>;
  readonly tasksPending: ReadonlyArray<TaskId>;
}
```

**`FeatureContractError` shape (new `src/types/FeatureContract.d.ts`):**

```ts
type FeatureContractError =
  | { readonly _tag: "ContractReadFailed"; readonly path: AbsolutePath; readonly cause: unknown }
  | { readonly _tag: "ContractInvalidJson"; readonly path: AbsolutePath; readonly cause: unknown }
  | { readonly _tag: "ContractSchemaFailed"; readonly path: AbsolutePath; readonly issues: string }
  | { readonly _tag: "ContractCycleDetected"; readonly path: AbsolutePath; readonly cycle: ReadonlyArray<TaskId> }
  | { readonly _tag: "ContractWriteFailed"; readonly path: AbsolutePath; readonly cause: unknown };
```

**`FeatureContract` service surface:**

```ts
class FeatureContract extends Context.Tag("FeatureContract")<
  FeatureContract,
  {
    readonly load: (path: AbsolutePath) => Effect.Effect<Feature, FeatureContractError>;
    readonly save: (path: AbsolutePath, feature: Feature) => Effect.Effect<void, FeatureContractError>;
    readonly nextReady: (feature: Feature) => Option.Option<Task>;
    readonly markStatus: (feature: Feature, taskId: TaskId, status: TaskStatus) => Feature;
    readonly incrementAttempt: (feature: Feature, taskId: TaskId) => Feature;
  }
>() {}
```

**`RunTask` Tag surface (after S2 refactor):**

```ts
class RunTask extends Context.Tag("RunTask")<
  RunTask,
  {
    readonly run: (
      task: Task,
      feature: Feature,
      paths: RunTaskPaths,
    ) => Effect.Effect<TaskResult, RunTaskError, AgentRunner | ContextEngine | EvalParser | FileSystem.FileSystem>;
  }
>() {}

// RunTaskPaths grows two fields:
type RunTaskPaths = {
  readonly featureRoot: AbsolutePath;
  readonly specsPath: AbsolutePath;
  readonly contractPath: AbsolutePath;
  readonly attempt: number;
  readonly priorEvalPath: Option.Option<AbsolutePath>;  // NEW — drives ComposerRenderInput.priorEval
  readonly gitStatus: string;                           // NEW — drives ComposerRenderInput.gitStatus
};
```

</feature:shape>

<feature:failure_modes>

- **Malformed `FEATURE_CONTRACT.json` at load.** Tagged `ContractInvalidJson` (parse failure) or `ContractSchemaFailed` (Schema decode failure) surfaces with the path. Loop never starts. User fixes JSON manually.
- **Cycle in `depends_on` graph.** Detected at load time. `ContractCycleDetected` carries the cycle's task ids so the user can locate it. Loop never starts.
- **Torn contract write** (process killed mid-save). Accepted v0 failure mode. Recovery: `git checkout .tap/features/<slug>/FEATURE_CONTRACT.json` then re-run. Revisit when sandbox feature lands.
- **First task exhausts `maxAttempts`.** Marked `failed`, contract saved with progress preserved, loop halts with resume hint. User chooses: amend acceptance, bump `maxAttempts`, reset status.
- **`git status --short` fails** (not a repo, git not on PATH). `gitStatus` helper swallows non-zero exit and returns empty string. Composer still renders; loop continues.
- **`MAX_ITERATIONS` safety cap hit** (100). Defense against scheduler bugs — under normal operation bounded by `maxAttempts × task count`. Surfaces as `LoopSummary.stoppedReason = MaxIterations`. If seen in practice, it's a bug.
- **Scheduler finds no ready task while pending tasks remain** (all blocked on `failed` dependencies). Surfaces as `NoReadyTasks` with the blocked id list so the user can see what's stuck.
- **AgentRunner errors during a retry** (spawn fail, max turns). Handled identically to a FAIL verdict: count against `attempts`, retry if budget remains, halt-with-failed if exhausted. No special case for agent errors vs eval errors.

</feature:failure_modes>

<feature:open_questions>

- **Atomic contract writes.** Deferred until the sandbox feature (`--dangerously-skip-permissions` isolation) lands. At that point we pick an atomicity strategy compatible with the sandbox filesystem topology (temp-same-directory-rename works only if temp and target share a mount point inside the sandbox). Revisit as the first sub-task of the sandbox feature.
- **Dry-run mode.** No `--dry-run` flag on `bootstrap.ts` or `LoopRunner.run`. If debugging contract state without executing agents becomes painful, add it as its own ticket. Revisit if users ask.
- **`tap run <slug>` CLI.** Out of scope. Separate feature with `@effect/cli` wiring. `bootstrap.ts` stays as the entry point until that lands. Revisit once the CLI feature is planned.
- **Skip-and-continue exhaustion policy.** Not in v0 (locked on halt-with-resume). Revisit if dogfooding surfaces a pattern where one stuck task commonly blocks many unrelated ones and manual reset is painful.
- **Parallelism (`maxConcurrency`).** Explicitly v1 per `DESIGN.md` §5.3. Revisit when serial execution produces a concrete pain point.
- **Git status via a dedicated `Git` service.** Deferred until a second caller appears. Revisit when sandbox feature needs a swappable git strategy or when another service needs `git diff`, `git log`, etc.

</feature:open_questions>
