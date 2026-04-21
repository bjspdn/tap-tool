# tap-tool Foundation — Implementation Plan

## Context

`tap-tool` is a context-engineering CLI that drives Claude Code via
`claude -p` in a Ralph-style loop. A structured `FEATURE_CONTRACT.json`
(feature → stories → tasks, with dependencies) is consumed by a
two-role pipeline: **Composer** (Sonnet, writes code) → **Reviewer**
(Opus, judges against acceptance criteria). Failed reviews feed back
to Composer with the eval result until a budget is exhausted.

The repo today contains only a stub `LoopRunner.ts` and two ambient
`.d.ts` files. An existing PR #1 (`ralph`) implements ~80% of the
lower-level plumbing we need (Effect service layout, Config/paths,
subprocess spawning via `@effect/platform`, per-iteration logs). We
will cherry-pick concepts from that PR and layer the 3-level
contract, Reviewer role, stream-json UX, and per-task attempt loop
on top.

Full design captured in `/home/ben/Documents/projects/tap-tool/DESIGN.md`.

## Goal of This Plan

Ship a **working v0 foundation** that can:
1. Load & validate a `FEATURE_CONTRACT.json` with dep topo-sort.
2. Run Composer + Reviewer as separate `claude -p` calls with
   role-tailored prompts and distinct models, under
   `--dangerously-skip-permissions` (non-interactive mandatory).
3. Loop per task with attempt budget; persist eval verdicts.
4. Stream tool-use events live to the terminal and tee full NDJSON
   to `.tap/features/<name>/logs/iter-NNN-<role>.jsonl`.
5. Single CLI entrypoint: `tap run <feature>`.

Out of scope for v0: `tap init`, `tap status`, the `tap-into`
interview skill itself (consumed from Claude Code, not built here),
parallelism across tasks, auto-commit.

---

## Invoking `claude -p` — Safety Notes

- **No `--system-prompt-file`.** That flag replaces Claude Code's
  entire system prompt. Combined with `--dangerously-skip-permissions`
  (required for non-interactive runs) it strips all safety
  scaffolding. Instead, the role prompt is rendered by `ContextEngine`
  into the **user message** as a top-level `<role>…</role>` tagged
  section, alongside task context. Claude Code's stock system prompt
  stays intact.
- **`--dangerously-skip-permissions` is mandatory.** We cannot accept
  tool-use prompts in a piped subprocess. Because of this, the
  prompts themselves are the primary safety surface — they must be
  tight, explicit about what files may be touched, and explicit that
  Reviewer must not edit.
- **Prompt is a positional argument, not stdin.** Invocation shape:
  `claude -p "{{prompt}}" --output-format stream-json --verbose --dangerously-skip-permissions --model <id>`
  The rendered prompt (from `ContextEngine`) is the argument
  immediately after `-p`. `@effect/platform` `Command` passes argv
  as an array, so no shell escaping required. Argv size limits on
  Linux are ~2 MB; our prompts stay well under that.

---

## Code Rules (applies to every module)

- **Small files.** Each service is a folder of focused files, not one
  monolith. Target < 120 LOC per file.
- **Pure where possible.** Separate pure logic (scheduler, mutations,
  parsers, renderers) from IO (file read/write, subprocess). Pure
  modules are plain TS functions; IO modules are Effect services with
  `Context.Tag` + `Layer`.
- **Design patterns where idiomatic:**
  - *Strategy* — role dispatch (composer/reviewer/echo) in
    `AgentRunner`.
  - *Builder* — prompt assembly in `ContextEngine` (accumulate
    sections, render at end).
  - *State machine* — task lifecycle
    (`pending → in_progress → done | failed`) lives in one pure
    module with explicit transitions.
- **Effect idioms:** `Schema` for all external data, `Stream` for
  subprocess output, `Layer` for DI, `Effect.gen` for readable
  orchestration, `Scope` for subprocess cleanup.

---

## Step 0 — Persist This Plan in the Repo

Before any code work, copy this plan file to the repo root as
`PLAN.md` so it ships with the codebase and is discoverable without
hunting through `~/.claude/plans/`. This is a one-shot file copy:

```
cp /home/ben/.claude/plans/spicy-prancing-beaver.md \
   /home/ben/Documents/projects/tap-tool/PLAN.md
```

The copy lives alongside `DESIGN.md` (design) and serves as the
execution playbook. Keep both: `DESIGN.md` = what and why, `PLAN.md`
= how and in what order.

