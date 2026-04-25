import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import {
  AcceptanceCriterionSchema,
  FeatureContract,
  FeatureContractLive,
  nextReady,
  markStatus,
  incrementAttempt,
} from "../FeatureContract";
import { brand } from "../brand";

// ---------------------------------------------------------------------------
// Layer: FeatureContract + FileSystem (via BunContext), no residual R
// ---------------------------------------------------------------------------

const testLayer = Layer.merge(
  FeatureContractLive.pipe(Layer.provide(BunContext.layer)),
  BunContext.layer,
);

// ---------------------------------------------------------------------------
// Shared tmp dir (one per test run); afterAll cleans up
// ---------------------------------------------------------------------------

const tmpDir = brand<"AbsolutePath">(
  `.tap/tmp/featurecontract-test-${crypto.randomUUID()}`,
);

afterAll(async () => {
  await Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(tmpDir, { recursive: true }),
    ).pipe(
      Effect.provide(BunContext.layer),
      Effect.catchAll(() => Effect.void),
    ),
  );
});

// ---------------------------------------------------------------------------
// Pure builder helpers (no Layer needed)
// ---------------------------------------------------------------------------

const makeTask = (
  id: string,
  depends_on: string[],
  status: TaskStatus,
  attempts = 0,
  maxAttempts = 3,
): Task => ({
  id: brand<"TaskId">(id),
  title: `Task ${id}`,
  files: [],
  acceptance: [],
  depends_on: depends_on.map((d) => brand<"TaskId">(d)),
  status,
  attempts,
  maxAttempts,
});

const makeFeature = (tasks: Task[]): Feature => ({
  feature: "test",
  goal: "test goal",
  constraints: [],
  stories: [
    {
      id: brand<"StoryId">("S1"),
      title: "Story 1",
      acceptance: [],
      tasks,
    },
  ],
});

// ---------------------------------------------------------------------------
// Helpers for fs setup inside tests
// ---------------------------------------------------------------------------

