# Analytics Prompt Reduction — Spec (EPMCDME-17748)

## Intent

Some projects must not share any project content. Behind an opt-in flag, set globally or for one project, analytics keep only the work signal: which command, skill or agent ran, and on which ticket and MR. Every other piece of content stays out of analytics. Conversation history sync is a separate product feature and is not reduced (see Non-goals). With the flag off, output is unchanged from `main`.

## Approach

One shared leaf module, `src/agents/core/` (the reducer), imports nothing the daemon cannot import, the same way as `otlp-field-limits.ts`.

- **Prompt reduction is a derivation.** `reducePrompt(raw, { commandName, autoMarker })` runs on the raw prompt, next to the adapter's other derivations (`claude-code-otlp.plugin.ts:701-731`). It uses the command name and auto-prompt source the adapter has already derived. Its output is then masked and bounded (200 characters) like any field. This is so that refs past the 200-character cut are not lost. The command grammar (`command-fields.ts`, `copilot-cli.constants.ts:101-113`) and `AUTO_PROMPT_SOURCES` (`prompt-fields.ts:5-8`) move into `src/agents/core/`. The continuation sentence is added there as one more prompt source. `ticket-parser.ts` gains an as-written `findTicketRefs`, with the same filters as `extractTicketMentions`. Output: the auto marker, or the command plus refs, or the refs alone, or `REDACTED:PROMPT`. Refs are de-duplicated case-insensitively and keep the first spelling.
- **One record reducer, one keep-list per schema.** `reduceRecord(record, keepList)` runs last, after `event_id` is computed. Each keep-list is declared beside its schema's type. There are four: the hook event, the native OTLP attribute (by `KeyValue` name), the managed metric (`metrics-types.ts:12-99`), and the report session. Any string field not on its list becomes `REDACTED:<FIELD>`, with the field name in upper kebab case. This also applies to fields added later. `string[]` fields become `['REDACTED:<FIELD>']`. Nested objects not on the list are replaced whole. The native `tool_parameters` field gets a nested keep-list: `skill_name`, `mcp_server_name`, `mcp_tool_name`.
- **Branch reducer.** Branch fields on every schema (`git_branch`, metrics `branch`) are cut to their ticket keys, or become `REDACTED:BRANCH`. The exception is a shared branch name, which is sent as it is: exactly (case-insensitive, whole name, no prefix or suffix) `main`, `master`, `develop`, `dev`, `qa`, `test`, `testing`, `perf`, `stage`, `staging` or `prod`, listed in the constant `SHARED_BRANCH_NAMES` in `src/agents/core/analytics-reduction.ts`. `feature/main` and `test-acme-bank` are still reduced. The rule lives in `reduceBranch`, so it applies on every route. Attribution is unchanged. This runs after `mergeCommonFields` derives the story (`OtlpAgentAdapter.ts:380-391`).
- **Fail closed.** If reducing a field throws, that field becomes `REDACTED:FAILED`, the metrics are still sent, and `logger.debug` logs the field name and the error kind, never the content.

### Build points

1. `OtlpAgentAdapter.buildEvent` (`OtlpAgentAdapter.ts:295-342`), used by the three hook adapters.
2. `copilot-cli-otlp.unhooked-tools.ts`.
3. The Copilot usage enrichment (`copilot-usage-enrichment.ts:105-117`), which follows the decision of its hook-built template.
4. The Cowork producer (`stampCoworkEvent`, `cowork-events.ts:321-348`).
5. Native OTLP JSON, reduced at forward time per session (see Session decision). With reduction on, protobuf records for the session (`otlp.plugin.ts:403-430`) are dropped, and the endpoint still returns 200.
6. Managed metrics, through `reduceRecord` with the metrics keep-list.
7. Report and sync `buildPayload` (`payload-builder.ts`, `sync/report-builder.ts:37-60`). The report applies privacy in one module, `redactPayload(payload, mode: 'redact' | 'reduce')`. `reduce` wins when both modes apply.

### Setting

