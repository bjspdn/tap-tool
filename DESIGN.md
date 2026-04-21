# tap-tool — Design Notes

Context-engineering CLI around Claude Code. Drives a Ralph-style loop
that turns a structured feature contract into running code via two
distinct `claude -p` roles: **Composer** (writes) and **Reviewer**
(judges). Built on Effect + Bun + TypeScript.

Inspiration: the existing PR #1 (`ralph: context-engineered CLI for
Claude ralph loops`) already implements `ContextEngine`, `AgentRunner`,
`LoopRunner`, and per-feature folders. We cherry-pick that foundation
and extend it with a sprint/task hierarchy, per-task eval loop, and a
streaming terminal UX.

---

## 1. Workflow Overview

```
tap-into skill (Claude Code skill, not runtime)
  │  interview user about feature
  │  emit artifacts to disk
  ▼
.tap/features/<name>/
  FEATURE_CONTRACT.json   ← structured sprint/task tree
  SPECS.md                ← prose spec, XML-tagged sections
  PROMPT.md               ← optional extra direction
  logs/                   ← per-iteration jsonl + output (gitignored)
  eval/EVAL_RESULT.md     ← latest reviewer verdict
  ▼
tap run <feature>
  │  LoopRunner picks next ready task (topo sort on depends_on)
  │  Composer (claude -p, Sonnet) implements task
  │  Reviewer (claude -p, Opus) judges against acceptance
  │  pass → mark done, advance
  │  fail → Composer re-runs with EVAL_RESULT.md feedback
  │  budget exhausted → mark task failed, surface to user
```

The `tap-into` interviewer lives as a Claude Code skill (markdown +
instructions), not as runtime code. Its output is the contract+spec
pair on disk. Everything downstream consumes those files.

---

## 2. FEATURE_CONTRACT.json Shape

Three-level tree. Feature → Stories → Tasks. Stories group related
tasks and act as dependency boundaries; they do **not** carry a
separate eval phase (see §5).

```json
{
  "feature": "auth-rewrite",
  "goal": "Replace legacy session middleware with token-based auth.",
  "constraints": [
    "Use Effect for new services",
    "No `any` types",
    "Do not edit legacy/ directly — new code lives under src/auth/"
  ],
  "stories": [
    {
      "id": "S1",
      "title": "Token issuance",
      "acceptance": [
        "POST /auth/token issues a JWT for valid credentials",
        "Integration test auth.token.test.ts passes"
      ],
      "tasks": [
        {
          "id": "S1.T1",
          "title": "Add JWT signing service",
          "files": ["src/auth/token.ts"],
          "acceptance": ["Unit test signToken.test.ts passes"],
          "depends_on": [],
          "status": "pending",
          "attempts": 0,
          "maxAttempts": 3
        },
        {
          "id": "S1.T2",
          "title": "Wire handler to signing service",
          "files": ["src/auth/handler.ts"],
          "acceptance": ["Integration test auth.token.test.ts passes"],
          "depends_on": ["S1.T1"],
          "status": "pending",
          "attempts": 0,
          "maxAttempts": 3
        }
      ]
    }
  ]
}
```

Status values: `pending | in_progress | done | failed`.

Scheduler picks the next task whose `depends_on` are all `done`.
Execution is serial in v0 — a `maxConcurrency` flag is reserved for
v1 (see §5).

---

## 3. Roles, Prompts, Models

Two roles, each invoked as a fresh `claude -p` subprocess with a
distinct system prompt and model.

| Role     | Model (default)   | Writes code? | Reads prior eval? |
|----------|-------------------|--------------|-------------------|
| Composer | Sonnet (tunable)  | yes          | yes (on retry)    |
| Reviewer | Opus   (tunable)  | no           | n/a               |

Rationale for the split: Reviewer is the quality gate — it needs the
strongest judgment to catch subtle acceptance-criteria misses.
Composer writes mechanically against a clear task spec; Sonnet is
fast and capable enough. Both are tunable via config; this is the
default.

Prompts live on disk under `.tap/prompts/`:

```
.tap/prompts/
  composer.md          # system prompt for writer role
  reviewer.md          # system prompt for reviewer role
  OPERATING_CONTRACT.md # rules shared by both (no --no-verify, etc.)
```

Each prompt uses XML placeholders that `ContextEngine` fills per task:

```markdown
<role>composer</role>
<feature:goal>{{goal}}</feature:goal>
<story:id>{{story_id}}</story:id>
<story:acceptance>{{story_acceptance}}</story:acceptance>
<task:id>{{task_id}}</task:id>
<task:title>{{task_title}}</task:title>
<task:acceptance>{{task_acceptance}}</task:acceptance>
<task:files>{{task_files}}</task:files>
<repo:git_status>{{git_status}}</repo:git_status>
<prior_eval>{{last_eval_result_or_empty}}</prior_eval>
<constraints>{{constraints}}</constraints>
```

Reviewer is instructed to emit a machine-readable verdict at the end
of its response:

```markdown
<eval:verdict>PASS</eval:verdict>
<eval:issues>
  - file: src/auth/token.ts
    problem: …
    suggested_fix: …
