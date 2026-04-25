# deep-module-paradigm

<feature:goal>
Make Ousterhout's deep-module discipline a first-class, enforced paradigm across the tap-tool Ralph loop. The `tap-into` interview probes for it, `SPECS.md` captures it as a rigorous obligation in a new `<feature:depth>` section, the Composer respects it via a deep-module-aware Scout pre-step, the Reviewer judges the diff against it, and a new Summarizer role reports against it on terminal loop states.
</feature:goal>

<feature:context>
The loop today emits `SPECS.md` + `FEATURE_CONTRACT.json` to `.tap/features/<slug>/`. `SPECS.md` is read-not-parsed — `src/services/ContextEngine.ts:64-81` passes `specs_path` as a Handlebars string and the agents `Read` it themselves. `feature_constraints` is the only field already extracted and looped via `{{#each}}` in `.tap/prompts/COMPOSER_CONTRACT.md`.

Composer (`.claude/agents/Composer.md:27`) is instructed to "derive style from CLAUDE.md/AGENTS.md/CONTRIBUTING.md, mirror nearby code" but has no required pre-step that forces a survey of nearby patterns. Reviewer (`.claude/agents/Reviewer.md`) judges PASS/FAIL via three XML blocks in `EVAL_RESULT.md`. `LoopSummary` (`src/services/LoopRunner/LoopRunner.d.ts:17`) is built in memory; only `formatResumeHint` (`loopReporter.ts:26-51`) surfaces it, and only on halts.

Deep-module vocabulary already exists in the repo: `philosophy/design-principles.md:19-31` defines deep vs. shallow; `CLAUDE.md:29` enforces "prefer deep modules over shallow ones". Two Matt Pocock skills (`improve-codebase`, `domain-model`) were dropped in `.claude/skills/` and have just been removed by the user; their LANGUAGE.md / DEEPENING.md / INTERFACE_DESIGN.md vocabulary will be condensed into a new `~/.claude/skills/deep-modules/` skill consumed by the loop's three roles.

The `runRole` inline helper introduced in commit `e9d49c4` is the dispatch primitive that the new Summarizer role piggybacks on, keeping role symmetry with Composer/Reviewer.
</feature:context>

<feature:constraints>

- Use **depth-as-leverage** (per `improve-codebase/LANGUAGE.md:18-19`), not Ousterhout's implementation-line-to-interface-line ratio. The new `deep-modules` skill must restate this explicitly.
- **≤3 entry points per module is a hard cap.** Above → split into a new module. Applies to every entry in `<feature:depth>` and to every module Composer creates.
- Every file in any `task.files` across `FEATURE_CONTRACT.json` must map to exactly one `<feature:depth>` module entry. `tap-into`'s convergence check enforces this before emit.
- The emitted spec artifact remains `SPECS.md` (no rename). The `<feature:depth>` section is added to the existing template; sibling features in `.tap/features/*/SPECS.md` keep working — those that lack a `<feature:depth>` section get an empty `{{depth_section}}` placeholder downstream.
- Surface decode/parse failures in the new depth-section extractor (do not swallow). Bubble up or fold into downstream failure messages, per `feedback_surface_parse_errors`.
- Composer's pattern survey runs as an `Explore` Scout subagent. Output is **ephemeral** — passed via stdin into Composer's prompt, no on-disk artifact.
- Summarizer fires only on terminal `AllDone` and `Exhausted`. Skip on `RateLimited` and `NoReadyTasks`.
- `deep-modules` skill lives at `~/.claude/skills/deep-modules/`, not in the project. Single SKILL.md with vocabulary core + three short role overlays (probe / write / judge).
- Follow existing role-dispatch convention: Summarizer dispatches through the `runRole` helper (commit `e9d49c4`), not a parallel pathway.
- Summarizer failure must not gate loop termination — log and exit cleanly with the existing terminal status.
  </feature:constraints>

<feature:depth>

## Module: depth-section-extractor

