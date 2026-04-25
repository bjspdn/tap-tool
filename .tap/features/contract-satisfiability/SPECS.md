# contract-satisfiability

<feature:goal>
Prevent contract-reality mismatches from reaching the Composer loop. Introduce dual-form acceptance criteria (behavioral + mechanism), a shared `OPERATING_CONTRACT.md` rendered into both Composer and Reviewer prompts, a structured `@contract-deviation` marker protocol for permitted mechanism substitutions, and a new `Validator` sub-agent invoked by `tap-into` at authoring time to catch self-defeating criteria, non-viable mechanisms, and tracked "non-repo" path assumptions before emission. Reviewer retains a backstop reproduction check at execution time for markers that slip past authoring-time validation.
</feature:goal>

<feature:context>
The current tap-tool loop burned six Composer attempts in the `loop-runner` feature on two contract-reality mismatches. First, `S3.T1` prescribed `.tap/tmp/<uuid>/` as a "non-repo" test fixture path, but `.tap/` is tracked in the repo's git tree, so `git status --short` returns non-empty output from that location and breaks the test premise. Second, `S5.T1` prescribed `Schema.String.pipe(Schema.brand("TaskId"))` as the exact type construction, but Effect's `Schema.brand` produces a `BrandTypeId`-symbol-based brand that does not structurally match the ambient `Brand<T, B> = T & { readonly __brand: B }` declared in `src/types/Contract.d.ts` — making the self-check `_FeatureTypeMatches` assertion in the same task's criteria always fail. Both required mid-flight contract amendments to unblock progress. The loop-runner contract now carries a scoped escape-hatch as its final constraint entry; this feature promotes that escape hatch from local patch to layered policy with upstream prevention.

Builds on:

- `src/services/FeatureContract.ts` — schema + load/save. Extend to dual-form criteria.
- `src/services/ContextEngine.ts:61-83` — `toComposerContext` + `toReviewerContext`. Both gain `operating_contract` and `validation_warnings` fields.
- `.tap/prompts/COMPOSER_CONTRACT.md` + `.tap/prompts/REVIEWER_CONTRACT.md` — template files. Both gain new sections.
- `.claude/agents/Composer.md` + `.claude/skills/code-review/SKILL.md` — role rules. Updated to reference `OPERATING_CONTRACT.md`.
- `.claude/skills/tap-into/SKILL.md` — new `<validation_gate>` section after `<convergence_check>`.

Research confirmed:

- The Reviewer template currently renders no feature-level data; the loop-runner escape-hatch clause is Composer-only in practice (`ContextEngine.ts:63` renders `feature.constraints` into the Composer context only). This feature fixes that asymmetry by routing shared rules through `OPERATING_CONTRACT.md` and rendering it into both prompts.
- No pre-emit gate exists today; `tap-into` writes artifacts directly to disk after user sign-off. The `<convergence_check>` section is conversational — no machinery. Validator is new construction.
- `claude -p --agent X` spawned as an OS subprocess by `AgentRunnerLive.ts:48-56` is a main-thread Claude Code session of its own process, and can spawn one layer of `Agent()` sub-agents. Validator is invoked from `tap-into`'s main-thread session (not a subprocess), so it falls within this boundary. A 10-line smoke test before S7 lands is still warranted to confirm the nested-spawn path in practice.
- Dual-form criterion authoring is the load-bearing fix. Without it, the Composer can silently weaken acceptance via substitution markers by reclassifying parts of a single-blob criterion as "mechanism" and watering down the survivor "behavior." Splitting authoring-time prevents this: the behavioral field is frozen upstream; the Composer cannot reclassify.
</feature:context>

<feature:constraints>

