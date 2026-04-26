#!/usr/bin/env node
/**
 * tap CLI entry point.
 *
 * Usage:
 *   tap run <feature-slug>   — Run the Ralph loop for a feature
 *   tap init                 — Scaffold tap files into the current directory
 *   tap update               — Update managed tap files to the installed version
 *   tap remove               — Remove all tap-managed files from the current directory
 *   tap --version            — Print the installed tap version
 *
 * Wires all services via Effect layers.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Args, Command } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Fiber, Layer, Option, Ref } from "effect";
import { brand } from "./services/brand";
import { AgentRunnerLive } from "./services/AgentRunner";
import { ContextEngineLive } from "./services/ContextEngine";
import { Dashboard, DashboardLive } from "./services/Dashboard";
import { EvalParserLive } from "./services/EvalParser";
import { FeatureContract, FeatureContractLive } from "./services/FeatureContract";
import { LoopRunner, LoopRunnerLive } from "./services/LoopRunner/index";
import { RunTaskLive } from "./services/RunTask";
import { Scaffold, ScaffoldLive } from "./services/Scaffold";

// ---------------------------------------------------------------------------
// Package version — resolved at startup by walking up from this file
// ---------------------------------------------------------------------------

const resolveCliVersion = (): string => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (nodeFs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(nodeFs.readFileSync(candidate, "utf-8")) as {
          version?: string;
        };
        if (pkg.version) return pkg.version;
      } catch {
        // keep walking
      }
    }
    dir = path.dirname(dir);
  }
  return "0.0.0";
};

const CLI_VERSION = resolveCliVersion();

// ---------------------------------------------------------------------------
// Scaffold full-service type
//
// `Scaffold["Type"]` only declares `init`.  `makeScaffold` (and therefore
// `ScaffoldLive`) also provides `update` and `remove`; we cast to access them
// without widening the public Tag interface.
// ---------------------------------------------------------------------------

type ScaffoldWithAll = Scaffold["Type"] & {
  readonly update: () => Effect.Effect<void, ScaffoldError, FileSystem.FileSystem>;
  readonly remove: () => Effect.Effect<void, ScaffoldError, FileSystem.FileSystem>;
};

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

const initCmd = Command.make("init", {}, () =>
  Effect.gen(function* () {
    const scaffold = (yield* Scaffold) as ScaffoldWithAll;
    yield* scaffold.init().pipe(
      // A declined confirmation is not an error — exit cleanly.
      Effect.catchTag("ConfirmationDeclined", () => Effect.void),
    );
  }),
).pipe(Command.withDescription("Scaffold tap files into the current directory"));

const updateCmd = Command.make("update", {}, () =>
  Effect.gen(function* () {
    const scaffold = (yield* Scaffold) as ScaffoldWithAll;
    yield* scaffold.update();
  }),
).pipe(
  Command.withDescription(
    "Update managed tap files to the installed version",
  ),
);

const removeCmd = Command.make("remove", {}, () =>
  Effect.gen(function* () {
    const scaffold = (yield* Scaffold) as ScaffoldWithAll;
    yield* scaffold.remove();
  }),
).pipe(
  Command.withDescription(
    "Remove all tap-managed files from the current directory",
  ),
);

const tapCmd = Command.make("tap").pipe(
  Command.withDescription("tap-tool CLI"),
  Command.withSubcommands([runCmd, initCmd, updateCmd, removeCmd]),
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
  ScaffoldLive,
).pipe(Layer.provideMerge(NodeContext.layer));

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Command.run(tapCmd, { name: "tap", version: CLI_VERSION })(process.argv).pipe(
  Effect.provide(appLayer),
  NodeRuntime.runMain,
);
