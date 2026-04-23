import { describe, test, expect } from "bun:test";
import { Effect, Exit } from "effect";
import { parseEvalContent } from "../EvalParser";

const brand = <B extends string>(s: string): string & { readonly __brand: B } =>
  s as string & { readonly __brand: B };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASS_EMPTY = `
Some prose before the verdict block.

<eval:verdict>PASS</eval:verdict>
<eval:rationale>
All acceptance criteria met. Tests green. No anti-pattern violations.
</eval:rationale>
<eval:issues>
</eval:issues>

Trailing prose that should be ignored.
`;

const FAIL_TWO_ISSUES = `
<eval:verdict>FAIL</eval:verdict>
<eval:rationale>
Two acceptance criteria unmet.
</eval:rationale>
<eval:issues>
- acceptance_failed: "bunx tsc --noEmit passes"
  file: "src/services/EvalParser.ts"
  problem: "type error on line 14 — EvalResult.verdict widened to string"
  suggested_fix: "narrow verdict via \\"PASS\\" | \\"FAIL\\" cast after regex match"
- acceptance_failed: "bun test passes"
  file: "src/services/__tests__/EvalParser.test.ts"
  problem: "FAIL-empty-issues test expects EvalParseFailed but got EvalResult"
  suggested_fix: "add invariant check in parseEvalContent before returning"
</eval:issues>
`;

const MISSING_VERDICT = `
<eval:rationale>rationale without a verdict tag</eval:rationale>
<eval:issues></eval:issues>
`;

const MALFORMED_YAML = `
<eval:verdict>FAIL</eval:verdict>
<eval:rationale>malformed body below</eval:rationale>
<eval:issues>
- acceptance_failed: "unterminated string
  file: "src/foo.ts"
  problem: "x"
  suggested_fix: "y"
</eval:issues>
`;

const FAIL_NO_ISSUES = `
<eval:verdict>FAIL</eval:verdict>
<eval:rationale>claims FAIL but provides no issues</eval:rationale>
<eval:issues>
</eval:issues>
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvalParser", () => {
  test("PASS with empty issues parses to empty issues array", async () => {
    const result = await Effect.runPromise(parseEvalContent(PASS_EMPTY));
    expect(result.verdict).toBe("PASS");
    expect(result.issues).toEqual([]);
    expect(result.rationale).toContain("All acceptance criteria met");
  });

  test("FAIL with two issues maps every field correctly", async () => {
    const result = await Effect.runPromise(parseEvalContent(FAIL_TWO_ISSUES));
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toEqual({
      acceptanceFailed: "bunx tsc --noEmit passes",
      file: brand<"AbsolutePath">("src/services/EvalParser.ts"),
      problem: "type error on line 14 — EvalResult.verdict widened to string",
      suggestedFix: 'narrow verdict via "PASS" | "FAIL" cast after regex match',
    });
    const second = result.issues[1];
    if (!second) throw new Error("expected second issue");
    expect(second.acceptanceFailed).toBe("bun test passes");
    expect(second.file).toBe(
      brand<"AbsolutePath">("src/services/__tests__/EvalParser.test.ts"),
    );
    expect(second.problem).toBe(
      "FAIL-empty-issues test expects EvalParseFailed but got EvalResult",
    );
    expect(second.suggestedFix).toBe(
      "add invariant check in parseEvalContent before returning",
    );
  });

  test("Missing verdict tag raises EvalParseFailed with helpful reason", async () => {
    const exit = await Effect.runPromiseExit(parseEvalContent(MISSING_VERDICT));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("EvalParseFailed");
      expect(err.reason).toContain("verdict");
      expect(err.rawContent).toBe(MISSING_VERDICT);
    } else {
      throw new Error("expected Fail cause");
    }
  });

  test("Malformed YAML in <eval:issues> raises EvalParseFailed with raw preserved", async () => {
    const exit = await Effect.runPromiseExit(parseEvalContent(MALFORMED_YAML));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("EvalParseFailed");
      expect(err.rawContent).toBe(MALFORMED_YAML);
    } else {
      throw new Error("expected Fail cause");
    }
  });

  test("FAIL with empty issues violates invariant → EvalParseFailed", async () => {
    const exit = await Effect.runPromiseExit(parseEvalContent(FAIL_NO_ISSUES));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("EvalParseFailed");
      expect(err.reason).toContain("FAIL");
      expect(err.rawContent).toBe(FAIL_NO_ISSUES);
    } else {
      throw new Error("expected Fail cause");
    }
  });
});
