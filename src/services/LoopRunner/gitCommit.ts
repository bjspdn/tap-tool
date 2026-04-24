import { Effect } from "effect";
import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import * as nodePath from "node:path";

/**
 * Stages `task.files`, `contractPath`, and (if present on disk) the sibling
 * `SPECS.md`, then commits with the message `task(<id>): <title>`.
 *
 * All errors are swallowed — this is best-effort housekeeping. If the commit
 * fails (nothing staged, hook failure, etc.) the loop continues uninterrupted.
 * Not a Context.Tag; plain Effect-returning function.
 */
export const commitTask = (
  cwd: AbsolutePath,
  task: Task,
  contractPath: AbsolutePath,
): Effect.Effect<void, never, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const fs = yield* FileSystem.FileSystem;

    const specsPath = nodePath.join(nodePath.dirname(contractPath as string), "SPECS.md");
    const specsExists = yield* fs.exists(specsPath);

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

    yield* executor.exitCode(
      Command.make("git", "add", ...filesToAdd).pipe(
        Command.workingDirectory(cwd as string),
      ),
    );

    yield* executor.exitCode(
      Command.make(
        "git",
        "commit",
        "-m",
        `feat(${task.id as string}): ${task.title}`,
      ).pipe(Command.workingDirectory(cwd as string)),
    );
  }).pipe(Effect.catchAll(() => Effect.void));
