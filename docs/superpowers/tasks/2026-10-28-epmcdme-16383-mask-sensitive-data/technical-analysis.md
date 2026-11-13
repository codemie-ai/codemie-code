# Technical Research

**Task**: claude-code-otlp analytics hook payload secret masking truncation spool forwarder (EPMCDME-16383)
**Generated**: 2026-10-28
**Research path**: filesystem

---

## 1. Original Context

[CodeMie CLI][Analytics][Security] Secrets in forwarded hook payloads are sent to CodeMie analytics unmasked

Summary
The CLI analytics hook pipeline forwards free-text fields from Claude Code sessions to the CodeMie analytics API without masking secrets. Secret masking is applied only to local proxy logs, not to forwarded event payloads. Credentials read, typed or quoted during any collected session can reach the CodeMie backend.

Affected pipeline
claude-code-otlp hook events -> OtlpAgentAdapter.limitPayload -> proxy daemon spool -> otlp-spool/forwarder.ts -> analytics API. sanitizeLogArgs covers local logs only.

Fields forwarded TRUNCATED (no secret masking)
prompt / prompt_body (UserPromptSubmit): first 200 chars of the user prompt.
tool_input (PreToolUse/PostToolUse): first 300 chars - Bash commands, Write/Edit file content, MCP args, subagent prompts.
tool_response (PostToolUse): first 300 chars - command stdout, Read file content, MCP/WebFetch responses.
error: first 300 chars.
Fields forwarded UNTRUNCATED
last_assistant_message (Stop, SubagentStop, StopFailure): full final assistant/subagent response.
session_crons[].prompt (Stop, SubagentStop): full prompts of scheduled/loop tasks.
background_tasks[].command / description (Stop, SubagentStop): full background task commands.
custom_instructions (PreCompact): full /compact instructions.
message / title (Notification).
Leak scenarios
Session reads .env via Read tool -> first ~150-250 chars of file content (typically the first keys with values) are sent in tool_response.
Session runs cat .env / env / printenv via Bash -> first ~300 chars of stdout are sent.
Assistant quotes a secret in its final reply -> sent in full via last_assistant_message.
User pastes a key into a prompt -> first 200 chars sent.
A secret inside a background task command or a scheduled prompt -> sent in full.
Acceptance Criteria
Given a forwarded event with a free-text field containing a secret (API key, token, password, private key, connection string or another common credential pattern), when it leaves the client, then the secret is masked at hook or spool level, before forwarding.
Given last_assistant_message, session_crons[].prompt, background_tasks[].command, custom_instructions or a Notification message, when the event is forwarded, then the field is truncated to an explicit limit or excluded.
Given a Read of a sensitive file (.env*, credential files, key files), when the event is forwarded, then its tool_response is not sent.
(Negative) Given a field with no secret, when the event is forwarded, then its content is unchanged apart from the existing truncation.
Unit tests cover secret masking for every forwarded free-text field.

Additional requester context: reuse existing masking logic where possible. A comment file (`C:/Repositories/16383.txt`) proposes a per-field consumer check: drop fields no consumer reads (re-add when one appears); for used fields understand the use and, if nothing breaks, truncate and mask.

---

## 2. Codebase Findings

### Existing Implementations
Paths are under `C:/Repositories/codemie-code-dzmitry-halai/src` unless noted.
- `agents/core/OtlpAgentAdapter.ts` is the shared base class. `buildEvent` is at L184-200. `limitPayload` is at L203-224 and is called at L185. `boundedText` is at L226-241. Constants are `MAX_PROMPT_CHARS = 200` (L44) and `export const MAX_TOOL_FIELD_CHARS = 300` (L45).
- `limitPayload` copies the whole hook event with `{...hookEvent}`. It normalises `effort`, then truncates only `prompt` (200) and `tool_input`, `tool_response`, `error`, `description` (300), each via `boundedText`. `boundedText` stringifies objects with `JSON.stringify`, then does `slice(0, max)`. It then does `delete limited['raw']` and returns. **Every other key passes through untouched**: `last_assistant_message`, `session_crons`, `background_tasks`, `custom_instructions`, `message`, `title`, and any field Claude Code adds later.
- `buildEvent` (L188-199): `{...mergeCommonFields(limited,...), ...agentFields, type, session_id, timestamp, cwd, prompt_body: this.boundedText(hookEvent['prompt'], 200), schema_version}`. It then sets `event_id = buildEventId(event, limited, ts)` and returns `{ ...event, raw: { ...event } }` (**L199, not L161 as the comment says**).
  - `prompt_body` is computed from the **unmasked original** `hookEvent['prompt']`, not from `limited`. Masking only inside `limitPayload` would leave `prompt_body` unmasked.
  - `raw` is a shallow copy of the finished event. Masking the event before the spread masks both copies. Masking after it requires masking `raw` as well.
  - `event_id` for native hook events is a content hash of `limited` + timestamp (`claude-code-otlp.event-id.ts` L69-77). Masking inside `limitPayload` changes the id only for events whose content changes, and stays deterministic.
