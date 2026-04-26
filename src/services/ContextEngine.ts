import { Context, Effect, Layer, Option } from "effect";
import { FileSystem } from "@effect/platform";
import Handlebars from "handlebars";

// Template paths relative to the repo root (the Effect cwd during normal use and tests).
const COMPOSER_TEMPLATE_PATH = ".tap/prompts/COMPOSER_CONTRACT.md";
const REVIEWER_TEMPLATE_PATH = ".tap/prompts/REVIEWER_CONTRACT.md";
const SUMMARIZER_TEMPLATE_PATH = ".tap/prompts/SUMMARIZER_CONTRACT.md";

// ---------------------------------------------------------------------------
// Depth-section extractor
// ---------------------------------------------------------------------------

/**
 * Error emitted when a `<feature:depth>` block is structurally malformed
 * (e.g. open tag without a matching close tag).
 */
export type DepthParseError = {
  readonly _tag: "DepthParseError";
  readonly message: string;
};

/**
 * Extract the inner content of the `<feature:depth>…</feature:depth>` XML
 * block from `specsContent`.
 *
 * - Returns `None` when the block is absent (sibling features without the
 *   section keep working via an empty `{{depth_section}}` placeholder).
 * - Returns `Some(innerContent)` when the block is present and well-formed.
 * - Fails with `DepthParseError` when the block is malformed (open tag
 *   without close, mismatched delimiters) so callers are forced to surface
 *   the failure rather than silently proceeding with empty content.
 */
