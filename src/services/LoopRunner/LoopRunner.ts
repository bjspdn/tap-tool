import { Context, Effect, Ref } from "effect";
import { CommandExecutor, FileSystem } from "@effect/platform";
import { FeatureContract } from "../FeatureContract";
import { RunTask } from "../RunTask";
import type { AgentRunner } from "../AgentRunner";
import type { ContextEngine } from "../ContextEngine";
import type { EvalParser } from "../EvalParser";

// ---------------------------------------------------------------------------
// Safety cap
// ---------------------------------------------------------------------------

/** Hard upper bound on loop iterations — hitting this is a scheduler bug. */
export const MAX_ITERATIONS = 100;

// ---------------------------------------------------------------------------
// LoopRunner Tag
// ---------------------------------------------------------------------------

/**
 * Orchestrates the per-task attempt loop over a feature contract.
 * Yields a `LoopSummary` on exit (both normal completion and halt).
 * Error channel carries `FeatureContractError | RunTaskError`.
 *
 * The R channel includes AgentRunner | ContextEngine | EvalParser in addition
 * to what the acceptance criterion lists because RunTask.run propagates those
 * requirements through Effect.gen when called inside LoopRunner.run. Omitting
 * them would produce a tsc error (contract-reality escape hatch).
 */
export class LoopRunner extends Context.Tag("LoopRunner")<
  LoopRunner,
  {
    readonly run: (
      contractPath: AbsolutePath,
      dashboardRef?: Ref.Ref<DashboardState>,
    ) => Effect.Effect<
      LoopSummary,
      FeatureContractError | RunTaskError,
      | FeatureContract
      | RunTask
      | CommandExecutor.CommandExecutor
      | FileSystem.FileSystem
      | AgentRunner
      | ContextEngine
      | EvalParser
    >;
  }
>() {}
