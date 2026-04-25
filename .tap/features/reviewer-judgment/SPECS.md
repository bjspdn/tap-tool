# reviewer-judgment

<feature:goal>
Replace per-criterion ceremony with senior-dev judgment. Drop the `acceptance: AcceptanceCriterion[]` array at every contract level (Task, Story, Feature) and replace it with a `description: string` (≤3 lines) that gives the agent context. Reviewer stops checklist-classifying criteria and starts producing PR-style review: a verdict, a one-paragraph summary, and a list of file/line-anchored comments with severity. Verdict drives the loop's retry decision; severity is a human-readable label only.
</feature:goal>

<feature:context>
The running `contract-satisfiability` feature attempted to patch deadlocks by adding dual-form criteria, an `OPERATING_CONTRACT.md`, a `@contract-deviation` marker protocol, and a Validator sub-agent. After three iterations of `S1.T3`, every FAIL was process-grade — out-of-scope edits, marker-evidence wrong, contract self-tampering — while the substantive code worked: tests passed, tsc clean, contracts decoded. The ceremony was the failure mode, not the missing safety. This feature kills the ceremony.

Diagnosis (high confidence): acceptance criteria were trying to be both spec and quality gate simultaneously. That double duty is borrowed from human PM workflows where epics → stories → acceptance criteria coordinate teams of humans with separate context. Sub-agents in this loop share context directly via rendered prompts and full repo access — they don't need the coordination scaffolding. Removing it removes a class of false-FAIL deadlocks and trims the schema, the parser, the prompt templates, and two skill files.

Builds on:

- `src/services/FeatureContract.ts` — Schema + load/save. Drops `AcceptanceCriterionSchema`. Task, Story, Feature each gain `description`.
- `src/services/EvalParser.ts` — Rewrites `<eval:rationale>` → `<eval:summary>`, `<eval:issues>` (with `acceptance_failed`/`file`/`problem`/`suggested_fix`) → `<eval:comments>` (with `file`/`line?`/`severity`/`comment`). Verdict tag stays `<eval:verdict>PASS|FAIL</eval:verdict>`.
- `src/services/ContextEngine.ts` — Renders `task_description`, `story_title`, `story_description`, `feature_description`. Drops `task_acceptance`. Drops the dead `featureRoot` parameter from render-input types.
- `.tap/prompts/COMPOSER_CONTRACT.md` + `.tap/prompts/REVIEWER_CONTRACT.md` — Acceptance-criteria blocks die. Description blocks added. Reviewer template carries the four behavior prompts that drive judgment.
- `.claude/agents/Composer.md` + `.claude/agents/Reviewer.md` — Per-criterion language replaced with description-based language. Reviewer's `<section name="per-criterion-classification">` dies, replaced by `<section name="judgment">`.
- `.claude/skills/code-review/SKILL.md` — Rewritten around the four prompts and the PR-style output spec.
- `.claude/skills/tap-into/SKILL.md` — `<output_contract>` + `<sprint_json_schema>` updated to emit description instead of acceptance arrays.
- 4 on-disk contracts (`composer-reviewer`, `loop-runner`, `contract-satisfiability`, `reviewer-judgment`) migrated.

Research findings worth citing:

- LoopRunner (`src/services/LoopRunner/LoopRunnerLive.ts`) reads only `outcome.right.verdict` (strict `===` comparisons against `"PASS"`/`"FAIL"`) and `outcome.right.issues.length` (logging only). Zero content inspection. Verdict tag staying `PASS|FAIL` means LoopRunner needs only a field-rename on the issues→comments line.
- No code path anywhere in `src/` reads `OPERATING_CONTRACT.md` or `VALIDATION_RESULT.md`. Killing those concepts removes nothing real (they were never written).
- `featureRoot` is threaded through `ComposerRenderInput` and `ReviewerRenderInput` but never exposed to the Handlebars context. Pure dead parameter — drop while we're touching ContextEngine.
- `priorEvalPath` threading exists but has no test coverage. With description-based judgment, the prior eval is the ONLY signal Composer reads from a failed attempt — covering it now is load-bearing.
- The current `Contract.d.ts` ambient type for `AcceptanceCriterion` is a lenient `string | { behavioral; mechanism: Option<string> }` union, but the schema in `FeatureContract.ts` is strict-struct-only. Lie that's masked because all fixtures use struct form. Killed by this feature.
</feature:context>

