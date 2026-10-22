## Summary
Partial fix for EPMCDME-16154 (CLI half). The ticket is **not fully resolved by this PR**: the backend half is still required.

Interactive plain `claude` and Claude Desktop (direct Anthropic API) write background-subagent transcript rows with `stop_reason` null and never update `output_tokens`, so CLI Analytics undercounts session output tokens. This PR makes the CLI mark such requests as partial so the backend can use the OTel `api_request` value instead. `claude -p` and `codemie-claude` transcripts carry final usage and are unchanged.

Ticket: https://jiraeu.epam.com/browse/EPMCDME-16154

## Changes
- `agent.usage.request` gains `output_tokens_partial` (true when the merged request has no `stop_reason`; API-error rows are excluded).
- `agent.subagent.usage` `usage[]` rows and totals carry the flag when any request in the group is partial.
- `output_tokens` is still emitted as before (same-request rows are still max-merged); the CLI does not correct the number itself.
- Handoff for the backend half: `docs/superpowers/tasks/2026-10-22-epmcdme-16154-subagent-output-tokens/backend-plan.md`.

## Ticket acceptance criteria
| AC | Status |
|---|---|
| Session `output_tokens` equals OTel `api_request` total (interactive `claude`, Desktop) | **Not met by this PR**; needs the backend to take `output_tokens` from OTel (or the larger value) when `output_tokens_partial` is true |
| Subagent output equals OTel total of its requests and never exceeds the session total | **Not met by this PR**; same backend change (the session total is built from partial transcript values) |
| `claude -p` and `codemie-claude` stay correct | Covered by the code (emission and max-merge unchanged, flag is additive); not verified against a real session |

Please do not close the ticket on merge; keep it open for the backend change.

## Checklist
- [x] Self-reviewed
- [x] Unit tests added for the flag and the API-error exclusion
- [x] lint, typecheck, build pass
- [ ] Backend change (separate)
- [ ] Verified against real interactive `claude` and `claude -p` sessions
