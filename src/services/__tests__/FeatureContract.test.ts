import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import {
  FeatureContract,
  FeatureContractLive,
  TaskSchema,
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
  description: `Description for task ${id}`,
  files: [],
  depends_on: depends_on.map((d) => brand<"TaskId">(d)),
  status,
  attempts,
  maxAttempts,
});

const makeFeature = (tasks: Task[]): Feature => ({
  feature: "test",
  goal: "test goal",
  description: "test feature description",
  constraints: [],
  stories: [
    {
      id: brand<"StoryId">("S1"),
      title: "Story 1",
      description: "story one description",
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
      const noStories = { feature: "x", goal: "g", description: "d", constraints: [] };

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
        description: "cycle test feature",
        constraints: [],
        stories: [
          {
            id: "S1",
            title: "Story",
            description: "story desc",
            tasks: [
              {
                id: "A",
                title: "Task A",
                description: "task a desc",
                files: [],
                depends_on: ["B"],
                status: "pending",
                attempts: 0,
                maxAttempts: 3,
              },
              {
                id: "B",
                title: "Task B",
                description: "task b desc",
                files: [],
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
        description: "roundtrip feature description",
        constraints: ["constraint 1", "constraint 2"],
        stories: [
          {
            id: brand<"StoryId">("S1"),
            title: "Story 1",
            description: "story one description",
            tasks: [
              {
                id: brand<"TaskId">("S1.T1"),
                title: "Task 1",
                description: "task one description",
                files: [brand<"AbsolutePath">("src/foo.ts")],
                depends_on: [],
                status: "pending",
                attempts: 0,
                maxAttempts: 3,
              },
              {
                id: brand<"TaskId">("S1.T2"),
                title: "Task 2",
                description: "task two description",
                files: [],
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
  // description field — required on Task, Story, Feature (S5.T1)
  // -------------------------------------------------------------------------

  describe("description field (required)", () => {
    test("task with description field decodes and preserves the string", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/task-with-description.json`);
      const contract = {
        feature: "test",
        goal: "test goal",
        description: "feature description",
        constraints: [],
        stories: [
          {
            id: "S1",
            title: "Story 1",
            description: "story description",
            tasks: [
              {
                id: "T1",
                title: "Task 1",
                description: "Add description field as Schema.String to all three schemas.",
                files: [],
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
            yield* fs.writeFileString(p, JSON.stringify(contract));
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );

      const feature = await Effect.runPromise(
        Effect.flatMap(FeatureContract, (fc) => fc.load(p)).pipe(
          Effect.provide(testLayer),
        ),
      );

      const task = feature.stories[0]!.tasks[0]!;
      expect(task.description).toBe("Add description field as Schema.String to all three schemas.");
    });

    test("task without description field → ContractSchemaFailed (description is required)", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/task-without-description.json`);
      const contract = {
        feature: "test",
        goal: "test goal",
        description: "feature description",
        constraints: [],
        stories: [
          {
            id: "S1",
            title: "Story 1",
            description: "story description",
            tasks: [
              {
                id: "T1",
                title: "Task 1",
                // description intentionally absent
                files: [],
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
            yield* fs.writeFileString(p, JSON.stringify(contract));
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

    test("story without description field → ContractSchemaFailed (description is required)", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/story-without-description.json`);
      const contract = {
        feature: "test",
        goal: "test goal",
        description: "feature description",
        constraints: [],
        stories: [
          {
            id: "S1",
            title: "Story 1",
            // description intentionally absent
            tasks: [],
          },
        ],
      };

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.gen(function* () {
            yield* ensureTmpDir(fs);
            yield* fs.writeFileString(p, JSON.stringify(contract));
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

    test("feature without description field → ContractSchemaFailed (description is required)", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/feature-without-description.json`);
      const contract = {
        feature: "test",
        goal: "test goal",
        // description intentionally absent
        constraints: [],
        stories: [],
      };

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.gen(function* () {
            yield* ensureTmpDir(fs);
            yield* fs.writeFileString(p, JSON.stringify(contract));
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

    test("story with description field decodes and preserves the string", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/story-with-description.json`);
      const contract = {
        feature: "test",
        goal: "test goal",
        description: "feature description",
        constraints: [],
        stories: [
          {
            id: "S1",
            title: "Story 1",
            description: "Schema gains required description on Task/Story/Feature.",
            tasks: [],
          },
        ],
      };

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.gen(function* () {
            yield* ensureTmpDir(fs);
            yield* fs.writeFileString(p, JSON.stringify(contract));
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );

      const feature = await Effect.runPromise(
        Effect.flatMap(FeatureContract, (fc) => fc.load(p)).pipe(
          Effect.provide(testLayer),
        ),
      );

      expect(feature.stories[0]!.description).toBe(
        "Schema gains required description on Task/Story/Feature.",
      );
    });

    test("feature with description field decodes and preserves the string", async () => {
      const p = brand<"AbsolutePath">(`${tmpDir}/feature-with-description.json`);
      const contract = {
        feature: "test",
        goal: "test goal",
        description: "Replace per-criterion ceremony with senior-dev judgment.",
        constraints: [],
        stories: [],
      };

      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.gen(function* () {
            yield* ensureTmpDir(fs);
            yield* fs.writeFileString(p, JSON.stringify(contract));
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );

      const feature = await Effect.runPromise(
        Effect.flatMap(FeatureContract, (fc) => fc.load(p)).pipe(
          Effect.provide(testLayer),
        ),
      );

      expect(feature.description).toBe(
        "Replace per-criterion ceremony with senior-dev judgment.",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Unknown acceptance field — silently dropped by Schema.decodeUnknown (S5.T1)
  // -------------------------------------------------------------------------

  describe("unknown acceptance field at task/story level", () => {
    test("task with extra 'acceptance' field decodes successfully — Schema.decodeUnknown strips unknown fields", async () => {
      // Effect Schema.Struct strips unknown fields by default (onExcessProperty: "ignore").
      // The 'acceptance' field is unknown to the strict S5.T1 schema and is silently dropped.
      // There is no way to make Schema.Struct reject extra properties without passing
      // { onExcessProperty: "error" } explicitly to Schema.decodeUnknown. The production
      // load path does not set that option, so acceptance survives as a no-op.
      const p = brand<"AbsolutePath">(`${tmpDir}/task-with-acceptance-field.json`);
      const contract = {
        feature: "test",
        goal: "test goal",
        description: "feature description",
        constraints: [],
        stories: [
          {
            id: "S1",
            title: "Story 1",
            description: "story description",
            tasks: [
              {
                id: "T1",
                title: "Task 1",
                description: "task description",
                files: [],
                acceptance: [{ behavioral: "something", mechanism: { _id: "Option", _tag: "None" } }],
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
            yield* fs.writeFileString(p, JSON.stringify(contract));
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );

      const feature = await Effect.runPromise(
        Effect.flatMap(FeatureContract, (fc) => fc.load(p)).pipe(
          Effect.provide(testLayer),
        ),
      );

      const task = feature.stories[0]!.tasks[0]!;
      expect(task.description).toBe("task description");
      // acceptance is stripped from the decoded output — no property at all
      expect((task as unknown as Record<string, unknown>)["acceptance"]).toBeUndefined();
    });

    test("Schema.decodeUnknown with onExcessProperty: 'error' rejects unknown 'acceptance' field", () => {
      // This documents the mechanism: if a caller explicitly enables strict excess-property
      // checking, the acceptance field is rejected. The production FeatureContract.load does
      // not use this option, but the schema is clean enough that a strict decode fails on
      // legacy acceptance data — confirming the field is truly unknown.
      const taskWithAcceptance = {
        id: "T1",
        title: "Task 1",
        description: "task description",
        files: [],
        acceptance: [{ behavioral: "something" }],
        depends_on: [],
        status: "pending" as const,
        attempts: 0,
        maxAttempts: 3,
      };

      let threw = false;
      try {
        Schema.decodeUnknownSync(TaskSchema, { onExcessProperty: "error" })(taskWithAcceptance);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
});
