# EPMCDME-17411 Desktop analytics disable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `codemie proxy analytics disable` stops Claude Desktop metrics and conversation upload; `enable` resumes forward-only.

**Architecture:** One shared helper reads `claude-analytics.json` (corrupt = off). `DesktopTelemetryRuntime.poll()` re-reads it every poll, tracks the last valid state for the off/on edge, closes live Desktop records locally on off, and rebases known records on on. `DesktopSessionMetrics.canDeliver()` is a second layer. CLI text and Desktop-only target selection follow.

**Tech Stack:** TypeScript (ES modules, `.js` imports, `@/` alias, no `any`, `logger` not console), Vitest.

## Global Constraints

- No git commit, branch, push or PR steps; changes stay uncommitted. Never touch `.codemie/codemie-cli.config.json`.
- Unit tests only. Verify with `npx tsc --noEmit`, `npx eslint <changed files> --max-warnings=0`, `npx vitest run <touched test files>`; never the full suite, build or integration tests.
- `CoworkEventProducer` is unchanged. `excludedProjects` is NOT applied to Desktop chats.
- Negative-constraint pass: no task commits, runs integration tests, refactors Cowork, or applies exclusions to Desktop; include/exclude target selection stays unchanged.

## Acceptance criteria

- With the switch off or the file corrupt, Desktop sends no start/end metric and no conversation sync, from any send site.
- After enable, nothing written while disabled is sent (new, known and tracked chats).
- Records tracked at disable are closed locally (renamed, nothing sent) and are not uploaded by a later redelivery pass.
- `disable` output, `--help` and `analytics status` agree on scope; the exclude note still says Desktop chats are not affected.
- Flagless `enable`/`disable` works when only Claude Desktop is connected.

---

### Task 1: Shared switch helper

**Files:** Create `src/telemetry/runtime/analytics-switch.ts`; Test `src/telemetry/runtime/__tests__/analytics-switch.test.ts`

**Interfaces:** Produces `type ClaudeAnalyticsSwitch = 'on' | 'off' | 'corrupt'`, `readClaudeAnalyticsSwitch(): Promise<ClaudeAnalyticsSwitch>`, `claudeAnalyticsCollecting(): Promise<boolean>`.

Test-first: yes — with a temp `CODEMIE_HOME`: missing file -> on, `{enabled:true}` -> on, `{enabled:false}` -> off, `not json` -> corrupt and `claudeAnalyticsCollecting()` false for off and corrupt.

- [ ] Write the test (model the temp-home setup on `CoworkEventProducer.test.ts:441-469`), run it, see it fail.
- [ ] Implement, importing `readClaudeAnalyticsPreferences` from `@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js` as Cowork does:

```ts
export async function readClaudeAnalyticsSwitch(): Promise<ClaudeAnalyticsSwitch> {
  const prefs = await readClaudeAnalyticsPreferences();
  if (prefs.kind === 'corrupt') return 'corrupt';
  return prefs.value.enabled ? 'on' : 'off';
}
export async function claudeAnalyticsCollecting(): Promise<boolean> {
  return (await readClaudeAnalyticsSwitch()) === 'on';
}
```

- [ ] Run the new test; it passes.

### Task 2: Close records locally + `canDeliver` layer

**Files:** Modify `src/telemetry/runtime/DesktopSessionDelivery.ts` (add method after `reconcileRecords`, ~:259; adjust log text at :103), `src/telemetry/runtime/DesktopSessionMetrics.ts:33`; Test `src/telemetry/runtime/__tests__/DesktopSessionDelivery.test.ts` (new)

**Interfaces:** Consumes Task 1 `claudeAnalyticsCollecting`. Produces `DesktopSessionDelivery.closeLiveRecordsLocally(trackedActivity?: ReadonlyMap<string, number>): Promise<boolean>` — true when no own-host live record is left unclosed.

Test-first: yes — in a temp `CODEMIE_HOME`, save an `active` record (owner `process.pid`) and a live `completed` undelivered record via `SessionStore`, mock `SessionSyncer.sync` and the metrics senders: after the call both are renamed `completed_*`, the active one saved `reason: 'desktop-analytics-disabled'`, sync/end metric never called, returns true; a record whose reconcile lock is held (`acquirePidLock` mode `try` fails) returns false and stays live; a foreign-host record and an `active` record owned by another live pid are untouched. A second test: `new DesktopSessionMetrics(...).canDeliver()` is false while `enabled:false` and while corrupt.

