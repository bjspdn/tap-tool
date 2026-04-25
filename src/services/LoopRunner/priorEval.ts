import { Effect, Option } from "effect";
import { FileSystem } from "@effect/platform";
import * as nodePath from "node:path";
import { brand } from "../brand";
import { filesystemError } from "../AgentRunner";
import { archivePriorEval } from "./archive";

/**
 * Resolves the priorEvalPath to thread into RunTask for a given iteration.
 *
 * Behavior:
 *  - attempt <= 1 → returns Option.none() with no filesystem access.
 *  - attempt > 1:
 *      · check `<featureRoot>/eval/EVAL_RESULT.md` exists.
 *      · if missing → Option.none() (mid-run crash recovery: previous iteration
 *        died before the Reviewer wrote EVAL_RESULT.md). No archive performed.
 *      · if present → archive it via `archivePriorEval` to
 *        `<featureRoot>/eval/archive/<taskId>/iter-<attempt-1 padded to 3>-EVAL_RESULT.md`,
 *        then return Option.some(archivePath).
 *
 * Errors are mapped to FilesystemError tagged with the relevant path,
 * matching existing convention.
 */
export const resolvePriorEvalPath = (
  featureRoot: AbsolutePath,
  taskId: TaskId,
  attempt: number,
): Effect.Effect<
  Option.Option<AbsolutePath>,
  Extract<RunTaskError, { _tag: "FilesystemError" }>,
  FileSystem.FileSystem
> => {
  if (attempt <= 1) {
    return Effect.succeed(Option.none<AbsolutePath>());
  }

  const evalDir = brand<"AbsolutePath">(nodePath.join(featureRoot as string, "eval"));
  const evalResultPath = brand<"AbsolutePath">(nodePath.join(evalDir as string, "EVAL_RESULT.md"));
  const archivePath = brand<"AbsolutePath">(
    nodePath.join(
      evalDir as string,
      "archive",
      taskId as string,
      `iter-${String(attempt - 1).padStart(3, "0")}-EVAL_RESULT.md`,
    ),
  );

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(evalResultPath as string).pipe(
      Effect.mapError((cause) => filesystemError(evalResultPath, cause)),
    );

    if (!exists) return Option.none<AbsolutePath>();

    yield* archivePriorEval(evalResultPath, archivePath);
    return Option.some(archivePath);
  });
};
