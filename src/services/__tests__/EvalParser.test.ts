import { describe, test, expect } from "bun:test";
import { Effect, Exit } from "effect";
import { parseEvalContent } from "../EvalParser";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASS_EMPTY = `
Some prose before the verdict block.

<eval:verdict>PASS</eval:verdict>
<eval:summary>
One paragraph overall read of the diff. Tests green. No anti-pattern violations.
</eval:summary>
<eval:comments>
</eval:comments>

Trailing prose that should be ignored.
`;

const FAIL_TWO_COMMENTS = `
<eval:verdict>FAIL</eval:verdict>
<eval:summary>
Two issues caught.
</eval:summary>
<eval:comments>
- file: "src/services/EvalParser.ts"
  line: 14
  severity: "blocker"
  comment: "type error on line 14"
- file: "src/services/__tests__/EvalParser.test.ts"
  severity: "suggestion"
  comment: "Add invariant check"
</eval:comments>
`;

const FAIL_LINE_NULL = `
<eval:verdict>FAIL</eval:verdict>
<eval:summary>
One comment with explicit null line.
</eval:summary>
<eval:comments>
- file: "src/foo.ts"
  line: null
  severity: "nitpick"
  comment: "Line-less comment"
</eval:comments>
`;

const MISSING_VERDICT = `
<eval:summary>summary without a verdict tag</eval:summary>
<eval:comments></eval:comments>
`;

const MALFORMED_YAML = `
<eval:verdict>FAIL</eval:verdict>
<eval:summary>malformed body below</eval:summary>
<eval:comments>
- file: "unterminated string
  severity: "blocker"
  comment: "x"
</eval:comments>
`;

const FAIL_NO_COMMENTS = `
<eval:verdict>FAIL</eval:verdict>
<eval:summary>claims FAIL but provides no comments</eval:summary>
<eval:comments>
</eval:comments>
`;

const FAIL_INVALID_SEVERITY = `
<eval:verdict>FAIL</eval:verdict>
<eval:summary>bad severity value</eval:summary>
<eval:comments>
- file: "src/foo.ts"
  severity: "critical"
  comment: "some issue"
</eval:comments>
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvalParser", () => {
  test("PASS with empty comments parses to empty comments array", async () => {
    const result = await Effect.runPromise(parseEvalContent(PASS_EMPTY));
    expect(result.verdict).toBe("PASS");
    expect(result.comments).toEqual([]);
    expect(result.summary).toContain("One paragraph overall read");
  });

  test("FAIL with two comments maps every field correctly", async () => {
    const result = await Effect.runPromise(parseEvalContent(FAIL_TWO_COMMENTS));
    expect(result.verdict).toBe("FAIL");
    expect(result.comments).toHaveLength(2);

    const first = result.comments[0];
    if (!first) throw new Error("expected first comment");
    expect(first.file).toBe("src/services/EvalParser.ts");
    expect(first.line).toBe(14);
    expect(first.severity).toBe("blocker");
    expect(first.comment).toBe("type error on line 14");

    const second = result.comments[1];
    if (!second) throw new Error("expected second comment");
    expect(second.file).toBe("src/services/__tests__/EvalParser.test.ts");
    expect(second.line).toBeUndefined();
    expect(second.severity).toBe("suggestion");
    expect(second.comment).toBe("Add invariant check");
  });

  test("line as null parses to null (not undefined)", async () => {
    const result = await Effect.runPromise(parseEvalContent(FAIL_LINE_NULL));
    expect(result.verdict).toBe("FAIL");
    expect(result.comments).toHaveLength(1);
    const c = result.comments[0];
    if (!c) throw new Error("expected comment");
    expect(c.line).toBeNull();
    expect(c.severity).toBe("nitpick");
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

  test("Malformed YAML in <eval:comments> raises EvalParseFailed with raw preserved", async () => {
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

  test("FAIL with empty comments violates invariant → EvalParseFailed", async () => {
    const exit = await Effect.runPromiseExit(parseEvalContent(FAIL_NO_COMMENTS));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("EvalParseFailed");
      expect(err.reason).toContain("FAIL");
      expect(err.rawContent).toBe(FAIL_NO_COMMENTS);
    } else {
      throw new Error("expected Fail cause");
    }
  });

  test("Invalid severity value raises EvalParseFailed", async () => {
    const exit = await Effect.runPromiseExit(parseEvalContent(FAIL_INVALID_SEVERITY));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("EvalParseFailed");
      expect(err.reason).toContain("severity");
    } else {
      throw new Error("expected Fail cause");
    }
  });
});
