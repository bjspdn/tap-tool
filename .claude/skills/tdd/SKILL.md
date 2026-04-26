---
name: tdd
description: Test-driven development with red-green-refactor loop. Use when user wants to build features or fix bugs using TDD, mentions "red-green-refactor", wants integration tests, or asks for test-first development.
---

<philosophy>

<behavior_not_implementation>**Always verify behavior through public interfaces, not implementation details**, BECAUSE internal structure is the author's private concern — callers depend only on what the module promises, and tests that reach inside become obstacles to every refactor rather than safety nets for it. Code can change entirely; tests should not.</behavior_not_implementation>

<good_tests>**Always write integration-style tests that exercise real code paths through public APIs**, BECAUSE tests that describe what the system does rather than how it does it read like specifications and survive restructuring — a test named "user can checkout with valid cart" tells you exactly what capability exists and remains valid no matter how the internals change.</good_tests>

<bad_tests>**Always treat a test that breaks on a safe refactor as a signal that it is testing implementation, not behavior**, BECAUSE implementation-coupled tests — those that mock internal collaborators, test private methods, or inspect internal state directly — invert the value of a test suite: they block the changes you want and give false confidence about the behavior you care about. If you rename an internal helper and tests fail, those tests were wrong, not your rename.</bad_tests>

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

</philosophy>

<no_horizontal_slicing>**Always grow tests and code in vertical slices — one test then one implementation, cycling through each behavior — rather than writing all tests before any implementation**, BECAUSE tests written in bulk verify imagined behavior rather than actual behavior: they commit to test structure before the implementation teaches you what actually needs verifying, producing tests that are insensitive to real behavioral regressions and fragile against safe restructuring.

Vertical slices via tracer bullets (see the `<tracer_bullet>` block): one test, one implementation, repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behavior matters and how to verify it.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```
</no_horizontal_slicing>

<workflow>

<planning>**Always confirm the interface and priority behaviors with the user before writing any code**, BECAUSE starting to write tests before the interface is agreed on produces test structure that encodes assumptions — those assumptions harden into design constraints that are expensive to undo once real code builds on top of them.

- Confirm with the user what interface changes are needed.
- Confirm with the user which behaviors to test (prioritize).
- Identify opportunities for [deep modules](deep-modules.md) (small interface, deep implementation).
- Design interfaces for [testability](interface-design.md).
- List the behaviors to test (not implementation steps).
- Get user approval on the plan.

Ask: "What should the public interface look like? Which behaviors are most important to test?"

You cannot test everything. Confirm with the user exactly which behaviors matter most. Focus testing effort on critical paths and complex logic, not every possible edge case.</planning>

<tracer_bullet>**Always begin with a single tracer-bullet test that confirms one end-to-end path through the system**, BECAUSE a suite built on a broken foundation produces compounding confusion — the tracer bullet proves the path works before you invest in covering the remaining behaviors.

```
RED:   Write test for first behavior → test fails
GREEN: Write minimal code to pass → test passes
```
</tracer_bullet>

<incremental_loop>**Always write one test at a time and add only enough code to pass it**, BECAUSE writing code speculatively — anticipating tests not yet written — embeds unverified assumptions in the implementation and produces code that is never driven by a failing test, eliminating the diagnostic value the RED phase provides.

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- One test at a time.
- Only enough code to pass the current test.
- Do not anticipate future tests.
- Keep tests focused on observable behavior.</incremental_loop>

<refactor_phase>**Always reach GREEN before refactoring**, BECAUSE restructuring code that has a failing test conflates two separate problems — a broken test and a design concern — making it impossible to tell whether a new failure was caused by the refactor or was already present.

After all tests pass, look for refactor candidates (see [refactoring.md](refactoring.md)):

- Extract duplication.
- Deepen modules (move complexity behind simple interfaces).
- Apply design principles where natural.
- Consider what new code reveals about existing code.
- Run tests after each refactor step.</refactor_phase>

<checklist_per_cycle>**Always apply this checklist at every RED→GREEN cycle before moving on**, BECAUSE each cycle is a decision point — skipping the check lets bad test habits and speculative code accumulate silently across cycles until they are expensive to undo.

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```
</checklist_per_cycle>

</workflow>
