import { describe, test, expect, afterAll } from "bun:test";
import { Effect } from "effect";
import { BunContext } from "@effect/platform-bun";
import { FileSystem } from "@effect/platform";
import * as os from "node:os";
import * as path from "node:path";
import { brand } from "../../brand";
import { captureGitStatus } from "../gitStatus";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const repoRoot = brand<"AbsolutePath">(
  new URL("../../../../..", import.meta.url).pathname,
);

const tmpDir = brand<"AbsolutePath">(
  path.join(os.tmpdir(), `gitstatus-test-${crypto.randomUUID()}`),
);

afterAll(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(tmpDir as string, { recursive: true }).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }).pipe(Effect.provide(BunContext.layer)),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("captureGitStatus", () => {
  test("returns a string for a valid git repo", async () => {
    const result = await Effect.runPromise(
      captureGitStatus(repoRoot).pipe(Effect.provide(BunContext.layer)),
    );
    expect(typeof result).toBe("string");
  });

  test("returns empty string for a directory outside any git repo", async () => {
    // Create the tmpDir first so the command has a valid cwd to start from.
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(tmpDir as string, { recursive: true });
      }).pipe(Effect.provide(BunContext.layer)),
    );

    const result = await Effect.runPromise(
      captureGitStatus(tmpDir).pipe(Effect.provide(BunContext.layer)),
    );
    expect(result).toBe("");
  });
});