<feature:constraints>

- **Schema migration is layered, not big-bang.** Bootstrappability invariant: every story end-state must keep the running loop runnable (contracts decode, `bun test` exits 0, `bunx tsc --noEmit` exits 0). A clean-break "drop acceptance + add description in one task" deadlocks at intermediate states (ContextEngine reads `task.acceptance`, schema no longer has it → tsc fails). S1 adds description as **optional**; S5 tightens to required and drops acceptance + AcceptanceCriterion. S2–S4 flip the consumers in between. The "clean break" intent is preserved at the final state — just reached in two hops.

- **`description` field is the obligation surface.** Composer's job is to realize the description. Reviewer's job is to judge whether the diff plausibly realizes it. Description is ≤3 lines per level (Task, Story, Feature). When a test file is load-bearing for the task, the description may name it ("…with red→green→refactor in `src/services/__tests__/Foo.test.ts`"). Otherwise Composer picks test names.

- **Reviewer output shape: PR-style review, not checklist.** Verdict tag stays `<eval:verdict>PASS|FAIL</eval:verdict>` (LoopRunner depends on it). `<eval:rationale>` is renamed `<eval:summary>` (one paragraph, ≤300 words, overall read of the diff). `<eval:issues>` is replaced by `<eval:comments>` — a YAML list with fields `file: string`, `line: number | null` (optional, omit when not line-anchored), `severity: "blocker" | "suggestion" | "nitpick"`, `comment: string`. Verdict drives retry: PASS → task done, FAIL → retry with full summary + comments threaded into next Composer prompt. Severity is a human label, not a machine signal.

- **EvalParser invariant preserved with new field name.** Today `verdict === "FAIL"` requires `issues.length > 0`. New invariant: `verdict === "FAIL"` requires `comments.length >= 1`. Any comment counts; no severity-threshold rule. When verdict is PASS, `<eval:comments>` block may be empty.

- **The four behavior prompts drive Reviewer judgment.** Codified in `.claude/skills/code-review/SKILL.md` and re-rendered in `REVIEWER_CONTRACT.md`. Verbatim:
  1. Does this code do what the task description says?
  2. Are there obvious bugs, missing error handling, or logic errors?
  3. Does it follow codebase conventions (CLAUDE.md, TDD, test placement, branding, Effect)?
  4. Does it pass the quality gates? (`bun test` + `bunx tsc --noEmit`)

- **Shared rules already live in CLAUDE.md + agent .md files.** No `OPERATING_CONTRACT.md` is authored; no runtime-rendered shared file. ContextEngine does not gain an `operating_contract` field. The Validator sub-agent and `@contract-deviation` marker protocol from the dying `contract-satisfiability` design are dropped entirely — this feature replaces them, not extends them.

- **Run-forward-deprecate the two shipped features.** `composer-reviewer` and `loop-runner` ship with bugs. This feature does not fix those bugs. Their FEATURE_CONTRACT.json files get migrated for schema compatibility (description added, acceptance dropped at S5) but their unfinished/buggy task work is not reopened.

- **The dying `contract-satisfiability` feature is replaced, not deleted.** Its directory remains as a historical record of the abandoned ceremony architecture. Its FEATURE_CONTRACT.json is migrated to the new schema like the others. Its remaining pending tasks (S2 onwards) become archeology — never executed.

- **Anti-patterns skill survives untouched.** Orthogonal quality check, applies to both Composer and Reviewer, not coupled to acceptance criteria.

- **Composer's surviving sections** in `.claude/agents/Composer.md`: `scope`, `vcs`, `test-placement`, `types`, `skills`, `verification`. The `retry` and `exit` sections get reframed (criterion → description; eval issues → eval comments).

- **Reviewer's surviving sections** in `.claude/agents/Reviewer.md`: `role`, `forbidden-actions`, `independent-verification`, `scope-check`, `anti-pattern-check`, `output`. The `per-criterion-classification` section dies, replaced by a `judgment` section keyed off the four prompts. `verdict-rules` is rewritten.

