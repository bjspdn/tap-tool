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
// makeScaffold factory (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Construct a `Scaffold` service implementation.
 *
 * @param packageRoot - Absolute path to the installed @bjspdn/tap package.
 * @param cwd         - Working directory to scaffold into (the user's project root).
 */
export const makeScaffold = (packageRoot: string, cwd: string): Scaffold["Type"] =>
  Scaffold.of({
    init: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const terminal = yield* Terminal.Terminal;

        const manifestPath = nodePath.join(cwd, ".tap", "manifest.json");

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
        const templateDirs = [
          nodePath.join(packageRoot, ".claude", "agents"),
          nodePath.join(packageRoot, ".claude", "skills"),
          nodePath.join(packageRoot, ".tap", "prompts"),
        ];

        const absoluteFiles: string[] = [];
        for (const dir of templateDirs) {
          const files = yield* walkDir(fs, dir);
          absoluteFiles.push(...files);
        }

        // Copy each template file into cwd, preserving the relative path.
        const copiedRelPaths: string[] = [];
        for (const srcAbs of absoluteFiles) {
          const relPath = nodePath.relative(packageRoot, srcAbs);
          const destAbs = nodePath.join(cwd, relPath);
          const destDir = nodePath.dirname(destAbs);

          yield* fs.makeDirectory(destDir, { recursive: true }).pipe(
            Effect.catchAll((cause) =>
              Effect.fail<ScaffoldError>({
                _tag: "FileCopyFailed",
                src: srcAbs,
                dest: destAbs,
                cause,
              }),
            ),
          );

          const content = yield* fs.readFileString(srcAbs).pipe(
            Effect.catchAll((cause) =>
              Effect.fail<ScaffoldError>({
                _tag: "FileCopyFailed",
                src: srcAbs,
                dest: destAbs,
                cause,
              }),
            ),
          );

          yield* fs.writeFileString(destAbs, content).pipe(
            Effect.catchAll((cause) =>
              Effect.fail<ScaffoldError>({
                _tag: "FileCopyFailed",
                src: srcAbs,
                dest: destAbs,
                cause,
              }),
            ),
          );

          copiedRelPaths.push(relPath);
          yield* Effect.sync(() => console.log(`  created ${relPath}`));
        }

        // Create the .tap/features/ directory.
        const featuresDir = nodePath.join(cwd, ".tap", "features");
        yield* fs
          .makeDirectory(featuresDir, { recursive: true })
          .pipe(
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
        const tapDir = nodePath.join(cwd, ".tap");
        yield* fs.makeDirectory(tapDir, { recursive: true }).pipe(
          Effect.catchAll((cause) =>
            Effect.fail<ScaffoldError>({
              _tag: "ManifestWriteFailed",
              path: manifestPath,
              cause,
            }),
          ),
        );

        const manifest: InstallManifest = {
          version,
          files: copiedRelPaths,
        };

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
  });

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
