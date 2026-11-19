# Technical Research

**Task**: desktop telemetry runtime analytics preferences proxy
**Generated**: 2026-11-19
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-17411 [CLI Analytics][Claude Desktop] "codemie proxy analytics disable" does not stop Claude Desktop metrics and conversation upload.

Summary: `codemie proxy analytics disable` stops CLI Analytics collection for Claude Code and Cowork. The proxy's Claude Desktop sync runs separately and ignores the switch: it keeps sending session metrics (codemie_cli_session_total, codemie_cli_tool_usage_total) and uploading the conversation history. The command's own help says "Stop all analytics collection for the connector". Its output says "Controls the hook pipeline only — not affected: the daily analytics collector and the session sync that `codemie claude` runs itself" — Desktop sync is not listed.

Cause: only CoworkEventProducer (src/telemetry/runtime/cowork/CoworkEventProducer.ts ~L127-136: readClaudeAnalyticsPreferences(); return when corrupt or not enabled) reads the switch (~/.codemie/claude-analytics.json). DesktopTelemetryRuntime, DesktopSessionMetrics and DesktopSessionDelivery (src/telemetry/runtime/) never read it.

Acceptance criteria:
1. Given analytics are disabled, when a Cowork or Desktop chat session runs, no Desktop session metrics are sent.
2. Given analytics are disabled, conversation history upload is stopped too (decision made: disable stops EVERYTHING for Desktop: metrics AND conversation sync).
3. After enable, Desktop sync resumes. DECISION: forward-only — nothing written while disabled is sent after enable (like Claude CLI hooks; do not backfill). Implement as: on disabled->enabled transition set collectingSince = now (same mechanism as the Desktop reconnect transition in DesktopTelemetryRuntime.checkDesktopConnected), and records tracked at the moment of disable must be closed without sending (delivery-budget leaveQueue mechanism in src/agents/core/session/delivery-budget.ts) so the redelivery pass after enable does not upload them.
4. The `disable` output and `--help` describe the same scope (src/cli/commands/proxy/analytics-hints.ts unaffectedChannels/coverageNote, analytics-command.ts, analytics status).
Tests wanted (small unit tests only, NO integration): Desktop runtime/metrics/delivery sends nothing while claude-analytics.json has enabled:false and resumes when true; coverageNote()/unaffectedChannels for the Claude connector matches the channels that stay active.

OUT OF SCOPE: excludedProjects for Desktop chats (follow-up ticket), Cowork behaviour (CoworkEventProducer stays as is).

Pre-verified facts to confirm/refine rather than rediscover: readClaudeAnalyticsPreferences() returns {kind:'ok', value:{enabled, excludedProjects, collectionGeneration}} | {kind:'corrupt'} in src/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.ts; corrupt file => treat as disabled (same as Cowork). DesktopTelemetryRuntime.poll() calls checkDesktopConnected first, then start-up reconcile (delivery.reconcileRecords(true)), discoverSessions, pollSession (ensureSession -> sendSessionStartMetric; delivery.processSession -> syncer.sync), cowork.startIfIdle, finalizeInactive (-> finalizeSession -> delivery.finalizeLocked -> deliverLocked -> sendRecord: syncer.sync + sendSessionEndMetric), startRedeliveryIfDue (reconcileRecords(false)). DesktopSessionDelivery.deliverLocked already skips sending (saves record, flushes locally) when DesktopSessionMetrics.canDeliver() is false. The daemon is long-running so the switch must be re-read on each poll.

Constraint for the whole flow: no git commits; no integration tests are to be run (only typecheck, lint on changed files and narrow unit tests). Existing unit tests for the Desktop runtime live under src/telemetry/runtime/__tests__ and for the proxy analytics CLI under src/cli/commands/proxy/__tests__ — list the relevant existing test files and mocking patterns so the plan can extend them.

feature_area: desktop telemetry runtime analytics preferences proxy
run_dir: docs/superpowers/tasks/2026-11-19-epmcdme-17411-desktop-analytics-disable

---

## 2. Codebase Findings

### Existing Implementations

