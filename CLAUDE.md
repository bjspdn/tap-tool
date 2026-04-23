## General Guidelines

These apply across the whole repo. Feature-specific rules live in `.tap/features/<name>/SPECS.md`.

- **Types go in `src/types/` as ambient `.d.ts` declarations and are globally available without imports**, BECAUSE the tsconfig uses default `moduleDetection: "auto"` and files without imports or exports are treated as scripts, making their declarations global. Do not add `export {}` or any import to these files — that converts them to modules and breaks global visibility.

- **If an ambient type needs to reference an imported type, use `declare global { ... }` inside a module file**, BECAUSE once a `.d.ts` contains any import, naked declarations no longer reach global scope. The `declare global` block is the explicit hoist.

- **Do not export types declared in `src/types/`**, BECAUSE ambient declarations are already global; adding `export` converts the file into a module and breaks the ambient visibility for every consumer.

- **Tests go in a sibling `__tests__/` folder, named `<SourceName>.test.ts`**, BECAUSE the test runner's discovery glob matches this pattern and tests outside it will silently not run.

- **PascalCase for files exporting a single class, component, or type namespace; camelCase for modules exporting multiple utilities; lowercase for entry points (`index.ts`, `cli.ts`)**, BECAUSE the filename signals the shape of the export to readers scanning the directory — a mismatch forces them to open the file to find out what's inside.

- **Use branded types for identifiers and for primitives where mixing two values of the same underlying type would be a real bug**, BECAUSE the type system's job is to catch real confusions (`UserId` vs `PostId`), not to decorate every string. Over-branding adds noise that hides the brands that matter.

- **Add TSDoc to exported functions and to any function whose purpose isn't obvious from its name and signature**, BECAUSE TSDoc is documentation for callers — internal helpers and self-evident functions don't have callers who benefit, and universal TSDoc dilutes the signal where it's actually needed.

- **Leave `TODO` comments for work you're deliberately deferring**, BECAUSE the next agent (or you, later) needs to distinguish "this is done" from "this is a known gap." A codebase without TODOs forces readers to infer deferred work from absence, which is unreliable. Format: `// TODO: <what's missing> — <why deferred> — <trigger to revisit>`. Example: `// TODO: add retry backoff — premature before we see real rate-limit behavior — revisit once the loop runs against production API`.

- **Do not leave `TODO` as a way to hide incomplete work that should block the task**, BECAUSE the contract's acceptance criteria decide what "done" means. If a TODO describes work that's required to satisfy acceptance, the task isn't done — fix it, don't TODO it.