- **Path:** `src/services/ContextEngine.ts` (new internal function)
- **Interface (entry points, ≤3):**
  - `extractDepthSection(specsContent: string): Effect<Option<string>, ParseError>` — returns the inner content of the `<feature:depth>...</feature:depth>` XML block, `None` if absent, fails if malformed (open without close, mismatched tag).
- **Hidden complexity:** XML tag matching tolerant of leading/trailing whitespace and nested XML inside the block; explicit malformed-input detection rather than greedy regex that could silently swallow truncation.
- **Deletion test:** If deleted, three callers (`renderComposer`, `renderReviewer`, `renderSummarizer`) would each inline regex matching against `SPECS.md` content — three duplicate parse implementations that drift independently.
- **Seam:** `in-process`. No adapter.
- **Justification:** One input → one output, hides parse from three render paths. Future format changes (e.g., depth metadata fields) land in one place.

## Module: renderSummarizer

- **Path:** `src/services/ContextEngine.ts` (new public method on `ContextEngine` interface)
- **Interface (entry points, ≤3):**
  - `renderSummarizer(input: SummarizerRenderInput): Effect<string, RenderError>` — produces the rendered `SUMMARIZER_CONTRACT.md` prompt string.
- **Hidden complexity:** Loads `SUMMARIZER_CONTRACT.md` template at layer construction (parallel to existing `loadTemplates` in `ContextEngineLive`); maps camelCase `SummarizerRenderInput` → snake_case Handlebars context (mirrors `toComposerContext` shape at lines 64–81); parses and injects `{{depth_section}}` via `depth-section-extractor`; resolves `git_diff` via shell-out at render time.
- **Deletion test:** Without it, `LoopRunner`'s terminal branch would assemble the Summarizer prompt inline — the same coupling problem `renderComposer` and `renderReviewer` already solve for their roles. Three render call sites would diverge.
- **Seam:** `in-process`. No adapter.
- **Justification:** Symmetric with `renderComposer` (`ContextEngine.ts:64-81`) and `renderReviewer` (`ContextEngine.ts:83-98`). Same shape, same depth, same hidden machinery.

## Module: terminalSummaryDispatch

- **Path:** `src/services/LoopRunner/LoopRunnerLive.ts` (new helper, called once after the terminal-state decision)
- **Interface (entry points, ≤3):**
  - `dispatchTerminalSummary(summary: LoopSummary, ctx: RunContext): Effect<void, DispatchError>` — predicates on `summary.stoppedReason._tag`, dispatches Summarizer via `runRole` iff terminal-eligible (`AllDone` | `Exhausted`), writes `SUMMARY.md` to `.tap/features/<slug>/`. No-op otherwise.
- **Hidden complexity:** Pattern-matches on `StoppedReason._tag`; builds `SummarizerRenderInput` from feature contract + loop summary + `git diff`; runs dispatch through `runRole`; persists `SUMMARY.md`; absorbs Summarizer dispatch failures so loop termination is not gated.
- **Deletion test:** Without the helper, the terminal branch inlines both the eligibility predicate and the dispatch. A future `StoppedReason` variant (e.g., `Aborted`) added to the discriminated union would silently bypass the summary because the predicate isn't centralized.
- **Seam:** `in-process`.
- **Justification:** Single entry point hides eligibility predicate, input assembly, dispatch, file write, and failure absorption. "What counts as terminal" lives in exactly one place.

</feature:depth>

<feature:shape>

