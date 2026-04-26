# cli-dashboard — Loop Summary

## Overview

Feature **cli-dashboard** reached terminal state **AllDone**. All 6 tasks across 3 stories completed successfully (S1.T1, S1.T2, S2.T1, S2.T2, S3.T1, S3.T2). No tasks failed. The feature replaced `scripts/bootstrap.ts` with a proper `tap run <feature>` CLI backed by an in-memory `Ref<DashboardState>` and a real-time terminal dashboard.

---

## Changes by Story

### S1 — DashboardState type and LoopRunner integration

**S1.T1** — Created `src/types/Dashboard.d.ts` with ambient `declare global` declarations for `DashboardState`, `DashboardStoryState`, `DashboardTaskState`, and `DashboardTotals`. Uses `Option.Option<AgentRole>` for `phase` and `Option.Option<StoppedReason>` for `stoppedReason`. File imports `effect` and wraps all declarations in `declare global` per the project's ambient-type convention. (1 attempt)

**S1.T2** — Modified `LoopRunner.run` signature in `src/services/LoopRunner/LoopRunner.ts` to accept an optional `dashboardRef?: Ref.Ref<DashboardState>`. Updated `LoopRunnerLive` to call `Ref.update` at task start (`in_progress` + phase), phase change (Composer → Reviewer), cost/token accumulation, task completion (`done`/`failed`), and loop termination (`stoppedReason`). Existing LoopRunner tests updated to supply the Ref. (3 attempts, hit maxAttempts)

### S2 — Dashboard renderer

**S2.T1** — Created `src/services/Dashboard/renderFrame.ts` exporting a single pure function `renderFrame(state, columns) → string`. Implements grouped story/task layout with ANSI glyphs (`·`, `›`, `✓`, `✗`), right-aligned cost and duration per task using `Bun.stringWidth`/`Bun.sliceAnsi`, totals footer, and color-coded end-state footer (green AllDone, red TaskExhausted, yellow RateLimited/MaxIterations/NoReadyTasks). Tests in `src/services/Dashboard/__tests__/renderFrame.test.ts` cover all statuses, end states, and narrow-terminal truncation. (1 attempt)

**S2.T2** — Created `src/services/Dashboard/Dashboard.ts` with `Dashboard` Effect service tag and `DashboardLive` Layer. Exposes `run(ref) → Effect<void>`. TTY path hides cursor, runs a 200ms render loop racing against a `q`-keypress watcher via `terminal.readInput`, and renders a final frame on exit. Non-TTY path emits plain `[tap run <feature>]` status lines and exits when `stoppedReason` becomes `Some`. Created `src/services/Dashboard/index.ts` re-exporting the service and layer. (1 attempt)

### S3 — CLI entry and cleanup

**S3.T1** — Created `src/cli.ts` using `@effect/cli`: defines `tap run <feature>` command, builds initial `DashboardState` from the loaded feature contract, creates `Ref<DashboardState>`, forks `LoopRunner.run` and `Dashboard.run` as concurrent fibers, awaits loop then dashboard. Wires all existing Effect layers plus `DashboardLive` via `BunContext.layer`. Added `bin` field to `package.json`. (1 attempt)

**S3.T2** — Deleted `scripts/bootstrap.ts`. Updated all live references: `src/services/LoopRunner/loopReporter.ts` (TSDoc step 4 and runtime resume-hint string) and `src/services/LoopRunner/gitCommit.ts` (TSDoc) now reference `tap run <feature>` instead of `bun run scripts/bootstrap.ts`. TypeScript and test suite (162 pass / 0 fail) verified clean after deletion. (2 attempts)

---

## Failures

None.

---

## Depth-Contract Assessment

### Module: DashboardState — `src/types/Dashboard.d.ts`

**Verdict: Honored**

- **Entry-point cap (≤3):** Type-only module with zero callable entry points. Declares 4 ambient interfaces (`DashboardState`, `DashboardStoryState`, `DashboardTaskState`, `DashboardTotals`) in a `declare global` block. No exports, no runtime surface.
- **Seam adherence:** `in-process` ambient declaration. File uses `import type { Option }` from effect and wraps all declarations in `declare global` (lines 3–39), matching the project's module-file convention for ambient types that reference imported types.
- **Hidden complexity:** Declared as none (type-only). Confirmed: file is 40 lines of pure interface declarations with no logic. Callers read dashboard state via these interfaces without any awareness of the LoopRunner update mechanics.

