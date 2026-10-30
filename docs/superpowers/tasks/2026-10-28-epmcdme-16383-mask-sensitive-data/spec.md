# EPMCDME-16383: Mask secrets in forwarded hook payloads

Size: M (complexity 18). Scope: hook-process layer. Masking applies to all three OTLP adapters (`claude-code-otlp`, `copilot-chat-otlp`, `copilot-cli-otlp`); field drops and the sensitive-file Read skip are Claude only; `raw` is removed for all three.

## Problem

Hook events from the OTLP adapters reach the CodeMie analytics API with free text unmasked. Only local logs are protected (`sanitizeLogArgs`). A secret that is read, typed or quoted in a session can leave the machine. For Claude, five fields are also forwarded with no length limit, and every event is sent twice: once in typed fields and once more in a nested `raw` copy.

Pipeline: hook -> `OtlpAgentAdapter.buildEvent`/`limitPayload` (`src/agents/core/OtlpAgentAdapter.ts:184-241`) -> daemon spool -> `otlp-spool/forwarder.ts` -> backend.

## Approach

Fix the event where it is built, at hook time, once, in the shared `OtlpAgentAdapter` base. The spool and forwarder stay untouched (they forward bytes as written; `forwarder.test.ts:33-51`).

**Masking is always on in the base class**, for every adapter, and is not overridable. This follows the ticket (it names `OtlpAgentAdapter.limitPayload`; criteria say "a forwarded event") and gives future adapters the guard by default. The base gets only one Claude-driven extension point, with a default that reproduces today's output: a dropped-field list (default empty). Only `claude-code-otlp` overrides it. The base no longer adds `raw` for any adapter. The sensitive-Read skip lives in the Claude PostToolUse handler, not in the base.

1. **Drop unused fields (Claude).** No reader exists in the analytics backend or control plane for `last_assistant_message`, `session_crons`, `background_tasks`, `custom_instructions`, and Notification `message` and `title`. `limitPayload` removes the fields in the adapter's dropped-field list. `title` is dropped only on Notification events; the session summary event keeps its `title` (the backend reads it, `rollups.py:1221`).
2. **Mask every free-text field (all adapters).** `limitPayload` walks the hook payload (strings, arrays, objects) and masks every string value, so future hook fields are covered by default. It skips a fixed list of identifiers and typed fields: `session_id`, `type`, `timestamp`, `file_path`, `skill_name`, `subagent_type`, `fork_agent_id`, plus the Copilot identifiers `hook_event_name`, `tool_name`, `tool_use_id`, `agent_id`, `agent_type`, `agent_name`, `notification_type`, `error_type`. Non-string values are never touched. Common fields are stamped after `limitPayload` and are not walked.
3. **Mask first, then truncate.** Masking runs on the full value (objects as structures, before stringify), then the existing cut applies: 200 for prompt, 300 for `tool_input`, `tool_response`, `error`, `description`. No new caps. `prompt_body` is built from the masked prompt (today it reads the raw hook value), so it is masked too. `event_id` is computed from the masked payload: unchanged for events without a secret, different only for events that contain one.
4. **Remove `raw` (all adapters).** The backend stores nested `attrs.raw` verbatim and pops only top-level typed fields, so `raw` doubles every field and nothing reads it. The base no longer adds it, so no adapter emits `raw`. Checked: the only CLI reader is `session-project.ts:17-26` (`hookEventProjectNames`), which reads `codemie_project_name` at the top level first. That field is stamped on every event by `resolveIdentityFields` (`identity-fields.ts:38-48`) through `mergeCommonFields`, and `raw` only ever mirrored it, so the project gate sees the same value. `session-project.ts` is left unchanged so already-spooled events that still carry `raw` keep working. `copilot-cli-otlp.usage.ts:120` (daemon-built usage and summary events) also drops its `raw: { ...wire }` copy; its top level already carries `codemie_project_name` from the template, and no existing test covers it.
5. **Skip `tool_response` for sensitive-file Reads (Claude).** The `claude-code-otlp` PostToolUse handler checks `tool_name === 'Read'` and `tool_input.file_path`. If the path is sensitive, `tool_response` is omitted; `tool_name` and `file_path` are kept. The check runs before the event is built and ignores case and path separator. Sensitive means:
   - `.env` and `.env*`
   - `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`
   - `credentials*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`
   - anything under `.aws/`, `.ssh/` or `.gnupg/`

**Copilot check (verified against the code).**
- Copilot payload fields are identifiers, enum-like strings, numbers or free text. Identifiers (`session_id`, `tool_name`, `tool_use_id`, `agent_*`, `hook_event_name`, `notification_type`, `error_type`) are on the skip list; `usage_*` fields on `agent.session.end` are numbers/booleans or model names, never altered; `copilot-cli-otlp.usage.ts` builds its own events in the daemon (without `raw`, item 4), bypasses `limitPayload`, and carries only ids, model names and numbers (no free text). Its template fields come from the already-masked `agent.session.end` event.
- `buildEventId` in both Copilot plugins hashes the `limited` (masked) payload. Copilot CLI cuts some fields to 300 characters in `normalizeEvent` before the base sees them, so its `boundedFreeText` masks the text before cutting (the only change in a Copilot plugin).
- Existing Copilot tests use benign inputs (`'hi'`, `'boom'`, `'plain failure'`) and assert block outputs and `error_message`/`error_type`; none needs adjusting.

