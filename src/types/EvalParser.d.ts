type EvalResult = {
  readonly verdict: "PASS" | "FAIL";
  readonly summary: string;
  readonly comments: ReadonlyArray<EvalComment>;
};

// Aligned with the RunTaskError tagged union — these two variants are the
// error channel EvalParser.parse can raise. Using Extract keeps a single
// source of truth (RunTask.d.ts) for the tag shape.
type EvalParseFailed = Extract<RunTaskError, { readonly _tag: "EvalParseFailed" }>;
type EvalResultMissing = Extract<RunTaskError, { readonly _tag: "EvalResultMissing" }>;
type EvalParseError = EvalParseFailed | EvalResultMissing;
