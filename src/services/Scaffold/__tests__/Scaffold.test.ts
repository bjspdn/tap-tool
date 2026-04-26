import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { FileSystem, Terminal } from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import * as os from "node:os";
import { makeScaffold } from "../ScaffoldLive";

// ---------------------------------------------------------------------------
// Package root (4 dirs up from __tests__/)
// ---------------------------------------------------------------------------

const packageRoot = nodePath.resolve(
  nodePath.dirname(fileURLToPath(new URL(import.meta.url))),
  "../../../../",
);

// ---------------------------------------------------------------------------
// Terminal mock factory
// ---------------------------------------------------------------------------

const makeTerminalLayer = (readLineResponse: string): Layer.Layer<Terminal.Terminal> =>
  Layer.succeed(
    Terminal.Terminal,
    Terminal.Terminal.of({
      readLine: Effect.succeed(readLineResponse),
      display: (_text: string) => Effect.void,
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      isTTY: Effect.succeed(false),
      readInput: Effect.die("readInput not mocked in Scaffold tests"),
    }),
  );

// ---------------------------------------------------------------------------
// Test layer: NodeFileSystem + Terminal mock
// ---------------------------------------------------------------------------

const makeTestLayer = (readLineResponse = "n"): Layer.Layer<
  FileSystem.FileSystem | Terminal.Terminal
> =>
  Layer.merge(NodeFileSystem.layer, makeTerminalLayer(readLineResponse));

// ---------------------------------------------------------------------------
// Tmp directory management
// ---------------------------------------------------------------------------

let tmpDir = "";

