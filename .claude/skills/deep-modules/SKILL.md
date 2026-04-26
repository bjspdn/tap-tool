---
name: deep-modules
description: Deep-module discipline for the tap-tool Ralph loop. Provides shared vocabulary (module, interface, depth-as-leverage, seam, leverage, locality) and three role overlays — probe (tap-into), write (Composer + Scout), judge (Reviewer + Summarizer) — so plan-time vocabulary matches write-time and judge-time vocabulary. Activate when probing a feature design, surveying code before writing, or grading a diff against a depth contract. Explicitly rejects Ousterhout's implementation-line-to-interface-line ratio in favour of depth-as-leverage.
---

# deep-modules

Vocabulary and operational tests for deep-module discipline across the tap-tool Ralph loop. Three roles consume this skill: **probe** (tap-into at plan time), **write** (Composer + Scout at build time), **judge** (Reviewer + Summarizer at review/report time). Use the terms below exactly — consistent language across roles is the point.

<vocabulary>

<vocab_module>**Module** — anything with an interface and an implementation. Scale-agnostic: applies to a function, class, file, package, or tier-spanning slice. Avoid: unit, component, service.</vocab_module>

<vocab_interface>**Interface** — everything a caller must know to use the module correctly. Includes type signature, invariants, ordering constraints, error modes, required configuration, and performance characteristics. Avoid: API, signature (those refer only to the type-level surface — too narrow).</vocab_interface>

<vocab_depth>**Depth (depth-as-leverage)** — the amount of behaviour a caller can exercise per unit of interface they have to learn. A module is **deep** when large behaviour sits behind a small interface. A module is **shallow** when the interface is nearly as complex as the implementation.

> **Explicitly rejected:** Ousterhout's ratio of implementation-lines to interface-lines. That framing rewards padding the implementation. Depth here is leverage at the interface — what callers and tests get per unit of surface they must understand.</vocab_depth>

<vocab_seam>**Seam** _(Feathers)_ — a place where you can alter behaviour without editing at that place. The location at which a module's interface lives. Choosing seam placement is its own design decision, separate from what goes behind it. Avoid: boundary (overloaded with DDD's bounded context).</vocab_seam>

<vocab_leverage>**Leverage** — what callers get from depth. More capability per unit of interface to learn. One implementation pays back across N call sites and M tests.</vocab_leverage>

<vocab_locality>**Locality** — what maintainers get from depth. Change, bugs, knowledge, and verification concentrate in one place rather than spreading across callers. Fix once, fixed everywhere.</vocab_locality>

<term_relationships>Term relationships:

```
Module ──has──► Interface ──located at──► Seam
  │                                         │
  └──depth-as-leverage──┐          Adapter sits here
                         ▼
               Leverage (for callers)
               Locality (for maintainers)
```
</term_relationships>

</vocabulary>

<probe_overlay>

Used by the `tap-into` skill during the `<discussion_loop>` depth-discipline angle. For every module the feature will create or significantly modify, drive these probes:

<probe_what_it_hides>**Always ask "what does this module hide?" before accepting its design**, BECAUSE a deep module has a simple interface over substantial hidden complexity — if the answer is "not much", the module is likely shallow and should be merged into its caller or redesigned before the contract is emitted.</probe_what_it_hides>

<probe_entry_points>**Always count entry points and enforce the ≤3 cap at probe time**, BECAUSE splitting after the contract is emitted forces rework of `task.files`, `SPECS.md`, and the Composer's plan; catching a bloated interface in discussion costs nothing compared to catching it in review.</probe_entry_points>

<probe_deletion_test>**Always ask "what breaks if you delete this module?" before finalizing its seam**, BECAUSE if nothing cascades the module may not be earning its own seam — the caller can absorb it, and the seam adds indirection without depth.</probe_deletion_test>

<probe_seam_classification>**Always classify the seam as in-process / local-substitutable / remote-owned / external before the contract is emitted**, BECAUSE seam type determines how failures propagate and how the module is tested; a misclassified seam leads to wrong test strategies and unexpected integration failures downstream.</probe_seam_classification>

<probe_adapter_count>**Always verify that at least two adapters are justified before introducing a port**, BECAUSE a single-adapter seam is indirection without variance — the port adds cognitive overhead without enabling any substitution that the feature actually requires. If only one adapter is justified, the seam is hypothetical; reconsider introducing the port at all.</probe_adapter_count>

<probe_depth_entries>**Always populate `<spec:depth>` in `SPECS.md` with probe answers before emitting the contract**, BECAUSE every file in `task.files` must map to exactly one `<spec:depth>` module entry; an unmapped file is a contract gap that the Reviewer will treat as a blocker.</probe_depth_entries>

