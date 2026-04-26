import { describe, test, expect } from "bun:test";
import { Option } from "effect";
import { brand } from "../../brand";
import { renderFrame } from "../renderFrame";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const taskId = (s: string) => brand<"TaskId">(s);
const storyId = (s: string) => brand<"StoryId">(s);

function makeTask(
  id: string,
  status: TaskStatus,
  opts: Partial<Omit<DashboardTaskState, "taskId" | "status">> = {},
): DashboardTaskState {
  return {
    taskId: taskId(id),
    title: opts.title ?? `Task ${id}`,
    status,
    phase: opts.phase ?? Option.none(),
    attempt: opts.attempt ?? 1,
    tokensUsed: opts.tokensUsed ?? 0,
    costUsd: opts.costUsd ?? 0,
    startedAt: opts.startedAt ?? Option.none(),
    durationMs: opts.durationMs ?? Option.none(),
  };
}

function makeStory(
  id: string,
  tasks: DashboardTaskState[],
  title = `Story ${id}`,
): DashboardStoryState {
  return { storyId: storyId(id), title, tasks };
}

function makeState(
  stories: DashboardStoryState[],
  stoppedReason: Option.Option<StoppedReason> = Option.none(),
): DashboardState {
  const allTasks = stories.flatMap((s) => s.tasks);
  const tasksDone = allTasks.filter((t) => t.status === "done").length;
  const tasksFailed = allTasks.filter((t) => t.status === "failed").length;
  const tasksPending = allTasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;
  const tokensUsed = allTasks.reduce((acc, t) => acc + t.tokensUsed, 0);
  const costUsd = allTasks.reduce((acc, t) => acc + t.costUsd, 0);

  return {
    feature: "my-feature",
    stories,
    totals: { tokensUsed, costUsd, tasksDone, tasksFailed, tasksPending },
    stoppedReason,
    startedAt: Date.now() - 5_000, // 5 seconds ago — makes elapsed deterministic enough
  };
}

// Strip ANSI escape codes for plain-text assertions.
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// All-pending state
// ---------------------------------------------------------------------------

describe("all-pending state", () => {
  test("renders · glyph for every pending task", () => {
    const state = makeState([
      makeStory("S1", [
        makeTask("T1", "pending"),
        makeTask("T2", "pending"),
      ]),
    ]);
    const frame = renderFrame(state, 80);
    const lines = frame.split("\n");
    const taskLines = lines.filter((l) => strip(l).includes("T1") || strip(l).includes("T2"));
    expect(taskLines.length).toBe(2);
    for (const line of taskLines) {
      expect(strip(line)).toContain("·");
    }
  });

  test("task row does not show $0.00 when costUsd is 0", () => {
    const state = makeState([
      makeStory("S1", [makeTask("T1", "pending", { costUsd: 0 })]),
    ]);
    const frame = renderFrame(state, 80);
    const lines = frame.split("\n");
    // Task row should use blank padding, not "$0.00"
    const taskLine = lines.find((l) => strip(l).includes("T1"))!;
    expect(strip(taskLine)).not.toContain("$0.00");
  });

  test("contains feature name in header", () => {
    const state = makeState([makeStory("S1", [makeTask("T1", "pending")])]);
    const frame = renderFrame(state, 80);
    expect(strip(frame)).toContain("my-feature");
  });

  test("contains story header", () => {
    const state = makeState([makeStory("S1", [makeTask("T1", "pending")])]);
    const frame = renderFrame(state, 80);
    expect(strip(frame)).toContain("S1");
    expect(strip(frame)).toContain("Story S1");
  });

  test("no end-state line when stoppedReason is None", () => {
    const state = makeState([makeStory("S1", [makeTask("T1", "pending")])]);
    const frame = renderFrame(state, 80);
    const stripped = strip(frame);
    // None of the terminal markers should appear
    expect(stripped).not.toContain("AllDone");
    expect(stripped).not.toContain("TaskExhausted");
    expect(stripped).not.toContain("RateLimited");
  });
});

// ---------------------------------------------------------------------------
// Mixed statuses
// ---------------------------------------------------------------------------

