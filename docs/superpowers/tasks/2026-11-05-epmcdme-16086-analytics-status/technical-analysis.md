# Technical Research

**Task**: proxy status analytics spool
**Generated**: 2026-11-05
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-16086 (Bug, High): "[CLI Analytics] [Standalone] codemie proxy status reports healthy while analytics forwarding is stopped".
Description: `codemie proxy status` can report `Status: running, healthy` even when CLI Analytics telemetry is not delivered. Reproduced: daemon running, local endpoint OK, >1 MB telemetry stuck in local spool, spool cursors not advancing, no analytics reaching Standalone (e.g. SSO credentials expired and forwarding did not recover after re-auth). Example observed: "Undelivered telemetry: 1,016,445 bytes; Spool cursors advancing: 0 / 11; Remote analytics delivery: not working".
Expected: `codemie proxy status` should distinguish daemon health from analytics delivery health (e.g. "Daemon: healthy / Analytics delivery: unhealthy") and expose whether telemetry is being delivered, spool backlog is growing, analytics credentials are stale, pending telemetry is draining.
Root cause: status checks only daemon/process and local endpoint reachability; does not validate OTLP forwarding success, spool cursor progress, backlog, stale credentials, end-to-end delivery.

User's additional notes (authoritative, override ticket where they conflict):
1. Since the ticket was created, analytics-specific commands were added: `codemie proxy analytics status` and `codemie proxy analytics status --claude-code-otlp` (see EPMCDME-16396). Requirements must be re-analysed for a consistent solution: e.g. `codemie proxy status` shows a very basic one-line analytics field plus a tip to run the analytics command; or, if `proxy status` already supports showing issue details, it may also show analytics-related issues.
2. The ticket's suggested metrics (delivered?, backlog growing?, stale credentials?, draining?) must be evaluated for complexity / impact / usefulness — determine what data actually exists today to compute each one (spool files, cursors, forwarder state, last success/failure timestamps, credential expiry, etc.).
3. Restyle `codemie proxy analytics status` and `codemie proxy analytics status --claude-code-otlp` to the same report style as `codemie proxy status` (colors, indentation, "Status: running, healthy" form). Fields may be revised to be short, clear and consistent.
4. Must be tool-agnostic (Claude, Copilot, codemie-code, other OTLP adapters / spools).

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A — "Tell me whether the proxy daemon is healthy"**
- `proxy status` action — `src/cli/commands/proxy/index.ts:210-322`. Reads `checkStatus()` (pid + `proxy-daemon.json`), runs `checkProxyHealth` (shallow `/health`; `--deep` adds `GET /v1/llm_models` via gateway). Text output: `Status:  <green "running, healthy" | "running, healthy (upstream OK)"> | <yellow "running but UNHEALTHY">` then 2-space-indented `  Reason:`, `  URL:`, `  Port:`, `  API Key:`, `  Profile:`, `  Client:`, `  Project:`, `  Uptime:` (labels padded to 9 chars). Issue reporting already exists: yellow `  Warning:` + `           Repair:` lines for Claude Code OTLP endpoint mismatch (`:305-316`, from `checkClaudeCodeOtlpEndpoint`), and yellow `  Note:    last recorded issue — <healthReason>` (`:319-321`). Stopped: `Status: stopped`. `--json`: `{status:'healthy'|'unhealthy', apiKey, url, port, profile, uptimeSec, level, clientType?, project?, reason?, lastRecordedIssue?, otlpEndpointMismatch?}`; stopped `{status:'stopped'}`.
- `checkProxyHealth` — `src/cli/commands/proxy/health-check.ts:60`. Codes `ok|dead-socket|unauthorized|upstream-error`. Consumers: `proxy status`, `connect-orchestrator.ts:44`, `watcher.ts:12`. Checks LLM gateway only; no analytics path.
- `/health` handler — `src/providers/plugins/sso/proxy/sso.proxy.ts:291` returns `{status:'ok', port, startedAt, pid}` only; also `awaiting-login-listener.ts:65`. Consumer `daemon-manager.ts:70` (pid/port identity).
- Watcher-persisted health — `DaemonState.health/healthReason/lastHealthyAt/lastRecoveryAt` (`daemon-manager.ts:29-35`), written by `src/bin/proxy-daemon.ts:147-151,269-278` from deep LLM checks every 30s.

