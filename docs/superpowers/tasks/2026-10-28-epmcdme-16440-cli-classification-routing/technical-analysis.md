# Technical Research (sliced from parent: codemie-code repository)

## 1. Original Context
Child of EPMCDME-16440; see ../../technical-analysis.md Section 1.

## 2. Codebase Findings
- `src/agents/core/OtlpAgentAdapter.ts` `resolveIdentityFields`: `user_email` from stored SSO credentials, `codemie_project_name`, CLI version. `resolveProjectName` returns the active profile's `codeMieProject`.
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` and `claude-code-otlp.types.ts` (`HookInput` from the Claude agent SDK; no org field read).
- Spool/forwarder: `forwarder.ts` sends `X-CodeMie-Project` plus cookie/JWT; `session-project.ts` binds first project per session; conflicting/unsendable name discards unsent backlog; no name → never sent.
- `ConfigLoader.resolveProfileWorkspace`: global profile ignores repo `.codemie` workspace project (conflicts with AC4 for native Claude).
- Connector: `connectors/claude-code-otlp.ts` (scope user/project at lines 29, 43, 273, 374), `proxy/index.ts` (~317, 348); user scope resets allowlist, project scope appends folder to `CODEMIE_ANALYTICS_PROJECT_FILTER` in `~/.claude/settings.json`.
- codemie-claude: `claude` plugin with `CODEMIE_PROJECT`; `claude.plugin.ts` ~340 reads `ANTHROPIC_BASE_URL` from `~/.claude/settings.json` (only CodeMie-routing signal in source).
- Org evidence (probe 2026-10-27, key names only): `~/.claude.json` `oauthAccount.organizationName|organizationUuid|organizationType|billingType`; `claude auth status --json` keys: loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, configDirectory (no org). Undocumented format.

## 3. Documentation Findings
`.ai-run/guides` exist in the repo (architecture, integration, security, testing); to be loaded at delivery.

## 4. Testing Landscape
Existing tests around gate/spool/config; none for classification evidence or `.codemie` precedence with global profile.

## 5. Configuration and Environment
`CODEMIE_PROJECT`, `CODEMIE_ANALYTICS_PROJECT_FILTER`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR` (to verify), `~/.claude/settings.json`.

## 6. Risk Indicators
- Org source is an undocumented Claude file; must fail to Unknown and never log values.
- Project precedence change affects existing profile-project users (16025 branch also edits the gate path).
- Per-session stability of stamped evidence.
- Unconfirmed: whether codemie-claude events reach the cli-analytics endpoints.
- Overlap: 16383 masking, 16396 opt-out, 16394 proxy consent, 16414 auth.

## 7. Summary for Complexity Assessment
CLI-only change across adapter, config resolution, spool/forwarder binding and two launch modes with two tracking scopes; moderate-to-high novelty, depends on backend contract.

## 8. External References
Consumes contract produced by `backend-ingest-routing` (codemie).


---

## 9. Refresh against live main fd7d2ace and open PRs (2026-10-28)

Facts only, from this checkout (v0.16.2) and read-only PR refs. Paths are under `src/` unless noted; `spool/` = `providers/plugins/sso/proxy/plugins/otlp-spool/`. Contract read: backend `cli-analytics-events.md` ("Classification and routing").

