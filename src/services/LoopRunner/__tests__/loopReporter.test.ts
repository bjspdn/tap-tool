import { describe, test, expect } from "bun:test";
import { Either } from "effect";
import { brand } from "../../brand";
import { formatResumeHint, formatIterationFailure } from "../loopReporter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTask = (
  id: string,
  status: TaskStatus = "pending",
  maxAttempts = 3,
): Task => ({
  id: brand<"TaskId">(id),
  title: `Task ${id}`,
  description: `Description for ${id}`,
  files: [],
  depends_on: [],
  status,
  attempts: 0,
  maxAttempts,
});

const makeSummary = (
  overrides: Partial<LoopSummary> = {},
): LoopSummary => ({
  feature: "my-feature",
  iterations: 1,
  completed: false,
  stoppedReason: { _tag: "TaskExhausted", failedTaskIds: [brand<"TaskId">("T1")] },
  tasksDone: [],
  tasksFailed: [brand<"TaskId">("T1")],
  tasksPending: [],
  ...overrides,
});

const makePassResult = (taskId = "T1"): TaskResult => ({
  taskId: brand<"TaskId">(taskId),
  attempt: 1,
  verdict: "PASS",
  summary: "looks good",
  comments: [],
  composerLogPath: brand<"AbsolutePath">("/fake/composer.jsonl"),
  reviewerLogPath: brand<"AbsolutePath">("/fake/reviewer.jsonl"),
  evalResultPath: brand<"AbsolutePath">("/fake/EVAL_RESULT.md"),
  durationMs: 0,
});

const makeFailResult = (taskId = "T1"): TaskResult => ({
  ...makePassResult(taskId),
  verdict: "FAIL",
  summary: "not passing",
  comments: [
    {
      file: "src/foo.ts",
      line: 10,
      severity: "blocker",
      comment: "bad",
    },
    {
      file: "src/bar.ts",
      line: null,
      severity: "suggestion",
      comment: "maybe fix",
    },
  ],
});

// ---------------------------------------------------------------------------
// formatResumeHint
// ---------------------------------------------------------------------------

describe("formatResumeHint", () => {
  test("contains feature name in halted line", () => {
    const task = makeTask("T1", "failed");
    const summary = makeSummary({ feature: "alpha" });
    const output = formatResumeHint(summary, [task]);
    expect(output).toContain('feature "alpha" halted');
  });

  test("contains 'To resume:'", () => {
    const task = makeTask("T1", "failed");
    const summary = makeSummary();
    const output = formatResumeHint(summary, [task]);
    expect(output).toContain("To resume:");
  });

  test("contains failed task id and title formatted as bullet", () => {
    const task = makeTask("T1", "failed");
    const summary = makeSummary();
    const output = formatResumeHint(summary, [task]);
    expect(output).toContain(`· T1  "Task T1"`);
  });

  test("contains 'status' and 'attempts' (fixture 6 compatibility)", () => {
    const task = makeTask("T1", "failed");
    const summary = makeSummary();
    const output = formatResumeHint(summary, [task]);
    expect(output).toContain("status");
    expect(output).toContain("attempts");
  });

  test("singular: '1 task failed'", () => {
    const task = makeTask("T1", "failed");
    const summary = makeSummary({
      tasksFailed: [brand<"TaskId">("T1")],
    });
    const output = formatResumeHint(summary, [task]);
    expect(output).toContain("1 task failed");
    expect(output).not.toContain("1 tasks failed");
  });

  test("plural: '2 tasks failed'", () => {
    const t1 = makeTask("T1", "failed");
    const t2 = makeTask("T2", "failed");
    const summary = makeSummary({
      tasksFailed: [brand<"TaskId">("T1"), brand<"TaskId">("T2")],
      stoppedReason: {
        _tag: "TaskExhausted",
        failedTaskIds: [brand<"TaskId">("T1"), brand<"TaskId">("T2")],
      },
    });
    const output = formatResumeHint(summary, [t1, t2]);
    expect(output).toContain("2 tasks failed");
  });

  test("done and pending counts appear in header", () => {
    const t1 = makeTask("T1", "failed");
    const summary = makeSummary({
      tasksDone: [brand<"TaskId">("T2"), brand<"TaskId">("T3")],
      tasksPending: [brand<"TaskId">("T4")],
    });
    const output = formatResumeHint(summary, [t1]);
    expect(output).toContain("2 done");
    expect(output).toContain("1 pending");
  });

  test("multi-task: both failed tasks appear as bullets", () => {
    const t1 = makeTask("T1", "failed");
    const t2 = makeTask("T2", "failed");
    const summary = makeSummary({
      tasksFailed: [brand<"TaskId">("T1"), brand<"TaskId">("T2")],
      stoppedReason: {
        _tag: "TaskExhausted",
        failedTaskIds: [brand<"TaskId">("T1"), brand<"TaskId">("T2")],
      },
    });
    const output = formatResumeHint(summary, [t1, t2]);
    expect(output).toContain(`· T1  "Task T1"`);
    expect(output).toContain(`· T2  "Task T2"`);
  });

  test("non-failed tasks in allTasks are not listed as bullets", () => {
    const failed = makeTask("T1", "failed");
    const done = makeTask("T2", "done");
    const summary = makeSummary({
      tasksFailed: [brand<"TaskId">("T1")],
      tasksDone: [brand<"TaskId">("T2")],
    });
    const output = formatResumeHint(summary, [failed, done]);
    expect(output).not.toContain(`· T2`);
  });
});