**Purpose B — "Tell me whether analytics is collected for this tool/project"**
- `codemie proxy analytics status [--claude-code-otlp|--copilot-cli-otlp|--copilot-chat-otlp] [--json]` — `analytics-command.ts:257-268,303-307`; default connector Claude Code (`resolveAnalyticsConnector :68`).
- `collect/formatClaudeAnalyticsStatus` — `analytics-status.ts:42-106`; `collect/formatCopilotAnalyticsStatus` — `:120-184`. Plain, uncolored, unindented lines: `Hooks:`/`Connector:`+`Connected:`, `Scope:`, `Tracked projects:` list, `Collection: enabled|disabled`, `Excluded projects:`, `Current directory (<path>): tracked|not tracked (<reason>)`, `Hint:`, `Run: codemie proxy connect --<id>`, `Not affected by these settings: …`, corrupt-prefs line. JSON = the collected object verbatim.
- Advice text — `analytics-hints.ts:25-125` (`adviceForReason`, `unaffectedChannels`, `coverageNote`, `resumeNote`), switch per connector id; unknown connector → `undefined`.
- Distance from delivery health: none of B reads the spool, cursors, auth state or daemon state. It reports configuration/gating only.

**Purpose C — "Tell me whether telemetry actually reaches Standalone" (OTLP spool pipeline)**
- Spool root `~/.codemie/proxy/otlp-spool` (`spool-paths.ts:9`); per session 7 streams (`hooks`, `logs|metrics|traces` .bin, `*Json` .ndjson) + `<id>.status` (`:36-59`); `listSessionIds()` `:69`. Spool is keyed by session id, not by tool; hook lines carry `agentName` in the envelope (`otlp.plugin.ts:33`), OTEL bins do not. Feeds: every `OtlpAgentAdapter` via `forwardOtlpEventsToSpool` (`src/agents/plugins/utils.ts:17`) plus native Claude Code OTel (`/v1/analytics/otlp/v1/*`).
- Session status — `session-status.ts:31-85`: `cursors` (acked byte offsets), `endedAt`, `holds{session|stream:{reason,since}}`, `lastLoss{reason,at,bytes,detail}`, `stampLoss`, `delivery[stream]{reason,detail,since,cursor,end,attempts,nextAt}`, `lastDiscard{reason,stream,bytes,at}`, `sendMode`. No last-success timestamp field. `readStatus()` `:292` is a pure, lock-free read.
- Spool math — `spool-state.ts:33-97`: `readSpoolState` (size/cursor/mtime per stream), `hasPending`, `isDrained`, `isSessionDrained`, `lastActivityMs`. Pending bytes = Σ(size − cursor).
- Credential staleness — `otlp-spool/auth-state.ts:16-34`: **module-level in-memory boolean** inside the daemon (`markCredentialsStale` from `forwarder.ts:466,477,485`; cleared by `otlp.plugin.ts:143-163` on a fresh store read). Not persisted, not exposed on `/health` or any endpoint. While stale, `send()` returns `credentials_stale` (`forwarder.ts:124`) and the tick skips (`tick-processor.ts:179,189`).
- Delivery failures — `delivery-state.ts:170-178`: `auth-expired`, `credentials_stale`, `not_sendable` are deliberately **not** recorded in `status.delivery`; other failures are (with backoff, 24h retention → `lastLoss`).
- Global analytics auth marker — `src/utils/analytics-auth-status.ts:33-110`, file `~/.codemie/analytics-auth-status.json` `{status:'invalid',reason,baseUrl,detectedAt}`. Writers: metrics/conversations API clients, `sso-session-expiry.plugin.ts:47`; cleared by `sso.auth.ts:151`, `metrics-api-client.ts:87`, `apiClient.ts:235`, `AgentCLI.ts:373`. Readers: `sso.auth-gate.ts:137` (with `markerAppliesToProfile :51`), `credential-refresh.ts:220`, `stale-session-reconciliation.ts:185`. The OTLP forwarder does not write it.

