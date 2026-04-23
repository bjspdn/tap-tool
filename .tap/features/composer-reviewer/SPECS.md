# composer-reviewer

<feature:goal>
Deliver the Composer + Reviewer sub-agent layer of tap-tool: the subagent identity files, the role-tailored operating contracts, the supporting skills, and the Effect services (`ContextEngine`, `AgentRunner`, `EvalParser`) plus a `runTask` orchestration Effect that executes one task end-to-end through Composer → Reviewer → verdict. The output is a shippable vertical slice a future `LoopRunner` can call per-task, and a test suite that proves the slice works with a deterministic echo-agent fake.
</feature:goal>

<feature:context>
Builds on `DESIGN.md` (architecture) and `.claude/skills/tap-into/SKILL.md` (upstream interview skill that produces `SPECS.md` + `FEATURE_CONTRACT.json`). Existing runtime is scaffolding only: `src/index.ts` (stub), `src/services/LoopRunner.ts` (Context.Tag stub), `src/types/agent-runner.d.ts` + `src/types/loop-runner.d.ts` (type skeletons). Stack is confirmed Bun + TypeScript + Effect (`effect@^3.21.1`, `@effect/cli@^0.75.1`, `@effect/platform@^0.96.0`, `@effect/platform-bun@^0.89.0`).

This feature explicitly overrides two points in `DESIGN.md`:

1. DESIGN §3 says Reviewer "Writes code? no". We let the Reviewer write `EVAL_RESULT.md` itself via the Write tool. Less harness friction. Composer remains the only agent that edits source.
2. DESIGN's prompt layout had a single shared `OPERATING_CONTRACT.md`. We split it into two role-tailored per-invocation contracts (`COMPOSER_CONTRACT.md` + `REVIEWER_CONTRACT.md`) rendered by `ContextEngine`, because each role needs different kickoff instructions and strict isolation.

We also diverge from Anthropic's "harness design for long-running agents" Planner/Generator/Evaluator pattern in one way: each role runs as its own fresh `claude -p` process (Ralph-style context reset), not one continuous session with auto-compaction. The Planner in that article maps to the upstream `tap-into` skill's output (`SPECS.md` + `FEATURE_CONTRACT.json`), not to a runtime component here.

Relevant research locked during the interview: Claude Code's `claude -p --agent <name>` flag runs a whole headless session under a sub-agent definition, replacing the default system prompt and wiring `tools`, `model`, `skills`, `maxTurns`, and `hooks` from the agent file's frontmatter. Sub-agents do **not** auto-inherit project-level skills when running as the main thread — skills must be listed explicitly in the agent's `skills` frontmatter field.
</feature:context>

<feature:constraints>

