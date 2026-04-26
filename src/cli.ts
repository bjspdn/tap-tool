#!/usr/bin/env node
/**
 * tap CLI entry point.
 *
 * Usage: tap run <feature-slug>
 *
 * Wires all services via Effect layers, initialises Ref<DashboardState> from
 * the feature contract, forks LoopRunner.run and Dashboard.run as concurrent
 * fibers, then joins both in order (loop first, dashboard second).
 */

import * as path from "node:path";
import { Args, Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Fiber, Layer, Option, Ref } from "effect";
import { brand } from "./services/brand";
import { AgentRunnerLive } from "./services/AgentRunner";
import { ContextEngineLive } from "./services/ContextEngine";
import { Dashboard, DashboardLive } from "./services/Dashboard";
import { EvalParserLive } from "./services/EvalParser";
import { FeatureContract, FeatureContractLive } from "./services/FeatureContract";
import { LoopRunner, LoopRunnerLive } from "./services/LoopRunner/index";
import { RunTaskLive } from "./services/RunTask";

// ---------------------------------------------------------------------------
// Initial DashboardState factory
// ---------------------------------------------------------------------------

/**
 * Build an initial `DashboardState` from the on-disk `Feature` snapshot.
 *
 * Tasks already marked `done` or `failed` carry their persisted status so
 * the dashboard shows the correct baseline before the first iteration starts.
 */
const makeInitialDashState = (feature: Feature): DashboardState => {
  const stories: ReadonlyArray<DashboardStoryState> = feature.stories.map(
    (s) => ({
      storyId: s.id,
      title: s.title,
      tasks: s.tasks.map(
        (t): DashboardTaskState => ({
          taskId: t.id,
          title: t.title,
          status: t.status,
          phase: Option.none<AgentRole>(),
          attempt: t.attempts,
          tokensUsed: 0,
          costUsd: 0,
          startedAt: Option.none<number>(),
          durationMs: Option.none<number>(),
        }),
      ),
    }),
  );

  const allTasks = stories.flatMap((s) => s.tasks);
  const totals: DashboardTotals = {
    tokensUsed: 0,
    costUsd: 0,
    tasksDone: allTasks.filter((t) => t.status === "done").length,
    tasksFailed: allTasks.filter((t) => t.status === "failed").length,
    tasksPending: allTasks.filter(
      (t) => t.status === "pending" || t.status === "in_progress",
    ).length,
  };

  return {
    feature: feature.feature,
    stories,
    totals,
    stoppedReason: Option.none<StoppedReason>(),
    startedAt: Date.now(),
  };
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const runCmd = Command.make(
  "run",
  { feature: Args.text({ name: "feature" }) },
  ({ feature }) =>
    Effect.gen(function* () {
      const contractPath = brand<"AbsolutePath">(
        path.resolve(
          process.cwd(),
          `.tap/features/${feature}/FEATURE_CONTRACT.json`,
        ),
      );

      // Load the feature contract to seed the initial dashboard state.
      const fc = yield* FeatureContract;
      const loadedFeature = yield* fc.load(contractPath);
      const initialState = makeInitialDashState(loadedFeature);

      const dashRef = yield* Ref.make(initialState);

      const loopRunner = yield* LoopRunner;
      const dashboard = yield* Dashboard;

      // Fork both services as concurrent fibers.
      const loopFiber = yield* Effect.fork(
        loopRunner.run(contractPath, dashRef),
      );
      const dashFiber = yield* Effect.fork(dashboard.run(dashRef));

      // Await the loop runner; it sets stoppedReason in dashRef on exit.
      yield* Fiber.join(loopFiber);

      // Await the dashboard — it exits once it observes stoppedReason is Some.
      yield* Fiber.join(dashFiber);
    }),
).pipe(Command.withDescription("Run the Ralph loop for a feature"));

const tapCmd = Command.make("tap").pipe(
  Command.withDescription("tap-tool CLI"),
  Command.withSubcommands([runCmd]),
);

// ---------------------------------------------------------------------------
// Layer graph
// ---------------------------------------------------------------------------

const appLayer = Layer.mergeAll(
  LoopRunnerLive,
  FeatureContractLive,
  RunTaskLive,
  ContextEngineLive,
  EvalParserLive,
  AgentRunnerLive,
  DashboardLive,
).pipe(Layer.provideMerge(NodeContext.layer));

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Command.run(tapCmd, { name: "tap", version: "0.0.1" })(process.argv).pipe(
  Effect.provide(appLayer),
  NodeRuntime.runMain,
);
