import type { Option } from "effect";

declare global {
  interface DashboardTaskState {
    readonly taskId: TaskId;
    readonly title: string;
    readonly status: TaskStatus;
    /** Which agent phase is currently running; None when task is pending or complete. */
    readonly phase: Option.Option<AgentRole>;
    readonly attempt: number;
    readonly tokensUsed: number;
    readonly costUsd: number;
    readonly startedAt: Option.Option<number>;
    readonly durationMs: Option.Option<number>;
  }

  interface DashboardStoryState {
    readonly storyId: StoryId;
    readonly title: string;
    readonly tasks: ReadonlyArray<DashboardTaskState>;
  }

  interface DashboardTotals {
    readonly tokensUsed: number;
    readonly costUsd: number;
    readonly tasksDone: number;
    readonly tasksFailed: number;
    readonly tasksPending: number;
  }

  interface DashboardState {
    readonly feature: string;
    readonly stories: ReadonlyArray<DashboardStoryState>;
    readonly totals: DashboardTotals;
    /** None while loop is running; Some<StoppedReason> when the loop has terminated. */
    readonly stoppedReason: Option.Option<StoppedReason>;
    readonly startedAt: number;
  }
}