- Language/runtime: TypeScript on Bun. All services written as Effect `Context.Tag` + `Layer` pairs, swappable in tests.
- Ambient types: all new type declarations live under `src/types/*.d.ts`, no exports (per project `CLAUDE.md`).
- PascalCase for all new code file names (per project `CLAUDE.md`). Existing `agent-runner.d.ts` and `loop-runner.d.ts` are renamed to `AgentRunner.d.ts` + `LoopRunner.d.ts`.
- Tests live under `__test__/` folders adjacent to the code they exercise.
- No `any`. No `as unknown as`. Errors are tagged unions decoded/raised through `effect/Schema`.
- Subagent spawn command is fixed: `claude -p --agent <Composer|Reviewer> --output-format stream-json --verbose --dangerously-skip-permissions`. No `--model`, no `--allowedTools`, no `--append-system-prompt` — the agent frontmatter supplies all of those.
- Do **not** spawn with `detached: true`. Prior incident: detached spawns left zombie `claude` processes running after parent exit. Use default process-group behavior.
- Subagent frontmatter lists skills explicitly. No reliance on cwd auto-discovery (docs: sub-agents don't inherit skills when running as main).
- Templating: `handlebars`. Per-invocation render; no compile cache in v0.
- File paths the harness writes: `.tap/features/<slug>/logs/<task_id>/iter-NNN-<role>.jsonl` (stream-json tee), `.tap/features/<slug>/logs/<task_id>/iter-NNN-<role>.stderr.log` (stderr tee). Eval output `.tap/features/<slug>/eval/EVAL_RESULT.md` is written by Reviewer itself, not the harness.
- The feature delivers `runTask`; it does **not** deliver a `FeatureContract` loader/saver, a `LoopRunner` scheduler, a CLI surface, or any VCS / auto-commit behavior. All of those are downstream features.

</feature:constraints>

<feature:shape>

```
                LoopRunner (next feature)
                        │
                        ▼  runTask(task, feature, paths)
        ┌──────────────────────────────────────────────────────────┐
        │ RunTask (Effect orchestration)                           │
        │                                                          │
        │  1. ContextEngine.renderComposer → stdin string          │
        │  2. AgentRunner.run("Composer", stdin, opts)             │
        │     spawn: claude -p --agent Composer                    │
        │       --output-format stream-json --verbose              │
        │       --dangerously-skip-permissions                     │
        │     tee stdout → logs/<task_id>/iter-NNN-composer.jsonl  │
        │     tee stderr → ...iter-NNN-composer.stderr.log         │
        │     wait for exit, collect `result` event                │
        │                                                          │
        │  3. ContextEngine.renderReviewer → stdin string          │
        │  4. AgentRunner.run("Reviewer", stdin, opts)             │
        │     Reviewer writes eval/EVAL_RESULT.md via Write tool   │
        │                                                          │
        │  5. EvalParser.parse(EVAL_RESULT.md contents)            │
        │     → { verdict, rationale, issues }                     │
        │                                                          │
        │  6. Return TaskResult                                    │
        └──────────────────────────────────────────────────────────┘

Sub-agent identities live in `.claude/agents/`, skills in `.claude/skills/`,
per-task prompt templates in `.tap/prompts/`:

.claude/agents/
  Composer.md   # model: sonnet, skills: [tdd, anti-patterns],       maxTurns: 50
  Reviewer.md   # model: opus,   skills: [anti-patterns, code-review], maxTurns: 50

.claude/skills/
  tdd/SKILL.md            # TDD methodology (code-agnostic)
  anti-patterns/SKILL.md  # code-shape rules: monolith, DRY, purity, nesting, naming
  code-review/SKILL.md    # Reviewer methodology + verdict emission rules

.tap/prompts/
  COMPOSER_CONTRACT.md    # handlebars template → per-task stdin for Composer
  REVIEWER_CONTRACT.md    # handlebars template → per-task stdin for Reviewer

Source layout under src/:

src/
  services/
    RunTask.ts            # orchestration Effect
    AgentRunner.ts        # Command spawn, stream-json parse, stdout+stderr tee
    ContextEngine.ts      # handlebars render, renderComposer + renderReviewer
    EvalParser.ts         # parse <eval:verdict>/<eval:rationale>/<eval:issues>
    __test__/
      RunTask.test.ts         # uses AgentRunnerEcho
      AgentRunner.test.ts     # Echo layer + stream-json schema roundtrip
      ContextEngine.test.ts   # fixture render + missing-key error
      EvalParser.test.ts      # PASS/FAIL/malformed fixtures
  types/
    Contract.d.ts         # Task, Story, Feature (per DESIGN §2)
    RunTask.d.ts          # TaskResult, EvalIssue, RunTaskError tagged union
    AgentRunner.d.ts      # renamed from agent-runner.d.ts; extended with AgentEvent
    ContextEngine.d.ts
    EvalParser.d.ts
    LoopRunner.d.ts       # renamed from loop-runner.d.ts (kept as-is otherwise)
```

Verdict schema the Reviewer emits into `EVAL_RESULT.md`:

```markdown
<eval:verdict>PASS|FAIL</eval:verdict>
<eval:rationale>
  ≤ 300 words, free-text, why the verdict.
</eval:rationale>
<eval:issues>
  # YAML list. Empty when verdict = PASS.
  - acceptance_failed: "..."
    file: "..."
    problem: "..."
    suggested_fix: "..."
</eval:issues>
```

`TaskResult` returned by `runTask`:

```ts
type EvalIssue = {
  acceptanceFailed: string
  file: string
  problem: string
  suggestedFix: string
}

type TaskResult = {
  taskId: string
  attempt: number              // 1-indexed, caller-supplied
  verdict: "PASS" | "FAIL"
  rationale: string
  issues: EvalIssue[]
  composerLogPath: string
  reviewerLogPath: string
  evalResultPath: string
  durationMs: number
}
```

`RunTaskError` (tagged union; caller decides retryability):

```ts
type RunTaskError =
  | { _tag: "ComposerSpawnFailed";       exitCode: number; stderr: string }
  | { _tag: "ReviewerSpawnFailed";       exitCode: number; stderr: string }
  | { _tag: "ComposerMaxTurnsExceeded" }
  | { _tag: "ReviewerMaxTurnsExceeded" }
  | { _tag: "EvalResultMissing";         expectedPath: string }
  | { _tag: "EvalParseFailed";           reason: string; rawContent: string }
  | { _tag: "TemplateRenderFailed";      template: string; missingKey: string }
  | { _tag: "FilesystemError";           path: string; cause: unknown }
```

</feature:shape>

<feature:failure_modes>

- **Reviewer forgets to write `EVAL_RESULT.md`.** Harness raises `EvalResultMissing`. Mitigation: REVIEWER_CONTRACT kickoff ends with "Exit after writing EVAL_RESULT.md"; the path is supplied via `{{eval_path}}` placeholder; `code-review` skill reinforces the contract.
- **Reviewer writes EVAL_RESULT.md but malformed (missing verdict tag, broken YAML).** Raise `EvalParseFailed` with `rawContent` attached so the next Composer attempt can see exactly what was wrong.
- **Composer hits `--maxTurns 50`.** `result` event `subtype: "error_max_turns"` → `ComposerMaxTurnsExceeded`. Caller (LoopRunner) decides retry per `attempts` vs `maxAttempts`.
- **`claude -p` exits non-zero at the CLI level** (bad flag, process killed, auth error). `ComposerSpawnFailed` / `ReviewerSpawnFailed` with exit code + stderr. Usually fatal; LoopRunner halts.
- **Template placeholder missing from render context.** `TemplateRenderFailed` with template name + missing key. Raised at render time, before any subprocess spawn.
- **Zombie `claude` child processes.** Prevented by not using `detached: true`. Cancellation of a `runTask` Effect sends `SIGTERM` to the direct child pid; Claude Code's own subprocesses may orphan briefly but do not survive the parent cleanly.
- **Composer edits files outside `task.files`.** Not enforced structurally by the harness in v0. The Reviewer's `code-review` skill (step 4) explicitly checks scope and flags violations as FAIL issues. Anti-pattern skill covers the shape dimension.
- **Log files collide across attempts.** Prevented by `iter-NNN` zero-padded attempt number in the log filename, supplied by the caller.
- **Handlebars interprets user-supplied strings as templates.** `feature_constraints`, `task_acceptance`, etc. may contain `{{ }}`-looking text. Render with `{{{ }}}` (triple-brace) or pre-escape, and test a fixture that contains `{{` in user text.

</feature:failure_modes>

<feature:open_questions>

- **Worktree isolation.** v0 runs both agents in the same cwd (the repo root where `tap` was invoked). Parallelism and worktree-per-task are explicitly deferred to a v1 feature once we have real usage signal — this matches DESIGN §5.3.
- **Real `claude -p` integration coverage.** The `AgentRunnerLive` layer is intentionally not exercised by `bun test` because it would require a real `claude` binary + API key + live cost. A manual smoke script belongs with the next feature (LoopRunner/CLI). For v0 we rely on `AgentRunnerEcho` for all automated coverage plus eyeballing on a first run.
- **Composer scope enforcement.** Whether to harden "Composer writes outside `task.files`" from a soft Reviewer flag to a hard structural check (pre-spawn snapshot, post-run diff) is deferred. Practitioner signal needed first.
- **Cost accounting.** `result` events carry `totalCostUsd` and `numTurns`. TaskResult does not expose them in v0; LoopRunner may need them later for budget tracking. Add when LoopRunner asks for it, not speculatively.
- **Existing `LoopRunner.ts` stub.** Left as-is except for its type file rename. This feature does not implement `LoopRunner`.
- **Handlebars vs Mustache.** Picked `handlebars` for conditionals/helpers we may want later (e.g. `{{#if prior_eval_path}}`). If the final templates don't need conditionals, a future simplification could drop to Mustache or a hand-rolled `{{key}}` replacer.

</feature:open_questions>
