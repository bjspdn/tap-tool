import { Effect, Layer } from "effect";
import { FileSystem, Terminal } from "@effect/platform";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { Scaffold } from "./Scaffold";

// ---------------------------------------------------------------------------
// Package root resolution
// ---------------------------------------------------------------------------

/**
 * Walk up from the current file's URL until a directory containing
 * `package.json` is found. Works for both the unbuilt source tree
 * (`src/services/Scaffold/ScaffoldLive.ts`) and the bundled output
 * (`dist/cli.js`), since the first `package.json` encountered going up is
 * always @bjspdn/tap's own manifest.
 */
const resolvePackageRoot = (): string => {
  const thisFile = fileURLToPath(new URL(import.meta.url));
  let current = nodePath.dirname(thisFile);
  while (current !== nodePath.dirname(current)) {
    if (nodeFs.existsSync(nodePath.join(current, "package.json"))) {
      return current;
    }
    current = nodePath.dirname(current);
  }
  throw new Error("[Scaffold] Could not resolve package root from import.meta.url");
};

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

/**
 * Recursively enumerate all regular files under `dir`.
 * Returns absolute paths. Missing or unreadable directories yield an
 * empty array rather than failing — not every template sub-tree is
 * required to exist in every build variant.
 */
const walkDir = (
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    const entries: Array<string> = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    const results: string[] = [];
    for (const entry of entries) {
      const full = nodePath.join(dir, entry);
      const info = yield* fs
        .stat(full)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (info === null) continue;
      if (info.type === "Directory") {
        const children = yield* walkDir(fs, full);
        results.push(...children);
      } else {
        results.push(full);
      }
    }
    return results;
  });

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Enumerate all template files from the three sub-trees in `packageRoot`. */
const enumerateTemplateFiles = (
  fs: FileSystem.FileSystem,
  packageRoot: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    const templateDirs = [
      nodePath.join(packageRoot, ".claude", "agents"),
      nodePath.join(packageRoot, ".claude", "skills"),
      nodePath.join(packageRoot, ".tap", "prompts"),
    ];
    const results: string[] = [];
    for (const dir of templateDirs) {
      const files = yield* walkDir(fs, dir);
      results.push(...files);
    }
    return results;
  });

/** Copy a single file from srcAbs to destAbs, creating parent dirs as needed. */
const copyFile = (
  fs: FileSystem.FileSystem,
  srcAbs: string,
  destAbs: string,
): Effect.Effect<void, ScaffoldError> =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(nodePath.dirname(destAbs), { recursive: true }).pipe(
      Effect.catchAll((cause) =>
        Effect.fail<ScaffoldError>({ _tag: "FileCopyFailed", src: srcAbs, dest: destAbs, cause }),
      ),
    );
    const content = yield* fs.readFileString(srcAbs).pipe(
      Effect.catchAll((cause) =>
        Effect.fail<ScaffoldError>({ _tag: "FileCopyFailed", src: srcAbs, dest: destAbs, cause }),
      ),
    );
    yield* fs.writeFileString(destAbs, content).pipe(
      Effect.catchAll((cause) =>
        Effect.fail<ScaffoldError>({ _tag: "FileCopyFailed", src: srcAbs, dest: destAbs, cause }),
      ),
    );
  });