- [ ] Write both tests; run; see them fail.
- [ ] `canDeliver()`: first line `if (!(await claudeAnalyticsCollecting())) return false;` (before the cookie read). Reword the `deliverLocked` log at :103 to "Analytics off or no usable credentials; nothing sent" (no test pins it; grep first).
- [ ] `closeLiveRecordsLocally`: list `getCodemiePath('sessions')` with `isLiveRecordFileName` (as `listCandidates` :266-304). For each record with `agentName === config.clientType` and not `isForeignRecord`, take `acquirePidLock(reconcileLockPath(id), { mode: 'try' })` (no lock = unclosed), re-read via `readLiveRecord` under it, then:
  - `active` and owner is not this process and alive (`isOwnerAlive`): skip, not counted.
  - `active`: `saveSession({...record, status: 'completed', reason: 'desktop-analytics-disabled', endTime: desktopEndTime(record, trackedActivity.get(id))})`, then `leaveQueue(saved, undefined, Date.now())` (no drop mark, `delivery-budget.ts:114`).
  - `completed` with `ownerPid` defined: `leaveQueue(record, undefined, Date.now())`.
  - `leaveQueue` false -> `logger.warn` and count as unclosed. Never throws; failures are logged.
- [ ] Run `DesktopSessionDelivery.test.ts`; passes.

### Task 3: Runtime gate, edge detection, forward-only

**Files:** Modify `src/telemetry/runtime/DesktopTelemetryRuntime.ts` (new fields near :67; `poll()` :145-215; `retrackSession` :449-474); Test `src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts` (new `describe` after 'collection while Desktop is connected', ~:2256; reuse `startDaemon`, `pollTicks`, fake clock, `mockSync`, `mockSendSessionStart/End`; write the switch with `writeFileSync(join(codemieHome, 'claude-analytics.json'), ...)`; add an `applyBaseline` spy to `createAdapter()` if missing)

**Interfaces:** Consumes Task 1 `readClaudeAnalyticsSwitch`, Task 2 `closeLiveRecordsLocally`. Adds private fields `analyticsState?: 'on' | 'off'`, `closePending`, `corruptWarned`, `forwardOnlyFrom?: number`, `rebased: Set<string>`.

Test-first: yes —
1. `enabled:false`: several polls with a discoverable chat -> no start metric, no sync, no new record, no end metric on stop(); Cowork is still called as before.
2. A chat tracked and synced while on, then disabled: next poll leaves its files `completed_*`, nothing sent; after enabling and advancing `DESKTOP_REDELIVERY_INTERVAL_MS` still nothing sent.
3. Enable after a disabled period, chat written during it and again after: `applyBaseline` receives cutoff = enable time (Date mock), so only post-enable content is synced; the chat idle since enable is skipped (`collectingSince`).
4. Daemon started disabled -> enabled is an edge (cutoff applied); corrupt -> valid-on flap while previously on is not (no cutoff, `collectingSince` unchanged); corrupt sends nothing.
5. `closeLiveRecordsLocally` returning false keeps the gate closed after enable until it succeeds.

- [ ] Write the tests; run; see them fail.
- [ ] Add `checkAnalyticsSwitch(now): Promise<boolean>`, called first in `poll()` (before `checkDesktopConnected`):

```ts
private async checkAnalyticsSwitch(now: number): Promise<boolean> {
  const read = await readClaudeAnalyticsSwitch();
  if (read === 'corrupt') { /* warn once with the prefs path; keep analyticsState: a flap is no edge */ return false; }
  this.corruptWarned = false;
  if (read === 'off') {
    if (this.analyticsState !== 'off' || this.closePending) {
      this.analyticsState = 'off';
      this.closePending = !(await this.delivery.closeLiveRecordsLocally(this.trackedActivity()));
      if (!this.closePending) { this.trackedSessions.clear(); this.knownSessionIds = undefined; }
    }
    return false;
  }
  if (this.analyticsState === 'off') {
    if (this.closePending) this.closePending = !(await this.delivery.closeLiveRecordsLocally(this.trackedActivity()));
    if (this.closePending) return false; // forward-only: not enabled until the close succeeded
    this.collectingSince = this.forwardOnlyFrom = now;
    this.rebased.clear();
  }
  this.analyticsState = 'on';
  return true;
}
```
  `trackedActivity()` maps `codemieSessionId -> lastSeenActivityAt` from `trackedSessions`. Log info on each real edge.
- [ ] `poll()`: when `!collecting`, call `cowork?.startIfIdle(now, connected)` exactly as today (not-connected branch passes `false`), skip start-up pass, discovery, `pollSession`, `finalizeInactive`, redelivery, and return; `startupDue` stays set so the start-up reconcile runs on the first collecting poll. Connected-and-collecting flow unchanged. `lastPollAt` handling in `finally` unchanged.
- [ ] `retrackSession` :464: when `forwardOnlyFrom !== undefined`, the session id is not in `rebased` and `existing.runtimeCheckpoint?.baselineCutoffMs === undefined`, add `baselineCutoffMs: this.forwardOnlyFrom` to the merged `setRuntimeCheckpoint` call and add the id to `rebased`. This reuses `adapter.applyBaseline` in `processSession` (:52) so known/reopened records skip earlier content.
- [ ] Run `DesktopTelemetryRuntime.test.ts` and `DesktopTelemetryRuntime.start.test.ts` (the latter also reads the switch under its own `CODEMIE_HOME`); all pass.