Purpose A — "when analytics are disabled, Desktop sends no metrics and uploads no conversations".
- The switch: `src/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.ts:72` `readClaudeAnalyticsPreferences()` (never throws; absent/empty file -> `DEFAULT_...` object `enabled:true`; unreadable/unparsable/bad shape -> `{kind:'corrupt'}`). `collectionGeneration` is bumped on every enable/disable write (`analytics-targets.ts:106`). Path: `getCodemiePath('claude-analytics.json')` (honours `CODEMIE_HOME`).
- Readers of the switch today: `CoworkEventProducer.ts:127-136` (corrupt -> warn once, return; `!enabled` -> return; also `excludedProjects` at :147); `claude-code-otlp.gate.ts:25` (hook path, corrupt/disabled -> not tracked); `claude-code-otlp.plugin.ts:144,257`; `otlp-spool/evidence-send.ts:48` (send guard, generation compare); `analytics-targets.ts:99,207`; `analytics-status.ts:106`. No reader in `src/telemetry/runtime/DesktopTelemetryRuntime.ts`, `DesktopSessionMetrics.ts`, `DesktopSessionDelivery.ts`, `desktop-session.ts` (confirmed by grep of `readClaudeAnalyticsPreferences` over `src`).
- Desktop send sites (what a gate would sit in front of; one daemon-wide instance, `clientType` `claude-desktop`, built at `src/bin/proxy-daemon.ts:253`; the only non-test constructor of `DesktopTelemetryRuntime`):
  - Start metric: `DesktopTelemetryRuntime.ensureSession` :393 -> `DesktopSessionMetrics.sendSessionStartMetric` :71 (also saves the new record first, :391).
  - Live sync: `pollSession` :344 -> `DesktopSessionDelivery.processSession` :42 (`parseSession`, `adapter.processParsedSession` writes local metrics/conversation lines, then `syncer.sync` :63 only `if (sync && result.totalRecords > 0)`). `sync:false` = write locally, send nothing.
  - End/final: `finalizeInactive` :266 and `stop()` :122 -> `finalizeSession` :481 -> `DesktopSessionDelivery.finalizeLocked` :74 -> `deliverLocked` :100 -> `sendRecord` :139 (final `flushTranscript(...sync=true)`, `syncer.sync`, `metrics.sendSessionEndMetric` :106).
  - Start-up/redelivery: `reconcileRecords(true)` at the first connected poll (:173) and `reconcileRecords(false)` every `DESKTOP_REDELIVERY_INTERVAL_MS` (10 min, `desktop-session.ts:12`; `startRedeliveryIfDue` :292). Kinds: `restart` (finalize+deliver), `foreign-gone` and `legacy` (closed locally, nothing sent — `DesktopSessionDelivery.ts:335-357`, `legacy` also `renameSessionFiles`), `undelivered` (completed record -> `deliverLocked`); at most `RECONCILE_PER_START` undelivered per pass, newest first.
  - Existing "send nothing" precedent inside `deliverLocked` :102-109: `!(await metrics.canDeliver())` (cookies missing or analytics auth marked invalid, `DesktopSessionMetrics.ts:33`) -> save record, local flush (`flushTranscript(record,false)`), no send, record stays live as `{id}.json` for re-login. `canDeliver()` does not cover `sendSessionStartMetric` (it checks `context.cookies` itself, :76) nor `processSession` (live sync, :62).
  - Poll-level gates already present: `checkDesktopConnected` :222 (not connected -> only `cowork.startIfIdle(now,false)` + `finalizeInactive`, no discovery, no reconcile, no redelivery); runs first and also fires on `stop()`'s final poll.
- Cowork: `CoworkRunner.forAdapter` (`CoworkRunner.ts:25`) creates a `CoworkEventProducer` only for `ClaudeDesktopTelemetryAdapter`; it runs its own gate every `startIfIdle` (:36). Unchanged by the task.

Purpose B — "a record the daemon must not send is closed without sending".
- `delivery-budget.ts:114` `leaveQueue(s, reason, now, rename?)`: with `reason` undefined it renames the record's file set (`renameSessionFiles`, `session-generation.ts:254`, to `completed_*`) and writes no drop mark ("local-by-design"); with a reason and unsent data (`hasUndeliveredData` :87) it first stamps `droppedAt/droppedReason` (`DropReason` = 'rejected by the server' | 'retry budget exhausted' | 'retention expired' | 'local errors', `session/types.ts:79`). Returns whether files moved; when not renamed it re-saves `s` as given.
- Callers: `DesktopSessionDelivery.reportOutcome` :133 (budget spent), `stale-session-reconciliation.ts:293,322,343` (`closeExhaustedLocally` saves `{status:'completed', reason:'interrupted', endTime: lastRecordedActivityAt}` then `leaveQueue`; `'unqueued'` kind calls `leaveQueue(record, undefined, ...)`), `hook/generation-close.ts:59,76`, `hook/delivery.ts:81`.
- A Desktop-side local close that sends nothing already exists in `reconcileRecord` :346-357 (`legacy`: save `completed`/`interrupted` with `endTime: desktopEndTime(record)`, then `renameSessionFiles`). `desktopEndTime` at `desktop-session.ts:44`.
- `renameToCompleted` :202 / `isDeliveryDone` (`hook/delivery.ts`) is the "delivered" rename; `hasUndeliveredData` considers end metric sent/skipped plus pending metric and conversation lines of matched records.
- A completed record is re-tracked (not skipped) when Desktop shows newer activity: `retrackSession` :449 -> `reopenCompleted` (`desktop-session.ts:151`; restores live files, clears end/delivery state, does not set `baselineCutoffMs`). Only `buildNewSession` (:101) takes `baselineCutoffMs` (set in `ensureSession` :388 when `discovered.createdAt < collectingSince`) and `processSession` :52 applies it via `adapter.applyBaseline`.

