# tap-tool

Vocabulary for the tap-tool Ralph loop: a CLI that drives structured feature work through two distinct `claude -p` roles — Composer and Reviewer — iterating until each task passes or is exhausted.

## Language

**Feature**:
The top-level unit of work; one folder under `.tap/features/<name>/` containing a contract and a spec.
_Avoid_: sprint, epic, project

**Story**:
A named group of related tasks within a Feature that acts as a dependency boundary.
_Avoid_: phase, stage, group

**Task**:
A single unit of work scoped to specific files, executed by one or more Composer→Reviewer iterations, carrying acceptance criteria, status, attempts, and a maxAttempts budget.
_Avoid_: ticket, issue, step

**Iteration**:
One Composer→Reviewer pass for a single task attempt, producing exactly one Verdict and one Decision.
_Avoid_: cycle, run, pass

**Composer**:
The writer role inside an Iteration; a `claude -p` invocation that produces code edits against a Task.
_Avoid_: writer, generator, agent

**Reviewer**:
The judge role inside an Iteration; a `claude -p` invocation that emits a Verdict against the task's acceptance criteria.
_Avoid_: evaluator, critic, judge-bot

**Verdict**:
The Reviewer's PASS or FAIL judgment for one Iteration, written to EVAL_RESULT.md.
_Avoid_: result, outcome, score

**Decision**:
The per-Iteration classification (Pass / Retry / Exhausted / RateLimited) that the loop derives from the Verdict and attempt count to determine the next state.
_Avoid_: action, outcome, verdict

**StoppedReason**:
The tagged reason the loop halted (AllDone / TaskExhausted / MaxIterations / NoReadyTasks / RateLimited), emitted when the loop exits without completing all tasks.
_Avoid_: exit code, halt cause, termination reason

**FeatureContract**:
The structured `FEATURE_CONTRACT.json` file that encodes a Feature with its Stories and Tasks, dependency graph, and status fields.
_Avoid_: spec, manifest, config

**EVAL_RESULT.md**:
The file the Reviewer writes at the end of every Iteration, containing the Verdict, a prose summary, and a YAML comment list.
_Avoid_: eval file, review output, verdict file

## Relationships

- A **Feature** contains one or more **Stories**, each containing one or more **Tasks**.
- A **FeatureContract** is the on-disk encoding of a **Feature** and is the authoritative source for **Story** and **Task** state.
- A **Task** runs one or more **Iterations**; each **Iteration** produces exactly one **Verdict** and is classified into exactly one **Decision**.
- A **Composer** writes and a **Reviewer** judges; both roles execute inside a single **Iteration**.
- A **Reviewer** writes its **Verdict** to **EVAL_RESULT.md**; the loop reads that file to derive the **Decision**.
- A **Decision** of `Exhausted` or `RateLimited` produces a **StoppedReason** that halts the loop.

## Example dialogue

> **Dev:** "The Reviewer emitted PASS on the second attempt. What's the Decision?"
> **Architect:** "Decision is `Pass` — the Verdict drove it; attempt count is irrelevant once we have PASS."
> **Dev:** "What if the Reviewer emits FAIL on attempt 2 and maxAttempts is 3?"
> **Architect:** "Decision is `Retry` — we still have budget. The loop feeds EVAL_RESULT.md back to the Composer on the next Iteration."
> **Dev:** "Same FAIL on attempt 3?"
> **Architect:** "Now Decision is `Exhausted` — the Verdict is still FAIL, but the loop has no budget left. The loop emits a **StoppedReason** of `TaskExhausted` and halts."
> **Dev:** "So Verdict and Decision are never the same thing?"
> **Architect:** "Correct. Verdict is what the **Reviewer** reports. Decision is what the loop does about it given context the Reviewer doesn't see — attempt count, rate-limit signals, remaining budget."

## Flagged ambiguities

- "iteration" was used loosely to mean both a single Composer→Reviewer pass and the full sequence of attempts for a task — resolved: **Iteration** is one pass only; the multi-iteration sequence is called "the task's attempts".
- "verdict" vs "decision" — resolved: **Verdict** is the Reviewer's output (PASS/FAIL); **Decision** is the loop's classification of what to do next (Pass / Retry / Exhausted / RateLimited). They are produced by different actors at different layers.
- "spec" was used to mean both the **FeatureContract** JSON and the `SPECS.md` prose document — resolved: **FeatureContract** refers exclusively to `FEATURE_CONTRACT.json`; the prose document is called the spec file and is not a domain term.
