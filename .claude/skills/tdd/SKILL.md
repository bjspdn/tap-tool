---
name: tdd
description: Test-driven development methodology — red, green, refactor. Use when a task's acceptance criteria reference a test file (e.g. `*.test.ts`, `*.spec.js`, or any spec file), when adding new behavior that needs coverage, or when fixing a bug by reproducing it with a failing test first. Do not use for documentation-only tasks or tasks whose acceptance criteria contain no reference to tests or verification steps.
---

<red_green_refactor>

Write the failing test before writing any production code. The test failing for the right reason — not a compilation error, but a behavioral assertion — is the signal that the spec is correctly captured. Then write the simplest change that makes the test pass. Resist adding more than the test requires.

The refactor step comes only after the test is green. Clean up duplication, rename for clarity, and improve structure — in both the test and the production code. The refactor step does not add behavior. Any new behavior goes through a new red test first.

<example>
Red: write a test asserting that `sum([1, 2, 3])` returns `6`. Run it; it fails because `sum` does not exist.
Green: implement `sum` as `items.reduce((a, b) => a + b, 0)`. Run the test; it passes.
Refactor: if the implementation repeats logic found elsewhere, extract it. The test still passes after.
</example>

</red_green_refactor>

<one_assertion>

Each test verifies one specific behavior with one assertion — or one logical claim expressed as a set of tightly related assertions that jointly describe a single observable outcome. When a test has three assertions checking three unrelated behaviors, split it into three tests.

<example>
Wrong — two unrelated behaviors in one test:
```
assert result.length == 3
assert result.status == "ok"
```

Right — one test per behavior:
Test 1: "returns three items when input contains three elements" → `assert result.length == 3`
Test 2: "reports ok status on successful parse" → `assert result.status == "ok"`
</example>

</one_assertion>

<behavior_named_tests>

Test names describe observable behavior, not implementation mechanics. A reader should be able to reconstruct the full specification from test names alone, without reading the test bodies.

<example>
Wrong names (mechanics):
- `test_parse_function`
- `check_list_processing`
- `validate_edge_case_1`

Right names (behavior):
- `returns empty list when input is empty`
- `raises an error when the required field is missing`
- `trims leading whitespace from each token`
</example>

Name the subject, the context, and the expected outcome. Format: `<subject> <context> <outcome>` or equivalent natural-language phrasing that states what the system does, not what the test checks.

</behavior_named_tests>

<small_fast_units>

Tests run in milliseconds. They have no network calls, no filesystem reads, no database connections, and no subprocess spawns by default. Isolate the unit under test from its dependencies using in-memory fakes, stubs, or fixtures embedded in the test file.

When integration-style testing is genuinely required — testing an I/O boundary, a wire format, or a real subprocess — make it a conscious choice. State the justification in a comment at the top of the test or in the test's preamble. Keep these tests in a separate file or suite so the fast-unit suite can run independently.

</small_fast_units>

<arrange_act_assert>

Each test has three distinct phases:

1. Arrange: set up the inputs, dependencies, and initial state the test needs.
2. Act: invoke the single operation under test.
3. Assert: verify the single observable outcome.

Separate the phases with a blank line when the test body is longer than three lines. Avoid interleaving assertions with actions — assert after the action is complete.

<example>
```
// Arrange
const input = [3, 1, 2]

// Act
const result = sort(input)

// Assert
assert result == [1, 2, 3]
```
</example>

</arrange_act_assert>

<failure_messages>

When an assertion carries a custom failure message, the message explains the invariant being checked — not a restatement of the expression.

<example>
Wrong: `assert items.length == 0, "items.length == 0"`
Right: `assert items.length == 0, "list must be empty after calling clear()"`
</example>

A reader seeing the failure message in a CI log should understand what contract was violated without reading the test source.

</failure_messages>

<refactor_discipline>

The refactor step is a structural improvement pass, not a feature addition. Permitted in refactor:

- Rename variables, functions, and types for clarity
- Extract duplicated logic into shared helpers
- Reorganize code within the same behavioral boundary
- Improve test readability without changing what is asserted

Not permitted in refactor (requires a new red test first):

- Adding a new parameter or return field
- Changing how an error is surfaced
- Handling an input case not yet covered by a test

When in doubt, ask: does this change alter any currently passing test's expected output? If yes, go back to red.

</refactor_discipline>