## New masker

Add `maskSecretsInText` and a structure-walking variant to the existing `src/utils/security.ts`, next to `sanitizeLogArgs`/`sanitizeValue` (its "Data Sanitization and Redaction" section), not a new file. It shares the `[REDACTED]` marker and sensitive-key list, its imports are light, and its tests extend `src/utils/__tests__/security.test.ts`. The existing `sanitizeValue`/`maskString` are left unchanged: their value patterns are anchored to the whole string and `maskString` leaks 8 characters, so the new functions embed patterns in text instead. A sensitive key redacts its string value.

- Replaces the matched secret with `[REDACTED]`, keeps the surrounding text, shows no part of the secret.
- Patterns (embedded in text):
  - API keys and tokens: `sk-`, `sk-ant-`, AWS `AKIA…`, GitHub `ghp_`/`gho_`/`github_pat_`, GitLab `glpat-`, Slack `xox…`, JWT, `Bearer …`
  - PEM private key blocks; a block cut off before `END` is masked to the end of the text
  - Connection strings and URLs with `user:pass@`
  - `Authorization:` header lines
  - `NAME=value` / `name: value` where the name looks sensitive (password, secret, token, key, credential), including dotenv lines
- Linear-time regexes only. Input is bounded to about 64 KB before masking so a large tool output cannot stall the hook; safe because the final cut is at most 300 characters.
- Must not alter `"agentId":"<id>"` inside `tool_response` (the backend extracts it for fork attribution). No generic entropy or hex pattern.

## Acceptance criteria

1. A secret of each class above, placed in any forwarded free-text field of an event from any of the three adapters, is `[REDACTED]` in the built event, including `prompt_body`.
2. The five dropped fields are absent from `claude-code-otlp` events. No unbounded free-text field remains.
3. No adapter's events carry `raw`, including the daemon-built `copilot-cli-otlp` usage events. `codemie_project_name` is present at the top level, and the project gate (`hookEventProjectNames`, `hookRecordIsProject`) gives the same result as before.
4. A Read of `.env*`, a key file or a credential file produces a Claude event with no `tool_response`. A Read of an ordinary file is unaffected.
5. A field with no secret is unchanged except for the existing truncation. Identifiers and typed fields (the skip list) are never altered, for every adapter.
6. A secret that starts before the cut-off is fully masked, never partly shown.
7. `"agentId":"<id>"` inside a `tool_response` survives masking and truncation, and `fork_agent_id` is unchanged.
8. Tests extend existing files and cases; no new test files. A new case is added only where no existing case can be adapted.
   - `core/__tests__/OtlpAgentAdapter.test.ts` (around 435-528): masking cases for the base, added by extending its existing `limitPayload`/`raw` cases: each free-text field, structure walking, `prompt_body`, skip-list fields untouched, mask-then-truncate. The existing `raw` cases (lines 435-439, 503-505, 516-528) are adjusted to assert the top-level fields and the absence of `raw`; the base default stays nothing dropped.
   - `claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`: Claude-specific only. Adjust the Claude assertions on `raw` (around lines 499, 532, 1007-1013) to check top-level fields and the absence of `raw`; extend existing PostToolUse, prompt and error cases for the dropped fields (a session summary event keeps its `title`) and an unknown future field; add new cases only for what existing ones cannot carry (the sensitive-file Read path table).
   - `src/utils/__tests__/security.test.ts`: the masker's pattern table is added as cases in this file; existing `sanitizeLogArgs`/`sanitizeValue` cases stay as they are.
   - Copilot plugin tests need no change, except one existing Copilot CLI case gets a secret that straddles the 300-character cut (it must be fully masked).
   - Forwarder and spool tests are untouched (code unchanged); `forwarder.test.ts:33-51` remains the guard.
   - Fake secrets carry `// gitleaks:allow`.
9. Docs: update existing sections of `docs/ARCHITECTURE-OTLP-PLUGIN.md` only, no new doc files. §2 covers base-class masking for all adapters, the Claude-only dropped fields and removal of `raw` for all adapters (it currently says `raw` mirrors the full event, line 87), and the project-gate text (lines 77, 81) that says names are read from the top level and `raw`.

## Non-goals

- Removing secrets already sent or already spooled, and any backend change.
- Secrets read through Bash (`cat .env`, `env`, `printenv`); covered by value masking only.
- A general default length cap for unknown fields. Only the existing 200/300 caps and the five drops apply.
- The oversized batch / HTTP 413 sender problem (`spool-io.ts:368-413`, `forwarder.ts:130-139`). Separate ticket; dropping the five fields and `raw` shrinks batches but gives no guarantee.

## Risks left open

- Copilot output now changes for events containing secrets (masking only touches secret-matching strings; the existing 200/300 caps are unchanged), and their `event_id` changes for those events.
- Pattern-based masking is best effort; unrecognised secret formats pass through.
