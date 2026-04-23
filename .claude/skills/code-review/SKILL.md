---
name: code-review
description: Reviewer methodology for the tap-tool Ralph loop. Activates when this sub-agent session was launched as `claude -p --agent Reviewer` inside the tap-tool RunTask pipeline. Governs per-criterion classification, zero-trust verification, scope checking, verdict rules, and eval result emission. Do not use for general PR review, ad-hoc diff commentary, or any session not running under the Reviewer sub-agent identity.
---

<section name="trigger">

This skill is active when the session is the Reviewer sub-agent in the tap-tool composer-reviewer loop — i.e. the process was spawned with `claude -p --agent Reviewer`. The stdin prompt is a rendered `REVIEWER_CONTRACT.md` supplying `task_id`, `task_acceptance`, `task_files`, `eval_path`, and related fields.

Out of scope: general pull-request review, code commentary outside the tap loop, any session where no `eval_path` was supplied in stdin.

</section>

<section name="methodology">

Follow these steps in order. Do not skip or reorder them.

<subsection name="step-1-per-criterion-classification">

Read `task_acceptance` from the rendered prompt. For each criterion in that array, assign exactly one label:

- `Satisfied` — concrete evidence confirms the criterion is fully met.
- `Not satisfied` — concrete evidence shows the criterion is unmet or absent.
- `Partial` — criterion is partly met; name what is present and what is missing.

Every classification must name its evidence. Acceptable evidence forms:

- A file path and line number: `src/types/RunTask.d.ts:12`
- A grep hit: `grep -n "EvalIssue" src/types/RunTask.d.ts`
- A command result: `bunx tsc --noEmit` output (run it yourself — see step 2)
- Absence: "file does not exist at the expected path"

Hand-waving ("looks correct", "seems fine") is not evidence. If you cannot produce evidence, the criterion is `Not satisfied`.

</subsection>

<subsection name="step-2-zero-trust-verification">

Do not trust any test or type-check results reported by the Composer. Run independently:

```
bun test
bunx tsc --noEmit
```

Capture stdout and stderr. If either command exits non-zero, that is a FAIL. If the Composer's log claims green but your run is red, the Composer's claim is irrelevant — your result governs.

If `bun test` or `bunx tsc --noEmit` is not applicable for this task (e.g. the task produces only static markdown), note the reason explicitly; do not omit the step silently.

</subsection>

<subsection name="step-3-scope-check">

Enumerate every file touched since the last clean commit:

```
git diff --name-only HEAD
git status --short
```

Compare the output against `task_files` from the rendered prompt. Any file in the diff that is not in `task_files` is a scope violation. Scope violations produce a FAIL issue regardless of whether the file change appears benign.

</subsection>

<subsection name="step-4-verdict">

Emit `PASS` only when all of the following hold simultaneously:

1. Every acceptance criterion is classified `Satisfied` (no `Not satisfied`, no `Partial`).
2. `bun test` exits zero.
3. `bunx tsc --noEmit` exits zero.
4. No anti-pattern violations detected (consult the `anti-patterns` skill).
5. No scope violations (step 3 produced no out-of-bounds files).

Any single miss — one `Not satisfied`, one `Partial`, one test failure, one type error, one out-of-bounds file — produces `FAIL`. `Partial` does not round up to `Satisfied`.

</subsection>

<subsection name="step-5-emission">

Write exactly one file: the path supplied as `eval_path` in the rendered prompt. Use the Write tool. The file must contain the three-block schema:

```
<eval:verdict>PASS|FAIL</eval:verdict>
<eval:rationale>
  ...
</eval:rationale>
<eval:issues>
  ...
</eval:issues>
```

The full emission format — field names, YAML list shape, word-count constraint, and the exact `eval_path` value — is specified in the rendered `REVIEWER_CONTRACT.md` prompt. Do not guess the path; read it from the prompt.

Do not edit source files. Do not commit. The eval file is the only write this sub-agent performs.

</subsection>

</section>

<section name="issue-writing">

Each issue in `<eval:issues>` must contain:

- `acceptance_failed` — the exact or near-verbatim text of the criterion that failed, so the next Composer attempt can locate it in the contract.
- `file` — the specific file where the problem was observed, or the file that was expected but absent.
- `problem` — the concrete symptom: a line reference, a type error message, a missing export, a scope violation.
- `suggested_fix` — the minimum-viable change a Composer can act on in the next attempt. Be specific: name the declaration to add, the import to remove, the test assertion to write.

When verdict is PASS, `<eval:issues>` contains an empty YAML list. When verdict is FAIL, at least one issue entry is required.

</section>

<section name="failure-modes">

- `bun test` or `bunx tsc --noEmit` not available in PATH: report as a FAIL issue with `suggested_fix: "Ensure bun is installed and on PATH before Reviewer is spawned"`.
- `eval_path` not supplied in the rendered prompt: write the file to `.tap/features/<slug>/eval/EVAL_RESULT.md` as a fallback and note the missing placeholder as a FAIL issue.
- `git diff --name-only HEAD` returns no output on a fresh repo with no commits: use `git status --short` alone and note the limitation.

</section>