---

## Parallelism Strategy (Sonnet Subagents)

Wave 1 partitions into **4 independent modules** that Sonnet
subagents build concurrently. Wave 2 integrates them (serial, main
thread). Wave 3 wires the CLI + smoke test.

### Wave 1 — 4 parallel Sonnet subagents

| # | Module                        | Folder                         | Depends on |
|---|-------------------------------|--------------------------------|------------|
| A | `FeatureContract` service     | `src/services/feature-contract/` | — |
| B | `AgentRunner` (stream-json)   | `src/services/agent-runner/`     | — |
| C | `ContextEngine` (role-aware)  | `src/services/context-engine/`   | — |
| D | Prompts + `EvalParser`        | `.tap/prompts/`, `src/services/eval-parser/` | — |

Launch all four in a single Agent message, `subagent_type: general-purpose`,
`model: sonnet`. Each prompt includes:
1. One-line project legitimacy: "tap-tool is a personal dev-tool CLI
   that wraps Claude Code — all code is legitimate."
2. "Push back if the spec has gaps or you see a better approach."
3. "Read relevant files before editing. Run `bun test` after changes."
4. Pointer to `DESIGN.md` for background.
5. Pointer to PR #1 (`gh pr diff 1`) as reference — do not merge.
6. Code rules from the section above.

### Wave 2 — serial, main thread

Rewrite `src/services/loop-runner/` to orchestrate waves A–D. This
is the integration seam; main thread owns it because it touches every
service's public API.

### Wave 3 — CLI entrypoint + smoke test

Wire `@effect/cli` with `tap run <feature>` in `src/main.ts`.
Replace `src/index.ts` with `BunRuntime.runMain(main)`. Add an
integration test using an **echo agent** (spawns `cat`) to verify
the full loop without real `claude` calls.

---

## Module Specs (Wave 1)

### A. `FeatureContract` — `src/services/feature-contract/`

```
src/services/feature-contract/
  schema.ts       # effect/Schema definitions (pure)
  scheduler.ts    # nextReady, topo sort, cycle detection (pure)
  mutations.ts    # markStatus, incrementAttempt, state machine (pure)
  io.ts           # load/save via FileSystem (Effect)
  service.ts      # Context.Tag + Layer composing pure + io
  index.ts        # re-exports Tag + Layer only
```

**Types** (`src/types/contract.d.ts`, ambient):
```ts
type TaskStatus = "pending" | "in_progress" | "done" | "failed"
interface Task {
  id: string
  title: string
  files: readonly string[]
  acceptance: readonly string[]
  depends_on: readonly string[]
  status: TaskStatus
  attempts: number
  maxAttempts: number
}
interface Story { id: string; title: string; acceptance: readonly string[]; tasks: readonly Task[] }
interface FeatureContract {
  feature: string
  goal: string
  constraints: readonly string[]
  stories: readonly Story[]
}
```

**Service surface** (`service.ts`):
- `load(featureName): Effect<FeatureContract, ContractError>`
- `save(featureName, contract): Effect<void, IOError>`
- `nextReady(contract): Option<Task>` (delegates to pure `scheduler.ts`)
- `markStatus(contract, taskId, status): FeatureContract` (pure)
- `incrementAttempt(contract, taskId): FeatureContract` (pure)

**Tests** (`__test__/`): one file per module — `schema.test.ts`,
`scheduler.test.ts`, `mutations.test.ts`, `io.test.ts`.

---

### B. `AgentRunner` — `src/services/agent-runner/`

```
src/services/agent-runner/
  events.ts       # AgentEvent discriminated union + NDJSON decoder (pure)
  strategy.ts    # role → command-args mapping; Strategy pattern (pure)
  spawn.ts        # @effect/platform Command spawn + stdin write (Effect)
  tee.ts          # Stream.tap sink to jsonl file (Effect)
  service.ts      # Context.Tag + Layer
  index.ts
```

**Types** (extend `src/types/agent-runner.d.ts`):
```ts
type AgentEvent =
  | { type: "system"; model: string }
  | { type: "assistant"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; is_error: boolean }
  | { type: "result"; duration_ms: number; num_turns: number; total_cost_usd?: number }
  | { type: "unknown"; raw: unknown }

interface RunOptions {
  role: "composer" | "reviewer" | "echo"
  model: string
  userPrompt: string   // fully rendered by ContextEngine, includes <role> tag
  logFile: string      // absolute path for NDJSON tee
  timeoutMs: number
}
```