- **Tests in sibling `__tests__/` folders per CLAUDE.md.** No `any`, no `as unknown as`. Branded construction imports `brand<B>(s)` from `src/services/brand.ts`.

- **`scripts/bootstrap.ts` remains the entry point.** No CLI work in this feature.

</feature:constraints>

<feature:shape>

```
DYING (contract-satisfiability era)
┌──────────────────────────────────────────────────────────────┐
│  Task { acceptance: AcceptanceCriterion[] }                   │
│     │                                                         │
│     ▼                                                         │
│  COMPOSER_CONTRACT.md renders {{#each task_acceptance}}      │
│     │                                                         │
│     ▼                                                         │
│  Composer satisfies each criterion verbatim or emits          │
│  @contract-deviation marker (Validator pre-checks)            │
│     │                                                         │
│     ▼                                                         │
│  REVIEWER_CONTRACT.md renders same {{#each task_acceptance}} │
│     │                                                         │
│     ▼                                                         │
│  Reviewer per-criterion classify (Satisfied/Partial/Not)      │
│     │                                                         │
│     ▼                                                         │
│  EVAL_RESULT.md: verdict + rationale + issues[acceptance_failed]│
└──────────────────────────────────────────────────────────────┘

LIVING (reviewer-judgment era)
┌──────────────────────────────────────────────────────────────┐
│  Task { description: string }   ← ≤3 lines                    │
│     │                                                         │
│     ▼                                                         │
│  COMPOSER_CONTRACT.md renders {{{task_description}}}          │
│     │                                                         │
│     ▼                                                         │
│  Composer realizes description (no marker protocol, free      │
│  to choose mechanism)                                         │
│     │                                                         │
│     ▼                                                         │
│  REVIEWER_CONTRACT.md renders {{{task_description}}} + four   │
│  behavior prompts                                             │
│     │                                                         │
│     ▼                                                         │
│  Reviewer judges PR-style (does the diff realize it? bugs?    │
│  conventions? quality gates?)                                 │
│     │                                                         │
│     ▼                                                         │
│  EVAL_RESULT.md: verdict + summary + comments[file/line/      │
│  severity/comment]                                            │
│     │                                                         │
│     ▼                                                         │
│  LoopRunner reads .verdict (PASS → done, FAIL → retry with    │
│  full summary + comments threaded to next Composer attempt)   │
└──────────────────────────────────────────────────────────────┘
```

</feature:shape>

<feature:failure_modes>

- **Reviewer judgment drift.** Without a checklist, Reviewer might rubber-stamp diffs that look plausible. Mitigation: `independent-verification` section survives unchanged — Reviewer still re-runs `bun test` + `bunx tsc --noEmit` (quality gates are objective). The four prompts include "obvious bugs, missing error handling, logic errors" as a first-class question. The anti-patterns skill survives as a structural floor.

- **Description vagueness.** Authors trend toward "feature works correctly" prose. Mitigation: tap-into skill's interview discipline (the user is in this skill right now) is the upstream gate. There is no automated Validator anymore — judgment-on-judgment turtles all the way down. The trade is acceptable because false-FAIL ceremony loops are demonstrably worse than the rare vague-description case.

- **Bootstrappability across the migration.** Schema-strict-cut in one task deadlocks tsc at story boundaries. Mitigation: layered migration (description optional in S1, required in S5; consumers flipped in between).

- **Loop runs against intermediate state.** During S2–S4, the running contract has both `acceptance` arrays (vestigial sentinel) and `description` populated. Composer is obligated to nominal acceptance until S3 lands. Mitigation: the new contract's acceptance criteria are deliberately minimal and generic ("description per SPECS.md realized; bun test exits 0; bunx tsc --noEmit exits 0") so they don't generate false-FAIL ceremony — they're a floor, not a checklist.

- **Description-in-SPECS-then-JSON migration loses prose during S1.** S1 Composer must transcribe `<feature:descriptions>` from this SPECS.md into the FEATURE_CONTRACT.json files verbatim (or near-verbatim, ≤3 lines). Mitigation: descriptions are short and explicit; the S1 task description names this transcription as part of the work.

