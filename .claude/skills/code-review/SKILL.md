---
name: code-review
description: Reviewer methodology for the tap-tool Ralph loop. Activates when this sub-agent session was launched as `claude -p --agent Reviewer` inside the tap-tool RunTask pipeline. Governs PR-style judgment, zero-trust verification, scope checking, verdict rules, and eval result emission. Do not use for general PR review, ad-hoc diff commentary, or any session not running under the Reviewer sub-agent identity.
---

<trigger>

This skill is active when the session is the Reviewer sub-agent in the tap-tool composer-reviewer loop — i.e. the process was spawned with `claude -p --agent Reviewer`. The stdin prompt is a rendered `REVIEWER_CONTRACT.md` supplying `task_id`, `task_description`, `task_files`, `eval_path`, and related fields.

Out of scope: general pull-request review, code commentary outside the tap loop, any session where no `eval_path` was supplied in stdin.

</trigger>

<judgment>

For each behavior prompt below, gather concrete evidence before moving to the next. Acceptable evidence forms:

- A file path and line number: `src/types/RunTask.d.ts:12`
- A grep hit: `grep -n "EvalComment" src/types/RunTask.d.ts`
- A command result: the project's typecheck gate output (run it yourself — see the `<zero_trust_verification>` block)
- Confirmed absence: "file does not exist at the expected path"

Hand-waving ("looks correct", "seems fine") is not evidence. If you cannot produce evidence, treat the question as failing.

<prompt_description>**Always confirm the described behavior is actually present in the changed code**, BECAUSE the task description is the specification — any gap between what is described and what was written is a correctness defect, not a style concern. Read the description. Read the diff. For each named behavior in the description, confirm its presence with a file path or grep hit. If the description names a test file, verify it exists and exercises the described behavior.</prompt_description>

<prompt_bugs>**Always inspect control flow, error channels, and edge cases in the changed files**, BECAUSE bugs in these areas are the most common source of production failures and are invisible to purely syntactic review. Check: are fallible operations wrapped in Effect? Are error channels handled or threaded? Are edge cases (empty array, None, missing file) covered?</prompt_bugs>

<prompt_conventions>**Always derive project conventions from `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` when present, otherwise from nearby code in the changed files**, BECAUSE convention violations accumulate technical debt that compounds across every future contributor's reading time. Check test placement, error-handling idioms, type-system usage, and naming.</prompt_conventions>

<prompt_quality_gates>**Always re-run every applicable quality gate independently rather than accepting any reported result**, BECAUSE passing gates in the Composer's report cannot be trusted; only a fresh execution by the Reviewer confirms that the code compiles, tests pass, and lint is clean. See the `<zero_trust_verification>` block.</prompt_quality_gates>

</judgment>

<zero_trust_verification>

<rerun_quality_gates>**Always re-run every quality gate the project enforces independently**, BECAUSE the Composer's reported output is untrusted — only first-hand gate execution can confirm that the code actually passes. Discover gates by inspecting CI configuration, the project's manifest or build config, root-level task runners, and contributor documentation. Run every gate that applies (tests, typecheck, lint, build, format-check). If any gate exits non-zero, the verdict is FAIL.

If the task produced only static documentation, the relevant quality gates may not apply — note which were skipped and why.</rerun_quality_gates>

<zero_trust>**Always read the changed files directly from the working tree rather than trusting the Composer's description of what it changed**, BECAUSE the Composer's description is self-reported and unverifiable; the diff is the only authoritative record of what was actually written. Do not accept the Composer's description as a substitute for reading the actual diff.</zero_trust>

</zero_trust_verification>

<scope_check>**Always run ground-truth commands first and compare against both `task_files` and the `scout_manifest` before issuing a verdict**, BECAUSE the Composer's report of which files it touched is untrusted; the working tree is the only authoritative source for scope verification.

```
- Git status: !`git status --short`
- Git diff: !`git diff --stat`
- Git diff (name only): !`git diff --name-only HEAD`
```

**Scope verification (in order):**
1. Any file in the diff that is not in `task_files` is a scope violation → automatic FAIL. Report each out-of-scope file by name.
2. For verification reads: `task_files` and `scout_manifest` entries (targets + context) are expected reads — no justification needed.
3. Reads outside both `task_files` and the manifest are extraordinary. Before each such read, state one line: which specific claim in the diff you are verifying and why the diff alone is insufficient.
4. If you need more than two extraordinary reads, stop. Report the scope gap as a finding in your verdict rather than continuing to explore.

Note: if `git diff --name-only HEAD` returns no output on a fresh repo with no commits, use `git status --short` alone and note the limitation.</scope_check>

<verdict_rules>

<pass_conditions>**Always require all six conditions to hold simultaneously before emitting PASS**, BECAUSE a verdict that passes on five of six criteria still ships broken or out-of-contract code — every condition is a load-bearing gate, not a scoring rubric:

1. The task description is plausibly realized — the diff does what the description says.
2. No obvious bugs, missing error handling, or logic errors.
3. Project conventions followed.
4. Every applicable quality gate exits clean.
5. No anti-pattern violations (consult the `anti-patterns` skill).
6. No out-of-scope file edits.
</pass_conditions>

<fail_conditions>**Always emit FAIL on any single miss**, BECAUSE partial compliance is indistinguishable from non-compliance once the code ships — description not realized, any quality-gate failure, any obvious bug, any convention violation, any anti-pattern, or any scope violation each independently produces a FAIL verdict.</fail_conditions>

</verdict_rules>

<comment_writing>**Always include `file`, `severity`, and `comment` fields on every entry in `<eval:comments>`**, BECAUSE the downstream consumer parses this YAML structure by field name; missing required fields silently drop information from the eval record.

- `file` — the specific file where the problem was observed, or the file that was expected but absent.
- `line` — the line number where the problem is anchored (optional; omit when the comment is not line-specific).
- `severity` — one of `"blocker"`, `"suggestion"`, `"nitpick"`. Use `blocker` for issues that would prevent PASS, `suggestion` for improvements worth making, `nitpick` for minor style points.
- `comment` — the concrete observation plus the minimum-viable suggested action. Be specific: name the declaration to add, the import to remove, the test assertion to write.

When verdict is PASS, `<eval:comments>` contains an empty YAML list. When verdict is FAIL, at least one comment entry is required.</comment_writing>

<output>

<write_eval_result>**Always write `EVAL_RESULT.md` at the exact path given by `eval_path` using the Write tool and the three-block format below**, BECAUSE the downstream `EvalParser` service expects a file at that precise path with exactly these tags in this order; any deviation silently breaks the loop's result ingestion. Do not guess the path; read it from the rendered prompt. If `eval_path` is not supplied, write to `.tap/features/<slug>/eval/EVAL_RESULT.md` as a fallback and note the missing placeholder as a FAIL comment.

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
</write_eval_result>

<exit_after_write>**Always stop immediately after writing `EVAL_RESULT.md` and printing the confirmation line**, BECAUSE any action taken after the verdict is written falls outside the Reviewer's mandate and may corrupt loop state. Print exactly: `Wrote verdict: PASS|FAIL to <path>.` substituting the actual verdict and path. Then stop.</exit_after_write>

</output>

<gates_not_on_path>**Always report unavailable quality gate tools as a FAIL comment rather than skipping them silently**, BECAUSE skipping a gate without a recorded reason creates ambiguity about whether the code actually passes that gate. Use `comment: "Ensure the project's quality gate tools are installed and on PATH before Reviewer is spawned"`.</gates_not_on_path>
