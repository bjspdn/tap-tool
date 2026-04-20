# ralph

A small CLI tool, written in TypeScript with [Effect](https://effect.website/), that
does **context engineering around the Claude model** (or Cursor agent) to drive
a ["ralph loop"](https://ghuntley.com/ralph/)-style feature-implementation
agent.

The idea is simple: instead of hand-crafting a long prompt every time you want
an agent to keep working on a feature, you keep a small, structured
`.ralph/features/<name>/` folder in your repo (`SPEC.md`, `PLAN.md`,
`PROGRESS.md`, `SCRATCHPAD.md`). On each iteration, `ralph` re-reads those
files, re-renders a refreshed prompt, pipes it to `claude -p` (or
`cursor-agent -p`), and checks whether the agent has appended the completion
marker to `PROGRESS.md`. Repeat until done or the iteration budget is
exhausted.

## Install

```bash
bun install
bun run index.ts --help
```

Optionally link as `ralph` globally:

```bash
bun link
```

(The `bin` entry in `package.json` points at `./index.ts`, which Bun executes
directly via the shebang.)

## Usage

```bash
# 1. Scaffold .ralph/ in the current repo
ralph init

# 2. Describe a feature
ralph feature add rate-limiter --spec "Add a token-bucket rate limiter to the HTTP server."
$EDITOR .ralph/features/rate-limiter/SPEC.md   # refine as you like

# 3. See the prompt ralph would send (dry; no agent call)
ralph prompt rate-limiter

# 4. Run the ralph loop
ralph run rate-limiter                           # defaults to `claude -p`
ralph run rate-limiter --agent cursor-agent     # use Cursor CLI instead
ralph run rate-limiter --dry-run -n 3           # render 3 prompts to logs/ only
ralph run rate-limiter --auto-commit            # git commit after every iteration
ralph run rate-limiter -n 50 --timeout-ms 600000

# 5. Inspect progress
ralph status rate-limiter
```

## How the ralph loop works

Each iteration `ralph`:

1. **Gathers context** from `.ralph/features/<f>/{SPEC,PLAN,PROGRESS,SCRATCHPAD}.md`
   plus `git status --short`.
2. **Renders a prompt** with a small operating contract:
   - edit source files directly,
   - keep `PLAN.md` current,
   - append an `## Iteration N` section to `PROGRESS.md`,
   - only emit `RALPH_DONE` when everything is actually done.
3. **Invokes the agent** (`claude -p --permission-mode bypassPermissions`,
   `cursor-agent -p --force --output-format text`, or `cat` for the built-in
   `echo` test agent), piping the prompt on stdin and capturing stdout/stderr.
4. **Writes the prompt and full output** to
   `.ralph/features/<f>/logs/iter-NNN-*` for auditability.
5. **Checks `PROGRESS.md`** for the completion marker (default `RALPH_DONE`)
   and stops if present; otherwise continues until `--max` is hit.

Because the context is re-read from disk every iteration, the loop degrades
gracefully if the agent edits the plan, progress, or source files in
between — it just picks up wherever things stand now.

## Configuration

`ralph init` creates `.ralph/config.json`:

```json
{
  "agent": "claude",
  "agentArgs": [],
  "maxIterations": 25,
  "iterationTimeoutMs": 900000,
  "autoCommit": false,
  "completionMarker": "RALPH_DONE",
  "contextBudgetChars": 16000
}
```

| Key                  | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `agent`              | `"claude"`, `"cursor-agent"`, or `"echo"` (the last pipes prompt through `cat` — useful for tests) |
| `agentArgs`          | Extra args appended after the default flags                          |
| `maxIterations`      | Loop iteration budget                                                |
| `iterationTimeoutMs` | Per-iteration timeout                                                |
| `autoCommit`         | `git add -A && git commit` after each iteration                      |
| `completionMarker`   | Literal string in `PROGRESS.md` that signals "done, stop"            |
| `contextBudgetChars` | Soft cap on total chars of SPEC/PLAN/PROGRESS/SCRATCHPAD in prompt   |

Most flags on `ralph run` override these per invocation.

## Architecture

Built with Effect services so each concern is a replaceable `Layer`:

- `RalphPaths` — resolves `.ralph/...` paths for the current repo.
- `ConfigService` — loads and validates `.ralph/config.json` via `Schema`.
- `ContextEngine` — gathers feature files + git status, renders the prompt
  with a character budget.
- `AgentRunner` — spawns the underlying CLI (`claude` / `cursor-agent` / `cat`)
  with `@effect/platform` `Command`, streams stdout/stderr, enforces timeouts.
- `LoopRunner` — orchestrates the iteration loop, writes prompt & output
  logs, optionally `git commit`s, checks the completion marker.
- `@effect/cli` defines `ralph init | feature (add|list) | prompt | run | status`
  and wires it all up via `BunRuntime.runMain`.

## Project layout

```
index.ts                           # shebang entry
src/
  main.ts                          # CLI assembly, layer wiring
  templates.ts                     # default SPEC/PLAN/PROGRESS/SCRATCHPAD
  commands/
    init.ts feature.ts prompt.ts run.ts status.ts
  services/
    Config.ts ContextEngine.ts AgentRunner.ts LoopRunner.ts
    ContextEngine.test.ts LoopRunner.test.ts
```

## Tests

```bash
bun test
bun run typecheck
```

## Notes

- Requires Bun (`bun --version` >= 1.3).
- Expects `claude` or `cursor-agent` on `PATH` for the corresponding agents.
- The `echo` agent is not a real agent — it simply `cat`s the prompt back out.
  It is the default for tests and is useful for inspecting the effective
  prompt at runtime.
- `ralph` never deletes or rewrites `PROGRESS.md`; iteration entries are
  appended by the agent itself, which keeps the feedback loop stable if a
  run is interrupted.