### Task 4: CLI wording and tests

**Files:** Modify `src/cli/commands/proxy/analytics-hints.ts:85-103`, `analytics-command.ts:63,121,289`, `analytics-status.ts:88`; Tests `__tests__/analytics-hints.test.ts:11-26`, `analytics-advice.test.ts:136-149,186-205`, `analytics-status.test.ts:133`

**Interfaces:** `unaffectedChannels(connectorId: string, verb: 'disable' | 'exclude' = 'disable'): string`; `coverageNote(connectorId: string, verb: 'disable' | 'exclude' = 'disable'): string`. Copilot branches and the default branch (unknown ids) keep their current text. Add an explicit `CLAUDE_CODE_OTLP_AGENT_NAME` case, with `BASE` = "the daily analytics collector and the session sync that `codemie claude` runs itself":
- Claude `disable`: channels = BASE; note = "Controls Claude Code hooks, Cowork and Claude Desktop chats (metrics and conversation sync) — not affected: BASE."
- Claude `exclude`: channels = "Claude Desktop chats (exclusions are not applied to them), BASE"; note = "Controls the hook pipeline and Cowork only — not affected: <channels>."

Test-first: yes — update the three old-sentence tests to the new text first (they fail), then change the code. Add: `coverageNote(CLAUDE,'disable')` mentions Claude Desktop and not "hook pipeline only"; `coverageNote(CLAUDE,'exclude')` says Desktop chats are not affected; Copilot/unknown outputs unchanged.

- [ ] Update tests; run; see them fail.
- [ ] Implement in `analytics-hints.ts`; `analytics-command.ts:63` passes `'disable'`, `:121` passes `'exclude'`; `analytics-status.ts:88` uses the `'exclude'` variant for the closing line (it also lists exclusions).
- [ ] `analytics-command.ts:289` help: "Stop all analytics collection (every connected connector, or the flagged one; for Claude this covers hooks, Cowork and Claude Desktop chats; hooks stay installed)". Leave `resumeNote` unchanged.
- [ ] Run `analytics-hints`, `analytics-advice`, `analytics-status` and `analytics-command` tests; pass.

### Task 5: Desktop-only target selection

**Files:** Modify `src/cli/commands/proxy/analytics-targets.ts:215-229` (`connectorState`); Test `src/cli/commands/proxy/__tests__/analytics-command.test.ts` (near :859, which already mocks `../connectors/desktop.js`)

Test-first: yes — flagless `disable` and `enable` with no hooks, no stored preference, and `readDesktopGateway` resolving `{ port }` write `claude-analytics.json` for the Claude connector and do not print "No analytics connector is connected"; with no gateway the existing error stays; flagless `include`/`exclude` still use `listActiveAnalyticsConnectors` (unchanged).

- [ ] Write tests; run; see them fail.
- [ ] In `connectorState`, for the Claude connector set `active ||= Boolean(await readDesktopGateway())` (import from `./connectors/desktop.js`; a throw counts as not connected, via `logger.debug`). Do not change `ANALYTICS_CONNECTORS[].isActive`, so `proxy status` and include/exclude are unaffected.
- [ ] Run `analytics-command.test.ts` and `analytics-connectors.test.ts`; pass.

---

## Final verification (scoped, no commits)

- [ ] `npx tsc --noEmit`
- [ ] `npx eslint src/telemetry/runtime/analytics-switch.ts src/telemetry/runtime/DesktopSessionDelivery.ts src/telemetry/runtime/DesktopSessionMetrics.ts src/telemetry/runtime/DesktopTelemetryRuntime.ts src/cli/commands/proxy/analytics-hints.ts src/cli/commands/proxy/analytics-command.ts src/cli/commands/proxy/analytics-status.ts src/cli/commands/proxy/analytics-targets.ts --max-warnings=0` (plus the touched test files)
- [ ] `npx vitest run src/telemetry/runtime/__tests__/analytics-switch.test.ts src/telemetry/runtime/__tests__/DesktopSessionDelivery.test.ts src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.start.test.ts src/cli/commands/proxy/__tests__/analytics-hints.test.ts src/cli/commands/proxy/__tests__/analytics-advice.test.ts src/cli/commands/proxy/__tests__/analytics-status.test.ts src/cli/commands/proxy/__tests__/analytics-command.test.ts`

## Follow-ups (no work here)

`excludedProjects` for Desktop chats; Cowork backfill; `doctor` (`analytics-delivery-lines.ts`) and `inspect-desktop` still report `collecting: true` while off; a Desktop row in `analytics status`; user docs (`docs/COMMANDS.md`, `HOOKS.md`, `PROXY-AND-ANALYTICS.md`, README); the in-memory forward-only cutoff is lost if the daemon restarts between enable and a known chat's next activity.
