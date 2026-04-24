import { Context, Effect, Layer } from "effect";
import * as YAML from "yaml";

/**
 * Parses the contents of an EVAL_RESULT.md file produced by the Reviewer sub-agent.
 * Input is the raw file text; the caller (RunTask) is responsible for the read
 * and for raising EvalResultMissing when the file is absent.
 */
export class EvalParser extends Context.Tag("EvalParser")<
  EvalParser,
  {
    readonly parse: (rawContent: string) => Effect.Effect<EvalResult, EvalParseFailed>;
  }
>() {}

const VERDICT_RE = /<eval:verdict>\s*(PASS|FAIL)\s*<\/eval:verdict>/;
const RATIONALE_RE = /<eval:rationale>([\s\S]*?)<\/eval:rationale>/;
const ISSUES_RE = /<eval:issues>([\s\S]*?)<\/eval:issues>/;

const fail = (reason: string, rawContent: string): EvalParseFailed => ({
  _tag: "EvalParseFailed",
  reason,
  rawContent,
});

/**
 * Pure parse function. Exported so tests and the Live layer share one implementation.
 */
export const parseEvalContent = (
  rawContent: string,
): Effect.Effect<EvalResult, EvalParseFailed> =>
  Effect.gen(function* () {
    const verdictMatch = VERDICT_RE.exec(rawContent);
    const verdictRaw = verdictMatch?.[1];
    if (!verdictRaw) {
      return yield* Effect.fail(
        fail("missing or malformed <eval:verdict> tag", rawContent),
      );
    }
    const verdict = verdictRaw as "PASS" | "FAIL";

    const rationaleMatch = RATIONALE_RE.exec(rawContent);
    const rationaleRaw = rationaleMatch?.[1];
    if (rationaleRaw === undefined) {
      return yield* Effect.fail(fail("missing <eval:rationale> tag", rawContent));
    }
    const rationale = rationaleRaw.trim();

    const issuesMatch = ISSUES_RE.exec(rawContent);
    const issuesRaw = issuesMatch?.[1];
    if (issuesRaw === undefined) {
      return yield* Effect.fail(fail("missing <eval:issues> tag", rawContent));
    }
    const issuesBody = issuesRaw.trim();

    const issues = yield* parseIssuesBlock(issuesBody, rawContent);

    if (verdict === "FAIL" && issues.length === 0) {
      return yield* Effect.fail(
        fail("FAIL verdict requires at least one issue", rawContent),
      );
    }

    return { verdict, rationale, issues } satisfies EvalResult;
  });

const parseIssuesBlock = (
  issuesBody: string,
  rawContent: string,
): Effect.Effect<ReadonlyArray<EvalIssue>, EvalParseFailed> =>
  Effect.gen(function* () {
    if (issuesBody === "") return [];

    let parsed: unknown;
    try {
      parsed = YAML.parse(issuesBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return yield* Effect.fail(fail(`YAML parse failed: ${msg}`, rawContent));
    }

    if (parsed === null) return [];

    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(
        fail("<eval:issues> must be a YAML list", rawContent),
      );
    }

    const issues: EvalIssue[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const item: unknown = parsed[i];
      if (typeof item !== "object" || item === null) {
        return yield* Effect.fail(
          fail(`issue #${i} is not a YAML mapping`, rawContent),
        );
      }
      const rec = item as Record<string, unknown>;
      const acceptanceFailed = rec["acceptance_failed"];
      const file = rec["file"];
      const problem = rec["problem"];
      const suggestedFix = rec["suggested_fix"];
      if (
        typeof acceptanceFailed !== "string" ||
        typeof file !== "string" ||
        typeof problem !== "string" ||
        typeof suggestedFix !== "string"
      ) {
        return yield* Effect.fail(
          fail(
            `issue #${i} missing required string fields (acceptance_failed, file, problem, suggested_fix)`,
            rawContent,
          ),
        );
      }
      issues.push({
        acceptanceFailed,
        file: file as AbsolutePath,
        problem,
        suggestedFix,
      });
    }
    return issues;
  });

export const EvalParserLive = Layer.succeed(
  EvalParser,
  EvalParser.of({ parse: parseEvalContent }),
);