Purpose C — "after enable, collection counts from now" (forward-only).
- `collectingSince` field (`DesktopTelemetryRuntime.ts:67`, initial `startedAt`); moved only in `checkDesktopConnected` :243 (`connected && previous !== undefined` -> `now`). Consumed at :190 (sessions with `updatedAt < collectingSince` skipped), :388 (baseline cutoff for never-synced older chats), and reported through `onDesktopConnectedChange` (:248; proxy-daemon persists `desktopConnectedSince`).
- Readers of `desktopConnectedSince`: `analytics-delivery-lines.ts:31` (doctor "Claude Desktop collection": `collecting: true` once set), `inspect-desktop.ts:80-98` (reason `session-created-before-desktop-connected`). Neither reads the analytics switch.
- Transition detection options already in the code: the in-memory `previous` pattern of `desktopConnected` (:240) and `notConnectedReads` debounce for a read glitch; the on-disk `collectionGeneration`. A daemon starting while disabled has no in-memory previous value.

Purpose D — "the disable command and its help describe the same scope".
- `analytics-command.ts:289` `disable` description: 'Stop all analytics collection (every connected connector, or the flagged one; hooks stay installed)'; :292 `enable`: 'Resume analytics collection (...)'. Parent description :285. Output on disable: `setEnabledFor` :62-64 prints `coverageNote(connectorId)`; `exclude` also prints it (:121). `enable` prints `resumeNote` when changed (:66) then `reportEffectiveState`.
- `analytics-hints.ts:89` `unaffectedChannels(connectorId)` — `default` branch (Claude, `claude-code-otlp`) returns 'the daily analytics collector and the session sync that `codemie claude` runs itself'; copilot-cli / copilot-chat have their own strings. `:101` `coverageNote` = `Controls the hook pipeline only — not affected: ${unaffectedChannels}.`. `:110` `resumeNote` default (Claude): 'Usage already written to session transcripts while collection was off may be reported now that it is back on.'
- Same sentence also rendered by `analytics-status.ts:88` (closing line `These settings do not affect ${unaffectedChannels}.`) and `claudeAdvice` 'disabled' (`analytics-hints.ts:30-32`). The `status` section reports `Collection: enabled|disabled` (:77), no Desktop row.
- User docs repeating the scope: `docs/COMMANDS.md:1966` (disable row), `:1972` (Cowork follows disable), `:1976-1981` ("What is and is not covered"), `:1983` (resume note), `:2001` (status example); `docs/HOOKS.md:585`; `docs/PROXY-AND-ANALYTICS.md:63`; README.md :663 and :678.
- Target selection: `analytics-targets.ts:237` `selectTargetConnectors`: flag picks the connector; flagless `enable`/`disable` act on connectors that are active (Claude: `hasClaudeCodeOtlpHooks()`), have a stored preference, or are unreadable; throws 'No analytics connector is connected' when none. `hasActiveAnalyticsConnector` (`analytics-connectors.ts:113`) additionally counts a Desktop gateway (`readDesktopGateway`) — a different predicate.

Other touched code (not above): `src/telemetry/runtime/types.ts` (`DesktopTelemetryRuntimeConfig`: `readDesktopGateway` and `onDesktopConnectedChange` are the existing injectable hooks; no preferences hook), `src/providers/plugins/sso/session/SessionSyncer.ts` (sync target, mocked in tests).

### Decisions Already in the Code

- Corrupt preferences = not collecting, everywhere: gate (`claude-code-otlp.gate.ts:26`), Cowork (:128-134, warn once via `corruptPreferencesWarned`), send guard (`evidence-send.ts:49`), status 'Preferences file is corrupt — collection is stopped' (`analytics-status.ts:79`). Convention: read the file per run, no caching (Cowork reads it on every `run`; the hook reads per event). Cowork's corrupt warning message format: `[cowork-producer] Cowork sessions are not sent while the preferences file is corrupt: <path>`; the warn-once-and-reset-on-valid-read pattern is tested (`CoworkEventProducer.test.ts:457`).
- Local close vs drop: a close with `reason` undefined is "local-by-design, never marked" (`delivery-budget.ts:107-110`; `'unqueued'` and `legacy` use it); a close with a reason marks dropped only if `hasUndeliveredData`. Choice of mark is made by the caller.
- Poll ordering: `checkDesktopConnected` -> start-up pass -> discovery. Activity gate keyed on `updatedAt`, not creation time (comment :186-189); never-synced older chats are baseline-cut at `collectingSince` rather than backfilled (comment :385-389, "spiked backend load").
- Delivery is a single serialized path per session under `reconcileLockPath(sessionId)` (`pid-lock`, mode `wait` for finalize/retrack, `try` for reconcile). Any close of a record must hold that lock (`DesktopSessionDelivery.ts:238-248`, `DesktopTelemetryRuntime.ts:482`).
- Preference scope is Claude-wide: one file `claude-analytics.json` and one connector id `claude-code-otlp` (`storeForConnector`, `analytics-targets.ts:93`) govern hooks, Cowork, and (per this task) Desktop; `docs/PROXY-AND-ANALYTICS.md:29` and `:37` document `--claude-otlp` as covering Claude Desktop usage. `connect --claude-desktop` is a separate flag (`:24`) and installs no hooks, so `claude-code-otlp` reads as not active for a Desktop-only user (see Section 2 'Task Statements').
- Data direction: the switch is stored as `enabled` boolean plus `collectionGeneration`; the daemon needs a disabled->enabled transition edge. Neither a "previous enabled" value nor the generation seen is held by the runtime today (stored for CLI/hook consumption: hook freezes `collection_generation` into the evidence record, `claude-code-otlp.plugin.ts:150`, and `sendGuard` stops a session whose frozen generation differs, `evidence-send.ts:50-53`). The usual alternative would be an in-memory last-seen flag.
- Tests mock the I/O boundary and use the real filesystem under a temp `CODEMIE_HOME` (see Section 4); `fetch`/`MetricsSender`/`SessionSyncer` are the faked sends.

