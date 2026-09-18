## Summary

`codemie setup assistants` and `codemie setup skills` could only be driven through the interactive
wizard, which made them unusable for provisioning and CI. This adds a fully headless path to both
commands so several assistants or skills can be registered from a single non-interactive
invocation, and replaces the pipeline's partial-tolerant behaviour with a fail-fast contract: if any
requested item is not available to the authenticated user, the whole run aborts with a typed error
and a non-zero exit before anything is written to disk.

The interactive wizard already had assistant search and selection, so it is left as-is apart from
the fail-fast change, which now binds both modes rather than headless alone.

## Changes

- New shared modules under `src/cli/commands/shared/`: `headless.ts` (mode detection and flag
  validation), `identifier-resolution.ts` (resolve by id, slug, or case-insensitive exact name with
  distinct not-found and ambiguity errors), plus `executeWithSpinnerStrict` and `registerAllOrAbort`.
- `setup assistants` gains `--assistant`, `--scope`, `--mode` and `-y`; `setup skills` gains
  `--skill`, `--scope` and `-y`. Both `codemie setup …` and `codemie-<agent> setup …` inherit them
  through the shared command factories, with flag-parity tests to keep the two wiring sites in step.
- Headless mode is selected only by the item-selection flags, `-y`, or a non-TTY stdin. `--agent`,
  `--scope` and `--mode` remain wizard preselectors, so existing TTY invocations are unaffected.
- Removed three independent sources of silent partial success: a swallowed per-item fetch, an
  `if (!fullAssistant) continue`, and a spinner that converted thrown errors into `null`.
- Catalog fetches now page fully and union the project and marketplace catalogs, de-duplicated by
  id, so marketplace assistants the wizard can install are no longer reported as "not found".
- Pre-flight authenticates and resolves every identifier and target before the first filesystem
  write. `persistPartialWrites` records what reached disk when a later write fails.
- Headless auth is non-interactive, so a stale session cannot open a re-auth prompt in CI.
- Headless registration is purely additive: it registers the requested items and never unregisters
  ones the request did not name.

## Impact

Headless mode requires `--scope`, `--agent` and, for assistants, the registration mode explicitly —
nothing is auto-detected and no target is guessed. A missing flag is a named error.

There is no filesystem rollback by design: a failure after writes have begun aborts immediately and
reports the items already written by name.

The skills setup notice ("Skills are installed without tools or MCP servers") is printed as plain
output in headless mode with no keypress gate; the interactive Enter gate is unchanged.

Behaviour change worth calling out for reviewers: the interactive skills wizard previously filtered
unavailable ids out silently and reported success. It now aborts, matching the headless contract.

## Checklist

- [x] Self-reviewed
- [x] Manual testing performed
- [ ] Documentation updated (if needed)
- [x] No breaking changes (or documented)

---

Built through the SDLC Factory standard flow. Planning, review and validation artifacts are in
`docs/superpowers/tasks/2026-09-18-codemie-assistant-skill-registration/`.

Quality gates: license, lint, typecheck, commitlint, secrets, build, affected, unit, cli and agent
suites all green. Code review ran the full four-lens profile plus a standards audit; its 17 blocking
findings were fixed and re-verified by a targeted check round (17 resolved, 0 unresolved).
