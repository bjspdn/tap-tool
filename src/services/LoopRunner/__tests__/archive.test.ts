import { describe, test, expect, afterAll } from "bun:test";
import { Effect } from "effect";
import * as NodeContext from "@effect/platform-node/NodeContext";
import { FileSystem } from "@effect/platform";
import * as nodePath from "node:path";
import { brand } from "../../brand";
import { archivePriorEval } from "../archive";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpDir = brand<"AbsolutePath">(
  new URL(
    "../../../../../.tap/tmp/archive-test-" + crypto.randomUUID(),
    import.meta.url,
  ).pathname,
);

afterAll(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(tmpDir, { recursive: true }).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("archivePriorEval", () => {
  test("archives a file with known content into a nested path", async () => {
    const sourcePath = brand<"AbsolutePath">(nodePath.join(tmpDir, "source.md"));
    const destPath = brand<"AbsolutePath">(
      nodePath.join(tmpDir, "archive", "task-1", "iter-001-EVAL_RESULT.md"),
    );
    const content = "# Eval Result\nThis is test content.";

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(tmpDir, { recursive: true });
        yield* fs.writeFileString(sourcePath, content);
        yield* archivePriorEval(sourcePath, destPath);
        const exists = yield* fs.exists(destPath);
        expect(exists).toBe(true);
        const actual = yield* fs.readFileString(destPath);
        expect(actual).toBe(content);
      }).pipe(Effect.provide(NodeContext.layer)),
    );
  });

  test("missing source file yields FilesystemError with sourcePath", async () => {
    const sourcePath = brand<"AbsolutePath">(
      nodePath.join(tmpDir, "does-not-exist.md"),
    );
    const destPath = brand<"AbsolutePath">(
      nodePath.join(tmpDir, "archive", "task-1", "iter-002-EVAL_RESULT.md"),
    );

    const error = await Effect.runPromise(
      archivePriorEval(sourcePath, destPath).pipe(
        Effect.flip,
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(error._tag).toBe("FilesystemError");
    expect(error.path).toBe(sourcePath);
  });

  test("second archive to the same destPath overwrites cleanly", async () => {
    const sourcePath = brand<"AbsolutePath">(
      nodePath.join(tmpDir, "source2.md"),
    );
    const destPath = brand<"AbsolutePath">(
      nodePath.join(tmpDir, "archive", "task-1", "iter-003-EVAL_RESULT.md"),
    );
    const firstContent = "first content";
    const secondContent = "second content — overwritten";

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(tmpDir, { recursive: true });
        yield* fs.writeFileString(sourcePath, firstContent);
        yield* archivePriorEval(sourcePath, destPath);
        // overwrite source then archive again — destPath must reflect new content
        yield* fs.writeFileString(sourcePath, secondContent);
        yield* archivePriorEval(sourcePath, destPath);
        const actual = yield* fs.readFileString(destPath);
        expect(actual).toBe(secondContent);
      }).pipe(Effect.provide(NodeContext.layer)),
    );
  });
});
