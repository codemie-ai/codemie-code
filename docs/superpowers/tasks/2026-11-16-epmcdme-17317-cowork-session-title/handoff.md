# Handoff — EPMCDME-17317, CLI side (codemie-code)

**Ticket:** [EPMCDME-17317](https://jiraeu.epam.com/browse/EPMCDME-17317) — CLI Analytics: Claude Desktop auto-generated chat name shown as session prompt instead of first user prompt, for Code tab and Cowork sessions.
**Status: DONE.** Implemented and opened as [PR #829](https://github.com/codemie-ai/codemie-code/pull/829)
on branch `EPMCDME-17317_cowork-session-title`. This doc is now a record of what was done and why, not
a to-do.
**Epic:** EPMCDME-12917. **Ticket owner:** Yauheni Hil. **Cowork code owner:** Aliaksei Piatrovich (already confirmed this change is easy and independent).

## Why this turned out to be required, not optional

Earlier drafts of this doc called this cleanup optional, on the reasoning that the backend fix
(`codemie-dev/codemie`, [MR !4884](https://gitbud.epam.com/epm-cdme/codemie/-/merge_requests/4884))
already covers Cowork regardless of what the CLI sends. That reasoning is sound engineering judgment,
but checking the ticket's own Expected Result text directly (prompted by an automated reviewer's
acceptance-criteria-gap comment on MR !4884) showed it doesn't hold here: the ticket gives the Code
tab an explicit backend-only alternative ("the CLI does not forward `session_title`... **OR** the
backend serves the first prompt"), because the Code tab's hook data genuinely can't tell an auto-name
from a real `/rename` apart. For Cowork, no such "OR" is given — the Expected Result states directly
that "the CLI's Cowork producer does not send Desktop's `title` as `session_title`." The backend being
functionally sufficient doesn't satisfy a requirement the ticket states unconditionally for this one
surface. Hence: implemented, not left optional.

The backend (MR !4884, merged-ready) ignores `session_title` when a session's `entrypoint` is
`claude-desktop`, `claude-desktop-3p`, `local-agent`, or `remote_cowork` — serving the first prompt
instead, in Sessions list, Session Detail, and `worst_session_prompt`. That part remains true and
still covers every already-stored session and every CLI version in the field. This PR is the
additional, ticket-required piece on top: Cowork no longer sends the noise at all.

**Found by live testing on a real Desktop build (not in the original investigation):** Cowork has
*two* distinct entrypoints, not one — `local-agent` for the local-VM mode this PR's fix is scoped to,
and `remote_cowork` for a separate cloud-hosted mode (a remote workspace linked back to the local
machine). `remote_cowork` has **zero footprint anywhere in this repo** — it doesn't come from
`cowork-events.ts` or any other file here, so whatever produces it is either Desktop-native with no
local CLI involvement, or a code path this investigation hasn't found yet. **This PR's fix only
touches the `local-agent` path (`cowork-events.ts`'s own event producer).** If `remote_cowork`
sessions also forward a `session_title` from somewhere, it isn't from the code this PR changed — that
would need its own investigation.

## What was changed

`src/telemetry/runtime/cowork/cowork-events.ts` removed the line that forwarded Claude Desktop's own
auto-generated chat title as the wire event's `session_title` field:

```ts
...(envelope.title && TITLED_TYPES.has(String(own['type'])) && { session_title: envelope.title }),
```

That was `stampCoworkEvent`'s own choice; nothing upstream forced it. Confirmed before removing, as
planned: `envelope.title` and `TITLED_TYPES` had exactly one consumer each (this line), so both were
deleted outright — `CoworkEnvelope.title` from the interface, and `CoworkEventProducer.ts`'s
`title: discovered.title` that populated it — rather than left as disabled dead code. No other
producer or test expected a Cowork event to carry `session_title`. Cowork has no `--name`/`/rename`
equivalent today, so this loses no real information — only the auto-name stops being sent.

## What NOT to do

- Don't try to replicate the backend's `entrypoint` check on the CLI side as a way to "finish" the fix here.
  The backend already owns that decision for every surface (Code tab and Cowork) and for every already-sent
  event; a CLI-side filter would only affect sessions sent *after* the CLI update ships, and the ticket
  explicitly doesn't want two places deciding this.
- Don't touch the Code tab's hook path (`claude-code-otlp.plugin.ts`) — that's the other half of this bug,
  and it's structurally unfixable from the CLI (the hook can't tell Desktop's auto-name apart from a real
  `/rename`; that's *why* the fix had to be in the backend). Nothing to do there.

## Tests

Matches the ticket's own test list for the CLI side:
- `CoworkEventProducer.test.ts`'s full-pipeline test (`CoworkEventProducer.run`) now asserts no
  spooled Cowork event carries `session_title`, including the `agent.session.start` event — even
  though the test fixture's own Desktop metadata (`__tests__/fixtures/cowork-session/metadata.json`)
  sets a real title (`"Synthetic notes task"`). That assertion previously required `session_title` to
  be present; TDD RED confirmed before flipping the production code, then GREEN after.
- `cowork-events.test.ts` — unit-level regression test on `stampCoworkEvent` directly, confirming
  `agent.session.start` and `agent.prompt.submit` never get `session_title`. Since `CoworkEnvelope`
  no longer has a `title` field at all, this is a weaker guarantee on its own (there's nothing to try
  forwarding), but it's cheap insurance against a future regression reintroducing similar plumbing.
- 177 tests pass across the whole `src/telemetry/runtime/` tree; `npm run typecheck` and
  `eslint --max-warnings=0` both clean on the 4 changed files.

## Why entrypoint = `local-agent` for local-VM Cowork (context, already verified — don't re-derive)

In case it's useful background: local-VM Cowork's `entrypoint` comes from `cowork-events.ts:213`
(`state.entrypoint = line.entrypoint`), read directly off Desktop's own transcript line field — *not* from
`CLAUDE_CODE_ENTRYPOINT` like the Code tab (`claude-code-otlp.plugin.ts:315`). Both this repo's own test
fixture and the backend's unmerged Cowork test fixture independently hard-code it as `local-agent`, matching
Desktop's own `local-agent-mode-sessions` directory naming
(`src/telemetry/clients/claude-desktop/claude-desktop.paths.ts:54`). This is how the backend knew to add
`local-agent` to its Desktop-entrypoint set alongside `claude-desktop`/`claude-desktop-3p` — a naive reading
of the ticket would have missed Cowork entirely. Live testing after this (see the update at the top) also
caught `remote_cowork`, a second Cowork entrypoint this reasoning never produced, since it isn't read from
any transcript line this repo writes.
