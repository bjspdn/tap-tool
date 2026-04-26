# tap-init

<spec:goal>
Add `tap init`, `tap update`, `tap remove`, and `tap --version` CLI commands, restructure the package for npm publishing as `@bjspdn/tap`, swap the runtime platform from Bun to Node for portability, and set up a CI/CD pipeline that auto-publishes to npm with semantic versioning on push to master.
</spec:goal>

<spec:context>
The CLI today has a single `tap run <feature>` subcommand wired via `@effect/cli` in `src/cli.ts`. It runs on `@effect/platform-bun` with `BunRuntime.runMain` and a `#!/usr/bin/env bun` shebang. The package is `private: true` with no build step — Bun executes TypeScript directly.

The `.claude/` folder contains 3 agents (`Composer.md`, `Reviewer.md`, `Summarizer.md`) and 5 skill folders (`tap-into`, `code-review`, `deep-modules`, `anti-patterns`, `tdd`). The `.tap/prompts/` folder contains 3 contract templates (`COMPOSER_CONTRACT.md`, `REVIEWER_CONTRACT.md`, `SUMMARIZER_CONTRACT.md`). These are the files that `tap init` will scaffold into target codebases.

Key files:
- `src/cli.ts` — CLI entry point, @effect/cli command routing
- `package.json` — currently `private: true`, name `tap-tool`, bin points to `./src/cli.ts`
- `.claude/agents/` — 3 agent definitions
- `.claude/skills/` — 5 skill folders with SKILL.md + supporting docs
- `.tap/prompts/` — 3 prompt contract templates
</spec:context>

<spec:constraints>

