import { Effect } from "effect";
import { LoopRunnerLive } from "./services/LoopRunner";


Effect.runPromise(LoopRunnerLive).then(console.log)