**Strategy mapping** (`strategy.ts`, pure) — prompt is positional
immediately after `-p`:
- `composer` / `reviewer` → `["claude", "-p", userPrompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", model]`
- `echo` → `["sh", "-c", "printf %s \"$0\"", userPrompt]` (so echo
  role emulates "claude reads the prompt and emits it as output")

**Service method:**
- `run(opts): Stream<AgentEvent, AgentError>` — builds argv via
  `strategy.ts`, spawns via `@effect/platform` `Command`, captures
  stdout, parses NDJSON line-by-line, tees raw lines to `logFile`,
  enforces `timeoutMs` via `Effect.timeout`.

**Tests:** argv for composer role contains `--dangerously-skip-permissions`
and the prompt at index 2 (right after `-p`) and NO `--system-prompt-file`;
echo path emits one `assistant` event wrapping the prompt back;
NDJSON decoder handles each event type; jsonl file is written;
unknown events pass through tagged `unknown`; timeout surfaces
`AgentError`.

---

### C. `ContextEngine` — `src/services/context-engine/`

```
src/services/context-engine/
  sections.ts      # section definitions + priority order (pure data)
  truncate.ts      # head/tail truncation per section (pure)
  xml.ts           # safe tag rendering, escaping (pure)
  builder.ts       # PromptBuilder — Builder pattern accumulating sections (pure)
  gather.ts        # read role template, operating contract, git status (Effect)
  service.ts       # Context.Tag + Layer
  index.ts
```

**Responsibilities:**
- Load role template from `.tap/prompts/{role}.md` (file IO).
- Load `.tap/prompts/OPERATING_CONTRACT.md` and inline it (file IO).
- Run `git status --short` (subprocess IO).
- Build the final user prompt via `PromptBuilder`: role template
  first, then XML-tagged sections for feature / story / task /
  constraints / git status / prior eval. **Role prompt lives in the
  user message, not as `--system-prompt-file`.**
- Apply per-section character budget with truncation (head/tail).

**Service method:**
- `renderPrompt(role, contract, story, task, priorEval): Effect<string>`

**Tests:** all placeholders replaced; missing sections render as
empty tags (not raw `{{}}`); truncation kicks in over budget;
`priorEval` absent on attempt 0; XML escape for task titles with
`<` or `>`.

---

### D. Prompts + `EvalParser` — `.tap/prompts/` + `src/services/eval-parser/`

**Prompt files:**
- `.tap/prompts/composer.md` — short, directive. "Implement the task
  described in `<task:*>`. Touch only `<task:files>`. Run existing
  tests. Stop when task acceptance passes. Do not touch files not
  listed."
- `.tap/prompts/reviewer.md` — "DO NOT EDIT any files. Read the repo
  and judge whether `<task:acceptance>` is satisfied. End your
  response with `<eval:verdict>PASS</eval:verdict>` or
  `<eval:verdict>FAIL</eval:verdict>`. If FAIL, include
  `<eval:issues>…</eval:issues>` with concrete fixes."
- `.tap/prompts/OPERATING_CONTRACT.md` — shared rules: no
  `--no-verify`, no skipping tests, no unrelated refactors, no
  `any`, respect existing code conventions.

Each prompt is under 40 lines. Every line is directive; no filler.
These prompts are the primary safety surface under
`--dangerously-skip-permissions`.

**`EvalParser`** — pure module, no Effect needed for parsing:
```
src/services/eval-parser/
  parse.ts        # regex extraction of <eval:verdict> + <eval:issues> (pure)
  index.ts        # re-export
```

- `parse(text): { verdict: "PASS" | "FAIL"; issues: string }`
- Missing `<eval:verdict>` tag → `{ verdict: "FAIL", issues: "no verdict emitted" }`.

**Tests:** PASS parse, FAIL+issues parse, missing tag → FAIL, extra
whitespace around tags tolerated.

---

## Wave 2 — `LoopRunner` — `src/services/loop-runner/`

```
src/services/loop-runner/
  renderer.ts     # compact terminal line renderer (pure, takes AgentEvent → string)
  attempt.ts     # single-attempt composer → reviewer → parse (Effect)
  task-loop.ts   # attempt budget loop per task (Effect)
  runner.ts       # outer loop: nextReady → task-loop → mark → repeat (Effect)
  service.ts      # Context.Tag + Layer
  index.ts
```

