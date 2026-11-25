# Technical Research

**Task**: analytics prompt reduction otlp telemetry
**Generated**: 2026-11-24T13:27:36Z
**Research path**: filesystem

---

## 1. Original Context

Implement the story in /Users/yevhen_slyva/codemie-dev/codemie-code/docs/superpowers/tasks/2026-11-24-epmcdme-17748-prompt-reduction/story.md (Jira EPMCDME-17748 — analytics prompt reduction). Read that story.md file in full; it is the ONLY source of requirements. Do NOT read or reuse anything else under docs/stories/2026-11-24-epmcdme-17748-prompt-reduction/ (technical-analysis.md, complexity-assessment.json, ticket-body.md, arch-review/) or docs/superpowers/tasks/2026-11-23-epmcdme-17748-prompt-obfuscation/ — those are stale. Current branch EPMCDME-17748_prompt-reduction is fresh from origin/main (which includes src/telemetry/runtime/analytics-switch.ts); verify every claim against current code.

(Requirements: story.md ACs 1-17, NG1-NG5, D1-D15. Summarised in Section 8.)

---

## 2. Codebase Findings

### Existing Implementations

**P1: Strip free text from hook-collector events before they leave the machine**
- `maskAndBoundFields` / `boundedText` / `TEXT_FIELD_LIMITS` / `UNMASKED_FIELD_KEYS`, `src/agents/core/otlp-field-limits.ts:9-56`: masks secrets in every field (`maskSecretsDeep`), then cuts `prompt` to 200 and `tool_input`/`tool_response`/`error`/`error_message`/`description` to 300. It is a deny-list of size limits. Fields not listed pass through after masking. `UNMASKED_FIELD_KEYS` (session_id, type, file_path, skill_name, subagent_type, tool_name, agent_type, ...) skip masking. It is a leaf module so that daemon producers can import it. Consumers: `OtlpAgentAdapter.ts:305,341`, `copilot-cli-otlp.unhooked-tools.ts:91,100`, `cowork-events.ts:323,337`.
- `OtlpAgentAdapter.buildEvent` / `limitPayload`, `src/agents/core/OtlpAgentAdapter.ts:295-342`: the single build point for every hook adapter (`claude-code-otlp`, `copilot-chat-otlp`, `copilot-cli-otlp`). It drops `raw` and `droppedFields()`, masks and bounds, merges common fields, and sets `prompt_body = boundedText(limited.prompt, 200)` and `cwd = extractRepository(cwd)`. `event_id` is computed after limiting, from the limited payload (`:308`).
- `mergeCommonFields`, `OtlpAgentAdapter.ts:363-395`: `OVERRIDABLE_FIELD_KEYS = git_branch, repo_remote, story_id, story_source` (`:47`). It re-derives `story_id` from an event's own `git_branch` through `resolveBranchStory`.
- Claude adapter derivations, `claude-code-otlp.plugin.ts:701-731`: `parsePromptFields(typed)`, `resolveCommandFields(typed)` and `resolvePromptSource(prompt)` run on the **raw, untruncated** prompt before `buildEvent`. `droppedFields` drops `message`/`title` on Notification (`:766`).
- `withoutSensitiveFileContent`, `claude-code-otlp/event-fields/tool-fields.ts:131`: for credential files, shrinks `tool_input` to the path and drops `tool_response`. `resolveToolContextFields` (`:22-24`) extracts `subagent_type`, `description` and `skill_name` from the Agent/Skill `tool_input`.
- Copilot CLI: `userPrompt()` and `extractSlashCommand` (`copilot-cli-otlp.plugin.ts:81,293-297`, defined at `copilot-cli/copilot-cli.constants.ts:83,101`). `title` goes through `boundedFreeText` (`:323-324`).
- Copilot Chat: `prompt` is passed as is (`copilot-chat-otlp.plugin.ts:52`). No command parsing.
- Daemon producers outside the adapter: `stampCoworkEvent`, `src/telemetry/runtime/cowork/cowork-events.ts:321-348` (it masks and bounds `prompt_body` itself and sets `git_branch` from the envelope). Also the Copilot usage enrichment, `otlp-spool/copilot-usage-enrichment.ts`.