```
   user feature seed
         │
         ▼
   ┌─────────────┐         ┌──────────────────────────────┐
   │  tap-into   │────────▶│ SPECS.md                     │
   │  (probes    │         │  ├── <feature:depth>  (NEW)  │
   │   depth)    │         │  ├── <feature:shape> ...     │
   └─────────────┘         │ FEATURE_CONTRACT.json        │
         │                 └──────────────────────────────┘
         │ consumes
         ▼
  deep-modules skill (probe overlay)

   ┌───────────────────────────────────────────────────────┐
   │                LoopRunner (per task)                  │
   └─────────────────────────┬─────────────────────────────┘
                             │
                             ▼
              ┌──────────────────────────┐
              │ Scout (Explore subagent) │  ◀── deep-modules skill (write overlay)
              └────────────┬─────────────┘
                           │ ephemeral report via stdin
                           ▼
   ContextEngine ──▶ Composer (with {{depth_section}})
   (extractDepthSection)             │
                                     │ diff
                                     ▼
   ContextEngine ──▶ Reviewer (with {{depth_section}})  ◀── deep-modules skill (judge overlay)
                                     │
                                     │ EVAL_RESULT.md
                                     ▼
                          ┌────────────────────┐
                          │ terminal decision? │
                          └─────────┬──────────┘
                                    │ AllDone | Exhausted only
                                    ▼
                       terminalSummaryDispatch
                                    │
                                    ▼
   ContextEngine ──▶ Summarizer (with {{depth_section}} + git diff)
   (renderSummarizer)               │
                                    ▼
                          SUMMARY.md (on disk)
```

Three render paths share `extractDepthSection` and the `{{depth_section}}` placeholder. Three roles (Composer, Reviewer, Summarizer) share the `deep-modules` skill, with role-specific overlays. `tap-into` also consumes `deep-modules` for the probe overlay so plan-time vocabulary matches write-time and judge-time vocabulary.
</feature:shape>

<feature:failure_modes>

- **Malformed `<feature:depth>` block in SPECS.md.** `depth-section-extractor` surfaces the parse failure as `ParseError` rather than returning `None` silently. Renderers fold it into their failure channel; LoopRunner halts with a clear message rather than launching Composer with an empty obligation.
- **SPECS.md without a `<feature:depth>` section** (sibling features authored before this paradigm landed). Extractor returns `None`. Renderers inject empty placeholder. Composer / Reviewer behave as today — no depth obligation. Logged as a warning, not a hard failure, so existing `.tap/features/*/SPECS.md` keep working unchanged.
- **Scout subagent times out or returns garbage.** Composer proceeds without the report. Logged. Not a halt — Reviewer is the enforcement loop and will FAIL iterations that ignore obvious nearby patterns. Subsequent retry attempts re-spawn Scout (ephemeral, no caching).
- **Summarizer fails on terminal dispatch.** `SUMMARY.md` is not written. LoopRunner logs the failure and exits cleanly with the existing terminal status. `terminalSummaryDispatch` absorbs the failure inside the helper so the terminal status stays authoritative.
- **`runRole` dispatch envelope drift between Composer / Reviewer / Summarizer.** Mitigated by reusing the inline `runRole` helper from commit `e9d49c4` — single dispatch path, same envelope. New role plugs in by name + prompt + skills frontmatter, not by parallel orchestration code.
- **`deep-modules` skill not installed at `~/.claude/skills/deep-modules/` on the user's machine.** Composer/Reviewer/Summarizer's `skills:` frontmatter references a missing skill — agent harness handles missing-skill behavior. Not blocking but degrades the depth-discipline guarantees the feature is supposed to provide. Documented in the skill creation task.
  </feature:failure_modes>

<feature:open_questions>

- `improve-codebase` and `domain-model` skills relocation from project to `~/.claude/`. Out of scope — user removed local copies and will move them separately. The new `deep-modules` skill is created in this feature and does not depend on the relocation.
- Whether Scout's report should eventually be persisted as an artifact for Reviewer audit (currently ephemeral by user choice). Revisit only if Reviewer-side enforcement of "Composer ignored Scout" proves insufficient without an audit trail.
- Whether to backfill `<feature:depth>` sections into existing `.tap/features/*/SPECS.md` siblings or leave them paradigm-free. Deferred — backfill is a per-feature judgment call; the warning-on-missing-section behavior makes the cost visible without forcing it.
  </feature:open_questions>
