import { Context, Effect } from "effect";
import { FileSystem } from "@effect/platform";

// ---------------------------------------------------------------------------
// Type alias for the full run error union
// ---------------------------------------------------------------------------

export type RunError =
  | Extract<RunTaskError, { _tag: "AgentSpawnFailed" }>
  | Extract<RunTaskError, { _tag: "AgentMaxTurnsExceeded" }>
  | Extract<RunTaskError, { _tag: "RateLimited" }>
  | Extract<RunTaskError, { _tag: "FilesystemError" }>;

// ---------------------------------------------------------------------------
// Internal error constructors
// ---------------------------------------------------------------------------

export const spawnFailed = (
  role: AgentRole,
  exitCode: number,
  stderr: string,
): Extract<RunTaskError, { _tag: "AgentSpawnFailed" }> => ({
  _tag: "AgentSpawnFailed",
  role,
  exitCode,
  stderr,
});

export const maxTurnsExceeded = (
  role: AgentRole,
): Extract<RunTaskError, { _tag: "AgentMaxTurnsExceeded" }> => ({
  _tag: "AgentMaxTurnsExceeded",
  role,
});

export const filesystemError = (
  path: AbsolutePath,
  cause: unknown,
): Extract<RunTaskError, { _tag: "FilesystemError" }> => ({
  _tag: "FilesystemError",
  path,
  cause,
});

/**
 * Constructs a RateLimited error. `resetsAt` is a Unix timestamp (seconds).
 * Use `0` when no rate_limit_event was observed — the caller can distinguish
 * "unknown reset time" (0) from an actual timestamp (> 0).
 */
export const rateLimited = (
  role: AgentRole,
  resetsAt: number,
): Extract<RunTaskError, { _tag: "RateLimited" }> => ({
  _tag: "RateLimited",
  role,
  resetsAt,
});

// ---------------------------------------------------------------------------
// AgentRunner Tag
// ---------------------------------------------------------------------------

/**
 * Effect service that spawns a claude sub-agent and collects its NDJSON event stream.
 * Provides Live (real subprocess) and Echo (deterministic fake) layers.
 *
 * The `run` method requires `FileSystem` in its environment so both the Live layer
 * (which captures it at construction time and closes over it) and the Echo layer
 * (which acquires it at call time) remain type-compatible.
 */
export class AgentRunner extends Context.Tag("AgentRunner")<
  AgentRunner,
  {
    readonly run: (opts: AgentRunOptions) => Effect.Effect<
      {
        readonly events: ReadonlyArray<AgentEvent>;
        readonly result: Extract<AgentEvent, { type: "result" }>;
      },
      RunError,
      FileSystem.FileSystem
    >;
  }
>() {}

// ---------------------------------------------------------------------------
// AgentRunnerEchoScript type (exported — used by tests)
// ---------------------------------------------------------------------------

/**
 * Per-role script entry for the Echo fake layer.
 * `evalFileContent` is optional on all roles; the Echo layer writes it only
 * when role === "Reviewer" AND the field is present.
 */
export type RoleScript = {
  readonly events: ReadonlyArray<AgentEvent>;
  readonly exit:
    | { readonly _tag: "ok" }
    | { readonly _tag: "maxTurns" }
    | { readonly _tag: "rateLimited"; readonly resetsAt: number }
    | { readonly _tag: "spawnFail"; readonly exitCode: number; readonly stderr: string };
  readonly evalFileContent?: string;
};

/**
 * Script definition for the Echo fake layer. Drives deterministic test scenarios
 * without spawning any real subprocess. Keyed by AgentRole so a new role requires
 * only a new entry here — no type-topology changes elsewhere.
 */
export type AgentRunnerEchoScript = Readonly<Record<AgentRole, RoleScript>>;
