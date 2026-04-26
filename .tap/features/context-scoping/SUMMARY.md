# SUMMARY — context-scoping

## 1. Overview

Feature **context-scoping** reached terminal state **AllDone**. All 7 tasks across 5 stories completed successfully; 0 tasks failed. The feature replaces unbounded agent exploration in the Ralph loop with orchestrator-curated context delivery: ContextEngine now builds a ScoutManifest from `task.files` and `<spec:depth>` entries, Composer and Reviewer prompts enforce graduated read policies instead of blanket read permission, Scout produces structured deviation checks instead of freeform surveys, and Composer gains git-staleness-aware project memory for cross-task pattern caching.

---

## 2. Changes by Story

### S1 — Manifest resolution in ContextEngine

- **S1.T1 — ScoutManifest type definitions:** Created `src/types/Manifest.d.ts` with ambient declarations for `ScoutManifest` (targets + context arrays) and `ManifestEntry` (path, reason, optional module). Types are globally visible per project convention — no imports required.
- **S1.T2 — buildManifest + readDir dependency + render integration:** Extended `src/services/ContextEngine.ts` with internal `buildManifest` logic: parses `<spec:depth>` module paths from the depth section string, resolves sibling files via new `readDir` dependency, deduplicates against `task.files`, and returns a `ScoutManifest`. Wired `scout_manifest` template variable into `renderComposer` and `renderReviewer`. Tests in `src/services/__tests__/ContextEngine.test.ts` cover sibling resolution, directory children, missing-path graceful skip, empty depth section fallback, and deduplication.

### S2 — Composer context scoping

- **S2.T1 — COMPOSER_CONTRACT.md manifest section + graduated read policy:** Updated `.tap/prompts/COMPOSER_CONTRACT.md` to render the `{{scout_manifest}}` block (targets and context files with reasons) and replaced the blanket "You may read any file in the repository for context" permission with graduated friction: manifest and `task_files` are expected reads; anything else is extraordinary and requires a one-line justification. Added anti-rationalization framing marking unbounded exploration as a red flag.
- **S2.T2 — Composer.md scout_pre_step rewrite:** Rewrote `scout_pre_step` in `.claude/agents/Composer.md` to scope Scout to manifest files. Scout now produces a structured per-module deviation-check report (entry point count, seam category, hidden complexity) rather than a freeform paragraph survey. Deviations flagged as informational only; report is ephemeral (not written to disk).

### S3 — Reviewer context scoping

- **S3.T1 — REVIEWER_CONTRACT.md parallel scope constraint:** Added scoped read constraint to `.tap/prompts/REVIEWER_CONTRACT.md`. Primary Reviewer inputs are git diff, depth contract, and task description. Source reads allowed only to verify specific diff claims, not for general exploration. Includes `scout_manifest` for reference under the same graduated friction policy. No `memory: project` for Reviewer — clean-slate judgment preserved by design.

### S4 — deep-modules skill alignment

- **S4.T1 — Update write_scout_survey and judge_reinvention:** Rewrote `write_scout_survey` in `.claude/skills/deep-modules/SKILL.md` to match the scoped deviation-check pattern (manifest-bounded read, per-module structured flags). Updated `judge_reinvention` to reference manifest-scoped survey rather than assuming a full codebase sweep. Shared vocabulary and other overlays left unchanged.

### S5 — Memory integration

- **S5.T1 — Scout memory protocol in Composer.md:** Added `memory: project` to `Composer.md` frontmatter. Extended `scout_pre_step` with recall-before-read protocol: Scout checks project memory for each manifest file's module; if the stored commit hash matches HEAD (`git diff <hash> HEAD -- <file>` is empty), memory is trusted and the read is skipped; if stale or absent, Scout reads the file and saves entry-point, seam, naming, and error-idiom patterns with the current commit hash. One memory entry per module.

---

## 3. Failures

None.

---

## 4. Depth-Contract Assessment

No depth contract declared for this feature — depth assessment skipped.