### Task Statements Checked Against the Code

- "only CoworkEventProducer reads the switch; Desktop runtime/metrics/delivery never read it" — holds (grep: `readClaudeAnalyticsPreferences` has no hit in `src/telemetry/runtime/Desktop*.ts` or `desktop-session.ts`). Also read by the hook gate/plugin and `evidence-send` (not named by the task, none of them Desktop).
- "CoworkEventProducer ~L127-136" — holds (`:127-136`).
- Pre-verified `readClaudeAnalyticsPreferences()` shape — holds (`claude-code-otlp.preferences.ts:35-37,72`). Corrupt -> disabled for Cowork: holds (`:128-134`).
- poll() order — holds with one refinement: when not connected, poll never reaches reconcile/discovery; `startIfIdle` is called before `finalizeInactive`; `stop()` runs one more `poll()` then `finalizeSession` for every tracked session (:105-131), so a disable-time gate must also cover the stop path.
- "`deliverLocked` already skips sending (saves record, flushes locally) when `canDeliver()` is false" — holds (`:102-109`); it does not cover start-metric, live sync (`processSession` :62) nor the end metric when called on a record the budget path handles; the skip leaves the record live (`{id}.json`) and unrenamed, so it stays a reconcile candidate (classify returns `'undelivered'` only for `completed`; an `active` one is only taken at start).
- "Implement forward-only as `collectingSince = now` on disabled->enabled, same mechanism as reconnect" — holds as a mechanism: `collectingSince` gates discovery (:190) and the baseline cutoff of never-synced chats (:388). Not covered by that mechanism today: a session already tracked, or a known `completed` record that is re-tracked, keeps its `lastSyncedHistoryIndex`; `reopenCompleted` sets no `baselineCutoffMs` (see Risks). Keeps in place: the redelivery pass (`startRedeliveryIfDue`, consumed by `reconcileRecords(false)`) — consumers listed below.
- "records tracked at the moment of disable must be closed without sending (leaveQueue) so the redelivery pass does not upload them" — `leaveQueue` exists as described and `reconcileRecords(false)` lists only live `completed` records with an owner of this host (`classifyRecord` :313-315), so a closed-and-renamed (`completed_*`) record is not listed (`isLiveRecordFileName`). Holds as a description of the mechanism.
- "the daemon is long-running so the switch must be re-read on each poll" — holds (daemon constructs one runtime per process; `poll` every `pollIntervalMs`, default 10 s, `proxy-daemon.ts:263`); Cowork re-reads per `run`.
- "Help says 'Stop all analytics collection for the connector'" — partly: the actual `disable` description is 'Stop all analytics collection (every connected connector, or the flagged one; hooks stay installed)' (`analytics-command.ts:289`). The quoted phrase is not in the source.
- "Output says Controls the hook pipeline only — not affected: the daily analytics collector and the session sync that `codemie claude` runs itself" — holds (`analytics-hints.ts:96,102`).
- "Existing tests under `src/telemetry/runtime/__tests__` and `src/cli/commands/proxy/__tests__`" — holds; listed in Section 4.
- "OUT OF SCOPE: Cowork behaviour stays" — keeps `CoworkEventProducer` gate in place; consumers: `CoworkRunner.ts:49`, `CoworkEventProducer.test.ts:441-455,1103,1205-1206`.

### Consumers of Changed Contracts