---

### Module: LoopRunner (modification) — `src/services/LoopRunner/`

**Verdict: Honored**

- **Entry-point cap (≤3):** Single entry point `run(contractPath, dashboardRef?) → Effect<LoopSummary>` (LoopRunner.ts lines 33–47). Optional `dashboardRef` parameter is additive; existing callers requiring only the contractPath continue to work without change.
- **Seam adherence:** `in-process`. Ref updates are injected at natural transition points inside `LoopRunnerLive` — no new I/O boundary introduced.
- **Hidden complexity:** All existing loop orchestration (scheduling, dependency resolution, retry policy, git commit, eval archiving) plus new `Ref.update` calls at each state transition remains hidden from callers. The `dashboardRef` parameter is the only new surface — callers do not interact with the Ref contents directly.

---

### Module: Dashboard renderFrame — `src/services/Dashboard/renderFrame.ts`

**Verdict: Honored**

- **Entry-point cap (≤3):** One exported symbol: `export function renderFrame(state: DashboardState, columns: number): string` (line 163). All internal helpers (`glyphAnsi`, `formatDuration`, `formatCost`, `renderTaskRow`, `renderStoryHeader`, `renderSeparator`, `renderTotalsFooter`, `renderEndStateFooter`) are module-private.
- **Seam adherence:** `in-process`, pure function. No side effects; no I/O. Confirmed by implementation — reads `DashboardState`, calls `Bun.stringWidth`/`Bun.sliceAnsi`, returns a string.
- **Hidden complexity:** Grouped story/task layout (lines 174–179), glyph-to-ANSI mapping (lines 19–37), column alignment with `Bun.stringWidth` (lines 72–84), cost/duration formatting (lines 43–52), footer composition (lines 96–111), end-state coloring with exhaustiveness guard (lines 113–146), and header elapsed-time display (lines 167–171) — all hidden behind the single `renderFrame` call.

---

### Module: Dashboard service — `src/services/Dashboard/Dashboard.ts`

**Verdict: Honored**

- **Entry-point cap (≤3):** One callable entry point: `run(ref: Ref<DashboardState>) → Effect<void>` (line 31). `Dashboard` (Context.Tag) and `DashboardLive` (Layer) are also exported for wiring — both are service infrastructure, not additional behavioral entry points. Count: 1 behavioral entry point.
- **Seam adherence:** `in-process`. Service backed by `Terminal.Terminal` from `@effect/platform`; no new process or network boundary.
- **Hidden complexity:** TTY detection (line 169), ANSI cursor management — `HIDE_CURSOR`/`SHOW_CURSOR`/`CURSOR_HOME`/`ERASE_DOWN` (lines 9–12, 88–89), 200ms refresh scheduling (lines 105–114), `q`-keypress handling via `terminal.readInput` mailbox (lines 121–135), `Effect.race` between render loop and quit watcher (line 138), plain-line fallback for non-TTY (lines 46–72), and terminal cleanup finalizer (lines 89–91) — all hidden from the caller behind `run(ref)`.

---

### Module: CLI entry — `src/cli.ts`

**Verdict: Honored**

- **Entry-point cap (≤3):** One bin entry point: `Command.run(tapCmd, ...)(process.argv)` (line 139). `makeInitialDashState` is a module-private helper (not exported). `runCmd` and `tapCmd` are internal command definitions.
- **Seam adherence:** `in-process` process entry point. Wires all layers through `BunContext.layer` and `BunRuntime.runMain`.
- **Hidden complexity:** `@effect/cli` command definition and argument parsing (lines 80–114), `makeInitialDashState` factory that maps `Feature` → `DashboardState` (lines 35–74), Effect layer composition merging 7 live layers (lines 125–133), `Ref` creation, and concurrent fiber forking with sequential join (lines 99–112) — all hidden from the process invocation surface `tap run <feature>`.