- `agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` holds the per-event handlers (`evaluate` L117-162, one handler per event):
  - `onStopEvent` L220 forwards `{...hookInput, ...gitHeadEnd}`, i.e. the full Stop input with `last_assistant_message`, `background_tasks` and `session_crons`.
  - `onSubagentStopEvent` L372 forwards `{...hookInput, ...stopFields}`.
  - `onStopFailureEvent` L263 and `onPreCompactEvent` L232 forward `hookInput` as is, so `custom_instructions` is included.
  - The default branch at L161 forwards any unhandled event (Notification) whole, so `message` and `title` pass through.
  - `onUserPromptSubmit` L431, `onPreToolUse` L456 and `onPostToolUse` L461 spread `hookInput` plus derived fields.
  - A handler can see the event name, `tool_name` and `tool_input` before `limitPayload`. This is where sensitive-file logic would sit.
- `agents/plugins/claude-code-otlp/event-fields/tool-fields.ts`:
  - `resolveToolContextFields` emits `file_path` only for Edit/Write/MultiEdit/NotebookEdit (`FILE_PATH_KEY_BY_TOOL` L77). **Not for Read.**
  - `resolveSkillForkFields` L68 reads `agentId` from the **uncut** `tool_response` into `fork_agent_id`, because the 300-char cut can lose it.
- The SDK hook types are in `agents/plugins/claude-code-otlp/claude-agent-sdk-hooks.d.ts`:
  - `NotificationHookInput` (L294): `message`, `title?`, `notification_type`.
  - Stop (L579-596) and SubagentStop (L626-634): `last_assistant_message?`, `background_tasks?: BackgroundTaskSummary[]` (description capped at 1000 chars by Claude), `session_crons?: SessionCronSummary[]`.
  - PreCompact: `custom_instructions: string | null` (L458).
- Spool (store as is): `providers/plugins/sso/proxy/plugins/otlp.plugin.ts` L236-252 wraps each event as `{agentName, hookEvent: JSON.stringify(event)}` (`OtlpHookSpoolData`). No transform.
- Forwarder: `providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts`.
  - `unwrapHookRecords` L162-191 forwards `hookEvent` byte for byte. The test and doc contract says it must not change any field (`__tests__/forwarder.test.ts` L33-51).
  - Masking at the forwarder would break that contract and the same-bytes-on-retry guarantee. The base-class hook-time point is consistent with "event is built at hook time".
- Other subclasses share `buildEvent`/`limitPayload`: `copilot-chat-otlp` (same field names `tool_input`/`tool_response`) and `copilot-cli-otlp` (normalises `toolArgs`->`tool_input`, `toolResult.textResultForLlm`->`tool_response` at L161-165). A base-class change affects all three adapters. The ticket scopes claude-code-otlp.
- Event types not named in the ticket may also carry free text: `agent.git.snapshot.git_commits` (`GitCommitSummary`, definition not located), `agent.subagent.usage`/`stop` `description`, `command_args`/`commands` from `command-fields.ts`, and `file_path`. These are unaudited.

### Architecture and Layers Affected
Hook process (agent adapter base class + Claude plugin handlers) -> local proxy daemon spool (`otlp.plugin.ts`, `otlp-spool/spool-io.ts`) -> forwarder -> backend. Masking belongs in the hook-process layer: `OtlpAgentAdapter.limitPayload` (generic) plus Claude handlers (tool-specific). The shared util goes in `src/utils/`. Wiki AGENTS.md says the forwarder is transport-only.

### Integration Points
- `forwardOtlpEventsToSpool` (`agents/plugins/utils.ts`) POSTs `{agentName, hookEvents}` to the daemon. It returns true only on 2xx.
- `session-project.ts` L17-26 (`hookEventProjectNames`) reads `codemie_project_name` from the event top level **and from `raw`**. `raw` has a CLI-side consumer: the project gate and the sealed-prefix filter (`hookRecordIsProject`). Removing `raw` outright would need a change there.