- **Project.** The flag is a single key, `analytics.promptReduction: true`, in `.codemie/codemie-cli.config.json`. This is story D10. Setup only adds or merges that key. It never creates `activeProfile` or `profiles`, and never changes existing profile content. A file that holds only the flag is not a `MultiProviderConfig` (`isMultiProviderConfig` requires `version`, `profiles` and `activeProfile`, `env/types.ts:241-244`). So `resolveProfileName` and `getActiveProfileName` still fall through to the global profile (`config.ts:550-557,1176-1191`).
- **Global.** The same key, in `~/.codemie/codemie-cli.config.json`.
- **Reading.** Neither file is read through `ConfigLoader.loadJsonConfig`, which returns `{}` on error (`config.ts:664-671`). A dedicated three-way read returns on, off or unreadable. Unreadable counts as on, with a one-time warning until the file reads clean. This is the same shape as `readClaudeAnalyticsSwitch` (`analytics-switch.ts:16-37`). The daemon re-reads the setting per tick and never through `multiProviderCache`.
- **Hookless producers.** Setup also writes the list of opted-in project paths to CodeMie home. The list is stored as absolute paths, like `excludedProjects`, and is read with the same three-way rule.

### Session decision

- **Decided once, at hook time.** The hook process decides per event. Reduction is on when any of these is on: the global setting; the project found by `findNearestConfigDir` from the session pin (`CLAUDE_PROJECT_DIR`); or the project found from the hook-time cwd. The hook reuses the `configDir` that `loadHookConfig` returns (`identity-fields.ts:201-225,266-276`). It never calls `ConfigLoader.load(cwd)` directly.
- **Stamped and carried.** The decision is stamped on the event as the kept field `analytics_reduction`. The daemon binds it to the session next to the session's project, the way `decideProject` binds the project (`session-project.ts:139-178,267-304`). The native OTLP streams, protobuf drops and Copilot enrichment for that session then follow it.
- **Report, sync and managed metrics.** These follow the same resolver, applied to the session's working directory.
- **Cowork.** It follows the global setting, plus the CodeMie-home list matched against the envelope's repository or working directory.
- **Sessions with no hook data.** Native OTLP for such a session is not forwarded today (`completeness-gate.ts:8-14`), and that stays.

### `event_id`

With reduction off, `event_id` is unchanged. With reduction on, the content part is an HMAC-SHA256 of the same payload before reduction, keyed by a random per-install key. The key is kept in CodeMie home and never sent. Distinct prompts stay distinct, and the backend cannot confirm guesses about dropped content.

## Acceptance Criteria

