import { Context, Effect } from "effect";

export class LoopRunner extends Context.Tag("LoopRunner")<LoopRunner, {
    readonly run: (loopOptions: LoopOptions) => Effect.Effect<LoopSummary>
}>() {}

export const LoopRunnerLive = Effect.gen(function* () {
    return "test"
})