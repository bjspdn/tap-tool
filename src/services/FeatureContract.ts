import { Context, Effect, Layer, Option, ParseResult, Schema } from "effect";
import { FileSystem } from "@effect/platform";

// ---------------------------------------------------------------------------
// Schemas (S5.T1)
// ---------------------------------------------------------------------------

// Schema.filter with an identity `is` predicate refines Schema.Type to the ambient Brand<T,B> shape in Contract.d.ts.
// Schema.brand is intentionally NOT used — it produces a different (effect/Brand symbol-based) brand that does not structurally match the ambient __brand property.
export const TaskIdSchema = Schema.String.pipe(Schema.filter((_s): _s is TaskId => true));
export const StoryIdSchema = Schema.String.pipe(Schema.filter((_s): _s is StoryId => true));
export const AbsolutePathSchema = Schema.String.pipe(Schema.filter((_s): _s is AbsolutePath => true));

export const TaskStatusSchema = Schema.Literal("pending", "in_progress", "done", "failed");

/*
@contract-deviation
{
  "criterion_ref": "S1.T3.acceptance[0]",
  "invalidity": "criterion-conflict",
  "evidence": "S1.T3 acceptance[0] prescribes Schema.OptionFromNullOr(Schema.String). S1.T3 acceptance[1] requires two dual-form decode tests that feed Effect Option JSON wire shapes ({\"_id\":\"Option\",\"_tag\":\"None\"} and {\"_id\":\"Option\",\"_tag\":\"Some\",\"value\":\"...\"}) directly to AcceptanceCriterionSchema. Schema.OptionFromNullOr decodes only null → None; it rejects the Effect Option JSON form, so both decode tests fail. Additionally, the save→load roundtrip test (FeatureContract.test.ts lines 261–310) writes a Feature containing Option.none() via fc.save; JSON.stringify(Option.none()) produces {\"_id\":\"Option\",\"_tag\":\"None\"}, which Schema.OptionFromNullOr cannot decode on the subsequent fc.load. Using Schema.OptionFromNullOr satisfies acceptance[0] but breaks acceptance[1].",
  "substitution": "Schema.Option(Schema.String) — decodes the Effect Option JSON wire format ({\"_id\":\"Option\",\"_tag\":\"None\"} and {\"_id\":\"Option\",\"_tag\":\"Some\",\"value\":\"...\"}) required by the criterion-1 tests and the roundtrip test. Legacy plain-string criteria are still rejected; the Schema.Union wrapper is still absent.",
  "behavioral_preserved_ref": "S1.T3.acceptance[1]"
}
*/

/*
@contract-deviation
{
  "criterion_ref": "S1.T3.acceptance[2]",
  "invalidity": "global-constraint-conflict",
  "evidence": "S1.T3.task.files lists only src/services/FeatureContract.ts, src/services/__tests__/FeatureContract.test.ts, and src/services/LoopRunner/__tests__/LoopRunner.smoke.test.ts. Acceptance[2] requires all three .tap/features/<slug>/FEATURE_CONTRACT.json files to decode under Schema.Option. Schema.Option rejects null; S1.T2 encoded every mechanism field as null when no mechanism was present. Satisfying acceptance[2] requires re-encoding those null values to Effect Option wire format ({\"_id\":\"Option\",\"_tag\":\"None\"}) in .tap/features/composer-reviewer/FEATURE_CONTRACT.json and .tap/features/loop-runner/FEATURE_CONTRACT.json — both outside task.files. The task-files scope constraint directly conflicts with acceptance[2].",
  "substitution": "Re-encoded mechanism: null to {\"_id\":\"Option\",\"_tag\":\"None\"} in .tap/features/composer-reviewer/FEATURE_CONTRACT.json and .tap/features/loop-runner/FEATURE_CONTRACT.json so all three contracts decode under Schema.Option.",
  "behavioral_preserved_ref": "S1.T3.acceptance[2]"
}
*/
// Strict dual-form only (S1.T3). Schema.Option decodes the Effect Option JSON wire
// format produced by JSON.stringify(Option.none()/Option.some(...)). Legacy plain-string
// criteria are rejected because Schema.Struct does not accept bare strings.
export const AcceptanceCriterionSchema = Schema.Struct({
  behavioral: Schema.String,
  mechanism: Schema.Option(Schema.String),
});

export const TaskSchema = Schema.Struct({
  id: TaskIdSchema,
  title: Schema.String,
  files: Schema.Array(AbsolutePathSchema),
  acceptance: Schema.Array(AcceptanceCriterionSchema),
  depends_on: Schema.Array(TaskIdSchema),
  status: TaskStatusSchema,
  attempts: Schema.Number,
  maxAttempts: Schema.Number,
});

export const StorySchema = Schema.Struct({
  id: StoryIdSchema,
  title: Schema.String,
  acceptance: Schema.Array(AcceptanceCriterionSchema),
  tasks: Schema.Array(TaskSchema),
});

export const FeatureSchema = Schema.Struct({
  feature: Schema.String,
  goal: Schema.String,
  constraints: Schema.Array(Schema.String),
  stories: Schema.Array(StorySchema),
});

// ---------------------------------------------------------------------------
// Error constructors
// ---------------------------------------------------------------------------

const contractReadFailed = (path: AbsolutePath, cause: unknown): FeatureContractError => ({
  _tag: "ContractReadFailed",
  path,
  cause,
});

const contractInvalidJson = (path: AbsolutePath, cause: unknown): FeatureContractError => ({
  _tag: "ContractInvalidJson",
  path,
  cause,
});

