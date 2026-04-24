import type { Effect } from "effect";

declare global {
  interface LoopOptions {
    readonly onIterationStart?: (i: number) => Effect.Effect<void>;
    // TODO: placeholder — AgentResult dropped in S1.T2; LoopRunner will be redesigned in a later S-series.
    readonly onIterationEnd?: (i: number, r: unknown) => Effect.Effect<void>;
  }

  type StoppedReason =
    | { _tag: "AllDone" }
    | { _tag: "TaskExhausted"; failedTaskIds: ReadonlyArray<TaskId> }
    | { _tag: "MaxIterations"; cap: number }
    | { _tag: "NoReadyTasks"; remaining: ReadonlyArray<TaskId> }
    | { _tag: "RateLimited"; role: AgentRole; resetsAt: number };

  interface LoopSummary {
    readonly feature: string;
    readonly iterations: number;
    readonly completed: boolean;
    readonly stoppedReason: StoppedReason;
    readonly tasksDone: ReadonlyArray<TaskId>;
    readonly tasksFailed: ReadonlyArray<TaskId>;
    readonly tasksPending: ReadonlyArray<TaskId>;
  }
}