### 9.1 D2: the two launch modes
- **Native Claude** (user settings hooks -> `codemie hook --agent claude-code-otlp`, `cli/commands/hook.ts:1558-1561`): adapter `agents/core/OtlpAgentAdapter.ts` `processOtlpEvent` (60-135) builds the final event in the short-lived hook process (`buildEvent` 184-200; comment 52-54: the daemon env is frozen, so fields are stamped at hook time). Gate `isTracked` runs first (76; `claude-code-otlp.plugin.ts:91` -> allowlist); an untracked project writes nothing.
- Owner identity: `resolveIdentityFields` (`agents/core/event-fields/identity-fields.ts:38`) -> `resolveHookCredentials()` + `resolveIdentity`. The daemon also holds SSO creds. Claude account data is not read anywhere (`oauthAccount` has 0 hits in `src`).
- Project: `resolveProjectName` (83-96): (1) `process.env.CODEMIE_PROJECT` wins; (2) per-session pin `agents/core/session-project-pin.ts` (`~/.codemie/otlp-session-project/<sha256>.json`, 24h TTL, `wx` first-writer-wins); (3) `findNearestConfigDir(CLAUDE_PROJECT_DIR)` + `ConfigLoader.getActiveProfileName/load` -> `config.codeMieProject`. It returns a name only: no origin (link vs profile) is recorded.
- **Link vs global profile seam**: `utils/config.ts:233-248` `resolveProfileWorkspace(workingDir, isLocalProfile)`. For a non-local (global) profile, `IDENTITY_KEYS` (`codeMieUrl, codeMieProject, codeMieIntegration`, 603-607) are deleted from the local workspace and taken only from the global workspace, so a `.codemie` workspace project is ignored when the active profile is global. Callers: `config.ts:135, 1293`, `cli/commands/profile/index.ts:57-58`. #701 (isolate identity) was reverted by #712 on main.
- Repo remote: `resolveRepoFields` (`event-fields/repo-fields.ts:28`) -> `detectGitRemoteRepo` (`utils/processes.ts:539`) -> `parseGitRemoteUrl` (418): lowercased `owner/repo`, host dropped, scheme/port/Azure/Bitbucket normalised. Emitted as event field `repo_remote`. This is NOT the backend's `host[:port]/path` key and not a raw URL; no helper returns the raw `origin` URL (only `workflows/detector.ts:35,148` call `git remote get-url origin` directly).
- Routing signal: `claude-code-otlp/event-fields/session-env-fields.ts:38-58` reads `ANTHROPIC_BASE_URL` (loopback => `codemie-proxy`, other host => `litellm-proxy`, Bedrock/Vertex env => those, empty => anthropic); event fields `provider`/`api_host` only, which cannot tell a CodeMie gateway from another remote host. `connectors/vscode-claude-code.ts:156` writes `ANTHROPIC_BASE_URL=gatewayUrl` (a CodeMie-gateway native case). Whether Claude exports settings.json `env` to hook processes was not verified in code.
- **codemie-claude**: `BaseAgentAdapter.ts` sets `CODEMIE_SESSION_ID` (555), rewrites `CODEMIE_BASE_URL` to the local proxy URL (1076-1084) and maps it to `ANTHROPIC_BASE_URL` through `envMapping` (`claude.plugin.ts:160`; applied 1165-1167). Project = `CODEMIE_PROJECT` from the profile (`sso.template.ts:43`), so in this mode the global profile project beats a `.codemie` link (step 1 of `resolveProjectName`). Its session metrics go via `MetricsApiClient` `POST /v1/metrics` (`providers/plugins/sso/session/processors/metrics/metrics-api-client.ts:110`), not cli-analytics. The `CLI_ANALYTICS_*` endpoints (`sso.http-client.ts:27-30`) are used only by `spool/forwarder.ts`. So codemie-claude reaches cli-analytics only if the user-level claude-code-otlp hooks also fire inside a codemie-claude run; `claude-code-otlp.plugin.ts` has no `CODEMIE_SESSION_ID` guard (compare `copilot-cli-otlp.plugin.ts:50-55`). The hook-process env would then inherit `CODEMIE_PROJECT`, `CODEMIE_SESSION_ID` and the loopback `ANTHROPIC_BASE_URL`.
- Reliable decision point: the hook process (adapter, per event batch); the forwarder/daemon has no per-session env. `otlp.plugin.ts:199-282` `handleHooks` (daemon) only validates and spools; OTLP logs/metrics/traces (`handleOtlp` 284-324) are raw protobuf found by a session-id regex, with no CodeMie fields.

### 9.2 Spool: send / retain / delete today
- Tick `spool/tick-processor.ts:24-102`: `applyProjectPolicyLocked` (`spool-io.ts:159`) then `gateDecision`; `skip` advances OTEL cursors to EOF (71-86).
- "Session without a name is never sent": `session-project.ts:154-158` unbound + hooks present => `DISCARD` for hooks and OTEL; `spool-io.ts:177-186` executes it via `discardBacklogLocked` (134: cursor := file size, silent data loss) and persists. Conflict => discard unless a sealed prefix (`evaluateProjectPolicy` 146-175). `appendSpool` (257-311) decides bind/conflict at append time; `decideProject` is 39.
- Send: `forwarder.ts` `forwardSession` 289 (per session; hooks via `forwardHooks` 204, then each OTEL stream via `forwardOtelStream` 254). One request per session per stream today, but no `X-CodeMie-Session-Id` or evidence header is sent (`postToBackend` 52-82 sets only auth, Content-Type, `X-CodeMie-Project`).
- Response handling is a **single consumer, `send()` 93-148**: status only, body never read on main. `ok` => the caller calls `advanceCursor` (`session-status.ts:131`, monotonic) at 244/274 and `markSessionEnded`; any non-ok (409/503/413 included) => `'failed'` (134-139), cursor untouched, retried next tick (2 min, `spool-config.ts`); 401/403/302 twice => `auth-expired` => `markCredentialsStale`. A backend discard is HTTP 200 => `ok` => the cursor advances (contract: a discard is final). `send()` returns a `SendResult` string and drops the `Response`, so the only seam for a per-session outcome before the cursor advances is inside `send()` or a changed return type feeding 244/274. 409 body `{"reason":"stale_policy","policy_version"}`; OTLP-route discards are protobuf `partial_success.error_message`, not JSON.
- Local re-check `isSendAllowed` (`spool-io.ts:225`) runs under the session lock before each attempt and requires cursor/range equality; a new outcome type must keep it.