### Patterns and Conventions
ES modules with `.js` import extensions and `@/` aliases. Handlers are one method per event name. Truncation constants are exported from the base class. Docs: `docs/ARCHITECTURE-OTLP-PLUGIN.md` section 2 describes truncation and `raw` ("The event's own `raw` field mirrors the full enriched event"). It must be updated with any change.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/security/security-practices.md` (sanitization section, L110-133, "Always sanitize before logging") covers logging only.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` section 2 (L60, L75, L87) documents pipeline, truncation list and `raw`.
- Backend contract: `C:/Repositories/codemie/.ai-run/guides/integration/cli-analytics-events.md`. Rule 7 (L57): "Text taken from a prompt is cut by the sender to 200 characters, text taken from a tool or a description to 300". Rule 8 (L58) lists the typed hook keys. L72: untyped keys go to `attrs`.

### Architectural Decisions
Comment at `OtlpAgentAdapter.ts` L52-54 and `forwarder.ts` L158-160: the event is fully built at hook time and the forwarder only transports it, byte for byte.

### Derived Conventions
Test-only on explicit request per AGENTS.md, but the ticket explicitly requires unit tests.

---

## 4. Testing Landscape

### Existing Coverage (Vitest, colocated `__tests__/*.test.ts`)
- `agents/core/__tests__/OtlpAgentAdapter.test.ts`:
  - `FakeAdapter extends OtlpAgentAdapter` (L50-93) with mocked processes/config/identity modules.
  - Helpers `run(...)` and `forwarded()` (L105-109).
  - Truncation test L475-491 (prompt 200; tool_input/tool_response/error 300).
  - `raw` tests: effort L493-506, nested raw dropped L516-521, "raw mirrors the enriched event" L523-535.
- `agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`: `fork_agent_id` from the uncut `tool_response` (about L515-535, asserts `tool_response` has length 300 and does not contain the id), `description` (L499), per-event forwarding.
- `.../event-fields/__tests__/tool-fields.test.ts`.
- `otlp-spool/__tests__/forwarder.test.ts` (L1-60: `spoolLine` helper, `fetchMock`, status cases 200/401/403/302/301/500/503; **no 413 case**), `spool-io.test.ts`, `tick-processor.test.ts`.
- `utils/__tests__/security.test.ts` covers `sanitizeValue`/`sanitizeObject`/`sanitizeLogArgs`/`sanitizeHeaders`. Fake secrets carry a `// gitleaks:allow` comment.
- `agents/core/__tests__/config-redaction.test.ts`.

### Testing Framework and Patterns
Vitest, dynamic `await import` after `vi.mock`, `fetchMock` for the forwarder.

### Coverage Gaps
No test for masking of any forwarded field. No test for the unbounded fields (`last_assistant_message`, etc.). No sensitive-file Read test. No forwarder test for 413 or oversized batch.

---

## 5. Configuration and Environment

### Existing Masking Utilities and Gaps (for reuse)
- `utils/security.ts`: `sanitizeLogArgs` (L239), `sanitizeValue` (L82), `sanitizeObject` (L124), private `maskString`, `isSensitiveKey`, `isSensitiveValue`.
  - Works on nested objects and arrays, key-name based: 11 `SENSITIVE_KEY_PATTERNS` (api key, auth/access/refresh/bearer token, password, secret, credential, private key, cookie, authorization). A matching key redacts the whole value.
  - The string value patterns (L46-52) are all anchored `^...$`: `sk-` 20+ chars, `sk-ant-` 95+, `ya29.` 100+, JWT, and `Bearer ...`. A string under 20 chars is never checked.
  - **Gap 1**: whole-string only. A secret embedded in prose, a prompt, a `.env` dump or a command output is NOT detected, because of the anchors. On a plain string, `sanitizeLogArgs` only calls `isSensitiveValue`. **It cannot mask free text as is.**
  - **Gap 2**: no patterns for AWS `AKIA...`, GitHub `ghp_`/`gho_`/`github_pat_`, GitLab `glpat-`, Slack `xox*`, PEM private key blocks, connection strings (`scheme://user:pass@host`), `KEY=value` dotenv lines, `password=`/`token:` assignments, or `Authorization:` header lines.
  - **Gap 3**: `maskString` keeps the first 4 and last 4 chars (`abcd...wxyz [REDACTED]`). That leaks 8 chars of the secret, and it does not preserve surrounding text. Not suitable for forwarded text.
  - Usable as-is: the nested object/array walk shape, the key-name list (for structured `tool_input` objects before stringifying), and `[REDACTED]` as the marker. Not usable as the string masker.
