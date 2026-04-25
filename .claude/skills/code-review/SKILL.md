---
name: code-review
description: Reviewer methodology for the tap-tool Ralph loop. Activates when this sub-agent session was launched as `claude -p --agent Reviewer` inside the tap-tool RunTask pipeline. Governs PR-style judgment, zero-trust verification, scope checking, verdict rules, and eval result emission. Do not use for general PR review, ad-hoc diff commentary, or any session not running under the Reviewer sub-agent identity.
---

<section name="trigger">

This skill is active when the session is the Reviewer sub-agent in the tap-tool composer-reviewer loop — i.e. the process was spawned with `claude -p --agent Reviewer`. The stdin prompt is a rendered `REVIEWER_CONTRACT.md` supplying `task_id`, `task_description`, `task_files`, `eval_path`, and related fields.

Out of scope: general pull-request review, code commentary outside the tap loop, any session where no `eval_path` was supplied in stdin.

</section>

<section name="methodology">

Follow these steps in order. Do not skip or reorder them.

<subsection name="step-1-judgment">

Apply the four behavior prompts to the diff. For each one, gather concrete evidence before moving to the next. Acceptable evidence forms:

- A file path and line number: `src/types/RunTask.d.ts:12`
- A grep hit: `grep -n "EvalComment" src/types/RunTask.d.ts`
- A command result: the project's typecheck gate output (run it yourself — see step 2)
- Confirmed absence: "file does not exist at the expected path"

Hand-waving ("looks correct", "seems fine") is not evidence. If you cannot produce evidence, treat the question as failing.

**Prompt 1 — Does this code do what the task description says?**
Read `task_description` from the rendered prompt. Read the diff. For each named behavior in the description, confirm its presence in the changed code with a file path or grep hit. If the description names a test file, verify it exists and exercises the described behavior.

**Prompt 2 — Are there obvious bugs, missing error handling, or logic errors?**
Inspect control flow in the changed files. Check: are fallible operations wrapped in Effect? Are error channels handled or threaded? Are edge cases (empty array, None, missing file) covered?

**Prompt 3 — Does it follow project conventions?**
Match the project's existing style. Test placement, error-handling idioms, type-system usage, naming — derive these from `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` if present, otherwise mirror nearby code in the changed files.

**Prompt 4 — Does it pass the quality gates?**
See step 2 (zero-trust verification). Every applicable quality gate must exit zero for PASS.

</subsection>

<subsection name="step-2-zero-trust-verification">

Do not trust any test or type-check results reported by the Composer. Re-run every quality gate the project enforces (tests, typecheck, lint, build, format-check). Capture stdout and stderr. If any gate exits non-zero, that is a FAIL. If the Composer's log claims green but your run is red, the Composer's claim is irrelevant — your result governs.

If the task produced only static documentation, the relevant quality gates may not apply — note which were skipped and why.

</subsection>

<subsection name="step-3-scope-check">

Enumerate every file touched since the last clean commit:

```
git diff --name-only HEAD
git status --short
```

Compare the output against `task_files` from the rendered prompt. Any file in the diff that is not in `task_files` is a scope violation. Scope violations produce a FAIL comment regardless of whether the file change appears benign.

</subsection>

<subsection name="step-4-verdict">

Emit `PASS` only when all of the following hold simultaneously:

1. The task description is plausibly realized — the diff does what the description says (Prompt 1).
2. No obvious bugs, missing error handling, or logic errors (Prompt 2).
3. Project conventions followed (Prompt 3).
4. Every applicable quality gate exits clean.
5. No anti-pattern violations detected (consult the `anti-patterns` skill).
6. No scope violations (step 3 produced no out-of-bounds files).

Any single miss — description not realized, an obvious bug, a convention violation, a test failure, a type error, an out-of-bounds file, an anti-pattern — produces `FAIL`.

</subsection>

<subsection name="step-5-emission">

Write exactly one file: the path supplied as `eval_path` in the rendered prompt. Use the Write tool. The file must contain the three-block schema:

```
<eval:verdict>PASS|FAIL</eval:verdict>
<eval:summary>
One paragraph, ≤300 words, overall read of the diff.
</eval:summary>
<eval:comments>
# YAML list. Empty when verdict is PASS. ≥1 entry when FAIL.
- file: "<path>"
  line: <number>          # optional — omit when not line-anchored
  severity: "blocker" | "suggestion" | "nitpick"
  comment: "<concrete observation + suggested action>"
</eval:comments>
```

The full emission format — field names, YAML list shape, word-count constraint, and the exact `eval_path` value — is specified in the rendered `REVIEWER_CONTRACT.md` prompt. Do not guess the path; read it from the prompt.

Do not edit source files. Do not commit. The eval file is the only write this sub-agent performs.

</subsection>

</section>

<section name="comment-writing">

Each comment in `<eval:comments>` must contain:

- `file` — the specific file where the problem was observed, or the file that was expected but absent.
- `line` — the line number where the problem is anchored (optional; omit when the comment is not line-specific).
- `severity` — one of `"blocker"`, `"suggestion"`, `"nitpick"`. This is a human label; no machine logic acts on it. Use `blocker` for issues that would prevent PASS, `suggestion` for improvements worth making, `nitpick` for minor style points.
- `comment` — the concrete observation plus the minimum-viable suggested action. Be specific: name the declaration to add, the import to remove, the test assertion to write.

When verdict is PASS, `<eval:comments>` contains an empty YAML list. When verdict is FAIL, at least one comment entry is required.

</section>

<section name="failure-modes">

- Quality gates not available in PATH: report as a FAIL comment with `comment: "Ensure the project's quality gate tools are installed and on PATH before Reviewer is spawned"`.
- `eval_path` not supplied in the rendered prompt: write the file to `.tap/features/<slug>/eval/EVAL_RESULT.md` as a fallback and note the missing placeholder as a FAIL comment.
- `git diff --name-only HEAD` returns no output on a fresh repo with no commits: use `git status --short` alone and note the limitation.

</section>
