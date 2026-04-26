# cli-dashboard

<spec:goal>
Replace `scripts/bootstrap.ts` with a proper `tap run <feature>` CLI command using @effect/cli, and embed a real-time terminal dashboard showing task progress, token costs, and decorated terminal states — all driven by an in-memory `Ref<DashboardState>` shared between the loop and the renderer.
</spec:goal>

<spec:context>
Builds on the existing LoopRunner service (`src/services/LoopRunner/`) which orchestrates the Composer-Reviewer loop. Currently invoked via `scripts/bootstrap.ts` — a thin shim accepting a feature slug from `process.argv[2]`. The @effect/cli dependency is already in `package.json` but unused. Bun provides native SIMD-optimized string utilities (`Bun.stringWidth()`, `Bun.wrapAnsi()`, `Bun.sliceAnsi()`, `Bun.stripANSI()`) that replace external dependencies for terminal layout.
</spec:context>

<spec:constraints>

- Use @effect/cli for command definition and argument parsing
- Raw ANSI escape codes + Bun built-in string utilities for rendering — no external TUI libraries (no Ink, no blessed)
- External dependency budget: 0-1 packages (picocolors allowed if needed, otherwise raw ANSI)
- Dashboard state is in-memory via `Ref<DashboardState>` — no file-tailing for status
- JSONL logs continue to be written to disk for post-mortem; dashboard does not read them
- Non-TTY fallback: auto-detect, fall back to plain scrolling log lines
- Keyboard interaction: `q` to quit only, no task expansion or navigation
- Glyphs: `·` pending, `›` active, `✓` done, `✗` failed
- Tasks grouped by story with story header showing `Sx title`, tasks showing `Tx` only within groups
- Decorated end states: color-coded footer per StoppedReason (green AllDone, red TaskExhausted, yellow RateLimited/MaxIterations/NoReadyTasks)
- Delete `scripts/bootstrap.ts` after CLI entry is operational
- Follow existing Effect service patterns: Layer, Context.Tag, branded types, discriminated unions

</spec:constraints>

<spec:depth>

## Module: DashboardState

- **Path:** `src/types/Dashboard.d.ts`
- **Interface (entry points, ≤3):** Ambient type declarations — `DashboardState`, `DashboardTaskState`, `DashboardStoryState`, `DashboardTotals`. No callable entry points; consumed by Dashboard service and LoopRunner.
- **Hidden complexity:** None — type-only module. Types are ambient and globally visible.
- **Deletion test:** Every module that reads or writes dashboard state would need inline types.
- **Seam:** `in-process` — ambient declarations, no runtime boundary.
- **Justification:** Shared vocabulary between producer (LoopRunner) and consumer (Dashboard) without coupling them to each other.

## Module: LoopRunner (modification)

- **Path:** `src/services/LoopRunner/`
- **Interface (entry points, ≤3):** `run(contractPath, dashboardRef) → Effect<LoopSummary>` (modified signature — adds dashboardRef parameter).
- **Hidden complexity:** All existing loop orchestration (scheduling, dependency resolution, retry policy, git commit, eval archiving) plus new Ref updates at each state transition.
- **Deletion test:** No other module can orchestrate the Composer-Reviewer loop.
- **Seam:** `in-process`.
- **Justification:** Adding Ref updates at natural transition points (task start, phase change, cost accumulation, completion, terminal state) is a small incremental cost inside an already-deep module. The dashboard never needs to know about loop internals.

## Module: Dashboard renderFrame

- **Path:** `src/services/Dashboard/renderFrame.ts`
- **Interface (entry points, ≤3):** `renderFrame(state: DashboardState, columns: number) → string`.
- **Hidden complexity:** Grouped story/task layout, glyph mapping, column alignment with Bun.stringWidth, cost/duration formatting, footer composition, decorated end-state coloring, terminal-width truncation.
- **Deletion test:** Dashboard service would need to inline all rendering logic.
- **Seam:** `in-process` — pure function, no side effects.
- **Justification:** Pure render function isolates layout decisions from I/O concerns. Testable with fixture state without touching the terminal.

