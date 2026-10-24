## Summary
CLI half of EPMCDME-16154. The ticket is **not fully resolved by this PR alone**: it is completed together with the backend MR https://gitbud.epam.com/epm-cdme/codemie/-/merge_requests/4608.

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
| Session `output_tokens` equals OTel `api_request` total (interactive `claude`, Desktop) | **Met by the backend MR (!4608)**: a matched partial request takes `greatest(transcript, OTel)`; unpaired partial requests keep the transcript value (known limitation) |
| Subagent output equals OTel total of its requests and never exceeds the session total | **Met by the backend MR (!4608)**: the session-detail subagent row already sums OTel, and the session total is raised to the OTel value |
| `claude -p` and `codemie-claude` stay correct | Covered by the code (emission and max-merge unchanged, flag is additive); not verified against a real session |

Please do not close the ticket on merge of this PR alone; it closes with !4608. The backend currently derives "partial" from `stop_reason` itself and does not store `output_tokens_partial`, so this flag is an explicit signal for consumers and is not required by !4608.

## Checklist
- [x] Self-reviewed
- [x] Unit tests added for the flag and the API-error exclusion
- [x] lint, typecheck, build pass
- [ ] Backend MR !4608 merged
- [ ] Verified against real interactive `claude` and `claude -p` sessions
