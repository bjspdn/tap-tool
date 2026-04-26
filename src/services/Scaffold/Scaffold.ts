import { Context, Effect } from "effect";
import { FileSystem, Terminal } from "@effect/platform";

// ---------------------------------------------------------------------------
// Scaffold Tag
// ---------------------------------------------------------------------------

/**
 * Effect service that scaffolds tap-tool files into the current working
 * directory. Exposes init, update, and remove operations backed by a manifest
 * file at `.tap/manifest.json`.
 */
export class Scaffold extends Context.Tag("Scaffold")<
  Scaffold,
  {
    /**
     * Copy template files from the installed @bjspdn/tap package into cwd,
     * create `.tap/features/`, and write `.tap/manifest.json`.
     *
     * Requires `FileSystem` for file I/O and `Terminal` so that an existing
     * manifest triggers an interactive confirmation prompt.
     */
    readonly init: () => Effect.Effect<
      void,
      ScaffoldError,
      FileSystem.FileSystem | Terminal.Terminal
    >;
  }
>() {}