</eval:issues>
```

`LoopRunner` parses the verdict tag via regex. Anything other than
`PASS` is treated as fail and fed back to Composer on next attempt.

---

## 4. Services (Effect Layering)

```
┌──────────────────────────────────────────────────────┐
│ @effect/cli (tap init | tap run | tap status | ...)  │
└───────────────────┬──────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────────┐
│ LoopRunner                                          │
│   - pickNextReady(contract) → Task                  │
│   - runTask(task) → TaskResult                      │
│     · Composer attempt                              │
│     · Reviewer attempt                              │
│     · write EVAL_RESULT.md, update contract status  │
└──┬────────────┬────────────┬────────────┬───────────┘
   ▼            ▼            ▼            ▼
FeatureContract ContextEngine AgentRunner EvalParser
   (Schema)     (XML render)  (stream-    (regex on
                              json spawn)  verdict tag)
```

### Service responsibilities

- **`FeatureContract`** — load/validate/save `FEATURE_CONTRACT.json`
  via `effect/Schema`. Expose `nextReady`, `markStatus`,
  `incrementAttempt`. Dep-cycle detection at load time.
- **`ContextEngine`** — render role-specific prompt by filling XML
  placeholders from contract + spec + git status. Per-section
  character budget with truncation.
- **`AgentRunner`** — spawn `claude -p --output-format stream-json
  --verbose --model <id>`, stdin = rendered prompt, return
  `Stream<AgentEvent>`. Event types: `system`, `assistant`, `tool_use`,
  `tool_result`, `result`.
- **`EvalParser`** — parse reviewer output for `<eval:verdict>` +
  `<eval:issues>`; emit structured result.
- **`LoopRunner`** — orchestrate per-task attempt loop, persist state,
  stop conditions.

All services are Effect Tags with Layer implementations, swappable in
tests (echo agent, in-memory contract, etc.).

---

## 5. Key Decisions (Locked)

1. **Hierarchy: feature → stories → tasks.** Dependencies declared at
   task level via `depends_on`. Topo-sorted ready queue.
2. **Per-task eval only.** No story-level eval. Keep the system lean;
   revisit only if a concrete problem emerges.
3. **Serial execution v0.** Parallelism is a `maxConcurrency` flag for
   v1 once we have real usage data. Parallel writes to overlapping
   files require a file-claim scheduler that we refuse to build
   speculatively.
4. **Streaming UX.** `--output-format stream-json --verbose`, parse
   NDJSON events, tee to `logs/iter-NNN-<role>.jsonl` (full fidelity)
   and to stdout (compact one-line render).
5. **Roles named Composer + Reviewer.** Warmer than Generator/
   Evaluator, still precise.
6. **Skill boundary.** `tap-into` interview lives as a Claude Code
   skill that writes files. The CLI consumes files. No runtime
   coupling between interviewer and runner.
7. **Model split.** Composer = Sonnet (fast writing). Reviewer = Opus
   (strong judgment — the quality gate). Both tunable via config.
8. **Types.** Per CLAUDE.md: live under `src/types/*.d.ts` as ambient
   globals — no exports needed. Tests live under `__test__/` folders
   alongside the code they exercise.

---

## 6. Open Items

- Concrete shape of `SPECS.md` XML sections (for `tap-into` to emit
  consistently).
- `OPERATING_CONTRACT.md` content — which shared rules belong there vs
  inline per prompt.
- Whether to auto-commit after each successful task (PR #1 has a flag).
- Parallelism strategy when we reach it: file-claim scheduler vs
  branch-per-task + merge.
- CLI surface: reuse PR #1's commands (`init`, `feature add`, `run`,
  `status`, `prompt`) or adapt names.

---

## 7. Near-Term Build Order

1. `src/types/contract.d.ts` — ambient types for feature/story/task.
2. `src/services/FeatureContract.ts` — Tag + Layer + Schema.
3. `.tap/prompts/{composer,reviewer,OPERATING_CONTRACT}.md` stubs.
4. `AgentRunner` extension: stream-json, role, model, tee to file.
5. `LoopRunner` rewrite: per-task attempt loop + eval integration.
6. Minimal CLI: `tap run <feature>`.
7. Tests (under `__test__/`): contract schema, topo scheduler, eval
   parser, dry-run loop with echo agent.
