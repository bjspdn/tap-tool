<behavioral_focus>**Always exercise observable behavior through the public interface, not internal implementation**, BECAUSE behavior tests survive any internal refactor that leaves externally observable outcomes unchanged, while implementation tests turn every structural improvement into a test-maintenance burden.

Characteristics of a well-written test:

- Tests behavior callers or users care about
- Uses the public API only; never reaches into internals
- Survives internal refactors without modification
- Describes WHAT the system does, not HOW it does it
- Contains one logical assertion per test

```
GIVEN a cart with one product
WHEN checkout(cart, paymentMethod) is called
THEN result.status equals "confirmed"
```

</behavioral_focus>

<bad_tests>

<implementation_coupling>**Always assert on observable outcomes, not on internal mechanics**, BECAUSE tests that verify call counts, call order, or internal delegation break whenever the implementation is restructured — even when behavior is unchanged — turning refactoring from a safe activity into a test-maintenance tax.

Red flags:

- Mocking internal collaborators rather than boundary dependencies
- Testing private methods directly
- Asserting on call counts or call order
- Test breaks when internal structure changes but behavior does not
- Test name describes HOW, not WHAT
- Verifying outcomes through external means instead of the module's own interface

```
GIVEN a cart and a mocked paymentService
WHEN checkout(cart, payment) is called
THEN assert paymentService.process was called with cart.total
```

This test breaks whenever `checkout` is refactored to delegate differently, even if the observable outcome is unchanged. Prefer asserting on the result of `checkout` directly.

</implementation_coupling>

<bypassing_interface>**Always verify results through the module's own interface, not by reaching around it into storage or internal state**, BECAUSE bypassing the interface couples the test to the underlying representation and leaves the module's actual contract untested — a passing test no longer implies the interface works.

BAD: bypasses the interface to verify a side effect

```
CALL createUser(name: "Alice")
query the user store directly for name "Alice"
assert the raw record exists
```

GOOD: verifies through the module's own interface

```
SET user = createUser(name: "Alice")
SET retrieved = getUser(user.id)
assert retrieved.name equals "Alice"
```

The second form tests that the full round-trip through the module's interface works, which is the thing callers actually depend on.

</bypassing_interface>

</bad_tests>