- **TaskResult shape change ripple.** `EvalIssue` → `EvalComment`, `issues` → `comments`, `rationale` → `summary`. Hits LoopRunnerLive's logging line, RunTask, EvalParser, all related types and tests. Mitigation: S2 task lists every affected file; nothing left implicit.

- **Old contracts have descriptions worth nothing.** Migration of `composer-reviewer`, `loop-runner`, `contract-satisfiability` populates description mechanically (`description = task.title`) since their tasks are done/dead. Acceptable — those descriptions are archeology, not a forward obligation.

</feature:failure_modes>

<feature:open_questions>

- **`<feature:descriptions>` transitional section in this SPECS.md.** Becomes redundant after S1 (descriptions canonical in JSON). Could be stripped at S5 cleanup or left as a paper trail of how the migration was bootstrapped. Deferred — decide at S5 time.

- **TDD anchor formality.** Currently encoded as "description may name a load-bearing test file." No stricter rule (e.g., "must name a test file when adding new behavior"). Revisit if Composer drifts into writing tests after implementation.

- **Severity threshold for human review tooling.** Severity is currently a label only; no harness machinery acts on it. If a future tool wants to surface only blockers (e.g., a dashboard), the schema is in place. Out of scope for this feature.

- **Reviewer self-grading on judgment quality.** With criteria gone, there's no mechanical signal to tell whether Reviewer's judgment improved. Could be an open question for a future feature — track per-feature retry counts and human override rates.

- **Multi-stack support.** Quality gates are hardcoded `bun test` + `bunx tsc --noEmit` in Composer.md and Reviewer.md (TypeScript-only). Same TODO as the dying contract-satisfiability — not addressed here.

</feature:open_questions>

<feature:descriptions>

Transitional section. Per-id description prose authored upstream so S1's Composer can transcribe these into the four FEATURE_CONTRACT.json files. After S1 these are canonical in JSON and this section becomes redundant.

For the three OLD contracts (`composer-reviewer`, `loop-runner`, `contract-satisfiability`), descriptions are mechanical: every task description = its `title`; every story description = its `title`; every feature description = its `goal` (truncated to ≤3 lines if long). No prose authoring required — copy mechanically.

For this NEW contract (`reviewer-judgment`), descriptions are below.