**P2: Strip free text from native OTLP (`--claude-otlp`)**
- `maskOtlpJson`, `src/providers/plugins/sso/proxy/plugins/otlp-json-masking.ts`: redacts secret-named `KeyValue` attributes and scans every string for secrets. It has no keep-list. It is called from `OtlpInterceptor.handleOtlpJson`, `otlp.plugin.ts:359-400`, which drops the record on failure (fail-closed precedent).
- `handleOtlpBinary`, `otlp.plugin.ts:403-430`: protobuf is spooled **byte-blind and unmasked**. `tests/integration/analytics-secret-egress.test.ts:12` says "by design". The connector sets `OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json'` and `OTEL_LOG_TOOL_DETAILS: '1'`, and lists `http/protobuf` as a historical value (`cli/commands/proxy/connectors/claude-code-otlp.ts:118-132`).

**P3: Redact the local report and `--output` files**
- `redactPayload`, `src/cli/commands/analytics/report/redact.ts:39`: an existing opt-in `--redact` (`analytics/index.ts:252,370`). It blanks `title`, reduces `project` to its basename, drops `agentSessionFile` and masks `projectFilter`. It keeps `branch` and `userEmail`. It applies only to the export payload. Console output (`formatter.ts`) shows no titles (no `title`/`prompt` hits).
- `title` source: `aggregator.ts:415,777` `deriveTitle` (the first user prompt) and `otel-loader.ts:15`. Typed at `report/types.ts:16`. Other string fields per session include `branch`, `project`, `tools`, `skillInvocations`, `agentInvocations`, `commandInvocations` and `dispatches`.

**P4: `analytics sync` content**
- `buildSyncReport`, `analytics/sync/report-builder.ts:37-60`: calls `buildPayload` with no redaction, so the full `title` (first prompt) is uploaded to the webhook or git target. `sync/redact.ts` only removes `sig=` and URL credentials from logs and errors.

**P5: Ticket/command signal extraction**
- `TICKET_RE` (`/(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?!\d)/gi`), `extractTicketMentions` and `parsePromptFields`, `src/agents/core/ticket-parser.ts:14,240,328`. The regex is case-insensitive and results are upper-cased. Filters drop UUID shapes and keys in `NON_TICKET_PREFIXES`. Mentions are capped at 20. The function returns derived values only, never text.
- `resolveBranchStory`, `story-resolver.ts:76`: the branch's first ticket.
- `resolveCommandFields`, `claude-code-otlp/event-fields/command-fields.ts`: `COMMAND_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/`, leading `/` only. The token is the text up to the first whitespace, so `/usr/bin/node` gives the token `usr/bin/node`. It contains `/`, so the regex rejects it and the result is `''`.
- `autoPromptSource`, `prompt-fields.ts:4-22`: knows `<task-notification>` and `<agent-message`. **None found** for a continuation-after-context-reset marker (searched "being continued" and `continuation.ts`; that file handles transcript copies, not prompt text).
- MR/PR detection: **none found** (searched `!\d`, `pull/`, `merge_requests`, "MR" in `src/agents`, `src/cli/commands/analytics`).

**P6: Per-project and global analytics preference**
- `claude-analytics.json` (`claude-code-otlp.preferences.ts`): `enabled`, `excludedProjects[]` (absolute paths) and `collectionGeneration`. Written by `cli/commands/proxy/analytics-command.ts:87-178` and `analytics-targets.ts:104`. Read by `claude-code-otlp.gate.ts:32`, `copilot-analytics-gate.ts:34` and `telemetry/runtime/analytics-switch.ts` (`AnalyticsSwitch.check`, fail-closed on corrupt).
- `ConfigLoader`, `src/utils/config.ts:112` (`LOCAL_CONFIG = '.codemie/codemie-cli.config.json'`). `MultiProviderConfig` (`env/types.ts:206-214`) has no analytics or reduction key. **None found** for a reduction or obfuscation setting (searched `reduc`, `obfusc` in `src/`).

**P7: Fixed placeholder values**
- `REDACTED = '[REDACTED]'`, `src/utils/security.ts:135` (bracketed). Report: `REDACTED_PROJECT_FILTER = '<redacted>'`. Sync: `sig=REDACTED`.

