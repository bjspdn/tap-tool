type EvalIssue = {
  readonly acceptanceFailed: string;
  readonly file: AbsolutePath;
  readonly problem: string;
  readonly suggestedFix: string;
};

type TaskResult = {
  readonly taskId: TaskId;
  readonly attempt: number;
  readonly verdict: "PASS" | "FAIL";
  readonly rationale: string;
  readonly issues: ReadonlyArray<EvalIssue>;
  readonly composerLogPath: AbsolutePath;
  readonly reviewerLogPath: AbsolutePath;
  readonly evalResultPath: AbsolutePath;
  readonly durationMs: number;
};

type RunTaskError =
  | { readonly _tag: "AgentSpawnFailed"; readonly role: AgentRole; readonly exitCode: number; readonly stderr: string }
  | { readonly _tag: "AgentMaxTurnsExceeded"; readonly role: AgentRole }
  | { readonly _tag: "RateLimited"; readonly role: AgentRole; readonly resetsAt: number }
  | { readonly _tag: "EvalResultMissing"; readonly expectedPath: AbsolutePath }
  | { readonly _tag: "EvalParseFailed"; readonly reason: string; readonly rawContent: string }
  | { readonly _tag: "TemplateRenderFailed"; readonly template: string; readonly missingKey: string }
  | { readonly _tag: "FilesystemError"; readonly path: AbsolutePath; readonly cause: unknown };