Contract: what `claude-analytics.json` `enabled`/corrupt means for Claude-family collection (Desktop newly governed).
- `analytics-status.ts:77` prints only `Collection: enabled|disabled`; no Desktop mention. `status --json` carries `enabled` per connector via `collectClaudeAnalyticsStatus` (:102-124).
- `analytics-delivery-lines.ts:31` (doctor) reports Desktop `collecting: true` whenever `desktopConnectedSince` is set; independent of the switch. Reads: doctor group `Claude Desktop collection` (`doctor/groups.ts:18`, `compose.ts:59`).
- `inspect-desktop.ts:80-117` reasons list has no "analytics disabled" reason.
- `claudeAdvice` (`analytics-hints.ts:30`) 'disabled' description 'analytics collection is disabled'; consumed by `reportEffectiveState` (`analytics-targets.ts:149-170`) which evaluates `evaluateClaudeAnalyticsGate(target)` and prints it after `enable`/`include`; hook-only semantics (it also needs hooks installed, `analytics-targets.ts:156`).
- `docs/COMMANDS.md` / `HOOKS.md` / `PROXY-AND-ANALYTICS.md` / README text listed under Purpose D.

Contract: `unaffectedChannels(connectorId)` / `coverageNote` text.
- Callers: `analytics-command.ts:63` (disable), `:121` (exclude), `analytics-status.ts:88` (status closing line). `excludedProjects` is not applied to Desktop chats (out of scope) while `exclude` prints the same `coverageNote` — one shared note serves both verbs.
- Asserted verbatim in tests: `analytics-hints.test.ts:14-18`; `analytics-advice.test.ts:136-149` (`'Controls the hook pipeline only'`, `'session sync that `codemie claude` runs itself'`) and `:186-205` (status line `'  These settings do not affect the daily analytics collector and the session sync that `codemie claude` runs itself.'`, exact match); `analytics-status.test.ts:133` (`SENTENCE` constant, same text; Copilot variants :283,:290,:304). `analytics-report.test.ts` uses a fake 'X' sentence (unaffected).

Contract: `DesktopSessionDelivery` / `DesktopSessionMetrics` / `DesktopTelemetryRuntime` constructor and method signatures. Only non-test consumer is `proxy-daemon.ts:253` (runtime), `DesktopRepositoryResolver.ts` and `claude-desktop.discovery.ts` import types/names only. Tests construct them directly: `DesktopTelemetryRuntime.test.ts` (`new DesktopTelemetryRuntime(adapter, config[, cowork])`, 3 test files), and spy on `DesktopSessionDelivery.prototype.reconcileRecords` (`DesktopTelemetryRuntime.test.ts:2335`); one test reaches private `ensureSession`/`finalizeSession` (:384-396).

Contract: `stale-session-reconciliation.ts` `'desktop-gone'` kind (:335-340): a CLI launch closes a Desktop record whose daemon is gone locally and leaves it to the daemon to deliver; a Desktop record left live by a disabled daemon would be classified by this pass too. Not named by the task.

### Architecture and Layers Affected

- Telemetry runtime (daemon-side): `DesktopTelemetryRuntime` (poll orchestration, `collectingSince`), `DesktopSessionMetrics` (credential/`canDeliver` + start/end metric), `DesktopSessionDelivery` (processing, finalization, delivery, reconciliation).
- Preferences module of the Claude OTLP plugin (`src/agents/plugins/claude-code-otlp/`) read from `src/telemetry/runtime/` (Cowork already does so: same direction, `CoworkEventProducer.ts:18-20`).
- Session record / delivery queue layer (`src/agents/core/session/`: `delivery-budget`, `session-generation`, `stale-session-reconciliation`).
- CLI layer: `src/cli/commands/proxy/` (`analytics-command.ts`, `analytics-hints.ts`, `analytics-status.ts`); docs.

### Integration Points

- Daemon `src/bin/proxy-daemon.ts:253-295` constructs the runtime with `onDesktopConnectedChange` and `config.triggerPoll = runtime.triggerPoll` (used by the proxy to force a poll; also reaches the same `poll`).
- Cookies via `CodeMieSSO.getStoredCredentials` (`DesktopSessionMetrics.loadCookieAuth` :59); sends via `MetricsSender` and `SessionSyncer` (`@/providers/plugins/sso`).
- Preferences file shared with the CLI writer `updateClaudeAnalyticsPreferences` (atomic temp+rename, `claude-code-otlp.preferences.ts:115`), so a poll read never sees a torn file.
- Cowork producer shares the poll (`cowork.startIfIdle`), runs detached, own gate.

### Patterns and Conventions