**Other touched code**
- Managed-agent metrics: `providers/plugins/sso/session/processors/metrics/metrics-types.ts`. It carries `error_messages`, `api_errors`, `command_names`, `skill_names`, `agent_names` and `tool_names`, and no prompt text.
- Conversations sync: `sso/session/processors/conversations/` sends message `content` to CodeMie conversation history.
- Setup: `cli/commands/setup.ts` (833 lines). The only analytics prompt is in the subscription providers' setup steps (`anthropic-subscription.setup-steps.ts:55`, "Login to CodeMie platform to enable analytics sync?"; `moonshot-subscription.setup-steps.ts`).

### Decisions Already in the Code
- Mask first, then cut. Free-text limiting is a **deny-list by field name**: new fields pass through masked (`otlp-field-limits.ts:13-20`). Alternative: a keep-list. Reason: none found.
- Derived fields are computed from the raw prompt before truncation (`claude-code-otlp.plugin.ts:707-710`; ARCHITECTURE-OTLP-PLUGIN.md:98,199). This is the convention for "attribution before reduction".
- `cwd` already leaves only as `extractRepository(cwd)` (`parent/current`), never as an absolute path. `repo_remote` is unchanged (`OtlpAgentAdapter.ts:304`).
- Events are built at hook time in the hook process, not in the daemon, because the daemon's env and cwd are frozen at spawn (ARCHITECTURE-OTLP-PLUGIN.md:98). Spool lines hold the already-built event. The forwarder sends them as stored (`forwarder.ts:390-443`).
- `event_id` is a content hash of the limited payload for native hook events (`claude-code-otlp.event-id.ts`, `cowork-events.ts:335`). It is the backend dedup key ("first record wins").
- Protobuf OTLP is byte-blind (`otlp.plugin.ts:402`). A JSON parse or mask failure drops the record rather than sending it raw (`:385-391`).
- Daemon producers must import only the leaf `otlp-field-limits.ts`, not `OtlpAgentAdapter` (import cycle through `sso.proxy`).
- Analytics switches fail closed on a corrupt preference file (`analytics-switch.ts:16-19`).
- Project-scoped analytics preferences are stored as absolute paths in a CodeMie home file (`excludedProjects`). They are not stored in the repo-local config.

### Task Statements Checked Against the Code
- "Secrets are always masked; collectors, proxy, report, sync send prompt cut to 200 chars": **holds** for the hook collectors (`otlp-field-limits.ts:9`) and Cowork. Report and sync carry the **full** first prompt as `title`, uncut (`aggregator.ts:777`, `report-builder.ts:52`). The 200-character cut does not apply there.
- "No obfuscation or reduction setting on main": **holds** for prompt reduction. A partial mechanism exists: report `--redact` (`report/redact.ts`). It keeps `branch`, so it is not equivalent to AC10/AC11.
- "`--claude-otlp` sends tool details but not prompt text": **holds** for the env set (`OTEL_LOG_TOOL_DETAILS=1`, no `OTEL_LOG_USER_PROMPTS`) at `connectors/claude-code-otlp.ts:118-122`.
- "Ticket refs already extracted from raw prompt": **holds** (`ticket-parser.ts:328`, `claude-code-otlp.plugin.ts:717`).
- "Claude Code and Copilot CLI identify a leading slash command; Copilot Chat and Cowork do not": **holds** (`command-fields.ts`, `copilot-cli.constants.ts:101`; `copilot-chat-otlp.plugin.ts:52` and `cowork-events.ts` have no command parsing).
- "Nothing detects MR/PR numbers": **holds** (Section P5).
- "Backend reads prompt text to exclude auto prompts / skip `/clear`": **unverified**. This is backend behaviour. The CLI already sends `prompt_source` (`claude-code-otlp.plugin.ts:722`) for Claude only. A backend contract or sample would settle it.
- AC1 "when they reach the analytics step" of `codemie setup`: **contradicted** for the general setup flow. `setup.ts` has no analytics step. Only the subscription providers' setup steps ask about analytics sync.
- AC1 "project config file ... can be committed": **keeps** `ConfigLoader.LOCAL_CONFIG` in place. Its consumers are `load`, `loadLocalConfigProfile`, `resolveProfileName` and `saveLocalMultiProviderConfig` (`config.ts:112-750`). This repo's `.gitignore:65` ignores `.codemie`, and its own file is force-tracked. No code adds or removes `.codemie` from a user's `.gitignore` (searched `gitignore` in `config.ts`, `setup.ts`).
- AC4 "built-in commands such as `/clear` or `/compact` ... in the prompt": `command-fields.ts` doc says "built-in commands such as `/model` never reach [`UserPromptSubmit`]". Whether `/clear` reaches `UserPromptSubmit` is **unverified** and depends on Claude Code.
- AC7 "continuation prompt after a context reset ... leading marker": no marker constant exists (P5). **Unverified** which marker Claude Code writes.
- AC10 "repository name and git remote kept": **keeps** `cwd` = `extractRepository` and `repo_remote` in place (`OtlpAgentAdapter.ts:304`, `repo-fields.ts:37`). The keep-list does not name envelope identifiers (`session_id`, `event_id`, `timestamp`, `schema_version`, `platform`, `client_version`, `codemie_project_name`, `entrypoint`, `story_marker`, `prompt_source`). Their status is **unverified** against D1.
- AC14 "attribution computed from raw prompt and raw branch": **holds** for prompt mentions. For the branch, `mergeCommonFields` re-derives `story_id` from the event's own `git_branch` after common-field merge (`OtlpAgentAdapter.ts:380-391`). Ordering matters there.
- AC16 "`/usr/bin/node` mid-sentence not a command": **holds** today (the prompt must start with `/`). Ticket false positives: `TICKET_RE` is case-insensitive, so `step-2` and `v1-2` become `STEP-2` and `V1-2`. `v1.2.3` does not match (no `-`).
- NG5 / AC17 "reduction off = main output": **keeps** `maskAndBoundFields` and `maskOtlpJson` in place for every consumer listed in P1 and P2.

