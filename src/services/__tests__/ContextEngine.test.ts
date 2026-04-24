import { describe, test, expect } from "bun:test";
import { Effect, Exit, Option } from "effect";
import { makeContextEngine } from "../ContextEngine";

/** Brand a raw string as a nominal subtype for test fixtures. */
const brand = <B extends string>(s: string): string & { readonly __brand: B } =>
  s as string & { readonly __brand: B };

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: brand<"TaskId">("S3.T2"),
  title: "Tests for ContextEngine",
  files: [brand<"AbsolutePath">("src/services/__tests__/ContextEngine.test.ts")],
  acceptance: [
    "Fixture renders verbatim",
    "Missing placeholder raises TemplateRenderFailed",
  ],
  depends_on: [],
  status: "in_progress",
  attempts: 1,
  maxAttempts: 3,
  ...overrides,
});

const makeFeature = (overrides: Partial<Feature> = {}): Feature => ({
  feature: "composer-reviewer",
  goal: "Deliver the Composer + Reviewer sub-agent vertical slice.",
  constraints: [
    "Services are Effect Context.Tag + Layer pairs.",
    "No `any`, no `as unknown as`.",
  ],
  stories: [],
  ...overrides,
});

const makeComposerInput = (overrides: Partial<ComposerRenderInput> = {}): ComposerRenderInput => ({
  task: makeTask(),
  feature: makeFeature(),
  specsPath: brand<"AbsolutePath">(".tap/features/composer-reviewer/SPECS.md"),
  contractPath: brand<"AbsolutePath">(".tap/features/composer-reviewer/FEATURE_CONTRACT.json"),
  featureRoot: brand<"AbsolutePath">(".tap/features/composer-reviewer"),
  attempt: 1,
  priorEval: Option.none(),
  gitStatus: "On branch main-loop\nnothing to commit",
  ...overrides,
});

const makeReviewerInput = (overrides: Partial<ReviewerRenderInput> = {}): ReviewerRenderInput => ({
  task: makeTask(),
  feature: makeFeature(),
  specsPath: brand<"AbsolutePath">(".tap/features/composer-reviewer/SPECS.md"),
  contractPath: brand<"AbsolutePath">(".tap/features/composer-reviewer/FEATURE_CONTRACT.json"),
  featureRoot: brand<"AbsolutePath">(".tap/features/composer-reviewer"),
  attempt: 1,
  evalPath: brand<"AbsolutePath">(".tap/features/composer-reviewer/eval/EVAL_RESULT.md"),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextEngine", () => {
  test("Fixture renders verbatim — production COMPOSER template", async () => {
    const composerSrc = await Bun.file(".tap/prompts/COMPOSER_CONTRACT.md").text();
    const reviewerSrc = await Bun.file(".tap/prompts/REVIEWER_CONTRACT.md").text();
    const engine = makeContextEngine(composerSrc, reviewerSrc);

    const task = makeTask();
    const feature = makeFeature();
    const input = makeComposerInput({ task, feature });

    const result = await Effect.runPromise(engine.renderComposer(input));

    // feature values
    expect(result).toContain(feature.goal);
    for (const constraint of feature.constraints) {
      expect(result).toContain(constraint);
    }

    // task values
    expect(result).toContain(task.id as string);
    expect(result).toContain(task.title);
    for (const file of task.files) {
      expect(result).toContain(file as string);
    }
    for (const criterion of task.acceptance) {
      expect(result).toContain(criterion);
    }

    // reference paths
    expect(result).toContain(input.specsPath as string);
    expect(result).toContain(input.contractPath as string);

    // git status
    expect(result).toContain(input.gitStatus);
  });

  test("Missing placeholder raises TemplateRenderFailed with correct missingKey", async () => {
    const badComposerSrc = "Hello {{ mystery_field }} world";
    const reviewerSrc = await Bun.file(".tap/prompts/REVIEWER_CONTRACT.md").text();
    const engine = makeContextEngine(badComposerSrc, reviewerSrc);

    const exit = await Effect.runPromiseExit(engine.renderComposer(makeComposerInput()));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const cause = exit.cause;
      // The error is a plain fail cause; unwrap it.
      if (cause._tag === "Fail") {
        const err = cause.error as TemplateRenderError;
        expect(err._tag).toBe("TemplateRenderFailed");
        expect(err.template).toBe("COMPOSER_CONTRACT.md");
        expect(err.missingKey).toBe("mystery_field");
      } else {
        throw new Error(`Unexpected cause tag: ${cause._tag}`);
      }
    }
  });

  test("User text containing {{ does not break the render", async () => {
    const composerSrc = await Bun.file(".tap/prompts/COMPOSER_CONTRACT.md").text();
    const reviewerSrc = await Bun.file(".tap/prompts/REVIEWER_CONTRACT.md").text();
    const engine = makeContextEngine(composerSrc, reviewerSrc);

    const trickyTitle = "Use {{ braces }} in title";
    const trickyAcceptance = "Matches {{template}} placeholder syntax";

    const input = makeComposerInput({
      task: makeTask({
        title: trickyTitle,
        acceptance: [trickyAcceptance],
      }),
    });

    const result = await Effect.runPromise(engine.renderComposer(input));

    expect(result).toContain(trickyTitle);
    expect(result).toContain(trickyAcceptance);
  });

  test("Reviewer render smoke — evalPath verbatim + eval:verdict tag present", async () => {
    const composerSrc = await Bun.file(".tap/prompts/COMPOSER_CONTRACT.md").text();
    const reviewerSrc = await Bun.file(".tap/prompts/REVIEWER_CONTRACT.md").text();
    const engine = makeContextEngine(composerSrc, reviewerSrc);

    const input = makeReviewerInput();
    const result = await Effect.runPromise(engine.renderReviewer(input));

    expect(result).toContain(input.evalPath as string);
    expect(result).toContain("<eval:verdict>");
  });
});
