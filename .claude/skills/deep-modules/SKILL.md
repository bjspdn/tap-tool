---
name: deep-modules
description: Deep-module discipline for the tap-tool Ralph loop. Provides shared vocabulary (module, interface, depth-as-leverage, seam, leverage, locality) and three role overlays — probe (tap-into), write (Composer + Scout), judge (Reviewer + Summarizer) — so plan-time vocabulary matches write-time and judge-time vocabulary. Activate when probing a feature design, surveying code before writing, or grading a diff against a depth contract. Explicitly rejects Ousterhout's implementation-line-to-interface-line ratio in favour of depth-as-leverage.
---

# deep-modules

Vocabulary and operational tests for deep-module discipline across the tap-tool Ralph loop. Three roles consume this skill: **probe** (tap-into at plan time), **write** (Composer + Scout at build time), **judge** (Reviewer + Summarizer at review/report time). Use the terms below exactly — consistent language across roles is the point.

---

## Vocabulary core

**Module**
Anything with an interface and an implementation. Scale-agnostic: applies to a function, class, file, package, or tier-spanning slice.
_Avoid_: unit, component, service.

**Interface**
Everything a caller must know to use the module correctly. Includes type signature, invariants, ordering constraints, error modes, required configuration, and performance characteristics.
_Avoid_: API, signature (those refer only to the type-level surface — too narrow).

**Depth (depth-as-leverage)**
The amount of behaviour a caller can exercise per unit of interface they have to learn. A module is **deep** when large behaviour sits behind a small interface. A module is **shallow** when the interface is nearly as complex as the implementation.

> **Explicitly rejected:** Ousterhout's ratio of implementation-lines to interface-lines. That framing rewards padding the implementation. Depth here is leverage at the interface — what callers and tests get per unit of surface they must understand.

**Seam** _(Feathers)_
A place where you can alter behaviour without editing at that place. The location at which a module's interface lives. Choosing seam placement is its own design decision, separate from what goes behind it.
_Avoid_: boundary (overloaded with DDD's bounded context).

**Leverage**
What callers get from depth. More capability per unit of interface to learn. One implementation pays back across N call sites and M tests.

**Locality**
What maintainers get from depth. Change, bugs, knowledge, and verification concentrate in one place rather than spreading across callers. Fix once, fixed everywhere.

### Term relationships

```
Module ──has──► Interface ──located at──► Seam
  │                                         │
  └──depth-as-leverage──┐          Adapter sits here
                         ▼
               Leverage (for callers)
               Locality (for maintainers)
```

---

## Operational tests

### Deletion test

Imagine deleting the module. Ask: does complexity vanish (the module was a pass-through, not earning its keep), or does complexity reappear across N callers (the module was hiding something real)? A module that survives deletion without cascading rewrites is a candidate for removal or merger.

### Entry-point hard cap

**≤3 entry points per module.** Above this cap, split into a new module. This limit is not a style preference — it is enforced in `<feature:depth>` entries and in every Composer diff. An interface with 4+ entry points is a signal that the module mixes concerns.

### Seam taxonomy (four categories)

Classify every seam before deciding whether to introduce it. Category determines how the module behind it is tested.

| Category | Description | Testing approach |
|---|---|---|
| **in-process** | Pure computation, in-memory state, no I/O | Test through the interface directly. No adapter needed. |
| **local-substitutable** | Dependency has a local stand-in (PGLite, in-memory FS) | Test with the stand-in running. Seam is internal; no port at the module's external interface. |
| **remote-owned** | Your own services across a network (Ports & Adapters) | Define a port at the seam. Deep module owns the logic; transport is injected as an adapter. |
| **external** | Third-party services you don't control (Stripe, Twilio) | Inject as a port; tests use a mock adapter. |

### One adapter = hypothetical seam, two = real seam

Do not introduce a port (seam) unless at least two adapters are justified — typically production + test. A single-adapter seam is indirection, not depth. Expose a seam only when something actually varies across it.

### Interface is the test surface

Callers and tests cross the same seam. If a test has to reach past the interface into implementation detail, the module is the wrong shape — not the test. Delete old unit tests on shallow modules once tests at the deepened interface exist.

---

## Role overlays

### probe — tap-into interview prompts

Used by the `tap-into` skill during the `<discussion_loop>` depth-discipline angle. For every module the feature will create or significantly modify, drive these probes:

1. **What does it hide?** A deep module has simple interface over substantial hidden complexity. Probe for that ratio. If the answer is "not much", the module may be shallow.
2. **How many entry points?** Count them. If >3, split now, before the contract is emitted.
3. **What breaks if you delete it?** If nothing cascades, the module may not be worth its own seam. Ask whether the caller can absorb it.
4. **Where is the seam?** Classify as in-process / local-substitutable / remote-owned / external. Seam type determines how failures propagate and how the module is tested.
5. **One adapter or two?** If only one adapter is justified, the seam is hypothetical — reconsider whether to introduce the port at all.

Depth answers populate `<feature:depth>` in `SPECS.md`. Every file in `task.files` must map to exactly one `<feature:depth>` module entry before emit.

### write — Composer + Scout

Used by the `Composer` agent and its `Explore` Scout subagent before writing any code.

**Scout survey (Explore subagent — ephemeral report, no on-disk artifact):**
- Map the nearest sibling modules' interfaces: entry points, seam category, what they hide.
- Identify existing patterns (error handling, naming, type conventions) that the new code must match.
- Flag any existing module that already provides functionality the task is about to re-implement.
- Report format: one paragraph per nearby module — name, entry points, seam, what it hides, reuse verdict (yes/no).

**Composer obligations after reading Scout report:**
- Match interface shape (naming, error idioms, type patterns) of the nearest same-module siblings.
- Respect the `<feature:depth>` entry for every module touched: entry-point cap, seam category, hidden-complexity contract.
- Do not introduce a new seam unless two adapters are justified.
- If the task requires a new module, use the deletion test to justify it — state what complexity would reappear across callers without it.
- Keep every new module's entry points ≤3. If implementation demands more, split and update `task.files`.

### judge — Reviewer + Summarizer

Used by the `Reviewer` agent when grading a diff and by the `Summarizer` agent when producing `SUMMARY.md`.

**Per-module verdict checks (each can produce a blocker-severity comment):**

1. **Entry-point cap.** Does the diff respect ≤3 entry points for every module it touches or creates? Exceeding the cap is a blocker.
2. **Seam adherence.** Does the diff honor the seam category in the `<feature:depth>` entry? A module declared `in-process` that introduces a port is a blocker.
3. **Hidden-complexity contract.** Does the diff satisfy the "hidden complexity" description in `<feature:depth>`? Complexity that leaks into callers is a blocker.
4. **Deletion test.** Would deleting the diff's new modules cause complexity to reappear across callers? If not, the module is probably shallow — flag as a finding.
5. **Scout-visible reinvention.** Does the diff re-implement functionality that a survey of nearby modules would have surfaced? If yes, flag as a blocker: "Composer reinvented X; module Y already provides this."

**For Summarizer (`SUMMARY.md` depth-contract assessment section):**
For each module touched by the completed tasks, report:
- Module name and path.
- Depth contract from `<feature:depth>` (entry points, seam, hidden complexity).
- Verdict: honored / violated / partial. Cite specific task IDs and diff evidence.
- If violated: what should have been done differently.