### Consumers of Changed Contracts
- `otlp-field-limits.ts` exports: `OtlpAgentAdapter.ts:4,305,341`; `copilot-cli-otlp.unhooked-tools.ts:1,91,100`; `cowork-events.ts:7,323,337`; tests `otlp-field-limits.test.ts`, `OtlpAgentAdapter.test.ts`, `cowork-events.test.ts`, `analytics-secret-egress.test.ts`.
- `ReportPayload` / `ReportSessionRecord.title`/`branch`: `payload-builder.ts:143`, `redact.ts`, `report-generator.ts`, `sync/report-builder.ts`, the client `report/client/app.js` and `template.html`.
- `MultiProviderConfig` (any new key): `ConfigLoader.load*`/`save*` (`config.ts:123-760`); the deep merge at `config.ts:1719`.
- `prompt_body`, `ticket_mentions`, `command_name`, `skill_name`, `subagent_type`, `git_branch`: backend (outside the repo, unverified). Locally: `analytics/otel-loader.ts` (`user_prompt` → turns and title), `cost/dispatch-extractor.ts`, `report/session-source-detector.ts` (classifies by invocation names).
- `event_id` content hash: backend dedup. A reduced and an unreduced copy of the same event get different ids.

### Architecture and Layers Affected
- CLI: `cli/commands/setup.ts`, provider setup steps, `cli/commands/analytics/index.ts` (options), `analytics/report/*`, `analytics/sync/report-builder.ts`.
- Agent core / plugins: `OtlpAgentAdapter.ts`, `otlp-field-limits.ts`, `ticket-parser.ts`, the three `*-otlp` plugins.
- Proxy daemon: `sso/proxy/plugins/otlp.plugin.ts`, `otlp-json-masking.ts`, `otlp-spool/copilot-usage-enrichment.ts`, `sso/session/processors/metrics`.
- Telemetry runtime: `telemetry/runtime/cowork/*`.
- Utils / config: `utils/config.ts`, `env/types.ts`, `utils/security.ts`.

### Integration Points
- Hook process → `POST /hooks` on the local proxy → spool `hooks` stream → `forwarder.forwardHooks` → `CLI_ANALYTICS_EVENT_HOOKS`.
- Claude native OTLP (http/json) → `handleOtlpJson` → `*Json` streams → `forwardOtelJsonStream`.
- `analytics sync` → webhook or git targets (`sync/targets`).
- Managed metrics and conversations → CodeMie API from the SSO session-sync plugin.

