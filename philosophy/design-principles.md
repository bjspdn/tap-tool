# Design Principles

This file is the depth layer for the structural rules in `CLAUDE.md`. Read it when a rule points here, or when you're making a structural decision the rules don't directly cover.

The principles below are adapted from John Ousterhout's *A Philosophy of Software Design*. They are not laws — they are lenses. Apply judgment.

## The central framing

> "Complexity is anything related to the structure of a software system that makes it hard to understand and modify the system."

Complexity has three symptoms:

1. **Change amplification.** A seemingly small change requires edits in many places.
2. **Cognitive load.** Understanding one piece requires holding many others in your head.
3. **Unknown unknowns.** It is not obvious what must be modified, or what a change might break.

Every structural decision — where to put a file, what to name it, whether to split a module, how wide an interface should be — is a vote for or against these symptoms. When in doubt, ask: "does this change make it harder or easier for the next reader to understand and modify the system?"

## Deep modules

A module's interface is a complexity tax paid by every caller. Its implementation is a complexity cost paid once. The ratio of functionality hidden behind the interface to the surface area of the interface is a rough measure of module quality.

- **Deep module:** simple interface, substantial functionality. A good deep module lets callers do a lot without understanding how.
- **Shallow module:** complex interface relative to what it does. A pass-through wrapper, a one-method class that just forwards arguments, a config object with 30 fields.

Shallow modules are worse than no module at all, because they impose interface cost without providing abstraction benefit. If a module's interface has more surface area than its implementation has substance, delete the module.

Symptoms of shallow modules in this codebase to watch for:
- A "manager" class whose only job is to hold a config and forward calls.
- A wrapper around a library that exposes the library's full API with minor renames.
- A file that exports three functions, each one-line, each called from exactly one place.

## Information hiding

Modules should hide implementation decisions so that callers cannot depend on them. Every piece of knowledge a caller has about a module's internals is a constraint on future changes.

The question to ask of any interface: "if we changed the implementation, how many callers would need to change?" The answer should be zero for most implementation changes.

Practical applications:
- Do not expose internal data structures through getters. Expose operations, not state.
- Do not leak error types from dependencies through your interface. Translate them.
- Do not name parameters after their current implementation (`useMemoryCache: boolean`). Name them after their semantics (`cacheStrategy: 'memory' | 'redis'` — or better, pick one and hide the choice).

## Define errors out of existence

The most elegant error handling is no error handling. Before writing a try/catch, ask whether the error condition can be designed away.

- Empty list iteration doesn't need a special case — the loop just doesn't execute.
- A lookup that returns `undefined` on miss doesn't need a `NotFound` exception.
- A delete operation that's idempotent doesn't need a "doesn't exist" error.

When errors cannot be designed away, handle them at the lowest level that has enough context to make a decision. Don't propagate errors up just to log them and rethrow. Don't wrap every call in try/catch "for safety" — that's not safety, it's noise.

In this codebase specifically: Effect's error channel is strong enough to make most error types mechanical. Use the type system to make illegal states unrepresentable before reaching for error handling at runtime.

## Strategic vs. tactical programming

Tactical programming: "make this change work." Strategic programming: "leave the codebase better than you found it."

Strategic programming costs ~10-20% more time per change. It pays back because the codebase stays workable as it grows. Tactical programming compounds in the wrong direction — every shortcut makes the next change harder.

Signs you're being tactical when you should be strategic:
- "I'll refactor this later." (You won't.)
- "I'll just add a flag here." (Every flag is a fork in the complexity tree.)
- "This is a quick fix." (Quick fixes persist longer than anything else.)

The Ralph loop compounds this problem. An agent running 5 iterations of tactical fixes produces 5 layers of sediment, not 1 layer of polish. If the Reviewer sees the same structural issue flagged twice, the fix is not another patch — it's a refactor.

## Splitting

File length is a weak signal. Concern-mixing is a strong one.

Split when:
- A reader looking for behavior X has to skip past behavior Y that's unrelated.
- Two parts of the file change for different reasons.
- One part of the file is read often and another part is read rarely.

Don't split when:
- The file is long but cohesive — one concept, fully expressed.
- Splitting would require each piece to import context from the others.
- The split is "by layer" rather than "by concern" (e.g., "types file, logic file, constants file" for what is really one module).

The question isn't "how many lines?" It's "does this file have one job?"

## General-purpose over special-purpose

When designing a module's interface, prefer general-purpose abstractions over special-purpose ones — *when the generality costs roughly the same as the special case*.

A general interface with one caller today is often exactly what the second caller will need tomorrow. A special-purpose interface with one caller today usually has to be rewritten when the second caller arrives.

But: generality has a cost. A `doThing(options: 47FieldConfigObject)` is not general, it's just under-specified. The goal is interfaces that are general in their *semantics*, not interfaces that are general in their *parameter count*.

## Comments describe things code cannot

Code shows *what* and *how*. Comments exist for *why* and *what-not*.

Good comments:
- Why this approach was chosen over alternatives the reader might suggest.
- What invariants must hold that aren't expressed in the types.
- What the code is deliberately not doing (and why).

Bad comments:
- Paraphrasing the code in English.
- Stating the obvious.
- Explaining what a well-named function would have made self-evident.

If a comment explains something the code should have expressed directly, rewrite the code instead of the comment.

## When these principles conflict with the rules in CLAUDE.md

Follow the principle. The rules are instantiations of the principles for common cases; when a specific situation doesn't fit the rule's shape, the principle is what you're actually trying to serve. Note the divergence in a TODO or an open question for the user.