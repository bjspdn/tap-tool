import { describe, test, expect } from "bun:test";
import { Either } from "effect";
import { brand } from "../../brand";
import {
  decideIteration,
  decideTerminal,
  buildLoopSummary,
} from "../iterationPolicy";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const taskId = (s: string) => brand<"TaskId">(s);
const storyId = (s: string) => brand<"StoryId">(s);
const absPath = (s: string) => brand<"AbsolutePath">(s);

const makeTask = (
  id: string,
  status: TaskStatus,
  attempts = 0,
  maxAttempts = 3,
): Task => ({
  id: taskId(id),
  title: `Task ${id}`,
  description: `Description for ${id}`,
  files: [],
  depends_on: [],
  status,
  attempts,
  maxAttempts,
});

const makeFeature = (tasks: Task[]): Feature => ({
  feature: "test-feature",
  goal: "test goal",
  description: "test feature description",
  constraints: [],
  stories: [
    {
      id: storyId("S1"),
      title: "Story 1",
      description: "story description",
      tasks,
    },
  ],
});

const makeTaskResult = (verdict: "PASS" | "FAIL"): TaskResult => ({
  taskId: taskId("T1"),
  attempt: 1,
  verdict,
  summary: "summary",
  comments: [],
  composerLogPath: absPath("/tmp/composer.log"),
  reviewerLogPath: absPath("/tmp/reviewer.log"),
  evalResultPath: absPath("/tmp/EVAL_RESULT.md"),
  durationMs: 100,
});

const rateLimitedError: RunTaskError = {
  _tag: "RateLimited",
  role: "Composer",
  resetsAt: 9999,
};

const agentMaxTurnsError: RunTaskError = {
  _tag: "AgentMaxTurnsExceeded",
  role: "Reviewer",
};

const evalParseFailedError: RunTaskError = {
  _tag: "EvalParseFailed",
  reason: "bad parse",
  rawContent: "raw",
};

// ---------------------------------------------------------------------------
// decideIteration
// ---------------------------------------------------------------------------

describe("decideIteration", () => {
  test("Right + verdict=PASS, attempt < max → Pass", () => {
    const result = decideIteration(1, 3, Either.right(makeTaskResult("PASS")));
    expect(result._tag).toBe("Pass");
  });

  test("Right + verdict=PASS, attempt === max → Pass (PASS always wins)", () => {
    const result = decideIteration(3, 3, Either.right(makeTaskResult("PASS")));
    expect(result._tag).toBe("Pass");
  });

  test("Right + verdict=FAIL, attempt < max → Retry", () => {
    const result = decideIteration(1, 3, Either.right(makeTaskResult("FAIL")));
    expect(result._tag).toBe("Retry");
  });

  test("Right + verdict=FAIL, attempt === max → Exhausted", () => {
    const result = decideIteration(3, 3, Either.right(makeTaskResult("FAIL")));
    expect(result._tag).toBe("Exhausted");
  });

  test("Left + AgentMaxTurnsExceeded, attempt < max → Retry", () => {
    const result = decideIteration(1, 3, Either.left(agentMaxTurnsError));
    expect(result._tag).toBe("Retry");
  });

  test("Left + EvalParseFailed, attempt < max → Retry", () => {
    const result = decideIteration(2, 3, Either.left(evalParseFailedError));
    expect(result._tag).toBe("Retry");
  });

  test("Left + AgentMaxTurnsExceeded, attempt === max → Exhausted", () => {
    const result = decideIteration(3, 3, Either.left(agentMaxTurnsError));
    expect(result._tag).toBe("Exhausted");
  });

  test("Left + EvalParseFailed, attempt === max → Exhausted", () => {
    const result = decideIteration(3, 3, Either.left(evalParseFailedError));
    expect(result._tag).toBe("Exhausted");
  });

  test("Left + RateLimited, attempt < max → RateLimited (carries role and resetsAt)", () => {
    const result = decideIteration(1, 3, Either.left(rateLimitedError));
    expect(result._tag).toBe("RateLimited");
    if (result._tag === "RateLimited") {
      expect(result.role).toBe("Composer");
      expect(result.resetsAt).toBe(9999);
    }
  });

  test("Left + RateLimited, attempt === max → RateLimited (takes priority over exhaustion)", () => {
    const result = decideIteration(3, 3, Either.left(rateLimitedError));
    expect(result._tag).toBe("RateLimited");
    if (result._tag === "RateLimited") {
      expect(result.role).toBe("Composer");
      expect(result.resetsAt).toBe(9999);
    }
  });

  test("maxAttempts=1, FAIL on first run → Exhausted", () => {
    const result = decideIteration(1, 1, Either.right(makeTaskResult("FAIL")));
    expect(result._tag).toBe("Exhausted");
  });
});

// ---------------------------------------------------------------------------
// decideTerminal
// ---------------------------------------------------------------------------

