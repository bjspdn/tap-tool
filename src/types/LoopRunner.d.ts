import type { Effect } from "effect";

declare global {
  interface LoopOptions {
    readonly onIterationStart?: (i: number) => Effect.Effect<void>;
    // TODO: placeholder — AgentResult dropped in S1.T2; LoopRunner will be redesigned in a later S-series.
    readonly onIterationEnd?: (i: number, r: unknown) => Effect.Effect<void>;
  }

  interface LoopSummary {
    readonly feature: string;
    readonly iterations: number;
    readonly completed: boolean;
    readonly stoppedReason: string;
  }
}
