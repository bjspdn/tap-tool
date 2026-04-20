export const SPEC_TEMPLATE = (feature: string) => `# Feature: ${feature}

## Goal
Describe what "done" looks like in one or two sentences.

## User story / motivation
Why are we building this? Who benefits?

## Requirements
- Requirement 1
- Requirement 2

## Non-goals
- Things we are explicitly NOT doing

## Acceptance criteria
- [ ] Criterion 1 is testable and verifiable
- [ ] Criterion 2
- [ ] \`bun test\` passes
`

export const PLAN_TEMPLATE = (feature: string) => `# Plan: ${feature}

The agent should keep this file up to date as it learns more. Use a checklist
of small, concrete steps that each look achievable in a single iteration.

## Steps
- [ ] Read SPEC.md and restate the goal in 2-3 bullets
- [ ] Sketch the module / file layout
- [ ] Implement the smallest vertical slice
- [ ] Add tests for the slice
- [ ] Iterate until acceptance criteria pass

## Open questions
- ...
`

export const PROGRESS_TEMPLATE = (feature: string) =>
  `# Progress: ${feature}\n\n(Iteration entries will be appended here.)\n`

export const SCRATCHPAD_TEMPLATE = () =>
  `# Scratchpad\n\nFree-form notes for the agent across iterations.\n`

export const GITIGNORE_ENTRY = `# ralph loop artifacts
.ralph/features/*/logs/
`
