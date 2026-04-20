import { Context, Effect, Layer } from "effect";
import type { LoopOptions, LoopSummary } from "../types/loop-runner";

export class LoopRunner extends Context.Tag("LoopRunner")<LoopRunner, {
    readonly run: (loopOptions: LoopOptions) => Effect.Effect<LoopSummary>
}>() {}

export const LoopRunnerLive = Effect.gen(function* () {
    return "test"
})