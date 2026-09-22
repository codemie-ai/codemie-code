# Remove duplicate workflow run command surface

**Type**: Refactoring / CLI simplification  
**Status**: Draft  
**Recommended flow**: sdlc-light

---

## Summary

Remove the redundant 'codemie sdk workflows run' command and keep 'codemie workflow run' as the single canonical CLI entrypoint for executing shared or custom workflows.

This resolves the current duplication in workflow run orchestration without introducing a new shared helper layer for a command surface we no longer want to support.

---

## Problem

The workflow run logic is currently duplicated between:

- 'src/cli/commands/sdk/workflows.ts'
- 'src/cli/commands/workflow.ts'

The duplicated logic includes:

- workflow ID/name resolution
- '--input' parsing
- optional file upload
- execution polling
- interrupted approve/edit/abort flow
- final output rendering

The duplication exists only because the same capability is exposed through two CLI surfaces. Product direction is now to use the unified global command style, so 'codemie workflow run' should remain canonical and the SDK variant should be removed rather than refactored into a shared orchestration helper.

---

## Decision

Prefer eliminating the redundant command surface over extracting shared CLI orchestration.

### Keep

- 'codemie workflow run'

### Remove

- 'codemie sdk workflows run'

### Why

- preserves all user-visible workflow run capabilities
- aligns with unified global CLI structure ('codemie workflow', 'codemie assistants', 'codemie skill')
- removes duplication at the source
- avoids adding a helper abstraction for a path we do not want to keep

---

## Scope

### In scope

- Remove the 'run' subcommand from 'src/cli/commands/sdk/workflows.ts'
- Remove SDK-workflow-run-specific imports that become unused
- Update tests/help expectations that currently reference 'sdk workflows run'
- Keep 'src/cli/commands/workflow.ts' as the only workflow execution entrypoint
- Keep 'runWorkflow' in 'src/cli/commands/sdk/services/workflows.ts' if still used by 'workflow.ts'

### Out of scope

- redesigning the broader 'workflow' command taxonomy
- moving workflow run orchestration into a shared CLI helper
- changing the behavior of 'codemie workflow run'
- changing SDK service-layer contracts

---

## Acceptance Criteria

- [ ] 'codemie sdk workflows run' is no longer available
- [ ] 'codemie workflow run' still supports running workflows by ID or name
- [ ] 'codemie workflow run' still supports '--input', '--file', '--no-wait', and '--json'
- [ ] Existing workflow execution behavior remains unchanged for the global command
- [ ] No duplicate workflow run orchestration remains across 'workflow.ts' and 'sdk/workflows.ts'
- [ ] Tests/help text are updated to reflect the removed SDK run surface

---

## Implementation Notes

Suggested file touch points:

- 'src/cli/commands/sdk/workflows.ts'
  - remove the 'run' subcommand block
  - remove unused imports such as file/prompt/output helpers that were only needed by 'run'
- 'tests/integration/cli-commands/workflow.test.ts'
  - remove or update assertions for 'sdk workflows run --help'
  - keep coverage for 'workflow run'
- optionally review any docs/help snippets that mention the SDK run form

---

## Delivery Recommendation

Use **sdlc-light**.

### Reasoning

This is a small, well-bounded cleanup:

- single responsibility change
- limited file impact
- clear desired outcome
- no architecture exploration required
- no new abstraction is recommended

'sdlc-standard' would be unnecessary overhead unless additional CLI taxonomy changes are bundled into the same task.
