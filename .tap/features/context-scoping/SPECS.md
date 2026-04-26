# context-scoping

<spec:goal>
Reduce token waste in the tap-tool Ralph loop by replacing unbounded agent exploration with orchestrator-curated context delivery. ContextEngine builds a scoped manifest from the feature contract and SPECS.md depth entries, Scout verifies depth claims against actual code in a single bounded pass, and agents operate under a graduated read policy that treats unbounded exploration as extraordinary rather than default. Project memory with git-based staleness provides cross-task pattern caching.
</spec:goal>

<spec:context>
The tap-tool Ralph loop currently burns 60–70% of its token budget on redundant file reads. Logs from the `deep-module-paradigm` feature show Composer agents reading 21–36 files per task in an unbounded Scout sweep, re-reading the same files 3–9 times within a single task, and a cache-read-to-output ratio of 8:1 (target: 2–3:1). The root causes are:

1. **Blanket read permission** in `COMPOSER_CONTRACT.md` ("You may read any file in the repository for context").
2. **Unbounded Scout instruction** in `Composer.md` (`scout_pre_step`) and `deep-modules` SKILL.md (`write_scout_survey`) both telling the agent to survey the codebase without scope constraints.
3. **No context reuse across tasks** — each task's Scout rediscovers patterns that previous Scouts already found.

Key files this builds on:
- `src/services/ContextEngine.ts` — orchestrator that assembles prompts for Composer, Reviewer, and Summarizer agents. Already has `extractDepthSection()` and `renderComposer()`/`renderReviewer()` entry points.
- `.tap/prompts/COMPOSER_CONTRACT.md` — Handlebars template rendered by ContextEngine for Composer. Contains `{{task_files}}`, `{{depth_section}}`, and blanket read permission.
- `.tap/prompts/REVIEWER_CONTRACT.md` — Handlebars template for Reviewer. Similar structure.
- `.claude/agents/Composer.md` — agent definition with `scout_pre_step` rule.
- `.claude/skills/deep-modules/SKILL.md` — shared vocabulary with `write_scout_survey` and `judge_reinvention` rules.

Design influenced by the `obra/superpowers` project's orchestrator-curated-injection pattern: the orchestrator pre-extracts and curates exactly what context each subagent needs, rather than letting subagents discover context themselves. "Make subagent read plan file" is treated as a red flag.
</spec:context>

<spec:constraints>

- ContextEngine's public interface must not grow beyond its current 3 render entry points. Manifest building is internal hidden complexity.
- All read constraints use graduated friction (strong direction + extraordinary escape hatch), never hard walls. Rigid constraints caused Composer-Reviewer death spirals in prior features.
- Reviewer must NOT receive `memory: project` — it judges from a clean slate every time.
- Scout deviations from depth_section are informational, never blocking. The depth section was written at plan time; code evolves during the feature. Deviations are expected signal for the Summarizer, not stop-the-line errors.
- Type dependencies are project-specific and inferred by the agent from CLAUDE.md conventions — no generic type-dependency resolution in the manifest.
- Memory entries use one entry per module, not per file. Staleness checked via `git diff <stored-hash> HEAD -- <file>`.

</spec:constraints>

<spec:depth>

## Module: ContextEngine

- **Path:** `src/services/ContextEngine.ts`
- **Interface (entry points, ≤3):**
  1. `renderComposer(input: ComposerRenderInput)` — renders the full Composer prompt including the new scout manifest.
  2. `renderReviewer(input: ReviewerRenderInput)` — renders the full Reviewer prompt including the manifest for reference.
  3. `renderSummarizer(input: SummarizerRenderInput)` — renders the Summarizer prompt (unchanged by this feature).
- **Hidden complexity:** Manifest resolution — parsing `<spec:depth>` module paths from the depth section, resolving those paths to concrete sibling files via filesystem access, deduplicating against task.files, and structuring the result for template injection. Callers (LoopRunner) call `renderComposer()` exactly as before; they never see the manifest.
- **Deletion test:** Without ContextEngine, every caller would have to assemble prompts by hand — reading templates, extracting depth sections, resolving manifests, compiling Handlebars. Substantial duplication.
- **Seam:** `in-process`. ContextEngine is a pure service constructed via Effect Layer with injected dependencies (`readFile`, `readDir`).
- **Justification:** One render call hides template compilation, depth extraction, manifest resolution, and context assembly. Callers pay zero interface cost for the new manifest capability.

