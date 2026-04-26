<testable_interfaces>

<accept_dependencies>**Always accept external dependencies as parameters rather than constructing them inside the function**, BECAUSE a function that builds its own dependencies is inseparable from those specific implementations — callers cannot substitute alternatives, and tests cannot isolate the logic being exercised from the infrastructure it happens to use.

GOOD: dependency is a parameter; any conforming implementation can be passed in

```
FUNCTION processOrder(order, paymentGateway)
    RETURN paymentGateway.charge(order.total)
```

BAD: dependency is constructed internally; the function is coupled to one specific implementation

```
FUNCTION processOrder(order)
    SET gateway = PaymentGateway()
    RETURN gateway.charge(order.total)
```

See the `<dependency_injection>` block in the mocking skill for the same principle applied to mocking strategy.

</accept_dependencies>

<return_results>**Always return computed results rather than mutating inputs or producing hidden side effects**, BECAUSE a function whose output is a return value can be fully verified by inspecting that value in isolation; a function whose output is a mutation forces the test to reach into external state, coupling it to representation details that have nothing to do with the behavior being verified.

GOOD: returns a value; the test checks the return

```
FUNCTION calculateDiscount(cart)
    RETURN Discount(amount: cart.total * 0.1)
```

BAD: mutates the input; the test must inspect the input object afterwards

```
FUNCTION applyDiscount(cart)
    SET cart.total = cart.total - discount
```

When a side effect is genuinely required (persisting to storage, sending a notification), isolate it at the boundary and keep the logic that computes what to persist or send as a pure, returnable value.

</return_results>

<small_surface>**Always prefer the smallest interface surface that satisfies the actual use cases**, BECAUSE every method added multiplies the number of call combinations a consumer can make, and every parameter added multiplies the setup a test must perform — interface width is a complexity cost paid by every caller on every use, while the implementation's internal complexity is a cost paid once.

</small_surface>

</testable_interfaces>