### Patterns and Conventions
- Adapter dispatch: one handler per native event, a single `forwardToSpool` (AGENTS.md OTel section).
- Leaf utility modules for logic shared by the daemon and hooks (`otlp-field-limits.ts`).
- Fail-closed gates (`analytics-switch.ts`, `handleOtlpJson`).
- ES modules, `.js` imports, `@/` alias, `logger.debug` plus `sanitizeLogArgs`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/security/security-practices.md`: secret masking, `redactSecrets`, `sanitizeLogArgs`.
- `.ai-run/guides/usage/project-config.md`: precedence is CLI > env > project > global. The local config falls back to global field by field.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md:98-99,199`: the full masking and truncation contract, daemon producers and ticket fields.
- `docs/ARCHITECTURE-PROXY.md` §6.12.3 (Cowork).

### Architectural Decisions
- Protobuf is unmasked by design (`analytics-secret-egress.test.ts:12`).
- Derived fields come from the uncut prompt (OTLP doc:199).
- Notes on unmerged PRs (#710, "masking") at `ARCHITECTURE-OTLP-PLUGIN.md:347`.

### Derived Conventions
- Placeholders are bracketed today (`[REDACTED]`). D11 requires unbracketed `REDACTED:<KIND>`.

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/core/__tests__/otlp-field-limits.test.ts`, `OtlpAgentAdapter.test.ts`, `ticket-parser.test.ts`, `story-resolver.test.ts`.
- `claude-code-otlp/event-fields/__tests__/prompt-fields.test.ts`, `tool-fields.test.ts`, `subagent-fields.test.ts`. Plugin tests for the claude, copilot-cli and copilot-chat adapters.
- `telemetry/runtime/cowork/__tests__/cowork-events.test.ts`, `CoworkEventProducer.test.ts`.
- `proxy/plugins/__tests__/otlp-json-masking.test.ts`.
- `analytics/report/__tests__/payload-builder.test.ts`; `analytics/sync/__tests__/report-builder.test.ts`, `run-sync.test.ts`; `analytics/__tests__/analytics-output-writes.test.ts`.
- `tests/integration/analytics-secret-egress.test.ts`: end-to-end egress check across hook, ingest, spool and forwarder (http/json).

### Testing Framework and Patterns
Vitest (`unit`, `cli` and `agent` projects). `vi.hoisted` plus `vi.mock` with `importActual`. `setupTestIsolation` and a temp `CODEMIE_HOME`. Real temp git repos. `fetch` is faked at the boundary.

### Coverage Gaps
- No test for `report/redact.ts` (no `redact` test under `report/__tests__`).
- No MR/PR pattern tests (no detector exists).
- No setup test covers an analytics choice (`setup.ts` has none).
- Egress test excludes protobuf.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS` (Cowork). Connector-managed `OTEL_*` (`connectors/claude-code-otlp.ts:94-122`). No reduction env var exists.

### Configuration Files
- `~/.codemie/codemie-cli.config.json` (global) and `.codemie/codemie-cli.config.json` (local), both `MultiProviderConfig` v2.
- `~/.codemie/claude-analytics.json` (enabled, excludedProjects), plus the Copilot analytics preferences (`copilot-analytics-preferences.ts`).

### Feature Flags and Deployment Concerns
None found for reduction. The long-lived proxy daemon reads preferences per poll only through `AnalyticsSwitch`.

---

## 6. Risk Indicators

- Speculative: the current limiting is a deny-list (`TEXT_FIELD_LIMITS`). AC10's "any field added later" implies a keep-list applied at every build point: `OtlpAgentAdapter.buildEvent`, `stampCoworkEvent`, `unhooked-tools`, the Copilot usage enrichment, `maskOtlpJson`, report and sync. Any build point that is missed leaks content.
- Protobuf OTLP is byte-blind (`otlp.plugin.ts:402`). With reduction on, a client still exporting `http/protobuf` bypasses any JSON-level keep-list.
- Native OTLP attributes are `KeyValue` data, not properties. A keep-list there works on attribute names, a different shape from hook events.
- `event_id` content hashes change under reduction, so backend dedup sees reduced and unreduced copies as distinct (relevant to NG4 and flag toggling).
- Attribution order: `mergeCommonFields` re-derives the story from `git_branch`. Reducing the branch before this step breaks AC14 (`OtlpAgentAdapter.ts:380`).
- Project-level resolution needs the cwd. Daemon producers (Cowork: the VM repository and `HEAD` branch; Copilot enrichment) run with a frozen env and may not map an event to a project config file.
- `.codemie` is gitignored here (`.gitignore:65`). AC1's "can be committed" depends on each user repo's ignore rules.
- AC1 assumes an analytics step in `codemie setup` that does not exist in `setup.ts` (see Task Statements).
- No continuation-prompt marker is known to the code (AC7). Built-in `/clear` reaching hooks is unverified (AC4).
- `TICKET_RE` is case-insensitive and upper-cases its output. Lowercase hyphenated words such as `step-2` become kept "tickets", which bears on AC16.
- Statement keeps `report --redact` (`report/redact.ts`) in place alongside the new reduced-by-default report. It keeps `branch` (see Existing Implementations P3).
- Conversations sync (`sso/session/processors/conversations`) sends full message content, and the story's route list does not name it (D5 says "every analytics route").
- Managed metrics carry `error_messages` and `api_errors` (`metrics-types.ts`), which are free text on the proxy route.
- Placeholder format conflicts with the existing `[REDACTED]` constant. Tests assert the bracketed value (`otlp-json-masking.test.ts:11`).

---

## 7. Summary for Complexity Assessment

The task spans five layers: CLI (setup, analytics report options, sync), agent core (`OtlpAgentAdapter`, `otlp-field-limits`, `ticket-parser`), three hook adapters (claude-code-otlp, copilot-cli-otlp, copilot-chat-otlp), the proxy daemon (OTLP JSON ingest, Copilot usage enrichment, managed metrics) and the telemetry runtime (Cowork producer), plus config (`ConfigLoader`, `MultiProviderConfig`). Shared chokepoints exist for hook events (`buildEvent`, `maskAndBoundFields`), but at least six independent build points produce outgoing records: buildEvent, stampCoworkEvent, unhooked-tools, copilot enrichment, maskOtlpJson, and report/sync `buildPayload`.

Novel elements: no reduction setting, no keep-list model, no MR/PR detection and no continuation-marker detection exist today. Command parsing exists only for Claude and Copilot CLI. Partial precedents can be reused as patterns: raw-before-truncate derivation, fail-closed JSON ingest, `report --redact`, and project-scoped analytics preferences in `claude-analytics.json`. The setup flow has no analytics step to extend.

Tests are strong around masking, limits, ticket parsing, adapters, Cowork and an end-to-end http/json egress test. Gaps: report redaction, setup analytics, MR patterns, and protobuf. Key risks: the deny-list to keep-list shift across all build points, protobuf bypass, ordering of branch reduction against story derivation, project resolution in the daemon, and `event_id` changes.

---

## 8. External References

- `/Users/yevhen_slyva/codemie-dev/codemie-code/docs/superpowers/tasks/2026-11-24-epmcdme-17748-prompt-reduction/story.md`: resolved. Key facts:
  - Opt-in flag, global or per project. Project "on" only, saved in `.codemie/codemie-cli.config.json`. Either setting on means reduction is on (D8, D10).
  - Reduced prompt is the command name plus ticket and MR refs. Refs only when there is no command. `REDACTED:PROMPT` when there is nothing to keep. Auto prompts become their bare leading marker (`<task-notification>`). Every prompt is reduced (AC3-AC8).
  - MR refs: `!456`, `#456` and MR/PR URLs, each reduced to its number (AC9, D9).
  - Keep-list: metrics, event and tool type names (MCP included), command, skill and agent type names, ticket fields, repository name, git remote. The branch is cut to its ticket keys or `REDACTED:BRANCH`. Everything else is dropped or becomes `REDACTED:<FIELD>`, including future fields (AC10, D1, D7).
  - The report is reduced by default. `codemie analytics --unreduced` applies only to the local report. Sync is always reduced (AC11-AC13, D15).
  - Failure sends `REDACTED:FAILED`, metrics still go out, and the failure is logged without content (AC15). Placeholders are unbracketed `REDACTED:<KIND>` (D11).
  - Out of scope: backend setting (NG1), PII placeholders (NG2), backend changes (NG3), already-stored data (NG4), secret masking with the flag off (NG5).
