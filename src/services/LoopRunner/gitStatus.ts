import { Effect } from "effect";
import { Command, CommandExecutor } from "@effect/platform";

/**
 * Runs `git status --short` in `cwd` and returns stdout as a string.
 * Non-zero exits and spawn errors are swallowed — returns `""` instead.
 * Not a Context.Tag; plain Effect-returning function.
 */
export const captureGitStatus = (
  cwd: AbsolutePath,
): Effect.Effect<string, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    return yield* executor.string(
      Command.make("git", "status", "--short").pipe(
        Command.workingDirectory(cwd as string),
      ),
    );
  }).pipe(Effect.catchAll(() => Effect.succeed("")));
