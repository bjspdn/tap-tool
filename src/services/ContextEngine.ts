import { Context, Effect, Layer, Option } from "effect";
import { FileSystem } from "@effect/platform";
import Handlebars from "handlebars";

// Template paths relative to the repo root (the Effect cwd during normal use and tests).
const COMPOSER_TEMPLATE_PATH = ".tap/prompts/COMPOSER_CONTRACT.md";
const REVIEWER_TEMPLATE_PATH = ".tap/prompts/REVIEWER_CONTRACT.md";

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

/**
 * Factory that builds a ContextEngine service from pre-loaded template source strings.
 * Useful for tests that want to inject custom or minimal templates without touching the
 * filesystem.
 */
export const makeContextEngine = (
  composerSrc: string,
  reviewerSrc: string,
): ContextEngine["Type"] => {
  const composerTpl = Handlebars.compile(composerSrc, { strict: true });
  const reviewerTpl = Handlebars.compile(reviewerSrc, { strict: true });
  return ContextEngine.of({
    renderComposer: (input) =>
      tryRender("COMPOSER_CONTRACT.md", composerTpl, toComposerContext(input)),
    renderReviewer: (input) =>
      tryRender("REVIEWER_CONTRACT.md", reviewerTpl, toReviewerContext(input)),
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
    return makeContextEngine(composerSrc, reviewerSrc);
  }),
);

// --- Context mappers (camelCase RenderInput → snake_case Handlebars context) ---

const toComposerContext = (input: ComposerRenderInput) => ({
  feature_goal: input.feature.goal,
  feature_constraints: input.feature.constraints,
  task_id: input.task.id as string,
  task_title: input.task.title,
  task_files: input.task.files as readonly string[],
  task_acceptance: input.task.acceptance,
  specs_path: input.specsPath as string,
  contract_path: input.contractPath as string,
  // Empty string is Handlebars-falsy, so {{#if prior_eval_path}} is skipped on attempt 1.
  prior_eval_path: Option.getOrElse(input.priorEval, () => "" as string),
  git_status: input.gitStatus,
});

const toReviewerContext = (input: ReviewerRenderInput) => ({
  task_id: input.task.id as string,
  task_title: input.task.title,
  task_files: input.task.files as readonly string[],
  task_acceptance: input.task.acceptance,
  specs_path: input.specsPath as string,
  contract_path: input.contractPath as string,
  eval_path: input.evalPath as string,
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
