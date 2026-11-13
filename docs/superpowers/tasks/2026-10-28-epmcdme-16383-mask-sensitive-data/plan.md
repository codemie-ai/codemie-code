# EPMCDME-16383: Mask secrets in forwarded hook payloads - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** No secret leaves the client in a forwarded OTLP hook event; unused unbounded Claude fields and `raw` are removed.

**Architecture:** Mask once at hook time in `OtlpAgentAdapter.limitPayload` (all three adapters, always on), using a new embedded-pattern masker in `src/utils/security.ts`. No adapter emits `raw` any more. Claude overrides one base hook (dropped fields) and skips `tool_response` for sensitive-file Reads. Spool, forwarder and `session-project.ts` stay unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import extensions, `@/` alias), Vitest.

## Global Constraints

- Commit nothing: leave all changes unstaged. No new test or doc files; extend existing ones. Fake secrets in tests carry `// gitleaks:allow`.
- Marker is `[REDACTED]`; no part of a secret is shown. Mask the full value first, then apply the existing cuts (200 prompt; 300 `tool_input`, `tool_response`, `error`, `description`). No new caps.
- Never alter `"agentId":"<id>"` in `tool_response`. No generic entropy/hex pattern. Linear-time regexes only; input bounded to ~64 KB before masking.
- Existing `sanitizeValue`/`maskString`/`sanitizeLogArgs` stay unchanged.
- Run only the targeted test file per task (`npx vitest run <file>`); the whole-suite gates are owned by a later stage.

---

### Task 1: Secret masker in `security.ts`

**Files:** Modify `src/utils/security.ts` (new exports in the "Data Sanitization and Redaction" section, near L82-239); Test `src/utils/__tests__/security.test.ts`.

**Interfaces - Produces:**
```ts
export function maskSecretsInText(text: string): string;
/** Walks strings/arrays/objects; masks every string; a sensitive key (existing SENSITIVE_KEY_PATTERNS) redacts its string value.
 *  `skipKeys` applies to top-level keys only. Non-strings untouched. */
export function maskSecretsDeep(value: unknown, skipKeys?: ReadonlySet<string>): unknown;
```

Test-first: yes - a pattern table where each secret class (`sk-`, `sk-ant-`, AKIA, `ghp_`/`gho_`/`github_pat_`, `glpat-`, `xox*`, JWT, `Bearer`, PEM block incl. one cut off before END, `scheme://user:pass@host`, `Authorization:` line, `PASSWORD=`/`token:`/dotenv lines) embedded in prose returns text with `[REDACTED]` in place of the secret and surrounding text intact; a secret-free string is returned unchanged; `{"agentId":"a1b2c3"}` is unchanged; a >64 KB input returns quickly; `maskSecretsDeep` masks nested array/object strings, redacts a `password` key value, leaves numbers and `skipKeys` entries untouched.

- [ ] Add the table cases to `security.test.ts` (new `describe` blocks; existing cases untouched) and see them fail.
- [ ] Implement both functions, reusing the existing sensitive-key list and `[REDACTED]` marker; embed (non-anchored) patterns for the classes above. Run the file; expect pass.

### Task 2: Base-class masking, drop list and no `raw`

**Files:** Modify `src/agents/core/OtlpAgentAdapter.ts:44-45` (constants), `:184-224` (`buildEvent`, `limitPayload`); Test `src/agents/core/__tests__/OtlpAgentAdapter.test.ts` (around L435-535, via `FakeAdapter`).

**Interfaces - Produces (for Task 3):**
```ts
protected droppedFields(_hookEvent: Record<string, unknown>): readonly string[] { return []; }
```

Changes:
- `limitPayload`: remove `droppedFields(hookEvent)` keys, then `maskSecretsDeep` the copy (skip list as top-level keys: `session_id`, `type`, `timestamp`, `file_path`, `skill_name`, `subagent_type`, `fork_agent_id`, `hook_event_name`, `tool_name`, `tool_use_id`, `agent_id`, `agent_type`, `agent_name`, `notification_type`, `error_type`), then apply the existing `boundedText` cuts to the masked values.
- `buildEvent`: `prompt_body` from the masked `limited['prompt']` instead of `hookEvent['prompt']`; return `event` without `raw` (drop `return { ...event, raw: { ...event } }`). Keep `delete limited['raw']` so an incoming hook field named `raw` is still stripped.