**Purpose D — session-sync pipeline (managed `codemie <agent>` launches)**
- `~/.codemie/sessions/<id>.json` `Session.sync.metrics|conversations` with `lastSyncAt`, `lastSyncError`, `totalSynced/totalFailed` (`src/agents/core/session/types.ts:62-118`), `droppedAt`; `hasUndeliveredData()` `stale-session-reconciliation.ts:141` (private). Separate from the proxy daemon; no status command reads it.

**Other touched code**: `src/cli/commands/proxy/connectors/claude-code-otlp-endpoint.ts` (`checkClaudeCodeOtlpEndpoint`, existing OTLP issue in `proxy status`); owner-pending queue `~/.codemie/analytics/state/owner-pending` (`src/agents/core/evidence/owner-pending.ts:33`).

### Decisions Already in the Code
- Staleness kept in memory only, recovery automatic (`auth-state.ts:7-15`); alternative (persist) none found; reason: re-login resumes without restart.
- Login-blocked backlog has no clock and no `delivery` record (`delivery-state.ts:165-173`, `docs/ARCHITECTURE-OTLP-PLUGIN.md:324`) — so on disk a credential-blocked session looks like "pending, no failure record".
- Status data is stored per session, per stream; a "growing/draining" signal needs data over time; nothing stores history (stored → read direction: per-session snapshot, no time series).
- `proxy status` text uses `chalk.green/yellow`, 2-space indent, 9-char padded labels; analytics commands use `chalk.green('✓ …')`, `chalk.red('✗ …')`, `chalk.dim`, `chalk.yellow('Note: …')`. That is the convention for coloring.
- `analytics status --json` deliberately = collected object (tests assert shape unchanged: `analytics-advice.test.ts:176-195,246-256`).
- Connector-specific dispatch in hints/status by `connectorId` string (`analytics-hints.ts:117`); only 3 OTLP connectors.

### Task Statements Checked Against the Code
- "status checks only daemon/process and local endpoint reachability" — holds (`index.ts:216-239`, `health-check.ts:60`); `--deep` adds LLM upstream/auth only, plus OTLP endpoint config mismatch.
- "analytics commands were added (EPMCDME-16396)" — holds (`analytics-command.ts:277`).
- "`proxy status` already supports showing issue details" — holds: `Reason:`, `Warning:`/`Repair:`, `Note:` lines (`index.ts:289-321`).
- "credentials stale" metric — partially available: daemon in-memory flag not reachable from CLI; file marker `analytics-auth-status.json` exists but OTLP forwarder never writes it.
- "spool cursors not advancing / backlog growing / draining" — computable only as a snapshot (pending bytes, sessions with pending); trend needs two samples or a stored previous value — none stored.
- "Must be tool-agnostic" — spool is tool-agnostic by design; per-tool attribution exists only in hook lines' `agentName`; `analytics status` today is connector-specific (keeps Purpose B in place for Claude/Copilot only; codemie-code/managed agents use Purpose D).
- "forwarding did not recover after re-auth" — unverified here; the recovery path exists (`otlp.plugin.ts:143-163`, `credential-refresh.ts`); a live log sample would settle it.

### Consumers of Changed Contracts
- `proxy status` text: `index.test.ts:809-1030` (exact `console.log` strings, e.g. `'  API Key: local-key'`), `hook-cold-start.test.ts`, docs `README.md:760`, `docs/COMMANDS.md:89,265`, `src/utils/tips.json:238-243`.
- `proxy status --json`: `daemon-status-contract.test.ts:228-252`, `index.test.ts:881-1014`; no in-repo programmatic reader of the JSON found (searched `status', '--json'`, `proxy status`).
- `format*AnalyticsStatus` / analytics status text+JSON: `analytics-command.ts:262,266`, `analytics-status.test.ts:143-170`, `analytics-command.test.ts:169-192,393-421`, `analytics-advice.test.ts:176-273`, `docs/COMMANDS.md:1675,1725`, `README.md:655,670`, `copilot-chat-otlp.plugin.ts:33` (comment).
- `checkProxyHealth`/`ProxyHealthResult`: `watcher.ts`, `connect-orchestrator.ts:44`, `index.ts:233`.
- `/health` body: `daemon-manager.ts:70` (identity check on `port`+`pid`).