// ---------------------------------------------------------------------------
// formatIterationFailure
// ---------------------------------------------------------------------------

describe("formatIterationFailure", () => {
  test("Right + PASS → empty string", () => {
    const task = makeTask("T1");
    const outcome = Either.right(makePassResult("T1")) as Either.Either<TaskResult, RunTaskError>;
    const result = formatIterationFailure(1, task, 1, outcome);
    expect(result).toBe("");
  });

  test("Right + FAIL → contains verdict=FAIL, summary:, comments:, iteration, attempt/max, task id", () => {
    const task = makeTask("T1", "pending", 3);
    const outcome = Either.right(makeFailResult("T1")) as Either.Either<TaskResult, RunTaskError>;
    const result = formatIterationFailure(2, task, 2, outcome);
    expect(result).toContain("verdict=FAIL");
    expect(result).toContain("summary:");
    expect(result).toContain("comments:");
    expect(result).toContain("iter 2");
    expect(result).toContain("attempt 2/3");
    expect(result).toContain("T1");
  });

  test("Right + FAIL → comments count is the array length", () => {
    const task = makeTask("T1");
    const outcome = Either.right(makeFailResult("T1")) as Either.Either<TaskResult, RunTaskError>;
    const result = formatIterationFailure(1, task, 1, outcome);
    // makeFailResult produces 2 comments
    expect(result).toContain("comments: 2");
  });

  test("Right + FAIL → summary text appears in output", () => {
    const task = makeTask("T1");
    const outcome = Either.right(makeFailResult("T1")) as Either.Either<TaskResult, RunTaskError>;
    const result = formatIterationFailure(1, task, 1, outcome);
    expect(result).toContain("not passing");
  });

  test("Left + AgentMaxTurnsExceeded → contains _tag=AgentMaxTurnsExceeded, iteration, task id, attempt/max", () => {
    const task = makeTask("T1", "pending", 5);
    const error: RunTaskError = { _tag: "AgentMaxTurnsExceeded", role: "Composer" };
    const outcome = Either.left(error) as Either.Either<TaskResult, RunTaskError>;
    const result = formatIterationFailure(3, task, 2, outcome);
    expect(result).toContain("_tag=AgentMaxTurnsExceeded");
    expect(result).toContain("iter 3");
    expect(result).toContain("T1");
    expect(result).toContain("attempt 2/5");
  });

  test("Left with cause longer than 200 chars → cause is truncated to 200 in output", () => {
    const task = makeTask("T1", "pending", 3);
    const longCause = "x".repeat(500);
    const error: RunTaskError = {
      _tag: "FilesystemError",
      path: brand<"AbsolutePath">("/some/path"),
      cause: longCause,
    };
    const outcome = Either.left(error) as Either.Either<TaskResult, RunTaskError>;
    const result = formatIterationFailure(1, task, 1, outcome);
    // The truncated cause should appear in the JSON, not the full 500-char value
    expect(result).toContain("FilesystemError");
    // Ensure the full string does not appear
    expect(result).not.toContain(longCause);
    // The truncated version (200 chars of 'x') should appear
    expect(result).toContain("x".repeat(200));
  });

  test("Left + RateLimited → formats correctly (defensive — driver halts before logging)", () => {
    const task = makeTask("T1", "pending", 3);
    const error: RunTaskError = { _tag: "RateLimited", role: "Reviewer", resetsAt: 9999999 };
    const outcome = Either.left(error) as Either.Either<TaskResult, RunTaskError>;
    const result = formatIterationFailure(1, task, 1, outcome);
    expect(result).toContain("_tag=RateLimited");
    expect(result).toContain("T1");
    expect(result).toContain("attempt 1/3");
  });

  test("Left error tag appears prefixed with _tag= in output", () => {
    const task = makeTask("T1", "pending", 2);
    const error: RunTaskError = {
      _tag: "AgentSpawnFailed",
      role: "Composer",
      exitCode: 1,
      stderr: "some error output",
    };
    const outcome = Either.left(error) as Either.Either<TaskResult, RunTaskError>;
    const result = formatIterationFailure(4, task, 1, outcome);
    expect(result).toContain("_tag=AgentSpawnFailed");
    expect(result).toContain("failed:");
  });

  test("Left output contains full JSON of safe error object", () => {
    const task = makeTask("T1", "pending", 3);
    const error: RunTaskError = {
      _tag: "EvalParseFailed",
      reason: "invalid json",
      rawContent: "bad content",
    };
    const outcome = Either.left(error) as Either.Either<TaskResult, RunTaskError>;
    const result = formatIterationFailure(1, task, 1, outcome);
    expect(result).toContain("invalid json");
    expect(result).toContain("bad content");
  });
});