Test-first: yes - in `FakeAdapter`, an event with a secret in each free-text field (`prompt`, `tool_input` object, `tool_response`, `error`, `description`, and an unknown extra field) yields `[REDACTED]` in the built event, and in `prompt_body`; a secret straddling char 300 is fully masked; skip-list fields are unchanged; a secret-free event equals today's output apart from `raw`; a subclass overriding `droppedFields` gets the listed fields removed; no built event has `raw`. Adjust the existing `raw` cases (L435-439, 503-505, 516-528) to assert `raw` is absent and the top-level fields are present.

- [ ] Extend the existing truncation/`raw` cases with the above; run, see fail.
- [ ] Implement; run `OtlpAgentAdapter.test.ts`; expect pass.

### Task 3: Claude plugin - drops, sensitive Read

**Files:** Modify `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` (class overrides; `onPostToolUse` L461-466); add `isSensitiveFilePath(path: string): boolean` to `src/agents/plugins/claude-code-otlp/event-fields/tool-fields.ts`; Test `.../__tests__/claude-code-otlp.plugin.test.ts`.

Changes:
- Override `droppedFields`: always `last_assistant_message`, `session_crons`, `background_tasks`, `custom_instructions`, `message`; `title` only when the event is a Notification (the session summary keeps its `title`).
- `isSensitiveFilePath`: case-insensitive, `\` or `/`; true for `.env`/`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `credentials*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, anything under `.aws/`, `.ssh/`, `.gnupg/`.
- `onPostToolUse`: when `tool_name === 'Read'` and `tool_input.file_path` is a string and sensitive, omit `tool_response` from the forwarded payload (compute diff/fork fields from the stripped input); keep `tool_name` and `file_path`.

Test-first: yes - Stop/SubagentStop/PreCompact/Notification events lack the five dropped fields, a session summary event keeps `title`, an unknown future field with a secret is masked, no event has `raw` while `codemie_project_name` is top-level (and `hookEventProjectNames` gives the same result); a Read table (`.env`, `.env.local`, `C:\x\id_rsa`, `a/.aws/config`, `server.PEM` have no `tool_response`; `src/index.ts` keeps it); an Agent/Skill `tool_response` with `"agentId"` survives and `fork_agent_id` is unchanged.

- [ ] Adjust Claude `raw` assertions (~L499, 532, 1007-1013) to top-level checks plus `raw` absent; extend existing PostToolUse/prompt/error/Stop cases; add one new case only for the Read path table. See fail.
- [ ] Implement; run the plugin test file and `tool-fields.test.ts`; expect pass.

### Task 4: Copilot CLI masks before its own cut, no `raw` in usage events

**Files:** Modify `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts:203-206` (`boundedFreeText`: `maskSecretsInText` on the full text, then `slice`) and `copilot-cli-otlp.usage.ts:117-121` (return `wire` without `raw`; no existing test covers it); Test the existing Copilot CLI plugin test (extend one existing case).

Test-first: yes - an existing Copilot CLI case (error/message) gets a secret starting before char 300 and running past it; the normalized field contains `[REDACTED]` and no part of the secret.

- [ ] Extend the case, see fail; apply the one-line change; run that test file; expect pass.

### Task 5: Docs

**Files:** Modify `docs/ARCHITECTURE-OTLP-PLUGIN.md` section 2 only (lines ~60-87).

Test-first: no - document: base-class masking for all adapters (mask, then truncate), Claude-only dropped fields and removal of `raw` for all adapters (replace "raw mirrors the full enriched event", L87), sensitive-file Read skip, and fix the project-gate text (L77, L81) to say names are read from the top level (older spooled events may still carry `raw`).

- [ ] Edit the existing sections; no new files.

---

## Negative-constraint pass

- Spool/forwarder byte-for-byte contract and `session-project.ts` unchanged: no task touches them (Tasks 1-5).
- No change to existing `sanitizeValue`/`maskString`, no backend change, no retroactive masking of spooled lines: Task 1 adds new functions only.
- No generic entropy pattern; `agentId` preserved: Task 1 test, Task 3 test.
- No new default cap for unknown fields: Task 2 reuses the existing cuts.
- Bash `cat .env` not handled by file skip: value masking only (Task 1, 2).
- 413 / oversized batch out of scope: no task.
- No new test/doc files, no commits: Global Constraints.
- No adapter emits `raw`, including the daemon-built Copilot usage events: Tasks 2 and 4.