describe("mixed statuses", () => {
  test("correct glyphs for each status", () => {
    const state = makeState([
      makeStory("S1", [
        makeTask("T1", "pending"),
        makeTask("T2", "in_progress", {
          phase: Option.some<AgentRole>("Composer"),
        }),
        makeTask("T3", "done", {
          costUsd: 0.05,
          durationMs: Option.some(12_000),
        }),
        makeTask("T4", "failed"),
      ]),
    ]);
    const frame = renderFrame(state, 80);
    const lines = frame.split("\n");

    const t1 = lines.find((l) => strip(l).includes("T1"))!;
    const t2 = lines.find((l) => strip(l).includes("T2"))!;
    const t3 = lines.find((l) => strip(l).includes("T3"))!;
    const t4 = lines.find((l) => strip(l).includes("T4"))!;

    expect(strip(t1)).toContain("·");
    expect(strip(t2)).toContain("›");
    expect(strip(t3)).toContain("✓");
    expect(strip(t4)).toContain("✗");
  });

  test("active task shows phase label", () => {
    const state = makeState([
      makeStory("S1", [
        makeTask("T1", "in_progress", {
          phase: Option.some<AgentRole>("Reviewer"),
        }),
      ]),
    ]);
    const frame = renderFrame(state, 80);
    const stripped = strip(frame);
    expect(stripped).toContain("Reviewer");
  });

  test("done task shows cost and duration", () => {
    const state = makeState([
      makeStory("S1", [
        makeTask("T1", "done", {
          costUsd: 0.12,
          durationMs: Option.some(75_000), // 1m15s
        }),
      ]),
    ]);
    const frame = renderFrame(state, 80);
    const stripped = strip(frame);
    expect(stripped).toContain("$0.12");
    expect(stripped).toContain("1m15s");
  });

  test("pending task shows -- for duration", () => {
    const state = makeState([
      makeStory("S1", [makeTask("T1", "pending", { durationMs: Option.none() })]),
    ]);
    const frame = renderFrame(state, 80);
    const stripped = strip(frame);
    expect(stripped).toContain("--");
  });

  test("totals footer shows aggregated token count", () => {
    const state = makeState([
      makeStory("S1", [
        makeTask("T1", "done", { tokensUsed: 500, costUsd: 0.01 }),
        makeTask("T2", "done", { tokensUsed: 300, costUsd: 0.02 }),
      ]),
    ]);
    const frame = renderFrame(state, 80);
    const stripped = strip(frame);
    expect(stripped).toContain("800");
  });

  test("multiple stories render in order", () => {
    const state = makeState([
      makeStory("S1", [makeTask("T1", "done")]),
      makeStory("S2", [makeTask("T2", "pending")]),
    ]);
    const frame = renderFrame(state, 80);
    const s1Idx = strip(frame).indexOf("S1");
    const s2Idx = strip(frame).indexOf("S2");
    expect(s1Idx).toBeGreaterThanOrEqual(0);
    expect(s2Idx).toBeGreaterThanOrEqual(0);
    expect(s1Idx).toBeLessThan(s2Idx);
  });
});

// ---------------------------------------------------------------------------
// End states — colors
// ---------------------------------------------------------------------------

describe("decorated end states", () => {
  test("AllDone: frame contains green ANSI code", () => {
    const state = makeState(
      [makeStory("S1", [makeTask("T1", "done")])],
      Option.some<StoppedReason>({ _tag: "AllDone" }),
    );
    const frame = renderFrame(state, 80);
    // Green ANSI: \x1b[32m
    expect(frame).toContain("\x1b[32m");
    expect(strip(frame)).toContain("AllDone");
  });

  test("TaskExhausted: frame contains red ANSI code", () => {
    const state = makeState(
      [makeStory("S1", [makeTask("T1", "failed")])],
      Option.some<StoppedReason>({
        _tag: "TaskExhausted",
        failedTaskIds: [taskId("T1")],
      }),
    );
    const frame = renderFrame(state, 80);
    // Red ANSI: \x1b[31m
    expect(frame).toContain("\x1b[31m");
    expect(strip(frame)).toContain("TaskExhausted");
  });

  test("RateLimited: frame contains yellow ANSI code", () => {
    const state = makeState(
      [makeStory("S1", [makeTask("T1", "pending")])],
      Option.some<StoppedReason>({
        _tag: "RateLimited",
        role: "Composer",
        resetsAt: Date.now() + 60_000,
      }),
    );
    const frame = renderFrame(state, 80);
    // Yellow ANSI: \x1b[33m
    expect(frame).toContain("\x1b[33m");
    expect(strip(frame)).toContain("RateLimited");
  });

  test("MaxIterations: frame contains yellow ANSI code", () => {
    const state = makeState(
      [makeStory("S1", [makeTask("T1", "pending")])],
      Option.some<StoppedReason>({ _tag: "MaxIterations", cap: 50 }),
    );
    const frame = renderFrame(state, 80);
    expect(frame).toContain("\x1b[33m");
    expect(strip(frame)).toContain("MaxIterations");
  });

  test("NoReadyTasks: frame contains yellow ANSI code", () => {
    const state = makeState(
      [makeStory("S1", [makeTask("T1", "pending")])],
      Option.some<StoppedReason>({
        _tag: "NoReadyTasks",
        remaining: [taskId("T1")],
      }),
    );
    const frame = renderFrame(state, 80);
    expect(frame).toContain("\x1b[33m");
    expect(strip(frame)).toContain("NoReadyTasks");
  });
});

// ---------------------------------------------------------------------------
// Narrow terminal truncation
// ---------------------------------------------------------------------------

describe("narrow terminal truncation", () => {
  test("each line visible width does not exceed columns", () => {
    const state = makeState([
      makeStory("S1", [
        makeTask("T1", "in_progress", {
          title: "A very long task title that should be truncated on narrow terminals",
          phase: Option.some<AgentRole>("Composer"),
          costUsd: 1.23,
          durationMs: Option.some(99_000),
        }),
      ]),
    ]);
    const narrow = 40;
    const frame = renderFrame(state, narrow);
    const lines = frame.split("\n");
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(narrow);
    }
  });

  test("very narrow (20 cols) does not throw and yields lines", () => {
    const state = makeState([
      makeStory("S1", [makeTask("T1", "done", { costUsd: 0.5, durationMs: Option.some(3_000) })]),
    ]);
    expect(() => renderFrame(state, 20)).not.toThrow();
    const frame = renderFrame(state, 20);
    expect(frame.length).toBeGreaterThan(0);
  });

  test("wide terminal (200 cols) does not corrupt output", () => {
    const state = makeState([
      makeStory("S1", [makeTask("T1", "done", { costUsd: 0.01, durationMs: Option.some(1_000) })]),
    ]);
    const frame = renderFrame(state, 200);
    const stripped = strip(frame);
    expect(stripped).toContain("✓");
    expect(stripped).toContain("$0.01");
  });
});