### 9.3 Placement facts
- Base URL: forwarder `resolveBaseUrl` (195-201) = `daemon-manager.readState().targetUrl ?? url`; headers: `buildAuthHeadersFromCreds` (38) -> `providers/core/codemie-auth-helpers.ts buildAuthHeaders`. Hook process: `agents/core/hook-credentials.ts resolveHookCredentials`. No policy fetch or cache exists.
- Existing cache/state patterns: JSON under `getCodemiePath(...)` (`utils/paths.ts:385`): `session-project-pin.ts` (TTL, atomic `wx`), `utils/analytics-auth-status.ts` (best-effort, never throws), `spool/auth-state.ts` (stale-credential flag), `claude-code-otlp/__tests__/client-version-cache.test.ts`. Env knobs are read lazily in `spool/spool-config.ts`.
- Tracking scopes (#702, merged): `claude-code-otlp.allowlist.ts` `AllowlistScope = 'user'|'project'` (36); allowlist in `~/.claude/settings.json` `env.CODEMIE_ANALYTICS_PROJECT_FILTER` (31, 52-85); absent = all projects. The gate runs before any classification, so only tracked sessions can carry evidence (`cli/commands/proxy/claude-code-otlp-flow.ts`). Personal sessions are tracked under `user` scope like any other.

### 9.4 Claude config reading
- No reader of `~/.claude.json` identity exists. Existing JSON readers: `session-env-fields.ts:30-36` `readJsonFile` (null on any error, object-shape check, `resolveHomeDir()` join), `claude-code-otlp.allowlist.ts:56-85` (reads `env` only), `utils/mcp-config.ts:83-` (`navigateJsonPath` over `~/.claude.json` `projects.{cwd}`), `claude.plugin.ts:225,233` (hard-coded `~/.claude.json`, ignores `CLAUDE_CONFIG_DIR`), `claude.session.ts:73` (the only `CLAUDE_CONFIG_DIR` reader, for `projects/`). The exact path rule for `CLAUDE_CONFIG_DIR` plus `.claude.json` is not defined in this repo: confirm before relying on it.

### 9.5 Backend contract fields the CLI can already produce
| Contract item | Today |
|---|---|
| `X-CodeMie-Session-Id` | sessionId known in forwarder; not sent |
| `X-CodeMie-Project` | sent (`forwarder.ts:32,64-67`); the backend ignores it for routing without `Project-Source` |
| `X-CodeMie-Project-Source` (`linked_folder`/`profile`) | not produced (no origin tracking) |
| `-Routed-Via-CodeMie`, `-Organization`, `-Subscription-Type`, `-Policy-Version` | not produced; no policy/org code |
| `X-CodeMie-Repo-Remote` / event `repo_remote` | lossy `owner/repo` only (9.1); raw URL not exposed |
| `codemie_project_name` on events | yes (identity-fields); `hookEventProjectNames` reads top level and `raw` (`session-project.ts:18-28`) |
| `user_email`, `developer_name`, `identity_source` | yes |

### 9.6 Open PRs (all OPEN; read via `git fetch origin pull/<n>/head` into temp refs, deleted afterwards; worktree untouched)
- **#707 (head c1bafb52, EPMCDME-16441, 24 files, +2798/-318)**. The head differs from the brief: there is no hook-event rewrite; instead (a) `decideProject` pins the first *sendable* name and never conflicts a bound session (`session-project.ts` 27-52); `hookEventProjectNames` drops the `raw` lookup; (b) new `hook-records.ts` `groupHookRecords` splits a hook batch into one request per `codemie_project_name`, unnamed events under the bound project; `forwardHooks` loops over groups and advances the cursor only after all are `ok` (a failing group re-sends accepted ones); (c) `warnOnBackendDrop` is fire-and-forget on `response.ok` (`void`, `response.text()` raced against 2s, then `body.cancel()`), knows only `cli_analytics_disabled|project_context_required|project_context_conflict`, never affects `SendResult`; (d) `isSendAllowed` allows any sendable project for an unsealed hooks batch (`spool-io.ts` ~250-258); (e) `utils/config.ts` +224 (`resolveProfileWorkspace(workingDir,isLocalProfile,globalProfileIdentity,selectedProfileName)`, `NON_IDENTITY_WORKSPACE_KEYS`) plus migration `...isolate-global-profile-identity`, profile index/display, statusline.
  Seams: `forwarder.ts` `send()` 93-148 and `forwardHooks` 204-251 (textual: both rewritten; our outcome handling must fold into `send()` and the per-group loop; `warnOnBackendDrop` is a second concurrent reader of the same body, so a single body consumer is needed); `session-project.ts` `decideProject`/`evaluateProjectPolicy` and `spool-io.ts` `applyProjectPolicyLocked`/`isSendAllowed` (semantic: "no name => discard" vs our requirement to send folders with neither link nor registered repo; the first-sendable pin can bind a Personal session to a work project name, and `X-CodeMie-Project` on OTLP streams carries that pin); `config.ts:233` `resolveProfileWorkspace` (textual and semantic with link-beats-global). Per-group requests can hide a mismatch between the event project and the OTLP resource project (logs/metrics/traces carry the bound pin only); `project_context_conflict` is the backend's only guard.
- **#711 (head 45f48388, EPMCDME-16396)**: new `claude-code-otlp.gate.ts` `evaluateClaudeAnalyticsGate(cwd)` replaces the `isTracked` body (`plugin.ts` ~91-95), plus `preferences.ts`, `analytics-command.ts`/`-status.ts`, `connectors/claude-code-otlp.ts`, `proxy/index.ts`. Seam: `ClaudeCodeOtlpPlugin.isTracked` and `claude-code-otlp.plugin.test.ts`; it is the consumer of our result (the gate must be able to read `subscription_type`). No overlap with spool files.
- **#710 (head 0a0c0103, EPMCDME-16383)**: `OtlpAgentAdapter.ts` `limitPayload`/`buildEvent` (adds `maskSecretsDeep` with `UNMASKED_FIELD_KEYS`, removes the `raw` mirror `{...event, raw:{...event}}`, adds `droppedFields()`), plugin `ALWAYS_DROPPED_FIELDS`, tool-fields. Seams: any new event field must be in `UNMASKED_FIELD_KEYS` or it is masked; `hookEventProjectNames` reading `raw` becomes dead (compatible with #707); `mergeCommonFields`/`resolveCommonFields` (257-294) if classification fields are added there.
- **#667 (head 6240564d)**: still OPEN, last update 2026-10-21; touches `utils/config.ts` (`getEffectiveActiveProfileName`, `updateLocalConfig`, fallback warnings), `agents/core/AgentCLI.ts`, `cli/commands/profile/*`, `setup.ts`, `env/types.ts`, `.ai-run/guides/usage/project-config.md`. Textual conflict risk with any `ConfigLoader` change in `config.ts`.

### 9.7 Tests, commands, build
- Extend (vitest project `unit`: `src/**/*.test.ts`, alias `@`->`/src`): `spool/__tests__/{forwarder,spool-io,session-project,tick-processor,project-interleave}.test.ts`; `agents/core/__tests__/{OtlpAgentAdapter,session-project-pin,identity-resolver,hook-credentials}.test.ts`; `agents/plugins/claude-code-otlp/__tests__/{claude-code-otlp.plugin,claude-code-otlp.allowlist}.test.ts`; `utils/__tests__/{config-project-override,processes-git,mcp-config}.test.ts`; `providers/plugins/sso/proxy/plugins/__tests__/otlp.plugin.hooks.test.ts`. Convention: dynamic import after `vi.mock` (`.ai-run/guides/testing/testing-patterns.md`). No existing tests for classification, policy fetch or `oauthAccount`.
- Commands: `npx vitest run --project unit <paths>`; `npm run typecheck` (`tsc --noEmit`). Projects `cli`/`agent` (`tests/integration/**`) run the built `bin/` + `dist/`.
- Build: `node_modules` and `dist/` exist from an older base (dist stamped 2026-10-28 10:19 but built from older sources). Unit tests import `src` and need no rebuild; run `npm run build` (`tsc && tsc-alias && copy-plugin && bundle-statusline`) only before the `cli`/`agent` projects or manual `bin/` runs.

### 9.8 Risk indicators added
- Privacy: `resolveProjectName` order (env `CODEMIE_PROJECT` > pin > config) plus the #707 first-sendable pin can attach a work project to a session that should be Personal; the project header is also sent on OTLP streams. The backend ignores `X-CodeMie-Project` without `Project-Source`, but `project_context_conflict` still fires on a body/header mismatch.
- Data loss: `discardBacklogLocked` (spool-io.ts:134) on unbound/conflict, the OTEL `skip` advance (tick-processor.ts:81-86), and a 200 discard => `ok` => `advanceCursor`; 409/503 retain today but never refresh a policy.
- `repo_remote` is lossy (no host): registration lookup cannot be satisfied without a raw or host-bearing remote, and credential stripping must be kept (raw URLs can carry tokens; `parseGitRemoteUrl` strips userinfo).
- codemie-claude reaches cli-analytics only through user-level hooks with no managed-session guard: duplicate or unclassified pipelines are possible and the routed-via-CodeMie signal differs per mode.
- Four open PRs rewrite adjacent code (forwarder, session-project, config, adapter, plugin gate); merge order decides who rebases.
