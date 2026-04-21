## Subagent Dispatch

When composing prompts for subagents, always include:

- "Push back if the task spec has gaps or if you see a better approach."
- "Read relevant files before editing. Run tests after changes."
- A one-line description of the project and why the code is legitimate.

When a subagent reports back with an error or unexpected result, respond
with a clean restatement of intent — not criticism of the subagent's
output. Correction-heavy dispatch chains degrade subagent output quality
across subsequent calls.

## General Guidelines
> Guidelines to always follow. 

- When writing types, add them under @src/types with an ambient type extension (*.d.ts). No need to export them, they're globally available by default.
- When writing tests, drop them under the conresponding __test__ folder. If there is none, you may create one.
- When creating files, use PascalCase convention