</probe_overlay>

<write_overlay>

Used by the `Composer` agent and its `Explore` Scout subagent before writing any code.

<write_scout_survey>**Always complete a Scout survey (ephemeral report, no on-disk artifact) before writing implementation code**, BECAUSE writing without surveying risks re-implementing functionality already present in sibling modules, or violating naming and error-handling conventions established nearby. The Scout report must cover: entry points, seam category, what each nearby module hides, and a reuse verdict (yes/no) — one paragraph per nearby module.</write_scout_survey>

<write_match_siblings>**Always match the interface shape (naming, error idioms, type patterns) of the nearest same-module siblings**, BECAUSE inconsistent conventions multiply the cognitive load every future reader pays when navigating the module — consistency is a form of depth that reduces the interface readers must learn.</write_match_siblings>

<write_respect_depth_entry>**Always respect the `<spec:depth>` entry for every module touched: entry-point cap, seam category, and hidden-complexity contract**, BECAUSE the depth entry is the plan-time contract the Reviewer will grade against; deviating from it without updating the contract produces a guaranteed FAIL verdict.</write_respect_depth_entry>

<write_no_hypothetical_seams>**Always require two justified adapters before introducing a new seam**, BECAUSE a single-adapter seam adds indirection without enabling substitution — it is complexity cost with no leverage benefit. Do not introduce a port unless production and test adapters are both needed.</write_no_hypothetical_seams>

<write_justify_new_module>**Always justify a new module with the deletion test — state what complexity would reappear across callers without it**, BECAUSE a module that cannot pass the deletion test is a shallow pass-through that adds a seam without hiding complexity; the justification must appear in the task output so the Reviewer can evaluate it.</write_justify_new_module>

<write_entry_point_cap>**Always keep every new module's entry points ≤3; if implementation demands more, split and update `task.files`**, BECAUSE an interface with 4+ entry points is a signal that the module mixes concerns — splitting at that point is cheaper than the compounding caller complexity that accrues from a wide interface.</write_entry_point_cap>

</write_overlay>

<judge_overlay>

Used by the `Reviewer` agent when grading a diff and by the `Summarizer` agent when producing `SUMMARY.md`.

<judge_depth>**Always judge depth by leverage** (the work the interface does on behalf of callers) **not by line-count ratio**, BECAUSE Ousterhout's implementation-to-interface line ratio rewards padding the implementation with dead code and penalises tightly written implementations; leverage — capability per unit of surface — is the correct measure of depth.</judge_depth>

<judge_entry_point_cap>**Always treat an entry-point count above 3 as a blocker**, BECAUSE the ≤3 cap is not a style preference — it is the enforced limit in `<spec:depth>` entries and in every Composer diff; a module with 4+ entry points is a signal of mixed concerns that the Reviewer must surface before it calcifies.</judge_entry_point_cap>

<judge_seam_adherence>**Always verify that the diff honors the seam category declared in `<spec:depth>` and treat any deviation as a blocker**, BECAUSE a module declared `in-process` that introduces a port, or one declared `remote-owned` that couples directly to a transport, violates the architectural contract the probe phase established — catching it in review is the last gate before it ships.</judge_seam_adherence>

<judge_hidden_complexity>**Always verify that the diff satisfies the "hidden complexity" description in `<spec:depth>` and treat complexity leaked to callers as a blocker**, BECAUSE complexity that escapes the module boundary negates the leverage the depth contract promised — every caller that must know an implementation detail pays the tax the module was supposed to absorb.</judge_hidden_complexity>

<judge_deletion_test>**Always apply the deletion test to every new module in the diff and flag shallow modules as findings**, BECAUSE a module that can be deleted without cascading rewrites is a pass-through that adds a seam without hiding complexity; the finding signals that the Composer may have split at a boundary that doesn't exist in the problem domain.</judge_deletion_test>

<judge_reinvention>**Always flag as a blocker any diff that re-implements functionality a Scout survey of nearby modules would have surfaced**, BECAUSE reinvention duplicates behaviour that the existing module already hides, undermining locality — bugs and future changes must now be made in two places instead of one.</judge_reinvention>

<judge_summarizer>**Always include a depth-contract assessment section in `SUMMARY.md` for each module touched by completed tasks**, BECAUSE the summary is the loop's audit record; without a per-module verdict (honored / violated / partial) citing task IDs and diff evidence, there is no way to trace architectural drift back to the iteration that introduced it. Report: module name and path; depth contract from `<spec:depth>` (entry points, seam, hidden complexity); verdict with evidence; and, if violated, what should have been done differently.</judge_summarizer>

</judge_overlay>