describe("decideTerminal", () => {
  test("all tasks done → AllDone", () => {
    const feature = makeFeature([
      makeTask("T1", "done"),
      makeTask("T2", "done"),
    ]);
    const result = decideTerminal(feature);
    expect(result._tag).toBe("AllDone");
  });

  test("mix of done + pending → NoReadyTasks with pending ids", () => {
    const feature = makeFeature([
      makeTask("T1", "done"),
      makeTask("T2", "pending"),
      makeTask("T3", "done"),
    ]);
    const result = decideTerminal(feature);
    expect(result._tag).toBe("NoReadyTasks");
    if (result._tag === "NoReadyTasks") {
      expect(result.remaining).toContain(taskId("T2"));
      expect(result.remaining).not.toContain(taskId("T1"));
      expect(result.remaining).not.toContain(taskId("T3"));
    }
  });

  test("all tasks failed → AllDone (failed is not pending/in_progress, so remaining=[])", () => {
    // This matches the original LoopRunnerLive logic: remaining filters for
    // pending|in_progress only. All-failed leaves remaining empty → AllDone.
    const feature = makeFeature([
      makeTask("T1", "failed"),
      makeTask("T2", "failed"),
    ]);
    const result = decideTerminal(feature);
    expect(result._tag).toBe("AllDone");
  });

  test("in_progress task counts as remaining → NoReadyTasks", () => {
    const feature = makeFeature([
      makeTask("T1", "done"),
      makeTask("T2", "in_progress"),
    ]);
    const result = decideTerminal(feature);
    expect(result._tag).toBe("NoReadyTasks");
    if (result._tag === "NoReadyTasks") {
      expect(result.remaining).toContain(taskId("T2"));
    }
  });

  test("mix of done + failed + in_progress → NoReadyTasks with only in_progress id", () => {
    const feature = makeFeature([
      makeTask("T1", "done"),
      makeTask("T2", "failed"),
      makeTask("T3", "in_progress"),
    ]);
    const result = decideTerminal(feature);
    expect(result._tag).toBe("NoReadyTasks");
    if (result._tag === "NoReadyTasks") {
      expect(result.remaining).toEqual([taskId("T3")]);
    }
  });
});

// ---------------------------------------------------------------------------
// buildLoopSummary
// ---------------------------------------------------------------------------

describe("buildLoopSummary", () => {
  test("mixed statuses → correct tasksDone, tasksFailed, tasksPending arrays", () => {
    const feature = makeFeature([
      makeTask("T1", "done"),
      makeTask("T2", "failed"),
      makeTask("T3", "pending"),
      makeTask("T4", "in_progress"),
      makeTask("T5", "done"),
    ]);
    const stoppedReason: StoppedReason = { _tag: "NoReadyTasks", remaining: [taskId("T3"), taskId("T4")] };

    const summary = buildLoopSummary(feature, 5, stoppedReason);

    expect(summary.tasksDone).toEqual([taskId("T1"), taskId("T5")]);
    expect(summary.tasksFailed).toEqual([taskId("T2")]);
    expect(summary.tasksPending).toEqual([taskId("T3"), taskId("T4")]);
  });

  test("completed=true iff stoppedReason._tag === 'AllDone'", () => {
    const feature = makeFeature([makeTask("T1", "done")]);

    const allDoneSummary = buildLoopSummary(feature, 1, { _tag: "AllDone" });
    expect(allDoneSummary.completed).toBe(true);

    const exhaustedSummary = buildLoopSummary(feature, 1, {
      _tag: "TaskExhausted",
      failedTaskIds: [taskId("T1")],
    });
    expect(exhaustedSummary.completed).toBe(false);

    const maxIterSummary = buildLoopSummary(feature, 50, { _tag: "MaxIterations", cap: 50 });
    expect(maxIterSummary.completed).toBe(false);

    const noReadySummary = buildLoopSummary(feature, 3, {
      _tag: "NoReadyTasks",
      remaining: [],
    });
    expect(noReadySummary.completed).toBe(false);
  });

  test("iterations passes through to summary", () => {
    const feature = makeFeature([makeTask("T1", "done")]);
    const summary = buildLoopSummary(feature, 42, { _tag: "AllDone" });
    expect(summary.iterations).toBe(42);
  });

  test("feature name passes through to summary", () => {
    const feature = makeFeature([makeTask("T1", "done")]);
    const summary = buildLoopSummary(feature, 1, { _tag: "AllDone" });
    expect(summary.feature).toBe("test-feature");
  });

  test("stoppedReason is preserved on the summary", () => {
    const feature = makeFeature([makeTask("T1", "done")]);
    const reason: StoppedReason = { _tag: "RateLimited", role: "Reviewer", resetsAt: 12345 };
    const summary = buildLoopSummary(feature, 2, reason);
    expect(summary.stoppedReason).toEqual(reason);
    expect(summary.completed).toBe(false);
  });

  test("all done feature → empty failed and pending arrays", () => {
    const feature = makeFeature([
      makeTask("T1", "done"),
      makeTask("T2", "done"),
    ]);
    const summary = buildLoopSummary(feature, 2, { _tag: "AllDone" });
    expect(summary.tasksFailed).toEqual([]);
    expect(summary.tasksPending).toEqual([]);
    expect(summary.tasksDone).toEqual([taskId("T1"), taskId("T2")]);
  });
});