- AC1: `codemie setup` has a new "Analytics privacy" step for every provider. It states what is Sent (commands, skill and agent names, ticket and MR numbers, metrics) and what is Hidden (prompt text, file paths, tool input and output, branch names with ticket keys kept), and that conversation history in CodeMie chat is not affected. It shows "Current: ..." for global and for this project, and defaults to the current state. The prompt is "Hide prompts in analytics?". With global off the choices are Off, On for all projects, and On for this project only (<project>). With global on they are Keep on for all projects, Off, and On for this project only (<project>), where the last choice turns global off and the current project on in one pass. After global is turned off, setup lists the projects that stay on ("Still on for: ..."). The project choice is saved in `.codemie/codemie-cli.config.json`. (story AC1)
- AC1a: Writing the project flag adds or merges only `analytics.promptReduction`. A file that holds only the flag leaves profile selection unchanged. `codemie setup` rewriting the project config (`ConfigLoader.initProjectConfig`) preserves `analytics.promptReduction` by carrying the `analytics` block over. The setup step says that conversation history sync is not reduced. A protobuf `--claude-otlp` connection is reported as two plain lines followed by "Switch to http/json?".
- AC2: Reduction on for project A and off globally reduces A's analytics only, on every route. While the global setting is on, setup offers no project-level off and says that the global setting applies. (story AC2)
- AC3: A prompt that starts with a command or skill invocation is sent as the command name plus the ticket and MR refs found in the whole raw prompt. Other arguments are dropped (`/review-pr !456 check auth` becomes `/review-pr !456`). (story AC3)
- AC4: Command, skill and agent type names are sent unchanged, in the prompt and in their own fields, sdlc-factory or not. This covers slash commands, built-ins such as `/clear` and `/compact`, Skill invocations and Agent calls. The subagent's description and prompt are dropped. (story AC4)
- AC5: A prompt with no command is sent as its refs only, separated by spaces (`EPMCDME-123 !456`). (story AC5)
- AC6: A prompt with nothing to keep is sent as `REDACTED:PROMPT`. (story AC6)
- AC7: An automatic prompt is sent as its bare leading marker, for example `<task-notification>` or `<agent-message`. A continuation prompt after a context reset is sent as exactly `This session is being continued from a previous conversation`, with nothing after it. (story AC7)
- AC8: Every prompt in a session is reduced. (story AC8)
- AC9: `!456`, `#456` and GitLab/GitHub MR or PR URLs are each kept as their number. (story AC9)
- AC10: On every route, each record keeps only its schema's keep-list: metrics, event and tool type names (MCP included), command, skill and agent type names, ticket attribution fields, repository name, git remote, the envelope identifiers in Decisions, and the model usage and session-summary fields (model names, fixed enums, opaque ids and timestamps, which carry no typed text; the backend needs them to price requests). For hook events these are `request_id`, `message_id`, `model`, `model_raw`, `speed`, `inference_geo`, `service_tier`, `stop_reason`, `scope_kind`, `scope_name` (agent.usage.request) and `started_at`, `ended_at`, `models`, `primary_model`, `tools`, `skills`, `agents`, `commands`, `primary_command`, `client_versions` (agent.session.summary); kept containers keep only identifier-like strings. `title`, `compactions`, `branch_counts` and `branch_dominant` stay redacted. The branch is cut to its ticket keys, or `REDACTED:BRANCH`, unless it is exactly a shared branch name (`main`, `master`, `develop`, `dev`, `qa`, `test`, `testing`, `perf`, `stage`, `staging`, `prod`; case-insensitive), which is sent as it is. Every other string or string-list field is dropped or becomes `REDACTED:<FIELD>`, including fields added later. Managed metrics `error_messages`, `api_errors`, `reason` and `branch` are covered. (story AC10)
- AC11: With reduction on, the local report is reduced by default, on screen and in `--output` files. (story AC11)
- AC12: `codemie analytics --unreduced` shows the full local data, sends nothing, and leaves every other route reduced. (story AC12)
- AC13: `analytics sync` is always reduced and has no unreduced option. (story AC13)
- AC14: Ticket attribution gives the same result as with reduction off. (story AC14)
- AC15: A field whose reduction fails is sent as `REDACTED:FAILED`. The metrics are still sent, and the failure is logged without content. (story AC15)
- AC16: Look-alikes are not kept as a command, ticket or MR: `/usr/bin/node` mid-sentence, `#fff`, `# Plan`, `v1.2.3`. A prompt that does not start with a command keeps no command name. (story AC16)
- AC17: Ticket refs are matched case-insensitively and kept as written. This covers Jira-style keys (`EPMCDME-123`, `epmcdme-123`), GitHub `#24` and `org/repo#24`, and Azure DevOps `AB#123`.
- AC18: For a reduced session, protobuf OTLP records are dropped and the endpoint returns 200. The drop is logged once per daemon run, until a JSON request is seen, and the log names the fix (`codemie proxy connect --claude-otlp`). When reduction is turned on, setup reports a `--claude-otlp` connection still on `http/protobuf` and offers the reconnect that migrates it.
- AC19: A session whose hook-time decision is "reduce" has its native OTLP JSON reduced and its Copilot enrichment reduced. A session decided "not reduced" is sent as on `main`. Cowork events are reduced when the global setting is on or their project is on the opted-in list.
- AC20: An unreadable or malformed global or project setting counts as on, and logs a one-time warning.
- AC21: With reduction on, `event_id` is keyed by the per-install key. With reduction off, it is unchanged.
- AC22: With reduction off, analytics output is exactly what `main` produces today. (story AC17)

## Non-goals

- Reading a CodeMie backend project setting. (story NG1)
- PII masking with typed placeholders. (story NG2)
- Backend-side reduction or changes to how the backend stores or shows prompts. (story NG3)
- Reducing data already stored, synced or spooled before the flag was turned on. (story NG4)
- Changing secret masking when reduction is off. (story NG5)
- Changing conversation history sync (`sso/session/processors/conversations/`). It keeps uploading full content, and setup says so.
- Editing a user repo's `.gitignore`.
- Decoding protobuf OTLP.
- Changing profile selection in `config.ts`.

## Decisions