const contractSchemaFailed = (path: AbsolutePath, issues: string): FeatureContractError => ({
  _tag: "ContractSchemaFailed",
  path,
  issues,
});

const contractCycleDetected = (path: AbsolutePath, cycle: ReadonlyArray<TaskId>): FeatureContractError => ({
  _tag: "ContractCycleDetected",
  path,
  cycle,
});

const contractWriteFailed = (path: AbsolutePath, cause: unknown): FeatureContractError => ({
  _tag: "ContractWriteFailed",
  path,
  cause,
});

// ---------------------------------------------------------------------------
// findCycle — DFS over depends_on graph; returns cycle path or empty array
// ---------------------------------------------------------------------------

/**
 * Detects dependency cycles in the feature contract.
 * Returns the cycle as a ReadonlyArray<TaskId> (with the entry node repeated at end),
 * or an empty array if no cycle exists.
 */
export const findCycle = (feature: Feature): ReadonlyArray<TaskId> => {
  const allTasks = feature.stories.flatMap((s) => s.tasks);
  const deps = new Map<TaskId, ReadonlyArray<TaskId>>();
  for (const task of allTasks) {
    deps.set(task.id, task.depends_on);
  }

  const visited = new Set<TaskId>();
  const inStack = new Set<TaskId>();
  const stack: TaskId[] = [];

  const dfs = (id: TaskId): ReadonlyArray<TaskId> | null => {
    if (inStack.has(id)) {
      const idx = stack.indexOf(id);
      return [...stack.slice(idx), id];
    }
    if (visited.has(id)) return null;

    visited.add(id);
    inStack.add(id);
    stack.push(id);

    for (const child of deps.get(id) ?? []) {
      const cycle = dfs(child);
      if (cycle !== null) return cycle;
    }

    stack.pop();
    inStack.delete(id);
    return null;
  };

  for (const task of allTasks) {
    if (!visited.has(task.id)) {
      const cycle = dfs(task.id);
      if (cycle !== null) return cycle;
    }
  }

  return [];
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns the first schedulable task: (pending | in_progress) && attempts < maxAttempts
 * && all depends_on are done. `failed` tasks are not schedulable and do not contribute
 * to the doneIds set.
 */
export const nextReady = (feature: Feature): Option.Option<Task> => {
  const allTasks = feature.stories.flatMap((s) => s.tasks);
  const doneIds = new Set(
    allTasks.filter((t) => t.status === "done").map((t) => t.id),
  );
  const ready = allTasks.find(
    (t) =>
      (t.status === "pending" || t.status === "in_progress") &&
      t.attempts < t.maxAttempts &&
      t.depends_on.every((dep) => doneIds.has(dep)),
  );
  return ready !== undefined ? Option.some(ready) : Option.none();
};

/**
 * Returns a new Feature with the named task's status updated. Immutable.
 */
export const markStatus = (
  feature: Feature,
  taskId: TaskId,
  status: TaskStatus,
): Feature => ({
  ...feature,
  stories: feature.stories.map((story) => ({
    ...story,
    tasks: story.tasks.map((task) =>
      task.id === taskId ? { ...task, status } : task,
    ),
  })),
});

/**
 * Returns a new Feature with the named task's attempt count incremented. Immutable.
 */
export const incrementAttempt = (feature: Feature, taskId: TaskId): Feature => ({
  ...feature,
  stories: feature.stories.map((story) => ({
    ...story,
    tasks: story.tasks.map((task) =>
      task.id === taskId ? { ...task, attempts: task.attempts + 1 } : task,
    ),
  })),
});

// ---------------------------------------------------------------------------
// FeatureContract Tag
// ---------------------------------------------------------------------------

export class FeatureContract extends Context.Tag("FeatureContract")<
  FeatureContract,
  {
    readonly load: (path: AbsolutePath) => Effect.Effect<Feature, FeatureContractError>;
    readonly save: (path: AbsolutePath, feature: Feature) => Effect.Effect<void, FeatureContractError>;
    readonly nextReady: (feature: Feature) => Option.Option<Task>;
    readonly markStatus: (feature: Feature, taskId: TaskId, status: TaskStatus) => Feature;
    readonly incrementAttempt: (feature: Feature, taskId: TaskId) => Feature;
  }
>() {}

// ---------------------------------------------------------------------------
// FeatureContractLive
// ---------------------------------------------------------------------------

export const FeatureContractLive: Layer.Layer<FeatureContract, never, FileSystem.FileSystem> =
  Layer.effect(
    FeatureContract,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const load = (path: AbsolutePath): Effect.Effect<Feature, FeatureContractError> =>
        Effect.gen(function* () {
          const raw = yield* fs.readFileString(path).pipe(
            Effect.mapError((cause) => contractReadFailed(path, cause)),
          );

          const parsed: unknown = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (cause) => contractInvalidJson(path, cause),
          });

          const feature = yield* Schema.decodeUnknown(FeatureSchema)(parsed).pipe(
            Effect.mapError((parseError) =>
              contractSchemaFailed(
                path,
                ParseResult.TreeFormatter.formatErrorSync(parseError),
              ),
            ),
          );

          const cycle = findCycle(feature);
          if (cycle.length > 0) {
            return yield* Effect.fail(contractCycleDetected(path, cycle));
          }

          return feature;
        });

      const save = (path: AbsolutePath, feature: Feature): Effect.Effect<void, FeatureContractError> =>
        fs
          .writeFileString(path, JSON.stringify(feature, null, 2) + "\n")
          .pipe(Effect.mapError((cause) => contractWriteFailed(path, cause)));

      return FeatureContract.of({
        load,
        save,
        nextReady,
        markStatus,
        incrementAttempt,
      });
    }),
  );