```yaml
feature:
  description: |
    Replace per-criterion ceremony with senior-dev judgment. Drop the acceptance
    array from Task/Story/Feature; add description (≤3 lines) at every level.
    Reviewer produces PR-style review (verdict + summary + comments) instead of
    per-criterion classification.

stories:
  S1:
    description: |
      Schema gains optional description on Task/Story/Feature. AcceptanceCriterion
      and acceptance field stay (dropped at S5). Migrate all four FEATURE_CONTRACT.json
      files to populate description. Schema decode and tsc remain clean.
  S2:
    description: |
      Reviewer pipeline flips to PR-style judgment. EvalParser rewrites for new
      eval body shape (summary + comments YAML). Reviewer.md, code-review SKILL,
      and REVIEWER_CONTRACT.md template all adopt the four behavior prompts and
      new output spec.
  S3:
    description: |
      Composer pipeline flips to description-as-obligation. ContextEngine renders
      description fields, drops task_acceptance, drops dead featureRoot param.
      COMPOSER_CONTRACT.md template and Composer.md agent file align with the new
      shape.
  S4:
    description: |
      tap-into skill emits description fields instead of acceptance arrays. Future
      features authored via this skill produce contracts in the new shape from the
      start, no migration needed.
  S5:
    description: |
      Schema strict cut: drop AcceptanceCriterion, drop acceptance field on Task
      and Story. Description becomes required at all three levels. Drop empty
      acceptance arrays from all four contracts. Update LoopRunner resume hint
      and any remaining references.

tasks:
  S1.T1:
    description: |
      Add description field as Schema.optional(Schema.String) to TaskSchema,
      StorySchema, FeatureSchema in src/services/FeatureContract.ts. Update
      Contract.d.ts ambient types to mirror. Migrate all four FEATURE_CONTRACT.json
      files to populate description per the SPECS.md feature:descriptions block
      (this contract) or mechanically from title (the three old contracts).
      Tests in src/services/__tests__/FeatureContract.test.ts cover description
      decode (present and absent). All four contracts decode under updated schema;
      bun test and bunx tsc --noEmit pass.
  S2.T1:
    description: |
      Rewrite src/services/EvalParser.ts to parse <eval:summary> and <eval:comments>
      (replacing <eval:rationale> and <eval:issues>). Comment YAML field set:
      file, line (optional), severity, comment. Preserve invariant: verdict FAIL
      requires comments.length >= 1. Update src/types/EvalParser.d.ts and
      src/types/RunTask.d.ts: EvalIssue → EvalComment, TaskResult.rationale →
      summary, TaskResult.issues → comments. Update LoopRunnerLive logging line
      that reads .issues.length to read .comments.length. Update RunTask.ts and
      tests in src/services/__tests__/EvalParser.test.ts and RunTask.test.ts to
      match new shape. Verdict tag string stays "PASS"|"FAIL".
  S2.T2:
    description: |
      Rewrite .tap/prompts/REVIEWER_CONTRACT.md, .claude/agents/Reviewer.md,
      .claude/skills/code-review/SKILL.md to PR-style judgment. Reviewer's
      per-criterion-classification section dies; replaced by a judgment section
      keyed off the four behavior prompts (verbatim from feature:constraints).
      Verdict-rules rewritten (PASS = description realized + tests + tsc + scope +
      anti-patterns clean; FAIL = any one of those misses). Output spec aligns
      with the new EvalParser shape. Reviewer's forbidden-actions,
      independent-verification, scope-check, anti-pattern-check, and output
      sections survive structurally.
  S3.T1:
    description: |
      Update src/services/ContextEngine.ts and src/types/ContextEngine.d.ts:
      ComposerRenderInput and ReviewerRenderInput gain task_description,
      story_title, story_description, feature_description. Drop task_acceptance
      from rendered context. Drop the dead featureRoot parameter from render-input
      types. Add a test in src/services/__tests__/ContextEngine.test.ts covering
      priorEvalPath threading via Option.some(...) — no test exists today and
      retry-thread is now the only signal Composer reads from prior failure.
  S3.T2:
    description: |
      Rewrite .tap/prompts/COMPOSER_CONTRACT.md and .claude/agents/Composer.md.
      Acceptance criteria block in template dies; description blocks for feature,
      story, task added. "Acceptance is binary" non-negotiable line dies. Retry
      block reframed (read prior eval comments, address blockers and consider
      suggestions). Composer's tdd-skill trigger updated (description names test
      file → activate). Composer's exit clause swapped (description realized →
      exit). Composer's scope, vcs, test-placement, types, verification sections
      survive unchanged.
  S4.T1:
    description: |
      Rewrite the <output_contract> and <sprint_json_schema> sections of
      .claude/skills/tap-into/SKILL.md to emit description fields at task, story,
      and feature levels instead of acceptance arrays. Update <example_turns> so
      illustrative output matches the new shape. Update <convergence_check>:
      drop the "acceptance criteria are observable" bullet, replace with "every
      task has a description (≤3 lines) that names what to build."
  S5.T1:
    description: |
      Strict cut. In src/services/FeatureContract.ts: drop AcceptanceCriterionSchema,
      drop acceptance field from TaskSchema and StorySchema, change description
      from Schema.optional to Schema.String (required) at all three levels. Strip
      the dead @contract-deviation doc comments (FeatureContract.ts:17-36). In
      src/types/Contract.d.ts: drop AcceptanceCriterion type, drop acceptance
      field from Task and Story types, drop the bun:test module augmentation tied
      to AcceptanceCriterion, mark description required. Drop empty acceptance
      arrays from all four FEATURE_CONTRACT.json files. Update
      src/services/LoopRunner/LoopRunnerLive.ts:239 resume-hint string that
      references "acceptance". Update src/services/__tests__/FeatureContract.test.ts:
      remove acceptance-related fixtures, assert decode rejects unknown
      acceptance field. Final state: bun test and bunx tsc --noEmit clean across
      the entire repo.
```

</feature:descriptions>