- ES modules with `.js` suffix and `@/` alias; explicit return types on exports; `logger` not `console`; `[desktop-telemetry]` log prefix; no `any` (AGENTS.md "Common Pitfalls").
- Errors from background loops are caught and logged, never thrown into the poll (`poll()` callers `.catch`; `deliverLocked` never throws on send failure).
- One concern per class: metrics (`DesktopSessionMetrics`), delivery (`DesktopSessionDelivery`), orchestration (`DesktopTelemetryRuntime`); delivery receives `metrics` as a ctor dependency; the runtime config carries injectable readers (`readDesktopGateway`) for tests.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/` exists (architecture, development, integration, security, standards, testing, usage, `project.md`, `quality-gates.md`). Relevant by task classifier: architecture (5-layer plugin architecture), development-practices (error handling/async), testing-patterns (Vitest, dynamic-import mocking), quality-gates. They were not read in depth; no content in them about Desktop analytics was searched beyond the grep of docs below.
- `docs/COMMANDS.md:1960-2014` (analytics command reference), `docs/HOOKS.md:585` (Cowork follows disable), `docs/PROXY-AND-ANALYTICS.md:24-63`, `docs/ARCHITECTURE-PROXY.md` (Desktop collection), `docs/ARCHITECTURE-OTLP-PLUGIN.md` (Cowork producer / spool pattern).
- Prior task analyses in the same area: `docs/superpowers/tasks/2026-11-17-proxy-analytics-cli-redesign/`, `2026-11-18-epmcdme-17386-record-project-conflict-discard/`, `2026-11-12-epmcdme-17068-exit-notice-dropped-telemetry/` (delivery budget / dropped marks), `2026-11-05-epmcdme-16086-analytics-status/`.

### Architectural Decisions

- `delivery-budget.ts` header (:1-8): the one place that decides when a record may leave the queue with data unsent; "outages, rejected credentials and aborts never spend it".
- `DesktopTelemetryRuntime.ts:186-189`, `:385-389` comments (activity gate; baseline cutoff reasons). `desktop-session.ts` `ponytail:` comments mark accepted limitations.
- `claude-code-otlp.preferences.ts:1-9`: file lives outside Claude's own settings so `connect`/`disconnect` never touch it; hook-side callers fail closed on corrupt.

### Derived Conventions

- Gate-at-the-top-of-the-run, re-read per run (Cowork, hook gate).
- Local-only closes save `status:'completed'`, `reason:'interrupted'` (or a specific desktop reason such as `desktop-daemon-gone`), `endTime` then rename (`closeExhaustedLocally`, `legacy`).

---

## 4. Testing Landscape

### Existing Coverage

Desktop runtime (`src/telemetry/runtime/__tests__/`, `cowork/__tests__/`):
- `DesktopTelemetryRuntime.test.ts` (~2500+ lines; main suite): describe blocks include 'repository attribution', 'cookie auth', 'daemon restart with pre-existing sessions', 'new session discovery', 'transcript fingerprint', 'inactivity timeout', 'the Cowork producer' (:841), 'a failure never stops the daemon', 'end at the last activity', 'records a previous daemon left' (:1157), 'delivery after a failure', 'delivery credentials' (:1725), 'the delivery budget on a live re-delivery pass (EPMCDME-17068)' (:1846), 'a reopen and a delivery never interleave', 'folder switch', 'collection while Desktop is connected to this daemon' (:2256; best model for a reconnect/enable-transition test: `desktopPointsAt()`, `notices`, `startDaemon`, `pollTicks`, `startedSessions()`).
- `DesktopTelemetryRuntime.start.test.ts`: start-up pass, attempt accounting, `start()` not awaiting the pass (own mocks, own `CODEMIE_HOME`).
- `desktop-session.test.ts`, `DesktopRepositoryResolver.test.ts`: helpers and resolver.
- `cowork/__tests__/CoworkEventProducer.test.ts` (:441-469 preferences-corrupt/disabled, :1103 disabled with cursor, :1205-1206 table of closed gates), `DesktopTelemetryRuntime.cowork.test.ts`, `cowork-events.test.ts`, `cowork-fixture.ts`.
- No test files exist for `DesktopSessionDelivery` or `DesktopSessionMetrics` alone; both are exercised only through `DesktopTelemetryRuntime.test.ts` (one test spies `DesktopSessionDelivery.prototype.reconcileRecords`).
- Delivery budget unit tests: `src/agents/core/session/__tests__/delivery-budget.test.ts:227-315` (`leaveQueue`), `stale-session-reconciliation.test.ts:1750-1777`.

Proxy analytics CLI (`src/cli/commands/proxy/__tests__/`): `analytics-hints.test.ts` (pure, dynamic `import('../analytics-hints.js')` in each test; asserts `unaffectedChannels`/`coverageNote`/`resumeNote` at :11-26), `analytics-advice.test.ts` (end-to-end command run: mocks `@/utils/paths.js` -> temp dir, `@/utils/project-root.js`, `../connectors/desktop.js` `readDesktopGateway`; `run([...args])` via `createProxyAnalyticsCommand().parseAsync`; console spy `out()`; disable/exclude coverage assertions :136-149, status sentence :186-205), `analytics-status.test.ts` (`SENTENCE` :133, Copilot :283-304; mocks `@/utils/paths.js`, `@/utils/processes.js`), `analytics-command.test.ts` (mocks paths, project-root, `../connectors/desktop.js`), `analytics-connectors.test.ts` (mocks connector modules), `analytics-report.test.ts`, `analytics-clients.test.ts`, `analytics-consent-command.test.ts`, `analytics-destination.test.ts`, `inspect-desktop.test.ts`, `doctor-*.test.ts`.

### Testing Framework and Patterns

- Vitest `^4.1.5` (`package.json:172`); projects `unit`, `cli`, `agent` (`package.json:45`); unit files carry `@group unit` docblocks. Typecheck `tsc --noEmit`; lint `eslint ... --max-warnings=0`.
- Runtime suite pattern (`DesktopTelemetryRuntime.test.ts:1-378`): module mocks for `fs/promises` (stat via a fake transcript map; rename/unlink wrapped), `@/providers/plugins/sso/index.js` (`MetricsSender` fake exposing `sendSessionStart`/`sendSessionEnd` mocks `mockSendSessionStart`/`mockSendSessionEnd`; switch `realMetricsSender` for real+fetch), `SessionSyncer.js` (`mockSync`; `realSessionSyncer`), `sso.auth.js` (`mockGetStoredCredentials`), `@/utils/processes.js`, `@/utils/config.js`. Real filesystem under a temp `CODEMIE_HOME` per test (`resetCodemieHome`, `removeCodemieHome` closes the logger first for Windows). Fake clock `vi.useFakeTimers({ toFake: ['Date'] })` with `T0`; polls driven by `runtime.triggerPoll()`/`pollTicks`; `createAdapter()` fake adapter with `sentDeltas`; helpers `readRecord`, `recordFiles`, `persistedRecords`, `writeRecord`, `sessionIdFor`, `startRuntime`, `startDaemon`; private access via `(runtime as any)`.
- Because the runtime suite sets `CODEMIE_HOME` to an empty temp dir and `config.readDesktopGateway` returns connected, every existing test would read an absent `claude-analytics.json` (enabled defaults) under a new gate; a test sets the switch by `writeFileSync(join(codemieHome, 'claude-analytics.json'), JSON.stringify({ enabled: false }))` (Cowork tests do the same). The suite mocks `fs/promises` while the preferences module imports `node:fs/promises` (`readFile`); the mock spreads `actual`, so `readFile` is unaffected either way.
- CLI suites: dynamic imports after `vi.mock`, `vi.resetModules()` per test, temp dir via `CODEMIE_HOME` + mocked `getCodemiePath`.
- Integration tests (`tests/`) exist but are out of scope for this flow.

### Coverage Gaps

- No existing test reads the switch from the Desktop path; no test for a disabled->enabled transition in the runtime; none for closing records without sending on disable.
- `DesktopSessionMetrics.sendSessionStartMetric/EndMetric` and `canDeliver` have no direct unit tests (only via the runtime suite).
- `unaffectedChannels`/`coverageNote` tests assert Claude text by regex and exact status sentences (listed above); there is no test that the `disable` `--help` text equals the output scope.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — root of `~/.codemie`; `getCodemiePath` (`src/utils/paths.ts:368,385`) so `claude-analytics.json` and `sessions/` both move under it.
- `CODEMIE_DELIVERY_RETRY_WINDOW_MS` (`delivery-budget.ts:31`) — retry window; evidence retention via `evidenceRecordIdleDays()` (`otlp-spool/spool-config.js`).
- `OTLP_ALLOW_HOOKS_ONLY_FORWARD` — Cowork's own gate (`CoworkEventProducer.ts:137`); not applied to the Desktop pipeline.

### Configuration Files

- `~/.codemie/claude-analytics.json` `{version:1, enabled, excludedProjects[], collectionGeneration}` — the switch (see Section 2).
- Runtime config: `DesktopTelemetryRuntimeConfig` (`types.ts:18`); daemon sets `pollIntervalMs` (default 10000), `inactivityTimeoutMs` (default 300000), from `config.telemetryPollIntervalMs` / `config.telemetryInactivityTimeoutMs` (`proxy-daemon.ts:263-264`).
- `~/.codemie/sessions/{id}.json` and `completed_{id}.json` record sets; `*.reconcile.lock`.
- `.codemie/codemie-cli.config.json` is a personal override that shows as deleted in `git status`; exclude from any diff.

### Feature Flags and Deployment Concerns

- No feature flag for Desktop collection other than `OTLP_ALLOW_HOOKS_ONLY_FORWARD` (Cowork only). A running daemon from an older CLI keeps its old behaviour until restarted; `desktopConnectedSince` is only written by a newer daemon (`inspect-desktop.ts:89`).
- No secrets handling involved; logs go through `logger` (do not log cookie values).

---

## 6. Risk Indicators

- Gate coverage is spread over seven send sites (start metric `ensureSession`, `processSession` live sync, `deliverLocked`/`sendRecord` incl. the final flush, `reconcileRecords(true|false)`, `stop()`'s final poll and finalization, `finalizeInactive`). `canDeliver()` covers only `deliverLocked`; start metric and `processSession` have their own branches (`DesktopSessionMetrics.ts:76`, `DesktopSessionDelivery.ts:62`). Reading the switch in one place only would leave the others sending.
- Speculative: forward-only needs more than `collectingSince = now`. A session tracked or known when disable happens keeps its saved `lastSyncedHistoryIndex`; if it is re-tracked after enable (`reopenCompleted`, `desktop-session.ts:151`) no `baselineCutoffMs` is applied, so transcript lines written during the disabled period could upload. The discovery gate (`updatedAt < collectingSince`) tests only the chat's last activity (`discovered.updatedAt < collectingSince` -> skip, :190): a chat active after enable passes it, with its whole transcript when its record is known.
- Speculative: while disabled, `processSession` with `sync:false` still writes local pending lines (metrics deltas, conversation payloads) that a later pass could send; a decision on whether disable skips `pollSession` entirely or writes locally is a spec choice. The close-without-sending path (`leaveQueue`, `hasUndeliveredData`) treats pending lines as data.
- The `collectionGeneration`/in-memory transition detection must survive the daemon starting while disabled (no previous value) and a read glitch (corrupt file flap): Cowork treats corrupt as disabled and warns; a flip to corrupt then valid would look like disabled->enabled. `checkDesktopConnected` has a two-read debounce (`notConnectedReads`) as the existing precedent for a glitchy read.
- Records closed at disable time must be closed under `reconcileLockPath` (waiting lock for tracked sessions, `finalizeSession`-style; `try` for reconcile); a lock held by a CLI `reconcile`/another process (`DESKTOP_REOPEN_LOCK_BUDGET_MS` 30 s) interacts with a blocking poll. Also the `desktop-gone` kind in `stale-session-reconciliation.ts:335` and `reconcileRecords` classify a `completed` record with an owner as `undelivered`, so a locally-closed record must be renamed (`leaveQueue` returns false when not renamed and the record stays queued).
- Existing tests: `analytics-advice.test.ts:136-149,186-205`, `analytics-status.test.ts:133`, `analytics-hints.test.ts:14-18` assert the old Claude sentence; any change of `unaffectedChannels` default text fails them. `unaffectedChannels` default branch also serves any unknown connector id; `coverageNote` is shared by `disable` and `exclude` (exclude does not apply to Desktop chats; out of scope) and `status` uses the same text.
- Desktop-only users: flagless `analytics disable` throws 'No analytics connector is connected' when neither Claude hooks are installed nor a preference exists (`selectTargetConnectors` :237-259), although `hasActiveAnalyticsConnector` treats a Desktop gateway as connected; `disable --claude-otlp` writes the file regardless. A user who connected only `--claude-desktop` cannot use the flagless form (the same predicate is used by the `status`).
- `doctor` "Claude Desktop collection" and `inspect-desktop` keep reporting `collecting: true` while the switch is off (`analytics-delivery-lines.ts:31`); `analytics status` has no Desktop line. The ticket names status under AC4.
- Six docs spots repeat the old scope (`COMMANDS.md:1966,1972,1976-1983,2001`, `HOOKS.md:585`, `PROXY-AND-ANALYTICS.md:63`, README :663).
- Test mocks: `DesktopTelemetryRuntime.test.ts` is very large and uses private-method access; a new gate read must resolve under its `CODEMIE_HOME` temp dir. `DesktopTelemetryRuntime.start.test.ts` has its own mocks; it also sets `CODEMIE_HOME` (:253).
- Guides under `.ai-run/guides/` were only matched by name, not read in depth.

---

## 7. Summary for Complexity Assessment

Layers touched: the daemon-side Desktop telemetry runtime (`DesktopTelemetryRuntime`, `DesktopSessionMetrics`, `DesktopSessionDelivery`; 3 files, ~10 send/poll sites between them), the shared session/delivery-queue helpers (`leaveQueue`, `renameSessionFiles`, `reconcileLockPath`; reused, not changed by anything found), the proxy analytics CLI text (`analytics-hints.ts`, possibly `analytics-command.ts` descriptions, `analytics-status.ts`) and about six documentation spots. The preferences reader already exists and is already imported into `src/telemetry/runtime/` by Cowork, so no new module or dependency direction is involved.

Technical novelty is low in the gate itself (read a JSON file per poll, same convention as Cowork) and moderate in the transition handling: no code today tracks an enabled/disabled edge in the runtime, there are several independent send sites with different local-only precedents (`canDeliver`, `sync:false`, `legacy` close, `leaveQueue`), and `reopenCompleted` plus `baselineCutoffMs` is only applied to newly built records. Everything is single-process; no schema, network or config-file format change was found as a given.

Test posture: the runtime has a large, well-structured suite (`DesktopTelemetryRuntime.test.ts`, `.start.test.ts`) with a reusable harness (temp `CODEMIE_HOME`, fake clock, fake adapter, mocked senders) and a close precedent for connection transitions; `DesktopSessionDelivery` and `DesktopSessionMetrics` have no unit tests of their own. CLI hint tests are cheap, pure, and several assert the exact old Claude text and will need to change with it. Key risks: gate coverage across all send sites, forward-only semantics for already-known sessions, transition detection across daemon restarts and corrupt-file flaps, lock handling when closing records, and Desktop-only users who cannot use the flagless `disable`.

---

## 8. External References

None named by the task.
