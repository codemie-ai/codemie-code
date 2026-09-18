# Code review — 2026-09-18-codemie-assistant-skill-registration (2026-09-18)

**approve** · confidence: high · re-check of 17 blocking findings · 17 resolved · 0 unresolved · 0 superseded
Coverage: targeted verifier ✓

## Fix-up verdict

Every blocking finding from the final round is resolved and confirmed in the source at HEAD. The four
criticals are closed:

- `src/cli/commands/shared/headless.ts:38` — [other: CLI compatibility] `--agent`/`--scope`/`--mode` no longer divert a TTY invocation into headless mode — CR-009
- `src/cli/commands/assistants/setup/data.ts:227` — [other: availability] headless catalog is now the project + marketplace union, de-duplicated by id — CR-002
- `src/cli/commands/skills/setup/data.ts:201` — [other: fail-fast] `fetchSkillsByIds` throws `RegistrationItemNotFoundError` instead of filtering silently — CR-015
- `src/cli/commands/skills/setup/index.ts:406` — [other: write ordering] skill details pre-fetched for the whole batch before the first write or unregister — CR-016

## Also resolved

- `src/cli/commands/assistants/setup/index.ts:237` — [config] scope-local read replaces the cross-scope merge, so registries no longer drift — CR-006
- `src/cli/commands/shared/helpers.ts:111` — [infra] `persistPartialWrites` records what reached disk; re-register unregisters per item — CR-011
- `src/cli/commands/shared/identifier-resolution.ts:41` — [other: correctness] duplicate ids and slugs now raise `AmbiguousIdentifierError` — CR-012
- `src/utils/auth.ts:62` — [auth] `nonInteractive` threaded through `getAuthenticatedClient`; no re-auth prompt headlessly — CR-017
- CR-001, CR-003, CR-004, CR-005, CR-010 — catalog paging, `--project` rejection, 50-line limit, `hostAgent` fallback, JSDoc
- CR-007, CR-008, CR-013 — `--mode skill`, command-level partial failure, and multi-target `--agent` now asserted

## Deviations judged and accepted

- CR-001: `minimal_response` left `false` — those rows are the registration payload; round-trip cost bounded by `per_page` 100 instead.
- CR-003: `--project`/`--all-projects` rejected up front — the recommendation's second option.
- CR-012: case-insensitive matching kept per spec; only the silent last-wins pick was fixed.

## Checked and clean

commit-format ✓ · code-quality ✓ (the two rules it flagged, CR-004 and CR-010, are now met) · security ✓ ·
no spec non-goal breached — no rollback, telemetry, `--json`, schema change, or auto-detected target added