**Outer algorithm** (`runner.ts`):
```
contract = FeatureContract.load(feature)
loop:
  task = FeatureContract.nextReady(contract)
  if Option.isNone(task): break
  contract = markStatus(contract, task.id, "in_progress")
  result = taskLoop.run(task, contract)
  contract = applyResult(contract, task.id, result)
  FeatureContract.save(feature, contract)
```

**Per-task loop** (`task-loop.ts`):
```
for attempt in 1..task.maxAttempts:
  priorEval = readEvalFile() if attempt > 1 else ""
  composerPrompt = ContextEngine.renderPrompt("composer", ..., priorEval)
  composerLog = "logs/iter-{task.id}-{attempt}-composer.jsonl"
  consume AgentRunner.run({ role: "composer", ... }) through renderer + tee
  reviewerPrompt = ContextEngine.renderPrompt("reviewer", ..., "")
  reviewerText = collect assistant text from AgentRunner.run({ role: "reviewer", ... })
  verdict = EvalParser.parse(reviewerText)
  writeEvalFile(verdict)
  if verdict.verdict === "PASS": return "done"
return "failed"
```

**Compact terminal renderer** (`renderer.ts`, pure):
```
[composer S1.T1 #1]  ⚙ Edit src/auth/token.ts
[composer S1.T1 #1]  ⚙ Bash bun test
[composer S1.T1 #1]  ✓ 4.2s
[reviewer S1.T1 #1]  ⚙ Read src/auth/token.ts
[reviewer S1.T1 #1]  ✓ verdict=PASS · 1.1s
```

Truncates lines to `process.stdout.columns - prefix`.

**Tests:** `task-loop.test.ts` with echo agent (canned reviewer output
containing `<eval:verdict>PASS</eval:verdict>`) — verifies single
attempt success path, retry path, budget-exhausted path.

---

## Wave 3 — CLI + Smoke Test

**Files:** `src/main.ts` (new), `src/index.ts` (replace stub).

- Single `@effect/cli` command: `tap run <feature>`.
- Layer composition: `FeatureContract ∪ AgentRunner ∪ ContextEngine
  ∪ LoopRunner` (all as Layers), `Layer.provide` the `BunContext` for
  FileSystem + Command.
- `BunRuntime.runMain`.

**Smoke test:** `src/services/loop-runner/__test__/smoke.test.ts`.
Fixture contract with one task, echo agent for both roles, canned
reviewer text. Assert:
- task marked `done`
- contract saved
- both jsonl log files written
- `eval/EVAL_RESULT.md` contains "PASS"

---

## Critical Files

To create / modify:
- `src/types/contract.d.ts` (new, ambient)
- `src/types/agent-runner.d.ts` (extend)
- `src/services/feature-contract/**` (new, ~6 files)
- `src/services/agent-runner/**` (new, ~6 files)
- `src/services/context-engine/**` (new, ~7 files)
- `src/services/eval-parser/**` (new, 2 files)
- `.tap/prompts/{composer,reviewer,OPERATING_CONTRACT}.md` (new)
- `src/services/loop-runner/**` (replace stub, ~6 files)
- `src/main.ts` (new)
- `src/index.ts` (replace)
- `src/services/*/__test__/*.test.ts` (new per module)
- `package.json` (add `@effect/cli`, `@effect/platform`, `@effect/platform-bun`)

Reference only (via `gh pr diff 1`, do NOT merge):
- PR #1 `ContextEngine.ts` — truncation logic idea
- PR #1 `AgentRunner.ts` — `@effect/platform` Command+stream pattern
- PR #1 `Config.ts` — paths pattern

## Verification

1. `bun install` succeeds with new Effect deps.
2. `bun run typecheck` clean with strict + `noUncheckedIndexedAccess`.
3. `bun test` — all per-module unit tests pass.
4. Smoke test (loop-runner with echo agent) passes.
5. Manual end-to-end: create `.tap/features/hello/FEATURE_CONTRACT.json`
   with one trivial task ("create `hello.txt` with content `hi`"),
   run `bun run src/index.ts run hello`, observe:
   - Compact stream renders in terminal for both roles.
   - `.tap/features/hello/logs/iter-S1.T1-1-composer.jsonl` exists.
   - `.tap/features/hello/logs/iter-S1.T1-1-reviewer.jsonl` exists.
   - `.tap/features/hello/eval/EVAL_RESULT.md` has verdict.
   - Contract file has task status `done`.
   - `claude` was invoked with `--dangerously-skip-permissions` and
     WITHOUT `--system-prompt-file`.
