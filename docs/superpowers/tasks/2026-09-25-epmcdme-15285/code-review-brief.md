# Code review — 2026-09-25-epmcdme-15285 (2026-09-25)

**request-changes** · confidence: low · 2 blocking · 1 deferred · 2 filtered as noise
Coverage: blind — n/a (balanced profile) · edge-case ✓ · verification-gap — n/a (balanced profile) · acceptance — n/a (no spec)  (1/4 lenses ran; 1/1 applicable)
No story/spec, so acceptance criteria were not audited; confidence is low for that reason.

## Look here first

- `src/cli/commands/proxy/connectors/vscode-models.ts:338` — [other: API routing] `isResponsesOnlyGpt` sends Responses-only GPT ids that are not in the table (e.g. `gpt-5.1-codex`, `gpt-5.6-nova`, non-`openai.` prefixes) to chat-completions, so every request to them fails — CR-002
- `src/cli/commands/proxy/connectors/tenant-catalog.ts:72` — [config] empty or whitespace-only catalog ids get through and are written to chatLanguageModels.json as blank models (not confirmed against live data) — CR-001

## Checked and clean

commit-format ✓ · code-quality ✓ · security ✓ · 1 deferred → code-review-deferred.md