// ---------------------------------------------------------------------------
// makeScaffold factory (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Construct a `Scaffold` service implementation.
 *
 * The returned object satisfies `Scaffold["Type"]` and additionally exposes
 * `update` (added in S2.T2) before the `Scaffold` context tag is widened.
 *
 * @param packageRoot - Absolute path to the installed @bjspdn/tap package.
 * @param cwd         - Working directory to scaffold into (the user's project root).
 */
export const makeScaffold = (
  packageRoot: string,
  cwd: string,
): Scaffold["Type"] & {
  update: () => Effect.Effect<void, ScaffoldError, FileSystem.FileSystem>;
} => {
  const manifestPath = nodePath.join(cwd, ".tap", "manifest.json");

  const svc: Scaffold["Type"] & {
    update: () => Effect.Effect<void, ScaffoldError, FileSystem.FileSystem>;
  } = {
    // -------------------------------------------------------------------------
    // init
    // -------------------------------------------------------------------------
    init: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const terminal = yield* Terminal.Terminal;

        // If a manifest already exists, ask for confirmation before continuing.
        const manifestExists = yield* fs.exists(manifestPath);
        if (manifestExists) {
          yield* terminal
            .display("tap is already initialised in this directory. Re-scaffold? [y/N]: ")
            .pipe(Effect.orDie);
          const line = yield* terminal.readLine.pipe(
            Effect.catchTag("QuitException", () =>
              Effect.fail<ScaffoldError>({ _tag: "ConfirmationDeclined" }),
            ),
          );
          if (line.trim().toLowerCase() !== "y") {
            return yield* Effect.fail<ScaffoldError>({ _tag: "ConfirmationDeclined" });
          }
        }

        // Read the installed package version from its package.json.
        const pkgJsonRaw = nodeFs.readFileSync(
          nodePath.join(packageRoot, "package.json"),
          "utf-8",
        );
        const { version } = JSON.parse(pkgJsonRaw) as { version: string };

        // Enumerate all files from the three template sub-trees.
        const absoluteFiles = yield* enumerateTemplateFiles(fs, packageRoot);

        // Copy each template file into cwd, preserving the relative path.
        const copiedRelPaths: string[] = [];
        for (const srcAbs of absoluteFiles) {
          const relPath = nodePath.relative(packageRoot, srcAbs);
          const destAbs = nodePath.join(cwd, relPath);
          yield* copyFile(fs, srcAbs, destAbs);
          copiedRelPaths.push(relPath);
          yield* Effect.sync(() => console.log(`  created ${relPath}`));
        }

        // Create the .tap/features/ directory.
        const featuresDir = nodePath.join(cwd, ".tap", "features");
        yield* fs.makeDirectory(featuresDir, { recursive: true }).pipe(
          Effect.catchAll((cause) =>
            Effect.fail<ScaffoldError>({
              _tag: "FileCopyFailed",
              src: featuresDir,
              dest: featuresDir,
              cause,
            }),
          ),
        );
        yield* Effect.sync(() => console.log("  created .tap/features/"));

        // Write manifest last — a missing or partial manifest signals incomplete init.
        yield* fs.makeDirectory(nodePath.join(cwd, ".tap"), { recursive: true }).pipe(
          Effect.catchAll((cause) =>
            Effect.fail<ScaffoldError>({ _tag: "ManifestWriteFailed", path: manifestPath, cause }),
          ),
        );

        const manifest: InstallManifest = { version, files: copiedRelPaths };
        yield* fs
          .writeFileString(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
          .pipe(
            Effect.catchAll((cause) =>
              Effect.fail<ScaffoldError>({
                _tag: "ManifestWriteFailed",
                path: manifestPath,
                cause,
              }),
            ),
          );
        yield* Effect.sync(() => console.log("  created .tap/manifest.json"));
      }),

    // -------------------------------------------------------------------------
    // update
    // -------------------------------------------------------------------------
    update: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        // Refuse if not initialised.
        const manifestExists = yield* fs.exists(manifestPath);
        if (!manifestExists) {
          return yield* Effect.fail<ScaffoldError>({
            _tag: "ManifestReadFailed",
            path: manifestPath,
            cause: new Error(
              "tap is not initialised in this directory — run `tap init` first",
            ),
          });
        }

        // Read old manifest.
        const manifestRaw = yield* fs.readFileString(manifestPath).pipe(
          Effect.catchAll((cause) =>
            Effect.fail<ScaffoldError>({ _tag: "ManifestReadFailed", path: manifestPath, cause }),
          ),
        );
        const oldManifest = JSON.parse(manifestRaw) as InstallManifest;

        // Read package version.
        const pkgJsonRaw = nodeFs.readFileSync(
          nodePath.join(packageRoot, "package.json"),
          "utf-8",
        );
        const { version } = JSON.parse(pkgJsonRaw) as { version: string };

        // Enumerate new template files.
        const absoluteFiles = yield* enumerateTemplateFiles(fs, packageRoot);
        const newRelPaths = absoluteFiles.map((abs) => nodePath.relative(packageRoot, abs));
        const newRelSet = new Set(newRelPaths);

        // Stale = in old manifest but absent from new template list.
        const staleFiles = oldManifest.files.filter((f) => !newRelSet.has(f));
        const oldRelSet = new Set(oldManifest.files);

        // Copy all new template files (overwrite existing).
        for (const srcAbs of absoluteFiles) {
          const relPath = nodePath.relative(packageRoot, srcAbs);
          const destAbs = nodePath.join(cwd, relPath);
          yield* copyFile(fs, srcAbs, destAbs);
          const verb = oldRelSet.has(relPath) ? "updated" : "added";
          yield* Effect.sync(() => console.log(`  ${verb} ${relPath}`));
        }

        // Delete stale files.
        for (const relPath of staleFiles) {
          const destAbs = nodePath.join(cwd, relPath);
          yield* fs.remove(destAbs).pipe(Effect.orDie);
          yield* Effect.sync(() => console.log(`  removed ${relPath}`));
        }

        // Write updated manifest.
        const newManifest: InstallManifest = { version, files: newRelPaths };
        yield* fs
          .writeFileString(manifestPath, JSON.stringify(newManifest, null, 2) + "\n")
          .pipe(
            Effect.catchAll((cause) =>
              Effect.fail<ScaffoldError>({
                _tag: "ManifestWriteFailed",
                path: manifestPath,
                cause,
              }),
            ),
          );
        yield* Effect.sync(() => console.log("  updated .tap/manifest.json"));
      }),
  };

  return svc;
};

// ---------------------------------------------------------------------------
// ScaffoldLive layer
// ---------------------------------------------------------------------------

/**
 * Live layer for `Scaffold`. Resolves the package root once at construction
 * time (from `import.meta.url`) and captures the current working directory.
 */
export const ScaffoldLive: Layer.Layer<Scaffold, never, never> = Layer.succeed(
  Scaffold,
  makeScaffold(resolvePackageRoot(), process.cwd()),
);
