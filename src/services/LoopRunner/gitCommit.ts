import { Effect, Fiber, Stream } from "effect";
import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import * as nodePath from "node:path";
import { teeStream } from "../streamTee";

/**
 * Stages `task.files`, `contractPath`, and (if present on disk) the sibling
 * `SPECS.md`, then commits with the message `feat(<id>): <title>`.
 *
 * `projectRoot` must be the repository working-tree root (i.e. `process.cwd()`
 * from the bootstrap entry point). All git operations run from there so that
 * project-root-relative paths in `task.files` resolve correctly.
 *
 * Returns a typed `GitCommitError` on git failure; the caller decides log-and-continue vs. abort.
 * Not a Context.Tag; plain Effect-returning function.
 */
export const commitTask = (
  projectRoot: AbsolutePath,
  task: Task,
  contractPath: AbsolutePath,
): Effect.Effect<void, GitCommitError, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const fs = yield* FileSystem.FileSystem;

    const specsPath = nodePath.join(nodePath.dirname(contractPath as string), "SPECS.md");
    const specsExists = yield* fs.exists(specsPath).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
    );

    // Deduplicate: task.files may repeat entries, and contractPath may already
    // be listed in task.files.
    const seen = new Set<string>();
    const filesToAdd: string[] = [];

    for (const f of task.files) {
      if (!seen.has(f as string)) {
        seen.add(f as string);
        filesToAdd.push(f as string);
      }
    }

    if (!seen.has(contractPath as string)) {
      filesToAdd.push(contractPath as string);
    }

    if (specsExists && !seen.has(specsPath)) {
      filesToAdd.push(specsPath);
    }

    const runGit = (
      args: string[],
    ): Effect.Effect<{ exitCode: number; stderr: string }, never, never> =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(
            Command.make("git", ...args).pipe(
              Command.workingDirectory(projectRoot as string),
              Command.stderr("pipe"),
            ),
          ).pipe(Effect.orDie);

          const stderrChunks: Uint8Array[] = [];
          const stderrFiber = yield* teeStream(
            process.stderr,
            (cause) => cause,
            (chunk) =>
              Effect.sync(() => {
                stderrChunks.push(chunk);
              }),
          ).pipe(Effect.orDie);

          const code = yield* process.exitCode.pipe(Effect.orDie);
          yield* Fiber.join(stderrFiber);

          return {
            exitCode: code as unknown as number,
            stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
          };
        }),
      ).pipe(Effect.orDie);

    const addResult = yield* runGit(["add", ...filesToAdd]);
    if (addResult.exitCode !== 0) {
      return yield* Effect.fail({
        _tag: "GitAddFailed" as const,
        taskId: task.id,
        exitCode: addResult.exitCode,
        stderr: addResult.stderr,
      });
    }

    const commitMsg = `feat(${task.id as string}): ${task.title}`;
    const commitResult = yield* runGit(["commit", "-m", commitMsg]);

    if (commitResult.exitCode === 0) {
      return;
    }

    // exit code 1 from git commit when there is nothing to stage is benign.
    if (
      commitResult.exitCode === 1 &&
      (commitResult.stderr.includes("nothing to commit") ||
        commitResult.stderr === "")
    ) {
      return;
    }

    return yield* Effect.fail({
      _tag: "GitCommitFailed" as const,
      taskId: task.id,
      exitCode: commitResult.exitCode,
      stderr: commitResult.stderr,
    });
  });