beforeEach(async () => {
  tmpDir = nodePath.join(os.tmpdir(), `scaffold-test-${crypto.randomUUID()}`);
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(tmpDir, { recursive: true });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

afterEach(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .remove(tmpDir, { recursive: true })
        .pipe(Effect.catchAll(() => Effect.void));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const runInit = (cwd: string, terminalResponse = "n") =>
  makeScaffold(packageRoot, cwd)
    .init()
    .pipe(Effect.provide(makeTestLayer(terminalResponse)));

const runUpdate = (cwd: string) =>
  makeScaffold(packageRoot, cwd)
    .update()
    .pipe(Effect.provide(NodeFileSystem.layer));

// ---------------------------------------------------------------------------
// Tests — init
// ---------------------------------------------------------------------------

describe("Scaffold.init", () => {
  test("creates .claude/, .tap/prompts/, .tap/features/, and manifest", async () => {
    await Effect.runPromise(runInit(tmpDir));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const manifestRaw = yield* fs.readFileString(
          nodePath.join(tmpDir, ".tap", "manifest.json"),
        );
        const manifest = JSON.parse(manifestRaw) as InstallManifest;
        const featuresExists = yield* fs.exists(nodePath.join(tmpDir, ".tap", "features"));
        const agentsExist = yield* fs.exists(nodePath.join(tmpDir, ".claude", "agents"));
        return { manifest, featuresExists, agentsExist };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    expect(result.featuresExists).toBe(true);
    expect(result.agentsExist).toBe(true);
    expect(typeof result.manifest.version).toBe("string");
    expect(Array.isArray(result.manifest.files)).toBe(true);
    expect(result.manifest.files.length).toBeGreaterThan(0);
  });

  test("manifest files list contains agent and skill paths", async () => {
    await Effect.runPromise(runInit(tmpDir));

    const manifestRaw = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(nodePath.join(tmpDir, ".tap", "manifest.json"));
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const manifest = JSON.parse(manifestRaw) as InstallManifest;

    const hasAgent = manifest.files.some((f) => f.startsWith(".claude/agents/"));
    const hasPrompt = manifest.files.some((f) => f.startsWith(".tap/prompts/"));
    expect(hasAgent).toBe(true);
    expect(hasPrompt).toBe(true);
  });

  test("manifest is written last (all files already copied when it appears)", async () => {
    await Effect.runPromise(runInit(tmpDir));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const manifestRaw = yield* fs.readFileString(
          nodePath.join(tmpDir, ".tap", "manifest.json"),
        );
        const manifest = JSON.parse(manifestRaw) as InstallManifest;
        // Verify each listed file actually exists
        const checks: boolean[] = [];
        for (const rel of manifest.files) {
          checks.push(yield* fs.exists(nodePath.join(tmpDir, rel)));
        }
        return checks;
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    expect(result.every(Boolean)).toBe(true);
  });

  test("re-init with confirmation 'y' overwrites files and updates manifest", async () => {
    // First init
    await Effect.runPromise(runInit(tmpDir));

    // Overwrite one agent file with sentinel content
    const agentPath = nodePath.join(tmpDir, ".claude", "agents", "Composer.md");
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(agentPath, "SENTINEL");
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    // Re-init with 'y' confirmation
    await Effect.runPromise(runInit(tmpDir, "y"));

    const content = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(agentPath);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    expect(content).not.toBe("SENTINEL");
  });

  test("re-init with confirmation 'n' fails with ConfirmationDeclined", async () => {
    // First init
    await Effect.runPromise(runInit(tmpDir));

    // Attempt re-init with 'n'
    const exit = await Effect.runPromise(
      runInit(tmpDir, "n").pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause;
      // The failure carries a ScaffoldError with _tag ConfirmationDeclined
      expect(JSON.stringify(err)).toContain("ConfirmationDeclined");
    }
  });

  test("re-init with empty confirmation defaults to no (ConfirmationDeclined)", async () => {
    await Effect.runPromise(runInit(tmpDir));

    const exit = await Effect.runPromise(
      runInit(tmpDir, "").pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — update
// ---------------------------------------------------------------------------

describe("Scaffold.update", () => {
  test("normal update: copies all template files and rewrites manifest", async () => {
    // Initialise first so manifest exists
    await Effect.runPromise(runInit(tmpDir));

    // Overwrite one agent file with sentinel to confirm update overwrites it
    const agentPath = nodePath.join(tmpDir, ".claude", "agents", "Composer.md");
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(agentPath, "SENTINEL");
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    await Effect.runPromise(runUpdate(tmpDir));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const manifestRaw = yield* fs.readFileString(
          nodePath.join(tmpDir, ".tap", "manifest.json"),
        );
        const manifest = JSON.parse(manifestRaw) as InstallManifest;
        const agentContent = yield* fs.readFileString(agentPath);
        return { manifest, agentContent };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    // Sentinel overwritten by update
    expect(result.agentContent).not.toBe("SENTINEL");
    // Manifest still valid
    expect(typeof result.manifest.version).toBe("string");
    expect(result.manifest.files.length).toBeGreaterThan(0);
  });

  test("update deletes stale files no longer in template list", async () => {
    // Initialise first
    await Effect.runPromise(runInit(tmpDir));

    // Inject a fake stale entry into the manifest and create its file on disk
    const staleRelPath = ".claude/agents/STALE_FILE_TO_REMOVE.md";
    const staleAbsPath = nodePath.join(tmpDir, staleRelPath);

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Create the stale file
        yield* fs.writeFileString(staleAbsPath, "stale content");
        // Patch the manifest to include it
        const manifestPath = nodePath.join(tmpDir, ".tap", "manifest.json");
        const raw = yield* fs.readFileString(manifestPath);
        const manifest = JSON.parse(raw) as InstallManifest;
        manifest.files.push(staleRelPath);
        yield* fs.writeFileString(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    // Run update
    await Effect.runPromise(runUpdate(tmpDir));

    // Stale file must be gone
    const staleExists = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.exists(staleAbsPath);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    expect(staleExists).toBe(false);

    // New manifest must not contain the stale path
    const newManifestRaw = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(nodePath.join(tmpDir, ".tap", "manifest.json"));
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const newManifest = JSON.parse(newManifestRaw) as InstallManifest;
    expect(newManifest.files.includes(staleRelPath)).toBe(false);
  });

  test("update refuses with ManifestReadFailed when not initialised", async () => {
    // tmpDir has no manifest — never initialised
    const exit = await Effect.runPromise(runUpdate(tmpDir).pipe(Effect.exit));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("ManifestReadFailed");
    }
  });
});
