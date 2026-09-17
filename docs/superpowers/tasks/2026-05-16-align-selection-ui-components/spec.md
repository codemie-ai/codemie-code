# Align Selection UI Components Spec

## Goal

Align CodeMie-owned terminal selection rows so cursor markers, selected markers, labels, metadata, descriptions, and mode controls use consistent gutters across setup and profile-adjacent flows.

## Scope

This task covers custom-rendered selection UIs owned by the CodeMie CLI:

- Assistant setup selection list.
- Skill setup selection list.
- Agent target selection list.
- Assistant setup configuration mode picker.
- Assistant manual registration mode list.
- Shared storage scope picker.

Plain `inquirer` prompts in `profile` and `setup` commands remain unchanged because Inquirer owns their row rendering and cursor layout.

## Design

Add shared row-formatting helpers to `src/cli/commands/shared/selection/ui.ts`. The helpers provide stable spacing for selection rows and description/detail rows while preserving each caller's existing labels, colors, and behaviors.

Migrate custom renderers to those helpers only where their current row shape matches the shared pattern. The assistant and skill list rows use the shared selectable row helper. Agent target selection uses the same helper to remove its hand-rolled cursor and marker spacing. Configuration mode and storage scope use the shared single-choice row helper. Manual configuration uses the shared cursor gutter helper for assistant rows while keeping its mode switch layout intact.

## Acceptance Criteria

- Selected and unselected rows align under the same label column.
- Cursor and non-cursor rows reserve the same cursor gutter.
- Description/detail rows align under item labels, not under the selection marker.
- Existing visible text, keyboard behavior, and selection state behavior stay unchanged.
- Tests cover the shared row formatting and representative migrated renderers.

## Testing

Use focused Vitest tests for the shared selection UI helpers and affected renderer output. Run the targeted tests first, then run typecheck or the broader relevant test command if the focused tests pass.