### Architecture and Layers Affected
- CLI layer: `src/cli/commands/proxy/{index,analytics-command,analytics-status,analytics-hints,health-check}.ts`.
- Provider/proxy plugin layer: `otlp-spool/{spool-paths,spool-state,session-status,auth-state,delivery-state}.ts`, `otlp.plugin.ts`, `sso.proxy.ts` (`/health`).
- Daemon process: `src/bin/proxy-daemon.ts`, `DaemonState` in `daemon-manager.ts`.
- Utils: `analytics-auth-status.ts`.

### Integration Points
- CLI → daemon: only `proxy-daemon.json` and HTTP `/health`; no IPC for in-memory forwarder state.
- CLI → spool: direct filesystem reads possible (`listSessionIds`, `readStatus`, `readSpoolState` are pure reads; `readStatus` used without lock in `delivery-state.ts:98`).
- Forwarder → Standalone analytics API (`resolveAnalyticsEndpoint`, `postToBackend`).

### Patterns and Conventions
- Collect/format split (`collect*Status` → typed object, `format*Status` → string; `--json` prints the object).
- Health result as typed never-throwing object (`health-check.ts:21`).
- Import via `@/` alias with `.js`; never-throw best-effort status bookkeeping (`analytics-auth-status.ts:24`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md`, `integration/external-integrations.md`, `integration/exposed-api.md` (CLI surface) exist; `docs/ARCHITECTURE-OTLP-PLUGIN.md:83-90,296-324` is the authoritative spool/forwarder/delivery contract; `docs/ARCHITECTURE-PROXY.md`.

### Architectural Decisions
- ARCHITECTURE-OTLP-PLUGIN.md:324: auth-expired / credentials_stale excluded from finite delivery, unbounded until re-login.
- ARCHITECTURE-OTLP-PLUGIN.md:90: advancing a cursor frees no disk space; sweeper removes only drained idle sessions (15/60 min grace).
- Prior spec `docs/superpowers/specs/2026-10-28-epmcdme-16396-analytics-disable-investigation.md:64` considered `proxy status --analytics`; delivered as `proxy analytics status`.

### Derived Conventions
- Status headline `Status:  <state>` + indented detail lines; yellow for warnings/notes.

---

## 4. Testing Landscape

### Existing Coverage
- `proxy/__tests__/index.test.ts` (`describe('proxy status')` :809), `daemon-status-contract.test.ts`, `health-check.test.ts`, `watcher.test.ts`.
- `analytics-status.test.ts`, `analytics-command.test.ts`, `analytics-advice.test.ts`, `analytics-hints.test.ts`.
- `otlp-spool/__tests__/` incl. `auth-state.test.ts`, `delivery-retention.test.ts`, `spool-io.test.ts`, `forwarder.test.ts`, `tick-processor.test.ts`.

### Testing Framework and Patterns
- Vitest; `vi.mock` of `daemon-manager.js`/`health-check.js` with dynamic `await import(...)`; `console.log` spies asserting exact strings; temp `CODEMIE_HOME` fixtures for analytics status.

### Coverage Gaps
- No test reads spool backlog/cursors from a CLI command (no such code). No test of `analytics-auth-status` in a status view.

---

## 5. Configuration and Environment

### Environment Variables
- `OTLP_SEND_INTERVAL_MINUTES` (2), `OTLP_HELD_RETENTION_MINUTES` (1440), `OTLP_SWEEP_INTERVAL_MINUTES` (15), `OTLP_ENDED_SESSION_GRACE_MINUTES` (15), `OTLP_ABANDONED_SESSION_GRACE_MINUTES` (60), `OTLP_SEND_MAX_ATTEMPTS` (3), `OTLP_ALLOW_HOOKS_ONLY_FORWARD` — `otlp-spool/spool-config.ts:48-112`. `CODEMIE_HOME` via `getCodemiePath`.

### Configuration Files
- `~/.codemie/proxy-daemon.json`, `proxy-connection.json`, `proxy/otlp-spool/*`, `analytics-auth-status.json`, `claude-analytics.json`, `copilot-analytics.json`, `copilot-connectors.json`, `sessions/*.json`, `logs/debug-YYYY-MM-DD.log`.

### Feature Flags and Deployment Concerns
- None found.

---

## 6. Risk Indicators

- The decisive "credentials stale" signal lives only in daemon memory (`auth-state.ts:16`); `/health` exposes nothing analytics-related (`sso.proxy.ts:294`). Speculative: surfacing it needs a daemon→CLI channel (state-file field or `/health` field), changing a contract read by `daemon-manager.ts:70`.
- Credential-blocked backlog has no on-disk failure record (`delivery-state.ts:170-173`); a filesystem-only view cannot tell "blocked by auth" from "waiting for next tick/hold".
- No last-success timestamp anywhere in session status; "is delivering" / "draining" need a new record or two samples.
- Spool is shared across tools; per-tool split only via hook `agentName`; OTEL bins unattributed → per-tool backlog is approximate.
- Two independent pipelines (OTLP spool vs. session sync `sessions/*.json`) — a single "Analytics delivery" line covers only one unless both are read.
- Exact-string tests on `proxy status` and analytics status text (`index.test.ts`, `analytics-advice.test.ts`) — restyle breaks them; JSON shape of `analytics status` is asserted unchanged.
- Spool dir scan cost: sessions × 8 stat calls; large spools slow `proxy status` (today < 2s budget implied by shallow timeout 1.5s).
- `analytics status` connector-specific hints keep Purpose B tied to 3 connectors (see Task Statements).

---

## 7. Summary for Complexity Assessment

The change sits in the CLI layer (`proxy/index.ts`, `analytics-status.ts`, `analytics-command.ts`, `analytics-hints.ts`) and reads from the provider/proxy plugin layer (`otlp-spool/*`). Restyling the two analytics status renderers and adding a one-line analytics field to `proxy status` is confined to ~3-4 CLI files plus their exact-string tests. `proxy status` already has an issue-reporting idiom (`Reason:`, `Warning:`/`Repair:`, `Note:`), so analytics issues have an established slot.

Delivery-health data is partly available on disk: pending bytes per session/stream (`readSpoolState`), per-stream failure records with reason/attempts/since (`status.delivery`), recent losses/discards (`lastLoss`, `lastDiscard`, `stampLoss`), holds with reasons, and the global `analytics-auth-status.json` marker. Missing: a persisted credentials-stale flag (in-memory only in the daemon), any last-success timestamp, and any history for trend ("growing"/"draining"). Those require daemon-side additions (state-file or `/health` contract), which raises novelty and cross-process risk.

Test coverage is strong for spool internals and for current status output, but nothing covers a CLI reading the spool. Key risks: in-memory staleness, auth-blocked backlog leaving no on-disk trace, two separate delivery pipelines, and breaking exact-string tests/docs on restyle.

---

## 8. External References

None named by the task (EPMCDME-16396 referenced as prior work; its in-repo artifacts are `docs/superpowers/tasks/2026-10-28-epmcdme-16396-analytics-disable/` and `docs/superpowers/tasks/2026-10-29-epmcdme-16396-copilot-analytics-parity/`).

## Facts Added by Review

Researched for the names the spec relies on, after the analysis above was written. Read like the facts layer; where a line here contradicts one above, this one was read later.

- `'delivery_failed'` as a **token**: `session-project.ts:28-34` `DELIVERY_LOSS_REASONS = ['delivery_rejected','destination_unavailable','response_unverified','delivery_failed']`, type `DeliveryLossReason`. It is one of four. It is also part of `LossReason` (`session-project.ts:37-42`), so it can appear as `lastLoss.reason` after a range expires.
- Producer: `deliveryFailureOf()` `delivery-state.ts:170-178`. Returns nothing for `ok`, `discarded`, `auth-expired`, `credentials_stale` and `not_sendable`. Maps `http_400/413/422` to `delivery_rejected`, a `detail`-bearing outcome to `destination_unavailable`, `response_malformed/too_large` to `response_unverified`, and everything else (5xx, network, `response_read_failed`) to `delivery_failed` with `detail = cause`.
- It is stored as `SessionStatus.delivery[stream]: DeliveryFailure` (`session-status.ts:69`, interface `:124-135`: `reason, detail?, since, cursor, end, attempts, nextAt`). On-disk file: `statusFile(sessionId)` (`spool-paths.ts:57`). `parseDelivery` (`session-status.ts:196-217`) drops a record with `since==0`, `end<=cursor` or an unknown reason.
- Written by `noteDeliveryFailure` (`delivery-state.ts:128-163`, via `recordUnacknowledged` `:181-194`, called from the forwarder). Trimmed or cleared by `advanceCursor` (`session-status.ts:337-349`), `deliveryGate` (`delivery-state.ts:96-120`), `expireDeliveryLocked` (`:34-44`, which moves the record into `lastLoss` at `heldRetentionMs`) and `expireCarriedAgeLocked` (`:80-85`).
- `liveDelivery(sessionId, status, stream)` is at `delivery-state.ts:18-26`. It is **module-private (not exported)**. A record is "live" only when `rec.cursor === status.cursors[stream]` **and** the stream file's current size is `>= rec.end`. If `stat` fails, it returns `undefined`. It is async and does one `stat` per call. It does not check `nextAt` or `since`, so a record past retention that has not expired yet still counts as live.
- **Name collision:** `delivery_failed` is the spec's health reason (`spec.md:16,26`) **and** one of four `DeliveryLossReason` values. Spec rule 4 fires on "a live delivery-failure record", and that record may carry any of the four reasons.
- `areCredentialsStale()` is at `auth-state.ts:18`. It returns the module-level `let credentialsStale` (`:16`). The value lives **in daemon-process memory only**: no file, and lost on restart.
- `markCredentialsStale()` `:20-27` warns once. Its only callers are in `forwarder.ts:466,477,485`, when `authExpired()` is true for the hooks, OTEL or OTEL-JSON streams (401/403/302 after one retry).
- `clearCredentialsStale()` `:30-34` is called only by `otlp.plugin.ts:157` after `resolveFreshCredentials` succeeds.
- `forwarder.ts:124`: `send()` returns `{kind:'failed', reason:'credentials_stale'}` without a request.
- `tick-processor.ts:179`: the endpoint is not resolved while stale.
- `tick-processor.ts:189-193`: the tick returns early and only expires carried age.
- `otlp.plugin.ts:144`: `refreshCredentialsIfStale` re-reads the credential store when stale, or on the periodic throttle.
- While stale: no delivery record is written (`credentials_stale` and `auth-expired` are excluded at `delivery-state.ts:171-173`), and no hold is set or cleared (the tick exits before `applySessionEvidenceLocked`). Data that already exists on disk, such as holds or delivery records, stays as it was. The rule is documented in `docs/ARCHITECTURE-OTLP-PLUGIN.md:324` ("Deliberate exclusion ... not bounded by this window").
- `'analytics_endpoint_mismatch'` is in `HOLD_REASONS` at `session-project.ts:15`. It is persisted as `holds.session = {reason, since}` and validated by `parseHolds` (`session-status.ts:168-179`).
- Its only producer is `holdEndpointMismatch` (`tick-processor.ts:136-159`), reached from `processSessionTick` `:180` when `resolveAnalyticsEndpoint(credentials)` returns `null` (`classification.ts:131`).
- `null` means the URL candidates from daemon state (`syncApiUrl` / `ensureApiBase(syncCodeMieUrl)`, else `targetUrl`/`url`) do not canonicalize to the credentials' `api_identity`. The comment at `classification.ts:129` also says "or stale daemon/credentials".
- Past `heldRetentionMs()` it is cleared and recorded as `lastLoss.reason = 'analytics_endpoint_mismatch'` (`:148-150`, `holdOrLose` `session-project.ts:51-59`).
- It is cleared or replaced by the next non-stale tick with pending data, through `applySessionEvidenceLocked` (`tick-processor.ts:107-123`: another hold reason overwrites `reason` and keeps `since`; a send or loss calls `clearHold`).
- `session-project.ts:250` (any session hold means a `held` project policy).
- `tick-processor.ts:82,108-109,146,152,181` (reprobe check for `organization_encoding_unsupported`).
- `delivery-state.ts:62-63` (the carried-age loss reason uses the hold reason).
- Documented in `docs/ARCHITECTURE-OTLP-PLUGIN.md:313`.
- Being "stale" is in-memory daemon state, chosen over a file (`auth-state.ts:6-16`). It resets to `false` on every daemon start. No reason is recorded. The only out-of-process view is whatever the daemon exposes.
- Liveness of a delivery record is computed against the current cursor and file size, not trusted from the stored record (`delivery-state.ts:17-26`). Stale records are cleaned up lazily, only by the forwarder's gate, so a non-live record can sit on disk until the next gate pass.
- The two auth failure modes (`credentials_stale`, `auth-expired`) are deliberately not delivery failures and get no record or clock (`delivery-state.ts:165-173`; `ARCHITECTURE-OTLP-PLUGIN.md:324`).
- An endpoint-mismatch hold is session-scoped, set only with pending data, and its first-hold `since` is kept across reason changes (`tick-processor.ts:131-159`).
- Status reads in the daemon go through `readStatus` (`session-status.ts:292-299`). It never throws (`null` on any error) and normalizes the file. Locked writers use `withSessionLock`, which is not reentrant (`session-status.ts:309-310`).
- "`liveDelivery`, `delivery-state.ts:18`" **holds** as the location. It is **not exported** and is async with a `stat` per call (`delivery-state.ts:18`).
- "a stream has a live delivery-failure record" (rule 4, reason `delivery_failed`) **holds**: the records are in `status.delivery[stream]`. Their `reason` is any of four `DeliveryLossReason` values, not only `delivery_failed` (`session-project.ts:28-33`).
- "`areCredentialsStale()` (`auth-state.ts:18`)" **holds**. The value is daemon-memory only, so it can only reach the CLI through the daemon (`auth-state.ts:16`).
- "`holds.session.reason === 'analytics_endpoint_mismatch'` (... `tick-processor.ts:136`)" **holds** (`tick-processor.ts:136-159`, `session-project.ts:15`). "a session with pending data" matches the producer's own gate (`:142`).
- "No other hold reason affects health" **keeps in place** the 12 other `HOLD_REASONS` (`session-project.ts:6-20`) as non-health signals. Their consumers are `session-project.ts:250` and `tick-processor.ts` (above).
- AC4 "ignores a delivery record that fails the forwarder's liveness check" **holds** with the current rule: cursor equality plus file size `>= end` (`delivery-state.ts:20-22`).
- `areCredentialsStale` (spec: read for `/health`): consumers are `forwarder.ts:124`, `tick-processor.ts:179,189`, `otlp.plugin.ts:144`, plus test mocks in `otlp.plugin.*.test.ts`, `tick-processor.test.ts:37`, `owner-pending-retention.test.ts:31`, `delivery-retention.test.ts:30`, `project-interleave.test.ts:40` and `src/agents/core/evidence/__tests__/owner-pending.test.ts:58`. A read-only extra consumer does not change what they get.
- `liveDelivery`: consumers are `delivery-state.ts:106,139` only.
- `DELIVERY_LOSS_REASONS` / `HOLD_REASONS`: consumers are `session-status.ts:174,184,204` (parsers) and `LOSS_REASONS`.
- `/health` handlers: `sso.proxy.ts:291` and `src/cli/commands/proxy/awaiting-login-listener.ts:65`. These were covered by the base analysis and not re-read here.
