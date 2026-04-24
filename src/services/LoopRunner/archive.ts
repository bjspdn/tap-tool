import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import * as nodePath from "node:path";
import { brand } from "../brand";
import { filesystemError } from "../AgentRunner";

/**
 * Copies the file at `sourcePath` to `destPath`, creating all parent
 * directories along the way. Any filesystem error is mapped to a
 * `FilesystemError` tagged with the path of the failing step.
 *
 * If `sourcePath` does not exist the read fails immediately and the error
 * carries `sourcePath` — no side-effects are left behind.
 */
export const archivePriorEval = (
  sourcePath: AbsolutePath,
  destPath: AbsolutePath,
): Effect.Effect<
  void,
  Extract<RunTaskError, { _tag: "FilesystemError" }>,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parentDir = brand<"AbsolutePath">(nodePath.dirname(destPath));

    yield* fs.makeDirectory(parentDir, { recursive: true }).pipe(
      Effect.mapError((cause) => filesystemError(parentDir, cause)),
    );

    const content = yield* fs.readFileString(sourcePath).pipe(
      Effect.mapError((cause) => filesystemError(sourcePath, cause)),
    );

    yield* fs.writeFileString(destPath, content).pipe(
      Effect.mapError((cause) => filesystemError(destPath, cause)),
    );
  });
