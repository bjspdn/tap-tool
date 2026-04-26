# Artifact Templates

Reference for `SPECS.md` and `FEATURE_CONTRACT.json` formats emitted by the tap-into skill.

## SPECS.md Template

Prose spec with XML-tagged sections for downstream prompt rendering:

```markdown
# <feature-name>

<spec:goal>
One-to-three sentence statement of intent. What this feature does and why.
</spec:goal>

<spec:context>
What in the existing codebase this builds on, extends, or replaces. Key file references.
</spec:context>

<spec:constraints>

- Convention 1
- Convention 2
- Forbidden paths / patterns
</spec:constraints>

<spec:depth>

## Module: <module-name>

- **Path:** `<file-or-directory>` — one canonical path per module entry.
- **Interface (entry points, ≤3):** Each public entry point with signature and one-line purpose. Split if >3.
- **Hidden complexity:** What substantial logic/state/coordination does this module hide? Must be non-trivial.
- **Deletion test:** What would callers duplicate if deleted? No deletion cost = shallow wrapper.
- **Seam:** `in-process` | `IPC` | `network` | `file`. Boundary location and failure propagation implications.
- **Justification:** One sentence: what expensive problem does the simple interface hide?

_(Repeat for every module created or significantly modified. Every file in any task's `files` list must appear in exactly one module entry.)_

</spec:depth>

<spec:shape>
Architecture narrative + ASCII diagram from interview.
</spec:shape>

<spec:failure_modes>
Known failure modes and how design addresses them.
</spec:failure_modes>

<spec:open_questions>
Deliberately deferred items, with note on why and when to revisit.
</spec:open_questions>
```

## FEATURE_CONTRACT.json Schema

Three levels: feature → stories → tasks. No caps on counts.

```json
{
  "feature": "kebab-case-slug",
  "goal": "One-sentence statement of what this feature does.",
  "description": "≤3 lines describing what this feature does, for the Composer to realize.",
  "constraints": ["Free-form rule the Composer must respect", "..."],
  "stories": [
    {
      "id": "S1",
      "title": "Human-readable story title",
      "description": "≤3 lines describing the story's scope.",
      "tasks": [
        {
          "id": "S1.T1",
          "title": "Commit-sized task title",
          "description": "≤3 lines naming what to build. May reference a load-bearing test file path; otherwise the Composer picks test names.",
          "files": ["relative/path/one.ext"],
          "depends_on": [],
          "status": "pending",
          "attempts": 0,
          "maxAttempts": 3
        }
      ]
    }
  ]
}
```

## Emission Rules

<description_required>`description` required at every level (feature, story, task), ≤3 lines each. This is the obligation surface.</description_required>

<test_file_reference>Name load-bearing test files in task description when critical to acceptance. Otherwise Composer picks test names.</test_file_reference>

<no_acceptance_field>Omit `acceptance` field — superseded by `description`.</no_acceptance_field>

<stable_ids>Keep story/task ids stable after first emission. Downstream logs key off them.</stable_ids>

<depends_on_tasks>Reference task ids (not story ids) in `depends_on`. Cross-story deps allowed.</depends_on_tasks>

<status_and_attempts>Initialize: `status: "pending"`, `attempts: 0`, `maxAttempts: 3` unless user specifies otherwise.</status_and_attempts>

<files_completeness>List all paths Composer will create or modify in `files`, including paths that don't yet exist.</files_completeness>

<dag_no_cycles>Validate: no cycles in `depends_on`, no dangling ids, every task has description.</dag_no_cycles>
