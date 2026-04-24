#!/usr/bin/env bun
/**
 * Entry point until the tap run CLI lands.
 * Composes the full service graph and invokes LoopRunner.run.
 * Usage: bun run scripts/bootstrap.ts <feature-slug>
 */

import { Effect, Layer } from "effect";
import * as path from "node:path";
import { BunContext } from "@effect/platform-bun";
import { ContextEngineLive } from "../src/services/ContextEngine";
import { EvalParserLive } from "../src/services/EvalParser";
import { AgentRunnerLive } from "../src/services/AgentRunner";
import { FeatureContractLive } from "../src/services/FeatureContract";
import { RunTaskLive } from "../src/services/RunTask";
import { LoopRunner, LoopRunnerLive } from "../src/services/LoopRunner/index";
import { brand } from "../src/services/brand";

const featureSlug = process.argv[2];
if (!featureSlug) {
  console.error("usage: bun run scripts/bootstrap.ts <feature-slug>");
  process.exit(1);
}

const contractPath = brand<"AbsolutePath">(
  path.resolve(process.cwd(), `.tap/features/${featureSlug}/FEATURE_CONTRACT.json`),
);

const appLayer = Layer.mergeAll(
  LoopRunnerLive,
  FeatureContractLive,
  RunTaskLive,
  ContextEngineLive,
  EvalParserLive,
  AgentRunnerLive,
).pipe(Layer.provideMerge(BunContext.layer));

await Effect.runPromise(
  Effect.gen(function* () {
    const runner = yield* LoopRunner;
    const summary = yield* runner.run(contractPath);
    const { stoppedReason: r, iterations, tasksDone, tasksFailed, tasksPending } = summary;
    const rateLimitSuffix =
      r._tag === "RateLimited"
        ? ` RateLimited(${r.role}) — resets at ${r.resetsAt > 0 ? new Date(r.resetsAt * 1000).toISOString() : "unknown"}`
        : "";
    console.log(
      `[loop-runner] ${r._tag}${rateLimitSuffix} — iterations=${iterations} done=${tasksDone.length} failed=${tasksFailed.length} pending=${tasksPending.length}`,
    );
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        console.error(`[bootstrap] pipeline error: _tag=${e._tag}`, e);
        process.exit(1);
      }),
    ),
    Effect.provide(appLayer),
  ),
);
