# EPMCDME-16154 Backend handoff: subagent / session output_tokens

## Diagnosis (Task 2 verdict, from Jira evidence; no local transcript)
- H4 confirmed: with interactive plain `claude` (background subagent), the subagent transcript holds rows with `stop_reason = null` whose `output_tokens` is a placeholder that is never rewritten (OTel final vs transcript: 4766 vs 3, 365 vs 8, 344 vs 16, 314 vs 7, 254 vs 21, 252 vs 4, 160 vs 16, 457 vs 457). Session output on preview 2,448 (main 1,855 + subagent partials 532 + background 61) vs OTel 8,828. Input and cache tokens match; only output is affected.
- `claude -p` (foreground subagent) and CodeMie gateway (`codemie-claude`) transcripts carry final usage and stay correct.
- H1/H2/H3 are real code properties but were not the cause here; no change was made for them.

## CLI change (claude-code-otlp)
Streamed rows are still max-merged per `(request_id || message_id, model)`, so a later final row wins. A request whose merged record has no `stop_reason` is now marked partial:
- `agent.usage.request.output_tokens_partial: boolean` (true when `stop_reason` is empty/null after merging).
- `agent.subagent.usage.usage[].output_tokens_partial: boolean` (true when any request in that group is partial).
`output_tokens` is still emitted unchanged (it is a lower bound when partial). Other fields (`request_id`, `message_id`, `scope_kind`, `scope_name`, `agent_id`, `agent_type`, `stop_reason`) are unchanged. `agent.session.summary` carries no token fields. Replays re-emit merged records, so dedupe by `(session_id, request_id||message_id, model)` taking max.

## Required backend rule
1. For a request with `output_tokens_partial = true`, take `output_tokens` from the paired OTel `api_request` record, or the larger of the two when pairing exists. If unpaired, keep the transcript value and treat it as a lower bound.
2. Session `output_tokens` = sum over distinct requests across main + all subagent scopes. Subagent total = sum of its `agent_id` rows. Subagent <= session.
3. Pairing: by `request_id` when present; Claude Desktop OTel records carry no `request_id`, so pair by fingerprint (timestamp, model, input/cache tokens) backend-side.
4. H5 (unverifiable here): check the Preview session/agent aggregation sums all scopes, and that a scope row is not overwritten on a key collision.

## Rollout and edge cases

- **Rollout order.** `output_tokens_partial` is a new field on `agent.usage.request` and on each
  `agent.subagent.usage` `usage[]` row. Confirm the analytics ingest tolerates unknown fields (no strict
  schema rejection) before the CLI release, or ship the backend change first.
- **Group flag.** On `agent.subagent.usage`, `output_tokens_partial` is true when any request in the group
  is partial, while `output_tokens` is the sum. The flag says "do not trust this sum", not how many
  tokens are affected; per-request detail comes from `agent.usage.request`.
- **Older Claude Code versions.** A transcript that never carries `stop_reason` is flagged partial for
  every request. This is safe: the backend then uses the OTel `api_request` value (or the larger of the
  two), so the result stays correct, only the transcript value is distrusted.
- **API-error rows** have no `stop_reason` by nature and are not flagged partial.

## Acceptance checks
- Session output tokens (Preview) equals OTel `api_request` total (example: 2,448 vs 8,828 must reconcile).
- Subagent output tokens <= session output tokens (example: 1,283 subagent vs 2,701 session).
- `claude -p` and `codemie-claude` sessions are unchanged (rows have `output_tokens_partial = false`).