export const extractDepthSection = (
  specsContent: string,
): Effect.Effect<Option.Option<string>, DepthParseError> => {
  const OPEN = "<feature:depth>";
  const CLOSE = "</feature:depth>";

  const openIdx = specsContent.indexOf(OPEN);
  const closeIdx = specsContent.indexOf(CLOSE);

  // Completely absent — no open tag, no close tag.
  if (openIdx === -1 && closeIdx === -1) {
    return Effect.succeed(Option.none());
  }

  // Open tag present but close tag missing — malformed.
  if (openIdx !== -1 && closeIdx === -1) {
    return Effect.fail({
      _tag: "DepthParseError" as const,
      message: `<feature:depth> opened at index ${openIdx} but </feature:depth> was never closed`,
    });
  }

  // Close tag present but open tag missing — malformed.
  if (openIdx === -1 && closeIdx !== -1) {
    return Effect.fail({
      _tag: "DepthParseError" as const,
      message: `</feature:depth> found at index ${closeIdx} without a preceding <feature:depth>`,
    });
  }

  // Close tag appears before open tag — malformed.
  if (closeIdx < openIdx) {
    return Effect.fail({
      _tag: "DepthParseError" as const,
      message: `</feature:depth> at index ${closeIdx} precedes <feature:depth> at index ${openIdx}`,
    });
  }

  // Well-formed: extract inner content (strip leading/trailing whitespace).
  const inner = specsContent.slice(openIdx + OPEN.length, closeIdx).trim();
  return Effect.succeed(Option.some(inner));
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Return the directory portion of a file path (everything before the last `/`). */
const dirname = (filePath: string): string => {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? "." : filePath.slice(0, lastSlash);
};

/**
 * Heuristic: a path is a file path when its last segment contains a dot.
 * Directory paths like `src/services` have no dot in the final segment.
 */
const isFilePath = (p: string): boolean => {
  const basename = p.slice(p.lastIndexOf("/") + 1);
  return basename.includes(".");
};

// ---------------------------------------------------------------------------
// parseModulePaths — extract module paths from a depth section string
// ---------------------------------------------------------------------------

/**
 * Extract module file/directory paths from the inner content of a `<spec:depth>` block.
 * Matches lines of the form: `- **Path:** \`<path>\``
 */
const parseModulePaths = (depthSection: string): ReadonlyArray<string> => {
  const result: string[] = [];
  const re = /- \*\*Path:\*\* `([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(depthSection)) !== null) {
    if (match[1]) result.push(match[1]);
  }
  return result;
};

// ---------------------------------------------------------------------------
// buildManifest — internal manifest construction (hidden complexity)
// ---------------------------------------------------------------------------

/**
 * Build a ScoutManifest from task files and depth-section module paths.
 *
 * - `targets`: task.files mapped to ManifestEntry with reason "task file".
 * - `context`: sibling/child files of depth-section modules, deduplicated against
 *   task.files and against each other.
 * - File paths resolve to their parent directory; directory paths resolve to themselves.
 * - Missing or unreadable paths are skipped gracefully (`readDir` returns `[]` on error).
 * - When `depthSectionOpt` is `None`, only targets are returned (no context entries).
 */
const buildManifest = (
  depthSectionOpt: Option.Option<string>,
  taskFiles: ReadonlyArray<string>,
  readDir: (dirPath: string) => Effect.Effect<ReadonlyArray<string>, never>,
): Effect.Effect<ScoutManifest, never> =>
  Effect.gen(function* () {
    const taskFileSet = new Set(taskFiles);
    const targets: ManifestEntry[] = Array.from(taskFiles).map((p) => ({
      path: p,
      reason: "task file",
    }));

    if (Option.isNone(depthSectionOpt)) {
      return { targets, context: [] };
    }

    const modulePaths = parseModulePaths(depthSectionOpt.value);
    const contextPathSet = new Set<string>();
    const contextEntries: ManifestEntry[] = [];

    for (const modulePath of modulePaths) {
      const dirPath = isFilePath(modulePath) ? dirname(modulePath) : modulePath;
      const children = yield* readDir(dirPath);

      for (const child of children) {
        if (!taskFileSet.has(child) && !contextPathSet.has(child)) {
          contextPathSet.add(child);
          contextEntries.push({ path: child, reason: "sibling of depth module", module: modulePath });
        }
      }
    }

    return { targets, context: contextEntries };
  });

// ---------------------------------------------------------------------------
// SummarizerRenderInput
// ---------------------------------------------------------------------------

/**
 * Input to `renderSummarizer`. Parallel shape to `ComposerRenderInput` and
 * `ReviewerRenderInput`. The caller is responsible for formatting `stoppedReason`
 * from the `StoppedReason` discriminated union into a human-readable string.
 */
export type SummarizerRenderInput = {
  readonly feature: Feature;
  readonly specsPath: AbsolutePath;
  readonly contractPath: AbsolutePath;
  /** Absolute path where SUMMARY.md should be written by the Summarizer agent. */
  readonly summaryPath: AbsolutePath;
  /** Human-readable representation of the terminal `StoppedReason` variant. */
  readonly stoppedReason: string;
  readonly tasksDone: ReadonlyArray<TaskId>;
  readonly tasksFailed: ReadonlyArray<TaskId>;
};

// ---------------------------------------------------------------------------
// ContextEngine service
// ---------------------------------------------------------------------------

/**
 * Effect service that renders role-specific prompt contracts from Handlebars templates.
 * Reads both templates once at layer construction time.
 */
export class ContextEngine extends Context.Tag("ContextEngine")<
  ContextEngine,
  {
    readonly renderComposer: (
      input: ComposerRenderInput,
    ) => Effect.Effect<string, TemplateRenderError>;
    readonly renderReviewer: (
      input: ReviewerRenderInput,
    ) => Effect.Effect<string, TemplateRenderError>;
    // Optional so that existing ContextEngine mocks in LoopRunner tests that
    // only stub renderComposer + renderReviewer continue to compile. The live
    // layer and makeContextEngine always provide a full implementation.
    readonly renderSummarizer?: (
      input: SummarizerRenderInput,
    ) => Effect.Effect<string, TemplateRenderError>;
  }
>() {}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory that builds a ContextEngine service from pre-loaded template source strings.
 * Useful for tests that want to inject custom or minimal templates without touching the
 * filesystem.
 *
 * @param readFile - Optional file reader used to load SPECS.md content for
 *   `{{depth_section}}` injection. Defaults to returning empty string (no depth
 *   section) when omitted — suitable for tests that don't exercise depth parsing.
 * @param getGitDiff - Optional shell-out for the `{{git_diff}}` placeholder injected
 *   into the Summarizer template. Defaults to empty string — suitable for tests that
 *   don't exercise git diff output.
 */
export const makeContextEngine = (
  composerSrc: string,
  reviewerSrc: string,
  summarizerSrc: string,
  readFile: (path: string) => Effect.Effect<string, never> = (_path) =>
    Effect.succeed(""),
  getGitDiff: () => Effect.Effect<string, never> = () => Effect.succeed(""),
  readDir: (dirPath: string) => Effect.Effect<ReadonlyArray<string>, never> = (_dirPath) =>
    Effect.succeed([]),
): ContextEngine["Type"] => {
  const composerTpl = Handlebars.compile(composerSrc, { strict: true });
  const reviewerTpl = Handlebars.compile(reviewerSrc, { strict: true });
  const summarizerTpl = Handlebars.compile(summarizerSrc, { strict: true });

  /** Resolve the depth section Option for a given specs path; maps DepthParseError to TemplateRenderError. */
  const resolveDepthOpt = (
    specsPath: string,
  ): Effect.Effect<Option.Option<string>, TemplateRenderError> =>
    Effect.gen(function* () {
      const content = yield* readFile(specsPath);
      return yield* extractDepthSection(content).pipe(
        Effect.mapError(
          (e): TemplateRenderError => ({
            _tag: "TemplateRenderFailed",
            template: "SPECS.md (depth section)",
            missingKey: e.message,
          }),
        ),
      );
    });

  const resolveDepthSection = (
    specsPath: string,
  ): Effect.Effect<string, TemplateRenderError> =>
    resolveDepthOpt(specsPath).pipe(
      Effect.map((opt) => Option.getOrElse(opt, () => "")),
    );

  return ContextEngine.of({
    renderComposer: (input) =>
      Effect.gen(function* () {
        const depthOpt = yield* resolveDepthOpt(input.specsPath as string);
        const depthSection = Option.getOrElse(depthOpt, () => "");
        const manifest = yield* buildManifest(depthOpt, input.task.files as readonly string[], readDir);
        return yield* tryRender(
          "COMPOSER_CONTRACT.md",
          composerTpl,
          toComposerContext(input, depthSection, manifest),
        );
      }),

    renderReviewer: (input) =>
      Effect.gen(function* () {
        const depthOpt = yield* resolveDepthOpt(input.specsPath as string);
        const depthSection = Option.getOrElse(depthOpt, () => "");
        const manifest = yield* buildManifest(depthOpt, input.task.files as readonly string[], readDir);
        return yield* tryRender(
          "REVIEWER_CONTRACT.md",
          reviewerTpl,
          toReviewerContext(input, depthSection, manifest),
        );
      }),

    renderSummarizer: (input) =>
      Effect.gen(function* () {
        const depthSection = yield* resolveDepthSection(input.specsPath as string);
        const gitDiff = yield* getGitDiff();
        return yield* tryRender(
          "SUMMARIZER_CONTRACT.md",
          summarizerTpl,
          toSummarizerContext(input, depthSection, gitDiff),
        );
      }),
  });
};

/**
 * Live layer for ContextEngine — reads COMPOSER_CONTRACT.md, REVIEWER_CONTRACT.md,
 * and SUMMARIZER_CONTRACT.md once from the filesystem, compiles them with Handlebars
 * strict mode, and exposes the three render methods.
 */
export const ContextEngineLive = Layer.effect(
  ContextEngine,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const composerSrc = yield* fs.readFileString(COMPOSER_TEMPLATE_PATH);
    const reviewerSrc = yield* fs.readFileString(REVIEWER_TEMPLATE_PATH);
    const summarizerSrc = yield* fs.readFileString(SUMMARIZER_TEMPLATE_PATH);

    // Read specs file content for depth-section injection; default to empty
    // string when the file cannot be read (missing file = no depth section).
    const readFile = (path: string): Effect.Effect<string, never> =>
      fs.readFileString(path).pipe(Effect.catchAll(() => Effect.succeed("")));

    // Shell out to get the git diff at render time; fall back to empty string on error.
    const getGitDiff = (): Effect.Effect<string, never> =>
      Effect.tryPromise(async () => {
        const proc = Bun.spawn(["git", "diff", "HEAD"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return stdout;
      }).pipe(Effect.catchAll(() => Effect.succeed("")));

    // List immediate children of a directory for manifest resolution; skips gracefully on error.
    const readDir = (dirPath: string): Effect.Effect<ReadonlyArray<string>, never> =>
      fs.readDirectory(dirPath).pipe(
        Effect.map((entries) => entries.map((name) => `${dirPath}/${name}`)),
        Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)),
      );

    return makeContextEngine(composerSrc, reviewerSrc, summarizerSrc, readFile, getGitDiff, readDir);
  }),
);

// --- Context mappers (camelCase RenderInput → snake_case Handlebars context) ---

const findParentStory = (feature: Feature, task: Task): Story | undefined =>
  feature.stories.find((s) => s.tasks.some((t) => t.id === task.id));

const toComposerContext = (
  input: ComposerRenderInput,
  depthSection: string,
  scoutManifest: ScoutManifest,
) => {
  const story = findParentStory(input.feature, input.task);
  return {
    feature_description: input.feature.description ?? input.feature.goal,
    feature_constraints: input.feature.constraints,
    task_id: input.task.id as string,
    task_title: input.task.title,
    task_description: input.task.description ?? input.task.title,
    task_files: input.task.files as readonly string[],
    story_title: story?.title ?? "",
    story_description: story?.description ?? story?.title ?? "",
    specs_path: input.specsPath as string,
    contract_path: input.contractPath as string,
    // Empty string is Handlebars-falsy, so {{#if prior_eval_path}} is skipped on attempt 1.
    prior_eval_path: Option.getOrElse(input.priorEval, () => "" as string),
    git_status: input.gitStatus,
    depth_section: depthSection,
    scout_manifest: scoutManifest,
  };
};

const toReviewerContext = (
  input: ReviewerRenderInput,
  depthSection: string,
  scoutManifest: ScoutManifest,
) => {
  const story = findParentStory(input.feature, input.task);
  return {
    feature_description: input.feature.description ?? input.feature.goal,
    feature_constraints: input.feature.constraints,
    task_id: input.task.id as string,
    task_title: input.task.title,
    task_description: input.task.description ?? input.task.title,
    task_files: input.task.files as readonly string[],
    story_title: story?.title ?? "",
    story_description: story?.description ?? story?.title ?? "",
    specs_path: input.specsPath as string,
    contract_path: input.contractPath as string,
    eval_path: input.evalPath as string,
    depth_section: depthSection,
    scout_manifest: scoutManifest,
  };
};

const toSummarizerContext = (
  input: SummarizerRenderInput,
  depthSection: string,
  gitDiff: string,
) => ({
  feature_description: input.feature.description ?? input.feature.goal,
  specs_path: input.specsPath as string,
  contract_path: input.contractPath as string,
  summary_path: input.summaryPath as string,
  stopped_reason: input.stoppedReason,
  tasks_done: input.tasksDone as readonly string[],
  tasks_failed: input.tasksFailed as readonly string[],
  depth_section: depthSection,
  git_diff: gitDiff,
});

// --- tryRender: translate Handlebars throws into TemplateRenderError ---

const tryRender = (
  template: string,
  compiled: HandlebarsTemplateDelegate,
  context: object,
): Effect.Effect<string, TemplateRenderError> =>
  Effect.try({
    try: () => compiled(context),
    catch: (err) => ({
      _tag: "TemplateRenderFailed" as const,
      template,
      missingKey: extractMissingKey(err),
    }),
  });

const extractMissingKey = (err: unknown): string => {
  if (err instanceof Error) {
    // Handlebars strict-mode message shape: `"name" not defined in [object Object]`
    const match = /"([^"]+)" not defined/.exec(err.message);
    if (match && match[1]) return match[1];
    return err.message;
  }
  return String(err);
};
