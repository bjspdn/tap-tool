import type { Effect } from "effect";

interface LoopOptions {
  readonly onIterationStart?: (i: number) => Effect.Effect<void>
  readonly onIterationEnd?: (i: number, r: AgentResult) => Effect.Effect<void>
}

interface LoopSummary {
  readonly feature: string
  readonly iterations: number
  readonly completed: boolean
  readonly stoppedReason: string
}