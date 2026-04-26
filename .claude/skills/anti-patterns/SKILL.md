---
name: anti-patterns
description: Shape check for code being written (Composer) or reviewed (Reviewer) before finalizing. Activates whenever code is produced or evaluated and a pre-commit / pre-finalization quality pass is warranted. Enumerate violations against the eight patterns below; surface each as a concrete finding with a corrective action.
---

<patterns>

<monolithic_files>

**Always split a file when it mixes unrelated concerns**, BECAUSE a file that conflates multiple responsibilities forces every reader to navigate past unrelated logic to find what they need, and every isolated change risks disturbing adjacent code — a 400-line file touching parsing, validation, and persistence is three files waiting to diverge safely.

Rule: no file exceeds approximately 300 lines.

<example>
Split a 400-line file that handles parsing, validation, and persistence into three focused files — one per responsibility — each well under the threshold.
</example>

</monolithic_files>

<duplication_rule>

**Always extract a shared abstraction once a structural pattern repeats three times**, BECAUSE two occurrences may be coincidence, but three are a pattern — and triplicated logic means three places to update when the invariant changes, and three places to diverge silently.

Rule: if the same structural pattern appears three or more times, extract it.

<example>
Three call sites that each open a resource, run a callback, and close the resource share the same shape. Extract an abstraction that owns open/close and accepts the callback as an argument.
</example>

</duplication_rule>

<purity_violations>

**Always keep pure zones free of I/O, argument mutation, and ambient state reads**, BECAUSE a secretly impure function breaks the reasoning guarantees that make pure code easy to test and refactor — callers assume referential transparency and will be burned when they discover the hidden dependency.

Rule: a function declared or expected to be pure must not perform I/O, mutate its arguments, or read ambient state. Impure zones are explicit and bounded (service layers, effect handlers); impurity does not leak into pure computation.

<example>
A pure transformation function receives a record and returns a transformed copy. It does not write to a log, mutate the input, or read a global counter. Side effects belong in the caller's explicitly impure layer.
</example>

</purity_violations>

<deep_nesting>

**Always flatten control flow with early returns and named helpers when nesting passes three levels**, BECAUSE deep nesting buries invariants and exit conditions, making the logic hard to trace and easy to break — a reader must hold every enclosing condition in working memory just to understand one branch.

Rule: control flow beyond approximately three levels of nesting must be restructured.

<example>
Replace a four-level nested conditional with guard clauses that return or throw early at each failure condition, leaving the happy path at the top level of the function body.
</example>

</deep_nesting>

<magic_values>

**Always lift a recurring or non-obvious value to a named constant**, BECAUSE the constant's name carries the value's meaning to every reader, and a single source of truth prevents the inconsistency that follows from updating one literal but missing others. Exception: a value whose meaning is self-evident at its sole use site (e.g., `return 0` in a counter reset) need not be extracted.

Rule: untagged numbers or strings embedded in logic must be named. Use constants, named enumerations, or branded types.

<example>
Replace `if (status === 3)` with a named constant `const PENDING_STATUS = 3` declared at the module boundary, so every reader knows what 3 means.
</example>

</magic_values>

<vague_names>

**Always name identifiers by what they represent in the domain**, BECAUSE a vague name forces every reader to reconstruct the intent that the author already knew — `data`, `info`, `manager`, `helper`, `util`, `item`, and `thing` answer neither "of what" nor "for what", and that silence is a tax paid on every future read.

Rule: identifiers such as `data`, `info`, `manager`, `helper`, `util`, `item`, or `thing` must be renamed to reflect their actual role. An identifier must answer "of what, for what".

<example>
Rename `processData(data)` to `normalizeInvoiceLineItems(lineItems)` — the function name states what it transforms and the argument name states what it receives.
</example>

</vague_names>

<commented_out_code>

**Always delete code that is no longer active and trust version control to recover it**, BECAUSE commented-out code obscures the active logic, creates ambiguity about whether removal is safe, and accumulates into clutter that every future reader must mentally skip. Version control is the backup; a comment is not.

Rule: dead code left in comments must be deleted. The only permitted exception is an intentional forward reference formatted as an explicit TODO: `// TODO: <what> — <why> — <revisit trigger>`.

<example>
Delete the commented block entirely. If the code is likely to be needed again, leave exactly one TODO line: `// TODO: reinstate rate-limiting here — disabled pending load-test results — revisit after S4 benchmarks`.
</example>

</commented_out_code>

<implicit_contracts>

**Always make a function's preconditions, side effects, and error modes explicit at its boundary**, BECAUSE an implicit contract is correct only as long as the original author's memory is authoritative, which is never for long — every caller that learns about a hidden assumption through a production failure pays the tax that an explicit type, assertion, or docstring would have eliminated.

Rule: a function's preconditions, side effects, and error modes must be encoded — not left in the caller's head. Use the project's type system (branded types, tagged unions, assertions, generics) to encode constraints. Where types cannot express the constraint, use structured documentation (docstrings, comments). Codified contracts beat documentation.

<example>
A function that expects a non-empty list and may fail with a network error encodes both facts through the type system and error handling idiom the project already uses. Callers cannot ignore either constraint.
</example>

</implicit_contracts>

</patterns>

<reporting>

For each violation found, report:

1. The pattern ID from this file.
2. The file and approximate location.
3. A one-sentence description of the specific violation.
4. A concrete corrective action — not a general suggestion.

A clean file produces no findings. Do not report absence of findings as a positive assertion; simply omit it.

</reporting>
