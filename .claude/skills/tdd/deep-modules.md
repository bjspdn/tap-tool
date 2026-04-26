<deep_modules>

<deep_module_shape>**Always aim for the deep-module shape: small interface, large implementation**, BECAUSE the interface is a complexity tax levied on every caller every time they use the module, while the implementation complexity is paid once by the author — a module that hides substantial logic behind few, simple entry points multiplies the leverage it provides across the whole codebase.

```
┌─────────────────────┐
│   Small Interface   │  ← Few methods, simple params
├─────────────────────┤
│                     │
│                     │
│  Deep Implementation│  ← Complex logic hidden
│                     │
│                     │
└─────────────────────┘
```
</deep_module_shape>

<shallow_module_anti>**Always treat a large interface over a thin implementation as a design warning that the module must be deepened or consolidated**, BECAUSE a shallow module forces callers to understand nearly as much as the implementation to use it correctly — the complexity it was supposed to hide has been displaced onto every call site instead.

```
┌─────────────────────────────────┐
│       Large Interface           │  ← Many methods, complex params
├─────────────────────────────────┤
│  Thin Implementation            │  ← Just passes through
└─────────────────────────────────┘
```
</shallow_module_anti>

<design_questions>**Always ask these three questions before finalizing an interface and revise if any answer is yes**, BECAUSE writing tests against a premature interface locks in a surface that may still be reducible — every test written against an unnecessary method or parameter makes that surface harder to change later.

- Can I reduce the number of methods?
- Can I simplify the parameters?
- Can I hide more complexity inside?
</design_questions>

</deep_modules>