- `agents/core/config-redaction.ts` `redactSecrets`: recursive, key-name regex only, replaces with `***REDACTED***`. No value patterns, so it is useless for free text. Used only for `--show-config` output (`BaseAgentAdapter.ts` L621).
- `hooks/executor.ts` L439-447 calls `sanitizeValue` on `tool_input`/`tool_output` before handing them to user hooks. It has the same limits.
- `utils/processes.ts` `parseGitRemoteUrl` (L418+) strips URL userinfo from git remotes only.
- `cli/commands/analytics/report/redact.ts` blanks titles and paths for reports. It is privacy, not secret masking, and not reusable.
- No existing value-pattern secret scanner at runtime. Gitleaks runs in the repo toolchain (per the `gitleaks:allow` comments) but not as a runtime library. **Conclusion: reuse the structure and tests style of `security.ts`, but a new embedded-pattern string masker (for example `maskSecretsInText(text)`) is required.**

### Environment Variables / Configuration Files
No env vars or flags exist for these limits. Limits are code constants. The spool is configured by `otlp-spool/spool-config.ts` (`OTLP_SEND_MAX_ATTEMPTS`, `OTLP_ALLOW_HOOKS_ONLY_FORWARD`, grace minutes). There is no max batch bytes setting.

### Feature Flags and Deployment Concerns
The daemon outlives CLI upgrades (docs L99/L101). The hook-time change takes effect per hook process immediately. The spool may already contain unmasked old events, which are sent byte for byte, so already-spooled lines are not retroactively masked.

---

## 6. Risk Indicators

- **Order**: mask the full text first, then truncate. Truncating first can cut a secret so no pattern matches the remainder (the comments make the same point). `boundedText` currently does `JSON.stringify` then `slice`, so the masker must run on the full stringified value before the slice.
- **`prompt_body` and `prompt` computed separately** (L195 and L215) from the original value. Both need masking. `raw` duplicates the whole event. Mask before the `{...event, raw: {...event}}` spread, or mask the result of both.
- **Backend `agentId` extraction from `tool_response`** (see Section 7 table): a masker that rewrites `"agentId":"<hex>"` or an overly greedy generic-entropy pattern would break fork attribution. The CLI already supplies `fork_agent_id` from the uncut response for Skill only. `Agent`-tool ends rely on the first 300 chars of `tool_response`.
- **Read-of-sensitive-file**: the Read result is reachable only via `tool_name` + `tool_input.file_path` in the hook input. Bash `cat .env`/`env`/`printenv` has no file argument to key on, so this case relies on value masking only.
- **Shared base class** is used by `copilot-chat-otlp` and `copilot-cli-otlp`. A generic "limit every string" change alters their payloads as well. Field names for those hooks are not audited.
- **Unbounded future fields**: the field list approach goes stale (comments, point 5). A generic recursive "mask and cap every string in the event" in `limitPayload` is the alternative. It touches the structure fields like `session_id`, `cwd`, `timestamp`, `event_id` and `git_branch` unless excluded.
- **Oversized batch / 413 (comments, point 3), verified as real and probably out of scope**:
  - Backend: `codemie/src/codemie/rest_api/routers/cli_analytics.py` L378-379 returns 413 when the body exceeds `ANALYTICS_INGEST_MAX_BODY_BYTES = 5_242_880` (`configs/config.py` L204).
  - CLI: `otlp-spool/spool-io.ts` L368-413 `snapshotPendingHookRecords` reads `readRange(..., cursor, gate.limit)`. `gate.limit` is set only for a sealed session, so **there is no byte cap**: every record after the cursor goes in one POST (`forwarder.ts` L204-251).
  - `forwarder.ts` `send()` L130-139: any non-`ok` status logs and returns `'failed'`. The cursor is not advanced, so the same batch is retried every tick. There is no 413 case and no 413 test.
  - Each event is written twice (`raw` copy), and the unbounded fields grow the batch. This fix reduces but does not remove the risk. A byte-capped batch split or 413 handling is a separate change in `spool-io.ts`/`forwarder.ts`.