- Schema migration is strict in the final state; the union that permits legacy single-string criteria is a transient state used only to keep the contract loadable during S1 migration. By end of S1, all three `.tap/features/*/FEATURE_CONTRACT.json` files are dual-form only.
- Dual-form criterion shape: `{ behavioral: string, mechanism: Option<string> }`. The behavioral field is the load-bearing obligation the Composer must satisfy; the mechanism field is the suggested implementation path, advisory and substitutable under `OPERATING_CONTRACT.md` rules. The Reviewer validates the behavioral field first, then the mechanism.
- `.tap/prompts/OPERATING_CONTRACT.md` is rendered into BOTH the Composer and Reviewer prompts via `ContextEngine`. It contains the shared rules (never `--no-verify`, never `git push`, scope discipline, no source edits for Reviewer) and the `@contract-deviation` marker wire protocol spec.
- The substitution marker format is a JSON block-comment emitted only at the substitution site in source. Fields: `criterion_ref` (e.g. `"S5.T1.acceptance[2].mechanism"`), `invalidity` (one of `tsc-error`, `criterion-conflict`, `global-constraint-conflict`), `evidence` (short verbatim quote of the tool output or the contradicting criterion), `substitution` (plain-text description of what was done instead), `behavioral_preserved_ref` (e.g. `"S5.T1.acceptance[2].behavioral"`). Any marker format variation is a Reviewer FAIL.
- The Validator sub-agent is invoked via `Agent(subagent_type="Validator")` from within `tap-into`'s main-thread Claude Code session — one-level nest, not an OS subprocess. Validator writes `VALIDATION_RESULT.md` into the draft feature directory.
- Validator runs these check categories: structural (schema decode, dep cycle, dangling task ids, missing required fields), path-reality (`git ls-files` and `git check-ignore` on each prescribed path to detect tracked "non-repo" fixtures), self-contradiction (text-pair scan for criteria whose prescriptions logically collide), testability heuristic (does the behavioral field name a file, command output, or other observable — flag "works correctly" prose), mechanism-viability (stack-dispatched).
- Mechanism-viability dispatch: TypeScript uses a scratch file plus `bunx tsc --noEmit` and `grep` in `node_modules/<pkg>/dist/`. Rust uses a scratch file plus `cargo check` and `grep` in `~/.cargo/registry/src/`. Other stacks degrade to an LLM-only prose review emitted with `warning` severity (never `blocker`). Multi-stack expansion is out of scope per the TODO noted in `.claude/skills/tap-into/SKILL.md`.
- `VALIDATION_RESULT.md` findings split by severity: `blocker` halts `tap-into` emission until fixed; `warning` permits emission and is archived alongside the contract, then forwarded into the Composer and Reviewer prompts by `ContextEngine` so both agents see flagged criteria upfront at execution time.
- Composer skill uses positive framing: "your obligation is the behavioral field; treat the mechanism field as the suggested implementation path." No negative-phrased prohibitions on touching the behavioral field (pink-elephant rule — negative framing primes the forbidden action).
- Reviewer skill performs per-criterion dual-form classification: each criterion's `behavioral` and `mechanism` fields are classified independently. On `@contract-deviation` marker: the Reviewer parses the JSON, reproduces the claimed invalidity (writes the prescribed mechanism to a scratch file, runs the appropriate check), confirms `behavioral_preserved_ref` is Satisfied. If reproduction shows the literal mechanism works, the verdict is FAIL with a "false invalidity claim" issue.
- `scripts/bootstrap.ts` remains the entry point until the `tap run` CLI lands; no CLI work in this feature.
- Tests in sibling `__tests__/` folders per CLAUDE.md. No `any`, no `as unknown as`. Branded construction imports the existing `brand<B>(s)` helper from `src/services/brand.ts`.
- Bootstrappability invariant: every task must be buildable under the state that exists when it starts. S1 splits into three tasks (schema-lenient → migrate-all-contracts → schema-strict) so the contract being run is always loadable through the transition.
- The loop-runner constraint-21 contract-reality escape hatch remains in force during and after this feature. Validator operates upstream at authoring time; execution-time substitutions via markers are still legitimate for Validator blind spots, package-version drift, and new failure modes that arise between authoring and execution.

</feature:constraints>

<feature:shape>

```
AUTHORING TIME (tap-into skill, user's main Claude Code session)
┌─────────────────────────────────────────────────────────────────┐
│  tap-into interview converges                                    │
│     → draft contract to tmp                                      │
│     → Agent(subagent_type="Validator", model="opus")             │
│         ├─ stack-agnostic checks                                 │
│         │   · structural (schema decode, dep cycle, dangling)    │
│         │   · path-reality (git ls-files / check-ignore)         │
│         │   · self-contradiction (criterion-pair text scan)      │
│         │   · testability heuristic (behavioral is observable?)  │
│         ├─ stack-detect → mechanism-viability dispatch           │
│         │   · TS: scratch + bunx tsc --noEmit, grep node_modules │
│         │   · Rust: scratch + cargo check, grep ~/.cargo         │
│         │   · Unknown: LLM-only prose → warning severity         │
│         └─ write VALIDATION_RESULT.md (verdict + findings)       │
│     → surface findings to user in conversation                   │
│     → user fixes (re-interview) or accepts warnings              │
│     → emit final contract to .tap/features/<slug>/               │
│       copy VALIDATION_RESULT.md alongside                        │
└─────────────────────────────────────────────────────────────────┘

EXECUTION TIME (tap run, subprocess spawning)
┌─────────────────────────────────────────────────────────────────┐
│  LoopRunner loads contract + validation warnings                 │
│     → pick next ready task                                       │
│     → render Composer prompt:                                    │
│         feature_goal, feature_constraints, task.acceptance       │
│         (dual-form), operating_contract, validation_warnings     │
│     → spawn claude -p --agent Composer                           │
│         obligation: behavioral field                             │
│         allowance: substitute mechanism, emit JSON marker        │
│     → render Reviewer prompt (same new fields)                   │
│     → spawn claude -p --agent Reviewer                           │
│         per-criterion:                                           │
│             behavioral Satisfied? (primary)                      │
│             mechanism Satisfied? (literal or via valid marker)   │
│         on @contract-deviation marker:                           │
│             parse JSON → reproduce invalidity → confirm          │
│             behavioral_preserved_ref satisfied                   │
│     → verdict PASS/FAIL → loop                                   │
└─────────────────────────────────────────────────────────────────┘
```

