---
name: anti-patterns
description: Shape check for code being written (Composer) or reviewed (Reviewer) before finalizing. Activates whenever code is produced or evaluated and a pre-commit / pre-finalization quality pass is warranted. Enumerate violations against the eight patterns below; surface each as a concrete finding with a corrective action.
---

<section name="trigger">

Activate during any of these moments:

- A Composer agent has produced or modified code and is about to signal completion.
- A Reviewer agent is evaluating code against acceptance criteria.
- A shape check is requested before a file is committed or a task is marked done.

Apply every pattern below to every file touched by the task. A single confirmed violation is a blocker; report it as a finding, not a suggestion.

</section>

<section name="patterns">

<anti-pattern id="monolithic-files">

**Monolithic files**

Rule: no file exceeds approximately 300 lines.

Why it is a smell: a file that large conflates multiple responsibilities, making each harder to locate, test, and change in isolation.

<example>
Split a 400-line file that handles parsing, validation, and persistence into three focused files — one per responsibility — each well under the threshold.
</example>

</anti-pattern>

<anti-pattern id="duplication-rule">

**3+ duplication rule**

Rule: if the same structural pattern appears three or more times, extract it. Two occurrences are coincidence; three are a pattern.

Why it is a smell: triplicated logic means three places to update when the invariant changes, and three places to diverge.

<example>
Three call sites that each open a resource, run a callback, and close the resource share the same shape. Extract an abstraction that owns open/close and accepts the callback as an argument.
</example>

</anti-pattern>

<anti-pattern id="purity-violations">

**Purity violations in pure zones**

Rule: a function declared or expected to be pure must not perform I/O, mutate its arguments, or read ambient state. Impure zones are explicit and bounded (service layers, effect handlers); impurity does not leak into pure computation.

Why it is a smell: a secretly impure function breaks the reasoning guarantees that make pure code easy to test and refactor.

<example>
A pure transformation function receives a record and returns a transformed copy. It does not write to a log, mutate the input, or read a global counter. Side effects belong in the caller's explicitly impure layer.
</example>

</anti-pattern>

<anti-pattern id="deep-nesting">

**Deep nesting**

Rule: control flow beyond approximately three levels of nesting must be restructured.

Why it is a smell: deep nesting buries the invariants and exit conditions of a function, making the logic hard to trace and easy to break.

<example>
Replace a four-level nested conditional with guard clauses that return or throw early at each failure condition, leaving the happy path at the top level of the function body.
</example>

</anti-pattern>

<anti-pattern id="magic-values">

**Magic values**

Rule: untagged numbers or strings embedded in logic must be named. Use constants, named enumerations, or branded types. Exception: a value whose meaning is self-evident at its sole use site (e.g., `return 0` in a counter reset) need not be extracted.

Why it is a smell: a bare literal carries no semantic contract — its meaning lives only in the author's head at the moment of writing.

<example>
Replace `if (status === 3)` with a named constant `const PENDING_STATUS = 3` declared at the module boundary, so every reader knows what 3 means.
</example>

</anti-pattern>

<anti-pattern id="vague-names">

**Vague names**

Rule: identifiers such as `data`, `info`, `manager`, `helper`, `util`, `item`, or `thing` must be renamed to reflect their actual role. An identifier must answer "of what, for what".

Why it is a smell: a vague name forces every reader to reconstruct the intent that the author already knew.

<example>
Rename `processData(data)` to `normalizeInvoiceLineItems(lineItems)` — the function name states what it transforms and the argument name states what it receives.
</example>

</anti-pattern>

<anti-pattern id="commented-out-code">

**Commented-out code**

Rule: dead code left in comments must be deleted. Version control preserves history; a comment is not a backup. The only permitted exception is an intentional forward reference formatted as an explicit TODO: `// TODO: <what> — <why> — <revisit trigger>`.

Why it is a smell: commented-out code obscures the active logic and creates ambiguity about whether it is safe to remove.

<example>
Delete the commented block entirely. If the code is likely to be needed again, leave exactly one TODO line: `// TODO: reinstate rate-limiting here — disabled pending load-test results — revisit after S4 benchmarks`.
</example>

</anti-pattern>

<anti-pattern id="implicit-contracts">

**Implicit contracts**

Rule: a function's preconditions, side effects, and error modes must be encoded — not left in the caller's head. Prefer types (branded inputs, tagged error unions) as the primary encoding. Where types cannot express the constraint, use structured documentation (TSDoc or equivalent). Codified contracts beat documentation.

Why it is a smell: an implicit contract is correct only as long as the original author's memory is authoritative, which is never for long.

<example>
A function that expects a non-empty list and may fail with a network error encodes both facts: the argument type is a branded non-empty list, and the return type is a tagged union with `{ _tag: "NetworkError"; ... }` as one variant. Callers cannot ignore either constraint.
</example>

</anti-pattern>

</section>

<section name="reporting">

For each violation found, report:

1. The pattern ID from this file.
2. The file and approximate location.
3. A one-sentence description of the specific violation.
4. A concrete corrective action — not a general suggestion.

A clean file produces no findings. Do not report absence of findings as a positive assertion; simply omit it.

</section>