- D10: The project choice is saved in `.codemie/codemie-cli.config.json`, and only "on" is offered at project level. — user, answers AR-2
- D11: Placeholders are unbracketed `REDACTED:<KIND>`.
- The setup step is a new step in the general `codemie setup` flow for every provider, over adding it to the subscription providers' step only. — user
- Envelope identifiers are kept unchanged: session id, event id, timestamp, schema version, platform, client version, CodeMie project name, entrypoint, story marker, prompt source, `analytics_reduction`, and their native OTLP names (`session.id`, `event.name`, `event.timestamp`, `service.name`, `service.version`). This is chosen over redacting them. — user
- Protobuf OTLP is dropped for reduced sessions, over decoding it or passing it through. — user
- Reduction is decided per session at hook time and bound in the daemon, over matching events to a project by attribute. — user, answers AR-1
- Cowork follows the global setting plus a CodeMie-home list of opted-in project paths written by setup, over following the global setting only. — user, answers AR-1
- Managed-metrics error text is reduced, over being left unchanged. — user
- Conversation history sync stays unchanged and setup discloses it, over pausing it. — user, answers AR-6
- The continuation prompt is sent as its fixed opening sentence, over a new `<session-continuation>` marker. — user, answers AR-9
- Ticket matching stays case-insensitive and covers Jira, GitHub and ADO forms, over upper-case-only matching. Look-alikes such as `step-2` are accepted. — user
- The flag is written as a merge of a single key, never creating profile entries, over the `{version, activeProfile, profiles}` template. This mitigates AR-2 within D10.
- The global flag is the same key in the global `codemie-cli.config.json`, over `claude-analytics.json`.
- The setting is read with a fail-closed three-way read, over `ConfigLoader.loadJsonConfig`.
- The prompt reducer runs as a raw-prompt derivation in agent core, over a pass after the 200-character cut.
- There is one `reduceRecord` with a keep-list per schema, over a single shared keep-list.
- `string[]` fields reduce to a one-element `['REDACTED:<FIELD>']`, over a bare string.
- With reduction on, `event_id` is an HMAC with a per-install key over the payload before reduction, over an unsalted hash.
- Shared branch names (`main`, `master`, `develop`, `dev`, `qa`, `test`, `testing`, `perf`, `stage`, `staging`, `prod`) are sent as they are, matched exactly and case-insensitively, over reducing every branch. All other branches keep the ticket-keys-or-`REDACTED:BRANCH` rule. Changes story D7 (branch rule). — user, after approval
- Model usage and session-summary fields are kept, over redacting them, because redacted model names left the backend unable to price requests. — user, after approval
- Refs are emitted as written and de-duplicated case-insensitively, over upper-casing them.
- `report --redact` stays, merged into one report-privacy module where `reduce` wins, over two separate functions.

## Plan notes

- Keep the command, ref and marker regexes linear, and bound the reduced output. Test with a prompt of about 100 KB.

## Assumptions and risks

- If the project file also holds profiles, committing it commits their `apiKey`/`baseUrl`. Committing is only safe for a file that holds only the flag.
- Legacy-format handling of a local file that is not a `MultiProviderConfig` must not treat the `analytics` key as profile fields. The plan verifies `loadLocalConfigProfile`.
- Unverified: whether a session's hook decision reaches the spool before that session's native records are forwarded (the `deliveryGate` ordering). Unverified: the key names inside `tool_parameters`.
- Unverified: whether a Cowork envelope's repository or working directory maps to an on-disk project path.
- Unverified: whether the backend accepts one-element placeholder arrays for `error_messages` and `api_errors`.
- Unverified: whether built-in `/clear` reaches `UserPromptSubmit`.
- Repos that gitignore `.codemie` (this one does, at `.gitignore:65`) need the file force-added.

## Changes after approval (2026-11-25)

- Shared branch names are sent unreduced (AC10, branch decision), through `SHARED_BRANCH_NAMES` in `reduceBranch`. Commit: "feat(analytics): send shared branch names unreduced".
- Model usage and session-summary fields are kept, because redacting them left the backend unable to price requests ("Partial estimate ... REDACTED:MODEL-RAW"). The hook keep-list gains the fields listed in AC10. Commit: "fix(analytics): keep model usage and session summary fields when reduced".
- The setup step is renamed "Analytics privacy", states what is sent and hidden, shows the current state, offers the choices in AC1, lists projects that stay on, and words the protobuf warning as two plain lines plus "Switch to http/json?" (AC1, AC1a). Commit: "feat(cli): clearer analytics privacy step in setup".
- Bug fix: `codemie setup` rewrote the project config from scratch and erased `analytics.promptReduction`. `ConfigLoader.initProjectConfig` now carries the `analytics` block over, and `MultiProviderConfig` has an optional `analytics?: { promptReduction?: boolean }` (AC1a). Commit: "fix(cli): keep analytics setting when setup rewrites the project config".
