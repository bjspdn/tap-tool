<refactor_candidates>

<duplication>**Always extract duplicated logic into a shared abstraction so the concept lives in one place**, BECAUSE every copy is a future divergence point — when the logic must change, copies are updated inconsistently, and the bugs that result are hard to trace because the problem appears somewhere other than where the fix was applied.</duplication>

<long_methods>**Always break a routine into private helpers when its steps are no longer individually legible, and keep tests on the public interface — not the helpers**, BECAUSE testing private helpers couples the test to decomposition choices that are internal to the implementation; the public interface is the only surface whose behavior the rest of the system depends on.</long_methods>

<shallow_modules>**Always combine or deepen a module whose interface is nearly as large as its implementation**, BECAUSE a shallow module offers callers almost no abstraction benefit — they must understand nearly as much as the implementation to use it, and every time the implementation changes, callers feel it directly.</shallow_modules>

<feature_envy>**Always move logic to where its data lives when a routine spends most of its effort manipulating data that belongs to another module**, BECAUSE co-locating logic with its data reduces the number of places a reader must look to understand or change a concept, and keeps the owning module's encapsulation intact.</feature_envy>

<primitive_obsession>**Always introduce value objects to represent domain concepts that carry rules or constraints, rather than leaving them as raw primitives**, BECAUSE a raw primitive does not enforce the rules that make its value valid — any caller can construct an illegal value and pass it anywhere without the system catching it; a value object encodes the rules once and enforces them at every boundary.</primitive_obsession>

<code_revealed>**Always treat it as a refactor candidate when new code written during the TDD cycle makes existing code look problematic by contrast**, BECAUSE the contrast signal — unclear naming suddenly visible, misplaced responsibility exposed by the new neighbor, a missing abstraction made obvious — is the most reliable prompt for structural improvement you will get, and deferring it lets the drag accumulate.</code_revealed>

</refactor_candidates>
