<when_to_mock>

<mock_at_boundaries>**Always limit mocks to the edges of your system — true seams where your code hands off to something it does not own and cannot control in a test environment**, BECAUSE mocking at boundaries keeps tests honest about what the real system does while still making external dependencies controllable; mocking anywhere else substitutes a test double for code you actually own, meaning refactors change the real behavior without any test catching it.

Legitimate mock targets:

- External payment, email, or notification services
- Databases (when a dedicated test database is impractical; prefer a real test database when you can)
- Time sources and random-number generators
- The file system (when isolation is needed)

</mock_at_boundaries>

<do_not_mock_internal>**Always run the real code for internal collaborators you own and control**, BECAUSE substituting a mock for logic you wrote makes tests dependent on the internal wiring rather than the outcome — when that wiring changes, even without any behavior change, tests fail, and that is the primary driver of brittle test suites.

Avoid mocking:

- Your own modules or classes
- Internal collaborators that you own and control
- Anything whose behavior you could verify by running the real code

</do_not_mock_internal>

</when_to_mock>

<designing_for_mockability>

<dependency_injection>**Always pass external dependencies in as parameters rather than constructing them inside the function**, BECAUSE a function that builds its own external client is fused to that specific implementation — callers, including tests, cannot substitute an alternative without rewriting the function itself.

GOOD: dependency is injected; callers (including tests) supply the implementation

```
FUNCTION processPayment(order, paymentClient)
    RETURN paymentClient.charge(order.total)
```

BAD: dependency is constructed internally; tests cannot substitute it

```
FUNCTION processPayment(order)
    SET client = buildPaymentClient(configFromEnvironment())
    RETURN client.charge(order.total)
```

The second form couples the function to a specific client implementation and to whatever mechanism loads configuration, making isolated testing impossible without environment manipulation.

</dependency_injection>

<sdk_style_interfaces>**Always prefer specific, named functions for each external operation over a single generic dispatcher**, BECAUSE a specific function has a fixed signature and a fixed return shape, making its mock trivial and flat; a generic dispatcher forces the mock itself to branch on arguments to return the right shape, pushing logic into test setup that belongs nowhere near it.

GOOD: each operation is independently mockable

```
api.getUser(id)          — returns a User record
api.getOrders(userId)    — returns a list of Order records
api.createOrder(data)    — returns the created Order record
```

BAD: mocking requires the mock itself to branch on the arguments

```
api.request(endpoint, options)   — returns anything; mock must inspect endpoint to decide
```

The specific-function approach means each mock returns one known shape, test setup is flat, and it is immediately visible which external operations a given test exercises.

</sdk_style_interfaces>

</designing_for_mockability>