- Follow existing Effect service conventions: `Context.Tag` for service interface, `Layer` for implementation, ambient types in `src/types/*.d.ts`.
- `@effect/platform-node` replaces `@effect/platform-bun` in runtime dependencies. Bun remains the dev tooling (test runner, build tool, package manager).
- Template files (agents, skills, prompts) ship as-is in the npm package via the `files` field — no copy step, no `prepublishOnly` for templates.
- Build step is `bun build src/cli.ts --outdir dist --target node` — produces Node-compatible JS.
- `dist/` is gitignored but npm-published via `files` field.
- `settings.local.json` is NOT scaffolded (user-specific).
- `.tap/tmp/` is NOT scaffolded (repo-specific test folder).
- `CLAUDE.md` is NOT scaffolded (user's responsibility).
- No commitlint or husky setup — user handles commit convention enforcement separately.
- semantic-release triggers on `feat`, `fix`, `refactor` conventional commit types.

</spec:constraints>

<spec:depth>

## Module: Scaffold

- **Path:** `src/services/Scaffold/`
- **Interface (entry points, ≤3):**
  1. `init(): Effect<void, ScaffoldError, FileSystem | Terminal | Path>` — scaffold `.claude/` agents+skills and `.tap/` prompts+features into cwd, write manifest, log results. Prompts for confirmation if already initialized.
  2. `update(): Effect<void, ScaffoldError, FileSystem | Terminal | Path>` — replace all managed files with package versions, delete stale files (present in old manifest but absent in new version), write updated manifest, log results. Refuses if not initialized.
  3. `remove(): Effect<void, ScaffoldError, FileSystem | Terminal | Path>` — delete `.tap/` entirely, delete managed `.claude/` files (agents + skills), log results. Refuses if not initialized.
- **Hidden complexity:** Package root resolution via `import.meta.url` to locate template files regardless of install method (npm global, npx, bun). Manifest read/write/compare logic — builds file list from package templates, detects stale files by diffing old manifest against new file list, tracks installed version. Directory creation with parents, recursive file copying preserving directory structure, recursive directory deletion. Logging of each file/directory created, updated, or removed.
- **Deletion test:** Without this module, the CLI commands would each need to implement file discovery, manifest management, and path resolution independently — all three commands share this infrastructure.
- **Seam:** `in-process`. Called directly by CLI command handlers. Failures propagate as typed `ScaffoldError` through Effect's error channel.
- **Justification:** Three simple verbs (init, update, remove) hide the full complexity of cross-platform package root resolution, manifest-based file tracking, and idempotent file system operations.

## Module: CLI (modified)

- **Path:** `src/cli.ts`
- **Interface (entry points, ≤3):**
  1. `tapCmd` — root command with `--version` flag, dispatches to subcommands.
  2. (Subcommands are not separate entry points — they're children of `tapCmd` wired via `Command.withSubcommands`.)
- **Hidden complexity:** Adds `init`, `update`, `remove` subcommands alongside existing `run`. Each is a thin Effect program composing Scaffold service calls with the platform layer. `--version` reads version from package metadata.
- **Deletion test:** Without the CLI wiring, the Scaffold service has no consumer. The CLI is the only entry point for all tap commands.
- **Seam:** `in-process`. Entry point for the process — composes layers and runs via `NodeRuntime.runMain`.
- **Justification:** Single entry point hides the layer composition, command routing, and platform wiring that connects user input to service logic.

</spec:depth>

<spec:shape>

```
                         ┌─────────────┐
                         │   src/cli.ts │
                         │  @effect/cli │
                         └──────┬───────┘
                                │
               ┌────────┬───────┼────────┬──────────┐
               ▼        ▼       ▼        ▼          ▼
           tap init  tap update tap run  tap remove  --version
               │        │                │
               ▼        ▼                ▼
         ┌─────────────────────────────────┐
         │       Scaffold Service          │
         │  init() | update() | remove()   │
         └──────────────┬──────────────────┘
                        │
              ┌─────────┼──────────┐
              ▼         ▼          ▼
         resolve     manifest    file ops
        pkg root    read/write   copy/delete
     (import.meta)  (.tap/)     (.claude/, .tap/)
```

**`tap init` flow:**
1. Check if `.tap/manifest.json` exists → if yes, prompt "Already initialized. Re-scaffold?"
2. Resolve package root via `import.meta.url` (go up from `dist/cli.js`)
3. Enumerate template files from package: `.claude/agents/*`, `.claude/skills/**/*`, `.tap/prompts/*`
4. Copy each file to corresponding path in cwd, creating directories as needed
5. Create `.tap/features/` directory
6. Write `.tap/manifest.json` with version + file list
7. Log each created file/directory

**`tap update` flow:**
1. Read `.tap/manifest.json` → refuse if missing ("Not initialized. Run `tap init` first.")
2. Resolve package root, enumerate new template file list
3. Diff old manifest files against new file list → stale files = in old, not in new
4. Copy all new template files to cwd (overwrite existing)
5. Delete stale files
6. Write updated `.tap/manifest.json` with new version + new file list
7. Log updated/added/removed files

**`tap remove` flow:**
1. Read `.tap/manifest.json` → refuse if missing
2. Delete managed `.claude/` files (agents + skills) listed in manifest
3. Clean up empty `.claude/` subdirectories left behind
4. Delete `.tap/` entirely (features, prompts, manifest, everything)
5. Log each removed file/directory

**Manifest shape:**
```json
{
  "version": "1.2.3",
  "files": [
    ".claude/agents/Composer.md",
    ".claude/agents/Reviewer.md",
    ".claude/agents/Summarizer.md",
    ".claude/skills/tap-into/SKILL.md",
    ".tap/prompts/COMPOSER_CONTRACT.md"
  ]
}
```
</spec:shape>

<spec:failure_modes>

- **Package root unresolvable:** `import.meta.url` may behave differently under `npx`, `bunx`, or symlinked global installs. Scaffold should walk up from its own location looking for `package.json` with `name: "@bjspdn/tap"` as a fallback.
- **Manifest missing on update/remove:** Treated as "not initialized" — log a clear message directing user to `tap init`. Not a crash.
- **Manifest corrupted (invalid JSON):** Surface the parse error clearly. Suggest `tap remove` + `tap init` to re-scaffold.
- **Permission denied on file write:** Let the OS error propagate through Effect's error channel with the path that failed.
- **Partial init failure (e.g., copied half the files then crashed):** Manifest is written last. If manifest is absent, next `tap init` runs clean. If manifest exists but is partial, `tap update` will reconcile by overwriting everything.

</spec:failure_modes>

<spec:open_questions>

- **Shebang in built output:** `bun build --target node` may not inject `#!/usr/bin/env node` automatically. Composer should verify and add via a build script wrapper or post-build prepend if needed. npm's bin wiring may handle this regardless, but direct execution (`./dist/cli.js`) needs it.
- **semantic-release `refactor` type:** By default semantic-release only recognizes `feat` (minor) and `fix` (patch). The `refactor` type needs explicit configuration in `.releaserc.json` to trigger a patch release.
- **Version sourcing at runtime:** The CLI needs to read its own version for `--version`. Options: import from `package.json` at build time (bundler may inline it), or read the file at runtime relative to package root. Composer should pick the simplest approach that works post-build.

</spec:open_questions>