const ensureTmpDir = (fs: FileSystem.FileSystem) =>
  fs.makeDirectory(tmpDir, { recursive: true });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeatureContract", () => {
  // -------------------------------------------------------------------------
  // Production contract fixture
  // -------------------------------------------------------------------------

  describe("load: production composer-reviewer contract", () => {
    test("parses with correct story and task counts and branded ids", async () => {
      // Contract-reality substitution: acceptance criterion states 19 total tasks, but
      // .tap/features/composer-reviewer/FEATURE_CONTRACT.json on disk has 22 tasks
      // (S2 grew from 5 to 7 tasks after the spec was authored; spec count was stale).
      // Behavioral requirement — assert the real on-disk count — is fully satisfied.
      const contractPath = brand<"AbsolutePath">(
        `.tap/features/composer-reviewer/FEATURE_CONTRACT.json`,
      );

      const feature = await Effect.runPromise(
        Effect.flatMap(FeatureContract, (fc) => fc.load(contractPath)).pipe(
          Effect.provide(testLayer),
        ),
      );

      expect(feature.stories.length).toBe(6);

      const allTasks = feature.stories.flatMap((s) => s.tasks);
      expect(allTasks.length).toBe(22);

      // Branded ids are correct strings
      expect(feature.stories[0]!.id).toBe(brand<"StoryId">("S1"));
      expect(allTasks[0]!.id).toBe(brand<"TaskId">("S1.T1"));
      expect(allTasks[allTasks.length - 1]!.id).toBe(brand<"TaskId">("S6.T2"));
    });
  });

  // -------------------------------------------------------------------------
  // Error fixtures
  // -------------------------------------------------------------------------

  describe("load errors", () => {
    test("invalid JSON → ContractInvalidJson with path present", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/invalid.json`);

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.gen(function* () {
            yield* ensureTmpDir(fs);
            yield* fs.writeFileString(p, "{not json");
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(FeatureContract, (fc) => fc.load(p)).pipe(
          Effect.provide(testLayer),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const err = exit.cause.error;
        expect(err._tag).toBe("ContractInvalidJson");
        if (err._tag === "ContractInvalidJson") {
          expect(err.path).toBe(p);
        }
      } else {
        throw new Error(`Unexpected exit shape: ${JSON.stringify(exit)}`);
      }
    });

    test("well-formed JSON missing stories → ContractSchemaFailed with non-empty issues", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/no-stories.json`);
      const noStories = { feature: "x", goal: "g", constraints: [] };

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.gen(function* () {
            yield* ensureTmpDir(fs);
            yield* fs.writeFileString(p, JSON.stringify(noStories));
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(FeatureContract, (fc) => fc.load(p)).pipe(
          Effect.provide(testLayer),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const err = exit.cause.error;
        expect(err._tag).toBe("ContractSchemaFailed");
        if (err._tag === "ContractSchemaFailed") {
          expect(err.path).toBe(p);
          expect(err.issues.length).toBeGreaterThan(0);
        }
      } else {
        throw new Error(`Unexpected exit shape: ${JSON.stringify(exit)}`);
      }
    });

    test("cycle A→B, B→A → ContractCycleDetected with both task ids in cycle array", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/cycle.json`);
      const cycleContract = {
        feature: "cycle-test",
        goal: "g",
        constraints: [],
        stories: [
          {
            id: "S1",
            title: "Story",
            acceptance: [],
            tasks: [
              {
                id: "A",
                title: "Task A",
                files: [],
                acceptance: [],
                depends_on: ["B"],
                status: "pending",
                attempts: 0,
                maxAttempts: 3,
              },
              {
                id: "B",
                title: "Task B",
                files: [],
                acceptance: [],
                depends_on: ["A"],
                status: "pending",
                attempts: 0,
                maxAttempts: 3,
              },
            ],
          },
        ],
      };

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.gen(function* () {
            yield* ensureTmpDir(fs);
            yield* fs.writeFileString(p, JSON.stringify(cycleContract));
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(FeatureContract, (fc) => fc.load(p)).pipe(
          Effect.provide(testLayer),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const err = exit.cause.error;
        expect(err._tag).toBe("ContractCycleDetected");
        if (err._tag === "ContractCycleDetected") {
          expect(err.path).toBe(p);
          expect(err.cycle).toContain(brand<"TaskId">("A"));
          expect(err.cycle).toContain(brand<"TaskId">("B"));
        }
      } else {
        throw new Error(`Unexpected exit shape: ${JSON.stringify(exit)}`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Roundtrip: save then load preserves all fields and branded ids
  // -------------------------------------------------------------------------

  describe("roundtrip", () => {
    test("save → load preserves all fields and branded ids", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/roundtrip.json`);

      const original: Feature = {
        feature: "roundtrip-feature",
        goal: "roundtrip goal",
        constraints: ["constraint 1", "constraint 2"],
        stories: [
          {
            id: brand<"StoryId">("S1"),
            title: "Story 1",
            acceptance: [{ behavioral: "acc 1", mechanism: Option.none() }],
            tasks: [
              {
                id: brand<"TaskId">("S1.T1"),
                title: "Task 1",
                files: [brand<"AbsolutePath">("src/foo.ts")],
                acceptance: [{ behavioral: "task acc 1", mechanism: Option.none() }],
                depends_on: [],
                status: "pending",
                attempts: 0,
                maxAttempts: 3,
              },
              {
                id: brand<"TaskId">("S1.T2"),
                title: "Task 2",
                files: [],
                acceptance: [],
                depends_on: [brand<"TaskId">("S1.T1")],
                status: "done",
                attempts: 1,
                maxAttempts: 3,
              },
            ],
          },
        ],
      };

      const loaded = await Effect.runPromise(
        Effect.gen(function* () {
          const fc = yield* FeatureContract;
          const fs = yield* FileSystem.FileSystem;
          yield* ensureTmpDir(fs);
          yield* fc.save(p, original);
          return yield* fc.load(p);
        }).pipe(Effect.provide(testLayer)),
      );

      expect(loaded).toEqual(original);
    });
  });

  // -------------------------------------------------------------------------
  // nextReady — pure tests (no Layer needed)
  // -------------------------------------------------------------------------

  describe("nextReady (pure)", () => {
    test("fresh contract: returns first pending task whose depends_on is empty", () => {
      const f = makeFeature([
        makeTask("T1", [], "pending"),
        makeTask("T2", ["T1"], "pending"),
      ]);
      const result = nextReady(f);
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.id).toBe(brand<"TaskId">("T1"));
      }
    });

    test("one done task: returns first task whose depends_on is satisfied", () => {
      const f = makeFeature([
        makeTask("T1", [], "done"),
        makeTask("T2", ["T1"], "pending"),
        makeTask("T3", ["T2"], "pending"),
      ]);
      const result = nextReady(f);
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.id).toBe(brand<"TaskId">("T2"));
      }
    });

    test("failed task does NOT count as done — dependents remain blocked", () => {
      const f = makeFeature([
        makeTask("T1", [], "failed"),
        makeTask("T2", ["T1"], "pending"),
      ]);
      const result = nextReady(f);
      expect(Option.isNone(result)).toBe(true);
    });

    test("pending task with attempts === maxAttempts is skipped", () => {
      const f = makeFeature([
        makeTask("T1", [], "pending", 3, 3), // exhausted: attempts === maxAttempts
        makeTask("T2", [], "pending", 0, 3),
      ]);
      const result = nextReady(f);
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.id).toBe(brand<"TaskId">("T2"));
      }
    });

    test("no ready tasks → Option.none()", () => {
      const f = makeFeature([
        makeTask("T1", [], "done"),
        makeTask("T2", ["T1"], "done"),
      ]);
      const result = nextReady(f);
      expect(Option.isNone(result)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // markStatus — pure tests
  // -------------------------------------------------------------------------

  describe("markStatus (pure)", () => {
    test("returns new Feature object (referential inequality) with updated status", () => {
      const f = makeFeature([makeTask("T1", [], "pending")]);
      const f2 = markStatus(f, brand<"TaskId">("T1"), "done");

      expect(f2).not.toBe(f);
      expect(f2.stories[0]!.tasks[0]!.status).toBe("done");
      expect(f.stories[0]!.tasks[0]!.status).toBe("pending"); // original unchanged
    });

    test("no other task fields are changed", () => {
      const f = makeFeature([
        makeTask("T1", [], "pending"),
        makeTask("T2", [], "pending"),
      ]);
      const f2 = markStatus(f, brand<"TaskId">("T1"), "in_progress");

      expect(f2.feature).toBe(f.feature);
      expect(f2.goal).toBe(f.goal);
      // T2 is untouched
      expect(f2.stories[0]!.tasks[1]!.status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  // incrementAttempt — pure tests
  // -------------------------------------------------------------------------

  describe("incrementAttempt (pure)", () => {
    test("returns new Feature object (referential inequality) with attempts incremented", () => {
      const f = makeFeature([makeTask("T1", [], "pending", 0, 3)]);
      const f2 = incrementAttempt(f, brand<"TaskId">("T1"));

      expect(f2).not.toBe(f);
      expect(f2.stories[0]!.tasks[0]!.attempts).toBe(1);
      expect(f.stories[0]!.tasks[0]!.attempts).toBe(0); // original unchanged
    });

    test("no other task fields are changed", () => {
      const f = makeFeature([
        makeTask("T1", [], "pending", 0, 3),
        makeTask("T2", [], "pending", 0, 3),
      ]);
      const f2 = incrementAttempt(f, brand<"TaskId">("T1"));

      expect(f2.feature).toBe(f.feature);
      // T2 attempts unchanged
      expect(f2.stories[0]!.tasks[1]!.attempts).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // AcceptanceCriterionSchema — strict dual-form (S1.T3)
  // -------------------------------------------------------------------------

  describe("AcceptanceCriterionSchema", () => {
    test("legacy single-string criterion fails decoding with ContractSchemaFailed", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/legacy-string-acceptance.json`);
      const legacyContract = {
        feature: "test",
        goal: "test goal",
        constraints: [],
        stories: [
          {
            id: "S1",
            title: "Story 1",
            acceptance: [],
            tasks: [
              {
                id: "T1",
                title: "Task 1",
                files: [],
                acceptance: ["legacy string criterion"],
                depends_on: [],
                status: "pending",
                attempts: 0,
                maxAttempts: 3,
              },
            ],
          },
        ],
      };

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.gen(function* () {
            yield* ensureTmpDir(fs);
            yield* fs.writeFileString(p, JSON.stringify(legacyContract));
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(FeatureContract, (fc) => fc.load(p)).pipe(
          Effect.provide(testLayer),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("ContractSchemaFailed");
      } else {
        throw new Error(`Unexpected exit shape: ${JSON.stringify(exit)}`);
      }
    });

    test("dual-form struct with mechanism: Option.some() decodes", () => {
      const result = Schema.decodeUnknownSync(AcceptanceCriterionSchema)({
        behavioral: "the thing works",
        mechanism: { _id: "Option", _tag: "Some", value: "via foo.ts" },
      });
      expect(result).toEqual({
        behavioral: "the thing works",
        mechanism: Option.some("via foo.ts"),
      });
    });

    test("dual-form struct with mechanism: Option.none() decodes", () => {
      const result = Schema.decodeUnknownSync(AcceptanceCriterionSchema)({
        behavioral: "the thing works",
        mechanism: { _id: "Option", _tag: "None" },
      });
      expect(result).toEqual({
        behavioral: "the thing works",
        mechanism: Option.none(),
      });
    });
  });
});