- **Line-reference drift in the comments**: `raw` spread is at L199 (not L161). `spool-io.ts` L378 and `forwarder.ts` L130-139 and `fork_attribution.py` L29 are correct. The claim "backend takes `agentId` from the first 300 chars of tool_response" is confirmed (the regex reads the whole stored text, which the CLI has cut to 300).
- Speculative: removing fields entirely (the comments' proposal) is safe for the five untruncated ones per the consumer check below, but dropping `raw` needs the `session-project.ts` change. Truncating-plus-masking instead of dropping keeps forward compatibility if a consumer is added.
- Speculative: a masker applied to `tool_input` after `JSON.stringify` can corrupt the JSON text. Masking on the structured object first (key-aware plus value patterns) and then stringifying is safer. Backend stores `tool_input` as text.

---

## 7. Summary for Complexity Assessment

**Layers and surface.** Hook-process layer only for the core change: `OtlpAgentAdapter.limitPayload`/`buildEvent` (about 40 lines), one new shared masking util (new pattern list, since `security.ts` cannot mask embedded secrets), and a sensitive-file check in the Claude `onPostToolUse` handler (plus likely `onPreToolUse`). The spool and forwarder need no change if masking happens at hook time. About 3-5 source files plus tests plus `docs/ARCHITECTURE-OTLP-PLUGIN.md`. The change touches a base class shared with two Copilot adapters.

**Consumer check (codemie API and control-plane).** I grepped `codemie/src` and `control-plane` for each forwarded field. Anything stored goes into `hook_events`, either as a typed column (vocabulary.py `HOOK_TEXT_FIELDS`, L99-122) or into the residual `attrs` jsonb (`otlp.py` L894-914 `_hook_event_row`).

| Field | Backend use | Verdict |
|---|---|---|
| `prompt_body` | typed column. `session_dims.first_prompt`, auto-prompt and sentinel detection (`rollups.py` L177-179, L1600, L1913) | USED, keep 200-char limit plus mask |
| `prompt` (top level) | untyped, goes to `attrs`, no reader | UNUSED (duplicate of `prompt_body`) |
| `tool_input` | typed column, only declared (`vocabulary.py` L110, `otlp.py` L150); no reader/rollup reference | UNUSED beyond storage |
| `file_path`, `skill_name`, `subagent_type` | used (`rollups.py` L1661, `reader.py` L528) | USED, not free text of concern |
| `tool_response` | **USED**: `"agentId":"..."` regex (`fork_attribution.py` L29-56, L130-138; `reader.py` L915; `rollups.py` L2039) for Agent/Skill tool ends | USED, keep 300-char; mask must not touch `agentId` |
| `fork_agent_id` | used (`fork_attribution.py` L131) | USED |
| `error` | CLI sends `error`, but the typed column is `error_message`, so it lands in `attrs`. No reader | UNUSED |
| `description` (tool events) | no tool-event reader found. `rollups.py` L1444-1461 reads `description` for `agent.subagent.usage`/`stop` only | UNUSED on tool events, USED on subagent events (lower confidence) |
| `last_assistant_message`, `session_crons`, `background_tasks`, `custom_instructions`, `message`, `title` (Notification) | zero references in `codemie/src`; stored in `attrs`, not in `session_dims` (confirms comment point 1). `notification_type` is typed | UNUSED |
| `raw` | no backend reader. **CLI reader**: `session-project.ts` L17-26 | UNUSED by backend, USED by CLI project gate |

Control-plane: `harvest/cp_harvest/sources/codemie_telemetry.py` selects only session, usage and subagent tables (L46-61). The only mention of `hook_events` is the design docs (`docs/design/harvesting-architecture.md` L252), which plan to replicate "typed columns". No code reads hook text fields. Verdict for control-plane: no consumer.

**Test posture.** Existing adapter/forwarder tests give good scaffolding (FakeAdapter, `spoolLine`), but there is no masking, sensitive-file or 413 coverage.

**Sensitive-file Read detection.** `PostToolUse`/`PreToolUse` hook input carries `tool_name` and `tool_input` (`file_path` for Read in Claude Code; confirm against a real payload, since the repo's own `resolveToolContextFields` does not map Read). The handler can match the basename or path against `.env*`, key files (`*.pem`, `*.key`, `id_rsa*`, `*.p12`), and credential files (`credentials`, `.npmrc`, `.netrc`, `.aws/credentials`), then blank `tool_response` (and probably keep `tool_name`/`file_path`). This must run before `limitPayload`. It cannot cover Bash.

---

## 8. External References

- `C:/Repositories/16383.txt`: resolved. Claims checked against code:
  - Fields missing from backend queries: confirmed.
  - `raw` copy duplicates fields: confirmed, at `OtlpAgentAdapter.ts` L199.
  - No byte cap on the batch: confirmed (`spool-io.ts` L378, `gate.limit` is set only for a sealed session).
  - 413 treated as an ordinary failure with no cursor advance: confirmed (`forwarder.ts` L130-139).
  - Backend 5 MB limit: confirmed (`config.py` L204, `cli_analytics.py` L378).
  - `agentId` from the first 300 chars: confirmed (`fork_attribution.py` L29-32).
  - Not verified by me, as the comments also did not: real field sizes, the ingress/nginx limit, and the live DB retention of 90 days.
- Read-only repos: `C:/Repositories/codemie` (resolved) and `C:/Repositories/control-plane` (resolved).
