# Analytics Prompt Reduction Implementation Plan (EPMCDME-17748)

> **For agentic workers:** implement task-by-task; steps use `- [ ]` tracking. Commit per task using the repository's existing convention.

**Goal:** Opt-in reduction (global or per project) so analytics keep only the work signal (command/skill/agent names, ticket and MR refs, repo, remote); off = byte-identical to `main`.

**Architecture:** One daemon-safe leaf module in `src/agents/core/` (no imports beyond what `otlp-field-limits.ts` imports) provides `reducePrompt`, `reduceRecord`, `reduceBranch`. The hook process decides reduction per event, stamps `analytics_reduction`, and the daemon binds it per session. Every build point calls the same reducer with its schema's keep-list.

**Spec:** `docs/superpowers/tasks/2026-11-24-epmcdme-17748-prompt-reduction/spec.md`. Research: `technical-analysis.md` (same dir).

## Global Constraints

- Placeholders are unbracketed `REDACTED:<KIND>` (`REDACTED:PROMPT`, `REDACTED:BRANCH`, `REDACTED:FAILED`, `REDACTED:<FIELD>` in upper kebab case). `string[]` becomes `['REDACTED:<FIELD>']`.
- Setting key: `analytics.promptReduction: true` in `.codemie/codemie-cli.config.json` (project) and `~/.codemie/codemie-cli.config.json` (global). Either on = on. Unreadable = on, with a one-time warning.
- Reduction off: every existing test still passes unchanged (AC22). Existing `[REDACTED]` secret masking is untouched.
- ES modules, `.js` imports, `@/` alias, `logger.debug` (never content in logs), `getCodemiePath()` for home paths.

## Review Focus

1. A ~100 KB pasted prompt with the ticket at the end: the ref survives (reduction runs on raw text), regexes stay linear, output is bounded to 200 (Task 2).
2. A prompt from a monorepo subdirectory (`packages/x`) with the project flag at the repo root is reduced (Task 4).
3. A malformed project file (merge-conflict markers) counts as on (Task 3).
4. A new, unknown string field on a hook event leaves as `REDACTED:<FIELD>` (Task 1, Task 4).
5. Native OTLP for a project-only opt-in session is reduced even when its first native record arrives on the same tick as its first hook (Task 6).

## Plan notes and open risks (each verified inside its owning task)

- Regexes linear, output bounded, ~100 KB test: Task 2.
- One report-privacy module, `reduce` wins over `--redact`: Task 9.
- No daemon caching; read settings per tick, never via `multiProviderCache`: Tasks 3, 6, 7.
- **Risk, `deliveryGate` ordering** (`otlp-spool/delivery-state.ts`): verify that a session's hook-stamped decision is bound before `forwarder.ts` sends that session's native records. If it is not guaranteed, native records for a session with no bound decision wait a tick (`'wait'`) instead of going out unreduced: Task 6.
- **Risk, `tool_parameters` key names**: confirm `skill_name`, `mcp_server_name`, `mcp_tool_name` against `otlp.plugin.otel-json.test.ts:150-162` and any recorded fixture. If the names differ, use the real names and state it in the task's commit body: Task 6.
- **Risk, legacy `loadLocalConfigProfile`**: confirm that a local file holding only `{analytics:{promptReduction:true}}` is not read as legacy profile fields (`src/utils/config.ts` legacy path) and that `resolveProfileName`/`getActiveProfileName` still fall through to global. Pin it with a test, and do not change profile selection: Task 3.

---

### Task 1: Core record reducer and placeholders

**Files:** Create `src/agents/core/analytics-reduction.ts`, test `src/agents/core/__tests__/analytics-reduction.test.ts`.

**Produces:**
```ts
export type KeepList = { readonly keep: ReadonlySet<string>; readonly nested?: Readonly<Record<string, KeepList>> };
export const placeholder: (kind: string) => string;            // 'gitBranch'|'error_messages' -> 'REDACTED:GIT-BRANCH'|'REDACTED:ERROR-MESSAGES'
export function reduceBranch(branch: string | undefined): string | undefined; // shared names (SHARED_BRANCH_NAMES: main, master, develop, dev, qa, test, testing, perf, stage, staging, prod; exact, case-insensitive) as is; else ticket keys joined by ' ' (as written) or 'REDACTED:BRANCH'
export function reduceRecord<T extends Record<string, unknown>>(record: T, keepList: KeepList): T;
```
Numbers and booleans always pass. Unlisted strings become `placeholder(key)`, unlisted `string[]` become `[placeholder(key)]`, unlisted objects are replaced whole by `placeholder(key)`, and a `nested` entry recurses. Any throw while reducing one field sets that field to `REDACTED:FAILED`, and `logger.debug` logs the field name and `err.name` only.

