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
const SUMMARY_RE = /<eval:summary>([\s\S]*?)<\/eval:summary>/;
const COMMENTS_RE = /<eval:comments>([\s\S]*?)<\/eval:comments>/;

const VALID_SEVERITIES = new Set(["blocker", "suggestion", "nitpick"]);

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

    const summaryMatch = SUMMARY_RE.exec(rawContent);
    const summaryRaw = summaryMatch?.[1];
    if (summaryRaw === undefined) {
      return yield* Effect.fail(fail("missing <eval:summary> tag", rawContent));
    }
    const summary = summaryRaw.trim();

    const commentsMatch = COMMENTS_RE.exec(rawContent);
    const commentsRaw = commentsMatch?.[1];
    if (commentsRaw === undefined) {
      return yield* Effect.fail(fail("missing <eval:comments> tag", rawContent));
    }
    const commentsBody = commentsRaw.trim();

    const comments = yield* parseCommentsBlock(commentsBody, rawContent);

    if (verdict === "FAIL" && comments.length === 0) {
      return yield* Effect.fail(
        fail("FAIL verdict requires at least one comment", rawContent),
      );
    }

    return { verdict, summary, comments } satisfies EvalResult;
  });

const parseCommentsBlock = (
  commentsBody: string,
  rawContent: string,
): Effect.Effect<ReadonlyArray<EvalComment>, EvalParseFailed> =>
  Effect.gen(function* () {
    if (commentsBody === "") return [];

    let parsed: unknown;
    try {
      parsed = YAML.parse(commentsBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return yield* Effect.fail(fail(`YAML parse failed: ${msg}`, rawContent));
    }

    if (parsed === null) return [];

    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(
        fail("<eval:comments> must be a YAML list", rawContent),
      );
    }

    const comments: EvalComment[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const item: unknown = parsed[i];
      if (typeof item !== "object" || item === null) {
        return yield* Effect.fail(
          fail(`comment #${i} is not a YAML mapping`, rawContent),
        );
      }
      const rec = item as Record<string, unknown>;
      const file = rec["file"];
      const severity = rec["severity"];
      const comment = rec["comment"];

      if (typeof file !== "string") {
        return yield* Effect.fail(
          fail(`comment #${i} missing required string field "file"`, rawContent),
        );
      }
      if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity)) {
        return yield* Effect.fail(
          fail(
            `comment #${i} "severity" must be "blocker", "suggestion", or "nitpick"`,
            rawContent,
          ),
        );
      }
      if (typeof comment !== "string") {
        return yield* Effect.fail(
          fail(`comment #${i} missing required string field "comment"`, rawContent),
        );
      }

      const lineRaw = rec["line"];
      const line: number | null | undefined =
        lineRaw === undefined
          ? undefined
          : lineRaw === null
            ? null
            : typeof lineRaw === "number"
              ? lineRaw
              : (() => {
                  return undefined; // unexpected type — treat as absent
                })();

      comments.push({
        file,
        line,
        severity: severity as "blocker" | "suggestion" | "nitpick",
        comment,
      });
    }
    return comments;
  });

export const EvalParserLive = Layer.succeed(
  EvalParser,
  EvalParser.of({ parse: parseEvalContent }),
);
