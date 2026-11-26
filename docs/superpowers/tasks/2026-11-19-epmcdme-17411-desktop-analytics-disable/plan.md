# EPMCDME-17411 Desktop analytics disable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `codemie proxy analytics disable` stops Claude Desktop metrics and conversation upload; `enable` resumes and sends what was written while disabled (backfill, as for Cowork).

**Architecture:** One shared helper reads `claude-analytics.json` (corrupt = off). `DesktopTelemetryRuntime.poll()` re-reads it every poll and collects nothing while it is off, holding `lastPollAt` back so the first poll after enable discovers what changed meanwhile. `DesktopSessionMetrics.canDeliver()` is a second layer. CLI text and Desktop-only target selection follow.

**Tech Stack:** TypeScript (ES modules, `.js` imports, `@/` alias, no `any`, `logger` not console), Vitest.

## Global Constraints

- No git commit, branch, push or PR steps; changes stay uncommitted. Never touch `.codemie/codemie-cli.config.json`.
- Unit tests only. Verify with `npx tsc --noEmit`, `npx eslint <changed files> --max-warnings=0`, `npx vitest run <touched test files>`; never the full suite, build or integration tests.
- `CoworkEventProducer` is unchanged. `excludedProjects` is NOT applied to Desktop chats.
- Negative-constraint pass: no task commits, runs integration tests, refactors Cowork, or applies exclusions to Desktop; include/exclude target selection stays unchanged.

## Acceptance criteria

- With the switch off or the file corrupt, Desktop sends no start/end metric and no conversation sync, from any send site.
- After enable, what was written while disabled is sent (new, known and tracked chats), the same rule as Cowork.
- Records tracked at disable are left as they are and are sent after enable.
- `disable` output, `--help` and `analytics status` agree on scope; the exclude note still says Desktop chats are not affected.
- Flagless `enable`/`disable` works when only Claude Desktop is connected.

---

### Task 1: Shared switch helper

**Files:** Create `src/telemetry/runtime/analytics-switch.ts`; Test `src/telemetry/runtime/__tests__/analytics-switch.test.ts`

**Interfaces:** Produces `type ClaudeAnalyticsSwitch = 'on' | 'off' | 'corrupt'`, `readClaudeAnalyticsSwitch(): Promise<ClaudeAnalyticsSwitch>`, `claudeAnalyticsCollecting(): Promise<boolean>`, and `AnalyticsSwitch.check(): Promise<boolean>`, the daemon's per-poll read (warns once on a corrupt file).

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

### Task 2: `canDeliver` layer

**Files:** Modify `src/telemetry/runtime/DesktopSessionMetrics.ts:33`, `src/telemetry/runtime/DesktopSessionDelivery.ts` (log text at :103); Test `src/telemetry/runtime/__tests__/DesktopSessionDelivery.test.ts` (new)

**Interfaces:** Consumes Task 1 `claudeAnalyticsCollecting`.

Test-first: yes — `new DesktopSessionMetrics(...).canDeliver()` is false while `enabled:false` and while corrupt, true otherwise.

- [ ] Write the test; run; see it fail.
- [ ] `canDeliver()`: first line `if (!(await claudeAnalyticsCollecting())) return false;` (before the cookie read). A finalization while off then saves the record and flushes it locally, nothing sent; the record stays live and is delivered after enable. Reword the `deliverLocked` log at :103 to "Analytics off or no usable credentials; nothing sent" (no test pins it; grep first).
- [ ] Run `DesktopSessionDelivery.test.ts`; passes.

### Task 3: Runtime gate and backfill on enable

**Files:** Modify `src/telemetry/runtime/DesktopTelemetryRuntime.ts` (`poll()` :145-215); Test `src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts` (new `describe` after 'collection while Desktop is connected', ~:2256; reuse `startDaemon`, `pollTicks`, fake clock, `mockSync`, `mockSendSessionStart/End`; write the switch with `writeFileSync(join(codemieHome, 'claude-analytics.json'), ...)`)

**Interfaces:** Consumes Task 1 `AnalyticsSwitch`. Adds the private field `analyticsSwitch`.

Test-first: yes —
1. `enabled:false`: several polls with a discoverable chat -> no start metric, no sync, no new record, no end metric on stop(); Cowork is still called as before.
2. A chat tracked and synced while on gains messages while off: nothing is synced while off; after enable they are synced.
3. A chat opened while off: nothing is sent while off; after enable it is synced in full, with its start metric and no baseline.
4. `stop()` while off sends no end metric and leaves the record live; a later start with the switch on delivers it.
5. A corrupt file sends nothing and warns once; collection resumes when it reads valid.
6. A chat finalized before the pause and active while off is reopened after enable and its new messages are synced.

- [ ] Write the tests; run; see them fail.
- [ ] `poll()`: call `analyticsSwitch.check()` first (before `connection.check`). When it is false: set `reopenLockFailed` so `lastPollAt` is held back and the first poll after enable re-reads the window of the pause, call `cowork?.startIfIdle(now, connected)` exactly as today (not-connected branch passes `false`), skip the start-up pass, discovery, `pollSession`, `finalizeInactive` and redelivery, and return; `startupDue` stays set so the start-up reconcile runs on the first collecting poll. Tracked sessions and live records are left as they are. Connected-and-collecting flow unchanged.
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

`excludedProjects` for Desktop chats; `doctor` (`analytics-delivery-lines.ts`) and `inspect-desktop` still report `collecting: true` while off; a Desktop row in `analytics status`; user docs (`docs/COMMANDS.md`, `HOOKS.md`, `PROXY-AND-ANALYTICS.md`, README); the held-back discovery window is lost if the daemon restarts while off (the start-up reconcile still delivers its live records).