## Module: Manifest types

- **Path:** `src/types/Manifest.d.ts`
- **Interface (entry points, ≤3):**
  1. `ScoutManifest` — top-level type with `targets` and `context` arrays.
  2. `ManifestEntry` — entry type with `path`, `reason`, and optional `module` name.
- **Hidden complexity:** None beyond the type definitions themselves. This is a data-shape declaration.
- **Deletion test:** Without these types, ContextEngine and templates would use untyped objects for manifest data — every consumer would have to know the shape by convention rather than by type.
- **Seam:** `in-process`. Ambient type declarations, globally visible per project convention.
- **Justification:** Two types that standardize the manifest shape across ContextEngine (producer) and templates (consumer). Minimal interface, prevents shape drift.

## Module: COMPOSER_CONTRACT template

- **Path:** `.tap/prompts/COMPOSER_CONTRACT.md`
- **Interface (entry points, ≤3):**
  1. Handlebars template consumed by `ContextEngine.renderComposer()` — single render entry point.
- **Hidden complexity:** Prompt engineering — graduated read policy, anti-rationalization language, manifest presentation format, Scout instruction framing. Changes to agent behavior are encoded here without any caller knowing the prompt changed.
- **Deletion test:** Without this template, ContextEngine would have to hardcode the Composer prompt or every caller would assemble it manually.
- **Seam:** `file`. Template loaded from disk at ContextEngine construction time.
- **Justification:** All Composer behavioral changes (read policy, manifest, Scout instructions) are encoded in one template file. ContextEngine's code doesn't change when prompt wording is tuned.

## Module: REVIEWER_CONTRACT template

- **Path:** `.tap/prompts/REVIEWER_CONTRACT.md`
- **Interface (entry points, ≤3):**
  1. Handlebars template consumed by `ContextEngine.renderReviewer()` — single render entry point.
- **Hidden complexity:** Reviewer-specific scoping rules, graduated friction for read access, methodology for judging from diff + depth contract rather than full codebase survey.
- **Deletion test:** Same as COMPOSER_CONTRACT — without it, prompt assembly falls to callers.
- **Seam:** `file`. Template loaded from disk at ContextEngine construction time.
- **Justification:** Reviewer behavioral constraints are encoded in one template. Parallel to COMPOSER_CONTRACT but with clean-slate judgment emphasis.

## Module: Composer agent definition

- **Path:** `.claude/agents/Composer.md`
- **Interface (entry points, ≤3):**
  1. Agent definition consumed by Claude Code's agent framework — single load entry point.
- **Hidden complexity:** Scout orchestration protocol — manifest-scoped survey, structured deviation-check report format, memory recall/save protocol with git-based staleness, graduated read policy reinforcement.
- **Deletion test:** Without this definition, Composer agent falls back to default Claude Code behavior with no Scout step, no depth awareness, no memory protocol.
- **Seam:** `file`. Loaded by Claude Code agent framework at agent spawn time.
- **Justification:** All Scout operational instructions live in one place. Changes to Scout behavior (memory protocol, report format, scope constraints) don't touch ContextEngine or templates.

## Module: deep-modules skill

- **Path:** `.claude/skills/deep-modules/SKILL.md`
- **Interface (entry points, ≤3):**
  1. Skill definition consumed by Claude Code's skill framework — single load entry point.
- **Hidden complexity:** Shared vocabulary and role overlays (probe, write, judge) that ensure consistent depth-discipline language across all agents in the loop.
- **Deletion test:** Without this skill, each agent definition would have to independently define depth vocabulary and discipline rules — drift between agents would be inevitable.
- **Seam:** `file`. Loaded by Claude Code skill framework on demand.
- **Justification:** `write_scout_survey` and `judge_reinvention` need updating to match scoped manifest pattern — but the skill's role as shared vocabulary across agents remains the same.

</spec:depth>

<spec:shape>

