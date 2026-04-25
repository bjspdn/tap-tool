import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Option } from "effect";
import { BunContext } from "@effect/platform-bun";
import { FileSystem } from "@effect/platform";
import * as nodePath from "node:path";
import * as os from "node:os";
import { brand } from "../../brand";
import { resolvePriorEvalPath } from "../priorEval";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpRoot = brand<"AbsolutePath">(
  nodePath.join(os.tmpdir(), "priorEval-test-" + crypto.randomUUID()),
);

const taskId = brand<"TaskId">("task-abc");

afterAll(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(tmpRoot, { recursive: true }).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }).pipe(Effect.provide(BunContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fresh featureRoot under tmpRoot with a unique sub-directory. */
const makeFeatureRoot = (suffix: string) =>
  brand<"AbsolutePath">(nodePath.join(tmpRoot as string, suffix));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolvePriorEvalPath", () => {
  test("attempt=1 returns Option.none without touching the filesystem", async () => {
    const featureRoot = makeFeatureRoot("attempt-1");

    const result = await Effect.runPromise(
      resolvePriorEvalPath(featureRoot, taskId, 1).pipe(
        Effect.provide(BunContext.layer),
      ),
    );

    expect(Option.isNone(result)).toBe(true);

    // Confirm no archive directory was created
    const archiveExists = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.exists(nodePath.join(featureRoot as string, "eval", "archive"));
      }).pipe(Effect.provide(BunContext.layer)),
    );
    expect(archiveExists).toBe(false);
  });

  test("attempt=2, eval/EVAL_RESULT.md missing → Option.none, no archive created", async () => {
    const featureRoot = makeFeatureRoot("attempt-2-missing");

    // Create the featureRoot but NOT the eval dir / EVAL_RESULT.md
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(featureRoot, { recursive: true });
      }).pipe(Effect.provide(BunContext.layer)),
    );

    const result = await Effect.runPromise(
      resolvePriorEvalPath(featureRoot, taskId, 2).pipe(
        Effect.provide(BunContext.layer),
      ),
    );

    expect(Option.isNone(result)).toBe(true);

    const archiveExists = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.exists(nodePath.join(featureRoot as string, "eval", "archive"));
      }).pipe(Effect.provide(BunContext.layer)),
    );
    expect(archiveExists).toBe(false);
  });

  test("attempt=2, eval/EVAL_RESULT.md present → Option.some(archivePath), both files have content C", async () => {
    const featureRoot = makeFeatureRoot("attempt-2-present");
    const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));
    const evalResultPath = brand<"AbsolutePath">(nodePath.join(evalDir as string, "EVAL_RESULT.md"));
    const expectedArchivePath = brand<"AbsolutePath">(
      nodePath.join(evalDir as string, "archive", taskId as string, "iter-001-EVAL_RESULT.md"),
    );
    const content = "# Eval Result\nsome content for this iteration";

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(evalDir, { recursive: true });
        yield* fs.writeFileString(evalResultPath, content);
      }).pipe(Effect.provide(BunContext.layer)),
    );

    const result = await Effect.runPromise(
      resolvePriorEvalPath(featureRoot, taskId, 2).pipe(
        Effect.provide(BunContext.layer),
      ),
    );

    expect(Option.isSome(result)).toBe(true);
    expect(Option.getOrThrow(result)).toBe(expectedArchivePath);

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        // Archive file exists with correct content
        const archiveContent = yield* fs.readFileString(expectedArchivePath);
        expect(archiveContent).toBe(content);

        // Original EVAL_RESULT.md still exists (copy, not move)
        const originalContent = yield* fs.readFileString(evalResultPath);
        expect(originalContent).toBe(content);
      }).pipe(Effect.provide(BunContext.layer)),
    );
  });

  test("attempt=5 → archive name is iter-004-EVAL_RESULT.md", async () => {
    const featureRoot = makeFeatureRoot("attempt-5");
    const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));
    const evalResultPath = brand<"AbsolutePath">(nodePath.join(evalDir as string, "EVAL_RESULT.md"));
    const expectedArchivePath = brand<"AbsolutePath">(
      nodePath.join(evalDir as string, "archive", taskId as string, "iter-004-EVAL_RESULT.md"),
    );
    const content = "eval content for attempt 5";

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(evalDir, { recursive: true });
        yield* fs.writeFileString(evalResultPath, content);
      }).pipe(Effect.provide(BunContext.layer)),
    );

    const result = await Effect.runPromise(
      resolvePriorEvalPath(featureRoot, taskId, 5).pipe(
        Effect.provide(BunContext.layer),
      ),
    );

    expect(Option.isSome(result)).toBe(true);
    expect(Option.getOrThrow(result)).toBe(expectedArchivePath);
  });

  test("different taskId values produce different archive directories", async () => {
    const featureRoot = makeFeatureRoot("different-task-ids");
    const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));
    const evalResultPath = brand<"AbsolutePath">(nodePath.join(evalDir as string, "EVAL_RESULT.md"));
    const taskIdA = brand<"TaskId">("task-alpha");
    const taskIdB = brand<"TaskId">("task-beta");
    const content = "shared eval content";

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(evalDir, { recursive: true });
        yield* fs.writeFileString(evalResultPath, content);
      }).pipe(Effect.provide(BunContext.layer)),
    );

    const resultA = await Effect.runPromise(
      resolvePriorEvalPath(featureRoot, taskIdA, 2).pipe(
        Effect.provide(BunContext.layer),
      ),
    );

    // Re-write EVAL_RESULT.md (it still exists after the copy) for the second call
    const resultB = await Effect.runPromise(
      resolvePriorEvalPath(featureRoot, taskIdB, 2).pipe(
        Effect.provide(BunContext.layer),
      ),
    );

    expect(Option.isSome(resultA)).toBe(true);
    expect(Option.isSome(resultB)).toBe(true);

    const pathA = Option.getOrThrow(resultA);
    const pathB = Option.getOrThrow(resultB);

    expect(pathA).toContain("task-alpha");
    expect(pathB).toContain("task-beta");
    expect(pathA).not.toBe(pathB);

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const existsA = yield* fs.exists(pathA);
        const existsB = yield* fs.exists(pathB);
        expect(existsA).toBe(true);
        expect(existsB).toBe(true);
      }).pipe(Effect.provide(BunContext.layer)),
    );
  });
});
