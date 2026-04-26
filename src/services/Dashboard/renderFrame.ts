import { Option } from "effect";

// ---------------------------------------------------------------------------
// ANSI constants
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const GLYPH: Record<TaskStatus, string> = {
  pending: "·",
  in_progress: "›",
  done: "✓",
  failed: "✗",
};

function glyphAnsi(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return `${DIM}${GLYPH.pending}${RESET}`;
    case "in_progress":
      return `${CYAN}${GLYPH.in_progress}${RESET}`;
    case "done":
      return `${GREEN}${GLYPH.done}${RESET}`;
    case "failed":
      return `${RED}${GLYPH.failed}${RESET}`;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function renderTaskRow(task: DashboardTaskState, columns: number): string {
  const glyph = glyphAnsi(task.status);
  const phaseStr = Option.isSome(task.phase)
    ? ` ${DIM}(${task.phase.value})${RESET}`
    : "";
  const left = `  ${glyph} ${task.taskId}  ${task.title}${phaseStr}`;

  const costPart =
    task.costUsd > 0 ? formatCost(task.costUsd) : "     ";
  const durPart = Option.isSome(task.durationMs)
    ? formatDuration(task.durationMs.value)
    : "--";
  const right = `${costPart}  ${durPart}`;

  const rightWidth = Bun.stringWidth(right);
  // 1 space gap between left and right
  const availableLeft = Math.max(1, columns - rightWidth - 1);
  const leftWidth = Bun.stringWidth(left);

  let leftStr: string;
  if (leftWidth > availableLeft) {
    leftStr = Bun.sliceAnsi(left, 0, availableLeft);
  } else {
    leftStr = left + " ".repeat(availableLeft - leftWidth);
  }

  return `${leftStr} ${right}`;
}

function renderStoryHeader(story: DashboardStoryState, columns: number): string {
  const header = `${BOLD}${story.storyId}  ${story.title}${RESET}`;
  return Bun.sliceAnsi(header, 0, columns);
}

function renderSeparator(columns: number): string {
  return DIM + "─".repeat(Math.max(1, columns)) + RESET;
}

function renderTotalsFooter(state: DashboardState, columns: number): string {
  const { totals } = state;
  const parts: string[] = [
    `${totals.tokensUsed.toLocaleString()} tokens`,
    formatCost(totals.costUsd),
    `${totals.tasksDone}✓`,
  ];
  if (totals.tasksFailed > 0) {
    parts.push(`${RED}${totals.tasksFailed}✗${RESET}`);
  }
  if (totals.tasksPending > 0) {
    parts.push(`${DIM}${totals.tasksPending}·${RESET}`);
  }
  const line = parts.join("  ");
  return Bun.sliceAnsi(line, 0, columns);
}

function renderEndStateFooter(reason: StoppedReason, columns: number): string {
  let color: string;
  let text: string;

  switch (reason._tag) {
    case "AllDone":
      color = GREEN;
      text = `${BOLD}${GREEN}✓ AllDone${RESET}`;
      break;
    case "TaskExhausted":
      color = RED;
      text = `${BOLD}${RED}✗ TaskExhausted (${reason.failedTaskIds.join(", ")})${RESET}`;
      break;
    case "MaxIterations":
      color = YELLOW;
      text = `${BOLD}${YELLOW}⚠ MaxIterations (cap: ${reason.cap})${RESET}`;
      break;
    case "RateLimited": {
      const resetsAt = new Date(reason.resetsAt).toLocaleTimeString();
      text = `${BOLD}${YELLOW}⚠ RateLimited (${reason.role}) — resets at ${resetsAt}${RESET}`;
      break;
    }
    case "NoReadyTasks":
      text = `${BOLD}${YELLOW}⚠ NoReadyTasks (${reason.remaining.length} blocked)${RESET}`;
      break;
    default: {
      // exhaustiveness guard
      const _never: never = reason;
      text = String(_never);
    }
  }

  return Bun.sliceAnsi(text, 0, columns);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render the full dashboard frame as a plain string.
 *
 * Pure function — no I/O. Use `Bun.stringWidth` / `Bun.sliceAnsi` for
 * column-aware layout so multi-byte and ANSI-decorated content never
 * overflows the terminal width.
 *
 * @param state   Current snapshot of dashboard state.
 * @param columns Terminal width in columns (characters).
 * @returns       Complete frame string, lines joined with `\n`.
 */
export function renderFrame(state: DashboardState, columns: number): string {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  const elapsedMs = Date.now() - state.startedAt;
  const elapsed = formatDuration(Math.max(0, elapsedMs));
  const header = `${BOLD}tap run ${state.feature}${RESET}  ${DIM}[${elapsed}]${RESET}`;
  lines.push(Bun.sliceAnsi(header, 0, columns));
  lines.push(renderSeparator(columns));

  // ── Stories & tasks ────────────────────────────────────────────────────────
  for (const story of state.stories) {
    lines.push(renderStoryHeader(story, columns));
    for (const task of story.tasks) {
      lines.push(renderTaskRow(task, columns));
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push(renderSeparator(columns));
  lines.push(renderTotalsFooter(state, columns));

  // ── End-state decoration ───────────────────────────────────────────────────
  if (Option.isSome(state.stoppedReason)) {
    lines.push(renderEndStateFooter(state.stoppedReason.value, columns));
  }

  return lines.join("\n");
}