- [ ] Test-first: yes — `reduceRecord` keeps listed keys, turns an unlisted future field `foo_bar` into `REDACTED:FOO-BAR`, a `string[]` into a one-element array, and a nested object into one placeholder; a getter that throws yields `REDACTED:FAILED` and a debug log without the value; `reduceBranch('feature/EPMCDME-12-secret-client')` gives `EPMCDME-12`, `reduceBranch('main')` and `reduceBranch('Staging')` are sent as they are, and `reduceBranch('feature/main')` and `reduceBranch('test-acme-bank')` give `REDACTED:BRANCH`.
- [ ] Implement; run `npx vitest run src/agents/core/__tests__/analytics-reduction.test.ts` → PASS.

### Task 2: Prompt reducer, shared grammar, ref finders

**Files:** Create `src/agents/core/prompt-grammar.ts` (move `COMMAND_TOKEN_RE`/`resolveCommandFields` from `claude-code-otlp/event-fields/command-fields.ts`, Copilot's `extractSlashCommand` from `copilot-cli/copilot-cli.constants.ts:101-113`, and `AUTO_PROMPT_SOURCES` from `prompt-fields.ts:5-8`; the old modules re-export them). Modify `src/agents/core/ticket-parser.ts` (add finders). Extend `analytics-reduction.ts`. Tests: `ticket-parser.test.ts`, `analytics-reduction.test.ts`, the existing `prompt-fields.test.ts` stays green.

**Produces:** `findTicketRefs(raw: string): string[]` (as written, same filters as `extractTicketMentions`, plus `#24`, `org/repo#24`, `AB#123`); `findMrRefs(raw: string): string[]` (`!456`, `#456`, GitHub `/pull/N`, GitLab `/merge_requests/N` → `!456`/`#456`/`N` as the number form the spec gives); `reducePrompt(raw: string, opts: { commandName?: string; autoMarker?: string }): string`. Add the continuation source `'This session is being continued from a previous conversation'` to `AUTO_PROMPT_SOURCES`. Refs are de-duplicated case-insensitively, first spelling wins, and joined with `' '`.

- [ ] Test-first: yes — table test: `/review-pr !456 check auth` → `/review-pr !456`; `fix EPMCDME-123 see !456` → `EPMCDME-123 !456`; `epmcdme-123 and EPMCDME-123` → `epmcdme-123`; `hello` → `REDACTED:PROMPT`; `<task-notification>…` → `<task-notification>`; continuation prompt → exactly the sentence; `run /usr/bin/node`, `#fff`, `# Plan`, `v1.2.3` keep nothing; `https://github.com/o/r/pull/24` keeps `24`; a 100 KB prompt with `EPMCDME-9` at the end finishes in under 50 ms and returns `EPMCDME-9`.
- [ ] Implement with anchored or non-backtracking regexes, then run the three test files → PASS.

### Task 3: Reduction setting (read, write, opted-in list)

**Files:** Create `src/utils/analytics-reduction-setting.ts`, test `src/utils/__tests__/analytics-reduction-setting.test.ts`. Mirror `readClaudeAnalyticsSwitch` (`src/telemetry/runtime/analytics-switch.ts:16-37`).

**Produces:**
```ts
export type ReductionRead = 'on' | 'off' | 'unreadable';
export function readReductionFlag(configFile: string): Promise<ReductionRead>;             // missing file/key -> 'off'
export function isReductionOn(opts: { configDirs: string[] }): Promise<boolean>;        // global + each project dir; 'unreadable' -> true, warns once per file until clean
export function writeProjectReductionFlag(projectDir: string): Promise<void>;           // merge only analytics.promptReduction; never adds version/activeProfile/profiles
export function writeGlobalReductionFlag(on: boolean): Promise<void>;
export function readOptedInProjects(): Promise<string[] | 'unreadable'>;                // getCodemiePath('analytics-reduction-projects.json'), absolute paths
export function addOptedInProject(absPath: string): Promise<void>;
```
No `ConfigLoader.loadJsonConfig`, no cache.

Note: `ConfigLoader.initProjectConfig` (`src/utils/config.ts`), used by `codemie setup`, rewrote the project config from scratch and erased `analytics.promptReduction`. It now carries the `analytics` block over, and `MultiProviderConfig` has an optional `analytics?: { promptReduction?: boolean }` (see Task 10).

- [ ] Test-first: yes — conflict-marker file → `'unreadable'` and `isReductionOn` true with a single warning across two calls; writing the flag into a file with profiles preserves the profiles byte-for-byte except the new key; writing into an empty repo produces `{"analytics":{"promptReduction":true}}` only; with that flag-only file present, `ConfigLoader.loadLocalConfigProfile(dir, name)`, `resolveProfileName` and `getActiveProfileName` return the same as with no file (legacy-path risk).
- [ ] Implement; if the legacy test fails, stop and report rather than editing profile selection (non-goal). Run the test → PASS.

### Task 4: Hook collectors (buildEvent, three adapters, unhooked tools)

**Files:** Modify `src/agents/core/OtlpAgentAdapter.ts:295-395`, `claude-code-otlp.plugin.ts:701-731`, `copilot-cli-otlp.plugin.ts:81,293-324`, `copilot-chat-otlp.plugin.ts:52`, `copilot-cli-otlp.unhooked-tools.ts:91-100`. Declare `HOOK_EVENT_KEEP_LIST` beside the hook event type. It holds the spec's envelope identifiers plus `analytics_reduction`, `prompt_body`, type/tool/command/skill/agent names, MCP names, ticket fields, `cwd` (repository name), `repo_remote`, and `git_branch` (via `reduceBranch`). It also keeps the model usage and session-summary fields (model names, fixed enums, opaque ids and timestamps): `request_id`, `message_id`, `model`, `model_raw`, `speed`, `inference_geo`, `service_tier`, `stop_reason`, `scope_kind`, `scope_name` (agent.usage.request) and `started_at`, `ended_at`, `models`, `primary_model`, `tools`, `skills`, `agents`, `commands`, `primary_command`, `client_versions` (agent.session.summary), where kept containers keep only identifier-like strings. `title`, `compactions`, `branch_counts`, `branch_dominant`, `tool_input`, `tool_response`, `description` and `error` are excluded. Tests: `OtlpAgentAdapter.test.ts` and the plugin tests.

**Consumes:** Tasks 1-3. The decision is `isReductionOn({ configDirs: [loadHookConfig(...).configDir, findNearestConfigDir(CLAUDE_PROJECT_DIR), findNearestConfigDir(cwd)] })` (`identity-fields.ts:201-276`), never `ConfigLoader.load(cwd)`.

Order in `buildEvent`: adapters compute `prompt_body = reducePrompt(raw, …)` before limiting when on; mask/bound; compute `event_id`; `mergeCommonFields` (story derived from the raw branch); then `reduceBranch` and `reduceRecord`. Copilot Chat has no command, so it passes only refs and markers.

- [ ] Test-first: yes — with the project flag at the repo root and a hook cwd in `packages/x`, a Claude `UserPromptSubmit` of `/review-pr !456 secret` emits `prompt_body: '/review-pr !456'`, `analytics_reduction: true`, `story_id` equal to the off run, `git_branch` cut, `tool_input` absent or redacted, and an injected unknown field redacted; with everything off, the event deep-equals the current output (snapshot of the existing test).
- [ ] Implement; run the adapter and plugin tests → PASS.

### Task 5: Keyed `event_id` under reduction

**Files:** Modify `claude-code-otlp.event-id.ts:43-77` and the `cowork-events.ts:335` caller. Key: 32 random bytes at `getCodemiePath('analytics-event-key')`, mode 0600, created on first use, never logged or sent.

**Produces:** `eventId(payload, { reduced: boolean })`, where reduced means HMAC-SHA256 with the key over the same pre-reduction payload.

- [ ] Test-first: yes — reduced ids differ from the unkeyed hash, are stable across two calls, and differ for two distinct prompts; unreduced ids equal the existing fixture values.
- [ ] Implement; run `claude-code-otlp.event-id` and adapter tests → PASS.

### Task 6: Daemon session binding, native OTLP JSON, protobuf drop

**Files:** Modify `otlp-spool/session-project.ts:139-178,267-304` (bind `analytics_reduction` per session beside the project), `otlp-spool/forwarder.ts` (reduce `*Json` streams per session at forward time), `src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts:403-430` (drop protobuf for reduced sessions, return 200), and declare `OTLP_ATTRIBUTE_KEEP_LIST` (by `KeyValue` key, envelope names `session.id`, `event.name`, `event.timestamp`, `service.name`, `service.version`, and a `tool_parameters` nested list) beside the OTLP reader types. Tests: `forwarder.test.ts`, `delivery-retention.test.ts`, `otlp.plugin.otel-json.test.ts`.

- [ ] Verify `deliveryGate` ordering and the `tool_parameters` key names (see Plan notes), and record the outcome in the commit body.
- [ ] Test-first: yes — a session whose hook stamped `analytics_reduction: true` forwards native JSON with `tool_parameters` reduced to its nested keep-list and `user.email` redacted; an unstamped session forwards as on `main`; a native record whose session decision is not yet bound gets `'wait'`; a protobuf POST for a reduced session returns 200, spools nothing and logs once per daemon run until a JSON request arrives, naming `codemie proxy connect --claude-otlp`.
- [ ] Implement; run the three test files → PASS.

### Task 7: Copilot usage enrichment and Cowork producer

**Files:** Modify `otlp-spool/copilot-usage-enrichment.ts:105-117` (follow the template's `analytics_reduction`, apply `HOOK_EVENT_KEEP_LIST`), `src/telemetry/runtime/cowork/cowork-events.ts:321-348` (reduced when the global flag is on or the envelope's repository/working directory matches `readOptedInProjects()`; `'unreadable'` → reduced). Tests: `copilot-usage-enrichment` tests, `cowork-events.test.ts`.

- [ ] Test-first: yes — an enrichment row from a reduced template carries no free text and a kept `analytics_reduction`; a Cowork event whose working directory is on the opted-in list is reduced, an unlisted one with global off is unchanged, and a corrupt list reduces it. If no envelope field maps to a disk path, test the global-only path and note the limit in the commit body (spec risk).
- [ ] Implement; run tests → PASS.

### Task 8: Managed metrics

**Files:** Declare `METRICS_KEEP_LIST` beside `metrics-types.ts:12-99`; apply `reduceRecord` plus `reduceBranch` in `metrics-api-client.ts` (around `:416,556`, where records are sent) when `isReductionOn` for the session's working directory is true. Test: `metrics-api-client` test.

- [ ] Test-first: yes — with reduction on, the posted body has `error_messages: ['REDACTED:ERROR-MESSAGES']`, `api_errors: ['REDACTED:API-ERRORS']`, `reason: 'REDACTED:REASON'`, `branch` cut, and name lists and counts unchanged; off → identical to the current body.
- [ ] Implement; run test → PASS.

### Task 9: Report and sync privacy

**Files:** Modify `src/cli/commands/analytics/report/redact.ts` to `redactPayload(payload, mode: 'redact' | 'reduce')`, with `REPORT_SESSION_KEEP_LIST` beside `report/types.ts:16`; in `reduce` mode `title` becomes `reducePrompt(firstPrompt)` and `branch` is cut. `analytics/index.ts:252,370` adds `--unreduced` (local only), and the reduced default also applies to console and `--output`. `sync/report-builder.ts:37-60` always uses `reduce` when on and has no override. Tests: create `report/__tests__/redact.test.ts`, extend `sync/__tests__/report-builder.test.ts` and `analytics-output-writes.test.ts`.

- [ ] Test-first: yes — with reduction on, `--output` has reduced titles and branches; `--unreduced` shows full titles locally while sync output stays reduced; `--redact` together with reduction gives the `reduce` result; reduction off with `--redact` gives the same output as today.
- [ ] Implement; run tests → PASS.

### Task 10: Setup step

**Files:** Add a step to `src/cli/commands/setup.ts` (all providers), headed "Analytics privacy". It states what is Sent (commands, skill and agent names, ticket and MR numbers, metrics) and Hidden (prompt text, file paths, tool input and output, branch names with ticket keys kept), says that conversation history in CodeMie chat is not affected, and shows "Current: ..." for global and this project, defaulting to the current state. Prompt: "Hide prompts in analytics?". With global off the choices are Off, On for all projects, On for this project only (<project>). With global on they are Keep on for all projects, Off, On for this project only (<project>); that last choice turns global off and the current project on in one pass, and after global goes off the step lists "Still on for: ...". A project "on" calls `writeProjectReductionFlag` and `addOptedInProject`. When turning reduction on, it detects a `--claude-otlp` connection on `http/protobuf` (`connectors/claude-code-otlp.ts:115-139`), shows a two-line plain warning and asks "Switch to http/json?". `ConfigLoader.initProjectConfig` (`src/utils/config.ts`) carries the `analytics` block over so setup never erases the flag. Test: setup test with a mocked prompter.

- [ ] Test-first: yes — choosing project writes only the flag plus the home list entry; each menu (global off, global on) offers exactly its choices, the combined choice turns global off and the project on, and the "Still on for" list appears; the disclosure line is shown; a protobuf connection triggers the "Switch to http/json?" offer; a setup rerun keeps `analytics.promptReduction` in the project config.
- [ ] Implement; run test → PASS.

---

## Negative constraints (spec Non-goals and "not" clauses)

- Conversation history sync (`sso/session/processors/conversations/`) is not touched by any task; Task 10 only discloses it.
- No user `.gitignore` edit: Task 10 writes only the config and home list.
- Protobuf is never decoded; Task 6 only drops it.
- Profile selection in `config.ts` is not changed: Task 3 pins it with a test and stops on failure.
- Secret masking with reduction off is unchanged; every task has an "off = current output" assertion.
- No backend setting read, no backend change, no reduction of already-spooled data: Task 6 reduces only records whose session decision is bound now, and does not rewrite the spool.
- The setting is never read via `ConfigLoader.loadJsonConfig`/`ConfigLoader.load(cwd)`/`multiProviderCache` (Tasks 3, 4, 6).

## Changes after approval (2026-11-25)

- Task 1 and Task 4: shared branch names are sent as they are (`SHARED_BRANCH_NAMES` in `reduceBranch`), and the hook keep-list also keeps model usage and session-summary fields. Commits: "feat(analytics): send shared branch names unreduced", "fix(analytics): keep model usage and session summary fields when reduced".
- Task 10: the setup step was reworded and extended. Commit: "feat(cli): clearer analytics privacy step in setup".
- Tasks 3 and 10: `codemie setup` no longer erases the flag, because `ConfigLoader.initProjectConfig` carries the `analytics` block over. Commit: "fix(cli): keep analytics setting when setup rewrites the project config".
- Tasks 3 and 10: Off in the setup step now turns off the current project too (`writeProjectReductionFlag(dir, false)` and the new `removeOptedInProject`). Commit: "fix(cli): let setup turn off project-level analytics privacy".
- Review fixes touched tasks 1-4, 6-8, 9 and 10: nested project configs are read in full (`findAllConfigDirs`), the branch is cut by `reduceHookEvent`, native OTLP strings are redacted by default, hook and rule names leave the managed-metrics keep-list, the console report and Cowork prompt path were tightened, and the setup step was restructured. See "Code review fixes" in the spec's "Changes after approval".
- Request and issue URLs keep their path word with the number (`pull/812`, `merge_requests/77`, `merge-requests`, `pull-requests`, `pullrequests`, `pullrequest`, `issues/31`, `work_items/33`), so a reduced prompt shows what the number is. `MR_URL_RE` in `findMrRefs` and `ISSUE_URL_RE` in `findTicketRefs` (`ticket-parser.ts`). Commit: "fix(analytics): keep the path word of pull, merge request and issue urls".
- A reduced prompt ends with `REDACTED:REST_PROMPT` (`PROMPT_CUT_MARKER` in `analytics-reduction.ts`) when text was removed, so analytics show the prompt was cut. Nothing is added when the prompt held only the kept parts, or when it is fully `REDACTED:PROMPT`. The marker fits inside the 200 character limit. Commit: "feat(analytics): mark reduced prompts that had text removed".