## Module: Dashboard service

- **Path:** `src/services/Dashboard/Dashboard.ts`
- **Interface (entry points, ≤3):** `run(ref: Ref<DashboardState>) → Effect<void>`.
- **Hidden complexity:** TTY detection, ANSI cursor management (home, clear), refresh scheduling, `q` keypress handling via Terminal.readInput, plain-line fallback for non-TTY, terminal cleanup (show cursor, restore state) on exit/interrupt.
- **Deletion test:** CLI entry would need to inline all terminal I/O and refresh logic.
- **Seam:** `in-process`.
- **Justification:** Single entry point hides all terminal interaction complexity. Callers provide a Ref and get a long-running Effect that handles the rest.

## Module: CLI entry

- **Path:** `src/cli.ts`
- **Interface (entry points, ≤3):** `main` — the bin entry point invoked by `tap run <feature>`.
- **Hidden complexity:** @effect/cli command definition, argument parsing, Effect layer composition, Ref creation, concurrent fiber forking (loop + dashboard), graceful shutdown on loop completion or `q` press.
- **Seam:** `in-process` — process entry point.
- **Justification:** Thin orchestrator that wires the service graph and manages the two-fiber lifecycle. Replaces bootstrap.ts with a proper CLI surface.

</spec:depth>

<spec:shape>

```
CLI (src/cli.ts)
  ├─ parse "tap run <feature>" via @effect/cli
  ├─ create Ref<DashboardState> (initial state from contract)
  ├─ fork: LoopRunner.run(contractPath, ref)
  │    ├─ load contract → populate ref with stories/tasks
  │    ├─ for each iteration:
  │    │    ├─ ref.update(task → in_progress, phase → Composer)
  │    │    ├─ run Composer → ref.update(cost, tokens)
  │    │    ├─ ref.update(phase → Reviewer)
  │    │    ├─ run Reviewer → ref.update(cost, tokens)
  │    │    └─ ref.update(task → done|failed, phase → none)
  │    └─ ref.update(stoppedReason → Some(...))
  └─ fork: Dashboard.run(ref)
       ├─ detect TTY
       ├─ if TTY: loop on schedule
       │    ├─ read ref
       │    ├─ renderFrame(state, columns) → string
       │    └─ write frame to terminal (cursor home + clear + write)
       ├─ if non-TTY: on ref changes, print plain log lines
       └─ listen for 'q' keypress → interrupt loop fiber
```

</spec:shape>

<spec:failure_modes>

- **Non-TTY stdout:** Auto-detected via `Terminal.isTTY`. Falls back to plain scrolling lines — no ANSI escape codes emitted.
- **Terminal too narrow:** `renderFrame` truncates lines to `columns` width using `Bun.sliceAnsi()`. Layout degrades gracefully — costs/durations may be cut, but task status and glyphs remain visible.
- **Rate limited mid-run:** LoopRunner sets `stoppedReason` to `RateLimited` on the ref. Dashboard renders final frame with yellow footer showing reset time.
- **User presses `q`:** Dashboard fiber interrupts the loop fiber. LoopRunner's existing cleanup runs (contract saved to disk with current state). Terminal restored (cursor shown).
- **Feature slug not found:** @effect/cli arg parsing fails with a clear error before any fibers are forked. No dashboard rendered.
- **Contract invalid:** Existing FeatureContract validation errors surface before dashboard starts. Plain error output.

</spec:failure_modes>

<spec:open_questions>

- Refresh rate for dashboard (100ms? 200ms? 500ms?) — deferred to implementation. Start with 200ms, adjust if flicker or CPU usage is noticeable.
- Whether to use picocolors or raw ANSI for colors — deferred to Composer judgment. Either works; raw ANSI avoids the dependency.
- Plain-line fallback format for non-TTY — deferred. Simple `[taskId] status — title` lines are sufficient.

</spec:open_questions>
