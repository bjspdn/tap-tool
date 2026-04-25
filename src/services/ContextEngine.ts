import { Context, Effect, Layer, Option } from "effect";
import { FileSystem } from "@effect/platform";
import Handlebars from "handlebars";

// Template paths relative to the repo root (the Effect cwd during normal use and tests).
const COMPOSER_TEMPLATE_PATH = ".tap/prompts/COMPOSER_CONTRACT.md";
const REVIEWER_TEMPLATE_PATH = ".tap/prompts/REVIEWER_CONTRACT.md";

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
 */
export const makeContextEngine = (
  composerSrc: string,
  reviewerSrc: string,
  readFile: (path: string) => Effect.Effect<string, never> = (_path) =>
    Effect.succeed(""),
): ContextEngine["Type"] => {
  const composerTpl = Handlebars.compile(composerSrc, { strict: true });
  const reviewerTpl = Handlebars.compile(reviewerSrc, { strict: true });

  const resolveDepthSection = (
    specsPath: string,
  ): Effect.Effect<string, TemplateRenderError> =>
    Effect.gen(function* () {
      const content = yield* readFile(specsPath);
      const depthOpt = yield* extractDepthSection(content).pipe(
        Effect.mapError(
          (e): TemplateRenderError => ({
            _tag: "TemplateRenderFailed",
            template: "SPECS.md (depth section)",
            missingKey: e.message,
          }),
        ),
      );
      return Option.getOrElse(depthOpt, () => "");
    });

  return ContextEngine.of({
    renderComposer: (input) =>
      Effect.gen(function* () {
        const depthSection = yield* resolveDepthSection(input.specsPath as string);
        return yield* tryRender(
          "COMPOSER_CONTRACT.md",
          composerTpl,
          toComposerContext(input, depthSection),
        );
      }),

    renderReviewer: (input) =>
      Effect.gen(function* () {
        const depthSection = yield* resolveDepthSection(input.specsPath as string);
        return yield* tryRender(
          "REVIEWER_CONTRACT.md",
          reviewerTpl,
          toReviewerContext(input, depthSection),
        );
      }),
  });
};

/**
 * Live layer for ContextEngine — reads COMPOSER_CONTRACT.md and REVIEWER_CONTRACT.md
 * once from the filesystem, compiles them with Handlebars strict mode, and exposes
 * the two render methods.
 */
export const ContextEngineLive = Layer.effect(
  ContextEngine,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const composerSrc = yield* fs.readFileString(COMPOSER_TEMPLATE_PATH);
    const reviewerSrc = yield* fs.readFileString(REVIEWER_TEMPLATE_PATH);

    // Read specs file content for depth-section injection; default to empty
    // string when the file cannot be read (missing file = no depth section).
    const readFile = (path: string): Effect.Effect<string, never> =>
      fs.readFileString(path).pipe(Effect.catchAll(() => Effect.succeed("")));

    return makeContextEngine(composerSrc, reviewerSrc, readFile);
  }),
);

// --- Context mappers (camelCase RenderInput → snake_case Handlebars context) ---

const findParentStory = (feature: Feature, task: Task): Story | undefined =>
  feature.stories.find((s) => s.tasks.some((t) => t.id === task.id));

const toComposerContext = (input: ComposerRenderInput, depthSection: string) => {
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
  };
};

const toReviewerContext = (input: ReviewerRenderInput, depthSection: string) => {
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
  };
};

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