</feature:shape>

<feature:failure_modes>

- **Split ambiguity.** Deciding "behavior vs mechanism" per criterion is interpretive. `tap-into` adjudicates at authoring with imperfect foresight. Mitigation: Validator flags behaviorals that fail the testability heuristic; user refines during the authoring gate.
- **Behavioral vagueness drift.** Authors trend toward "feature works correctly" in the behavioral column to avoid over-specification. Mitigation: Validator's testability heuristic rejects prose that does not name a file, command output, or observable.
- **Mechanism becomes vestigial.** If the Composer reaches for the substitution escape hatch too often, the mechanism column stops carrying convention-steering weight. Mitigation: per-feature deviation-count metric (deferred; in open_questions).
- **Lazy duals.** Authoring burden produces `mechanism: null` everywhere or identical-text duals. Mitigation: Validator flags `mechanism === behavioral` and flags `mechanism === null` when the criterion text contains specific mechanism keywords (API names, type constructions, paths).
- **Validator false positives.** Flags valid criteria as untestable or contradictory; user rewrites unnecessarily. Mitigation: warning severity for low-confidence findings; only hard contradictions and tsc/cargo reproduction failures escalate to blocker.
- **Validator false negatives / blind spots.** Validator misses a mismatch; it reaches the loop anyway. Mitigation: Route A (Reviewer reproduces marker claims at execution time) remains as backstop.
- **Criterion-weakening via substitution.** The Composer emits a marker, claims behavioral-preserved, in practice waters down behavioral intent. Mitigation: the behavioral field is authored upstream and frozen; the Composer cannot reclassify. The Reviewer's `behavioral_preserved_ref` check validates the marker's claim against the frozen behavioral field.
- **Self-referential blind spot.** Validator uses LLM reasoning; may share blind spots with Composer and Reviewer. Mitigation: tool-grounded checks (`bunx tsc`, `cargo check`, `git ls-files`, `Schema.decodeUnknown`) are the load-bearing parts; LLM synthesis handles only prose-level heuristics and unknown-stack fallback.
- **Bootstrap risk during S1 migration.** S1 migrates the running contract itself. Mitigation: S1 splits into three ordered tasks (schema-lenient → migrate-all-contracts → schema-strict) so the contract is always loadable through the transition.

</feature:failure_modes>

<feature:open_questions>

- **`VALIDATION_RESULT.md` lifecycle after a feature completes.** Does it archive, get overwritten on each `tap-into` re-run, or feed into a per-feature deviation-trend log? Deferred. Revisit when a second feature author re-runs `tap-into` on an existing feature.
- **Reviewer Haiku/Sonnet sub-agent for marker reproduction.** Deferred. The nesting-from-subprocess-spawned-main-thread path is plausible but unconfirmed; a 10-line smoke test should run before committing to this optimization. Revisit once deviation-frequency data arrives from real usage.
- **Per-feature deviation-count metric.** Cumulative substitution markers across a feature's tasks. High counts signal a contract that should have caught more at authoring. Deferred; design when the first feature accumulates more than five markers.
- **Multi-stack mechanism-viability expansion.** Python, Go, Ruby, Clojure, Elixir dispatch. TODO noted in `.claude/skills/tap-into/SKILL.md`. Revisit when the tool ships to non-TS, non-Rust users.
- **Validator self-verification.** Can the Validator be run on its own `SKILL.md` or on the Validator methodology itself? Circular, probably no, but worth checking once Validator is stable.
- **Criterion-authoring style guide.** A prose doc describing "how to write a testable behavioral field" for `tap-into` authors. Currently encoded only in Validator's testability heuristic; lifting it to a shared human-readable doc would help contracts authored outside `tap-into`.

</feature:open_questions>