```
FEATURE_CONTRACT.json ──┐
                        │
SPECS.md ──► extractDepthSection() ──► parseModulePaths() ──┐
                                                             │
                                              readDir() ◄───┘
                                                  │
                                                  ▼
                                           buildManifest()
                                                  │
                              ┌────────────────────┤
                              ▼                    ▼
                     renderComposer()      renderReviewer()
                              │                    │
                              ▼                    ▼
                   COMPOSER_CONTRACT.md   REVIEWER_CONTRACT.md
                     (with manifest +       (with manifest +
                      graduated policy)      parallel constraint)
                              │
                              ▼
                     Composer agent
                              │
                       ┌──────┴───────┐
                       ▼              ▼
                 recall memory   manifest files
                       │              │
                   ┌───┴───┐          │
                   │       │          │
                fresh    stale     read once
                (skip)  (re-read     │
                   │    + save)      save to
                   │       │        memory
                   └───┬───┘          │
                       ▼              │
                Scout report ◄────────┘
               (deviation checks)
                       │
                       ▼
              Composer writes code
             (reads only task.files
              before editing)
```

Data flow:
1. ContextEngine reads SPECS.md, extracts depth section, parses module paths.
2. For each module path overlapping with task.files, resolves sibling files via readDir.
3. Builds ScoutManifest (targets + context), injects into template alongside existing variables.
4. Rendered COMPOSER_CONTRACT includes manifest + graduated read policy.
5. Composer spawns Scout with manifest scope. Scout checks memory first (git-based staleness), reads only what's needed, saves discoveries, produces structured deviation report.
6. Composer receives report, writes code. Reads only task.files before editing. Extraordinary reads require justification.
7. Reviewer receives parallel manifest, judges from diff + depth contract, reads source only to verify specific claims.

</spec:shape>

<spec:failure_modes>

**Manifest file doesn't exist.** A depth_section module path may reference a file or directory that was deleted or renamed since SPECS.md was written. ContextEngine's readDir call fails gracefully — the module is omitted from the manifest with no error. Scout proceeds with a smaller manifest. The missing module appears as a deviation in the Scout report (informational, not blocking).

**Depth section missing entirely.** Some features may not have a `<spec:depth>` block. buildManifest falls back to targets-only: task.files are listed, context array is empty. Scout gets a minimal manifest. Composer operates under graduated read policy but has less guidance on what to read for patterns.

**Memory has wrong patterns.** A memory entry records patterns that were true at commit X but the file has since been substantially rewritten. Git-based staleness check catches this — `git diff <stored-hash> HEAD -- <file>` returns non-empty, memory is discarded, file is re-read. Cost: one git diff per manifest file per task. Negligible.

**Scout report flags many deviations.** Depth section may be significantly out of date with actual code. Scout report becomes a long list of flags. This is informational — Composer proceeds with actual code state, not stale claims. Summarizer picks up the deviation count in its depth-contract assessment, signaling that SPECS.md may need updating.

**Composer rationalizes extraordinary reads.** Despite graduated policy and anti-rationalization language, the model may still find reasons to read beyond the manifest. This is by design — friction, not wall. The justification requirement creates a log trail. If logs show frequent extraordinary reads, the manifest scope needs widening (a tuning problem, not a bug).

</spec:failure_modes>

<spec:open_questions>

**Memory entry granularity.** Design specifies one memory entry per module. If a module spans many files (e.g., a directory with 10 source files), the memory entry may become large. Deferred — start with per-module, split to per-file if memory entries grow unwieldy. Revisit after first feature run with memory enabled.

**Reviewer manifest presentation.** Reviewer receives the manifest "for reference" but its primary inputs are git diff and depth contract. The exact template presentation (full manifest vs. summary) is a prompt-tuning question best resolved during S3.T1 implementation. The constraint (parallel graduated friction) is clear; the formatting is flexible.

**readDir dependency shape.** ContextEngine needs filesystem directory listing. Whether this is a simple callback like `readFile`, an Effect service, or a method on an existing dependency — implementation decision for S1.T2. The interface contract: given a directory path, return a list of file paths (non-recursive, immediate children only).

</spec:open_questions>
