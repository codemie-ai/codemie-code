# QA Gate Report — EPMCDME-15536

**Branch**: EPMCDME-15536_sso-session-finalization-fallback
**Runner**: npm
**Started**: 2026-10-13T12:28:00.000Z
**Status**: PASSED (by HITL decision — all 16 unit/integration failures confirmed pre-existing on clean `origin/main`, unrelated to this change; see `decisions.jsonl` for the `feature.verification` gate record)

## Gates

| Gate | Status | Duration | Command | Notes |
|---|---|---|---|---|
| license-check | PASS | ~2s | `npm run license-check` | No missing/stale headers. |
| lint | PASS | ~15s | `npm run lint` | Zero errors, zero warnings across all 6 changed source files + 6 new/extended test files. |
| typecheck | PASS | ~20s | `npm run typecheck` | No diagnostics. |
| build | PASS | ~10s | `npm run build` | `dist/` rebuilt, plugin assets + statusline bundle copied successfully. |
| unit | FAIL | ~17s | `npx vitest run --project unit` | 12 failed / 4759 total, across 4 files: `AgentCLI-model-source.test.ts`, `pi.extensions-scan.test.ts`, `providers-core.test.ts`, `extensions-scan.test.ts`. **None of these files are touched by this diff.** Verified identical failure count/content on a clean `origin/main` checkout via a temporary `git worktree` — pre-existing, unrelated to this change. |
| integration | FAIL | ~11s | `npx vitest run --project cli` | 4 failed / 288 total, all in `tests/integration/sso-claude-plugin.test.ts` (same `--settings`-vs-`--plugin-dir` symptom family as the unit-gate failures — a pre-existing model-picker-config injection issue unrelated to `onSessionStart`/reconciliation). **Verified identical failure on a clean `origin/main` checkout via a second temporary worktree.** |
| secrets scan | PASS | <1s | `npm run validate:secrets` | No secrets detected. |
| commitlint (full range) | PASS | ~2s | `npx commitlint --from origin/main --to HEAD --verbose` | All 6 commits on this branch pass Conventional Commits validation, 0 problems each. |
| ui | SKIPPED | — | (n/a) | No UI surface changed — this diff touches only backend plugin lifecycle code. |

## Failure detail

### unit gate — `pi.extensions-scan.test.ts` (representative sample)
```
AssertionError: expected +0 to be 2 // Object.is equality
 ❯ src/agents/plugins/pi/__tests__/pi.extensions-scan.test.ts:65:35
```
### integration gate — `sso-claude-plugin.test.ts` (representative sample)
```
AssertionError: expected '--settings' to be '--plugin-dir' // Object.is equality
 ❯ tests/integration/sso-claude-plugin.test.ts > ... > should inject --plugin-dir flag when plugin is installed
```

Both failure families were cross-checked against a clean `origin/main` worktree (`git worktree add /tmp/codemie-code-main-check[2] origin/main`) with the same `node_modules`; the exact same tests fail with the same assertion messages, confirming these are pre-existing baseline failures on `main`, not regressions introduced by this branch's 6 commits (which touch only `claude.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts`, `codemie-code.plugin.ts`, `opencode.plugin.ts`, `copilot-cli.plugin.ts`, and their lifecycle test files — none of the 5 failing test files are in that list).

## Drift signal

No. Implementation matches spec.md exactly: `onSessionStart` method names, `reconcileStaleSessions` call signature `(agentName, env, buildHookConfig)`, and the Pattern A/B split all match what spec.md and plan.md specified.

## Follow-up — CLI reconciliation hardening (2026-10-19)

Later review surfaced two correctness gaps the original Pattern A/B rollout did not cover:

1. **False stale on idle live terminals** — a second launch could finalize a still-open session as `interrupted` after 30 minutes of quiet because generic hook-managed sessions had no liveness heartbeat.
2. **Wrong routing/profile context on reconciliation** — stale finalization reused the current launch's `apiBaseUrl` / `ssoUrl` / `syncApiUrl` / `profileName`, and synthetic `SessionEnd.cwd` used `process.cwd()`, rather than the stranded session's own persisted context.

**Fix shipped**:

- `BaseAgentAdapter.run()` now owns generic hook-managed reconciliation centrally and writes a per-session heartbeat (`session.liveness.lastHeartbeatAt`);
- stale detection now uses the latest trustworthy sign of life (`max(real last activity, heartbeat)`);
- `hook.ts` / `ensure-session.ts` now persist `analyticsContext` on the session record;
- reconciliation reuses that persisted routing/profile context and the stale session's `workingDirectory`.

**Targeted verification**:

| Gate | Status | Command | Notes |
|---|---|---|---|
| typecheck | PASS | `npm run typecheck` | No diagnostics after the heartbeat + analytics-context changes. |
| unit (targeted) | PASS | `npx vitest run src/agents/core/session/__tests__/SessionStore.liveness.test.ts src/agents/core/session/__tests__/SessionStore.endTime.test.ts src/agents/core/session/__tests__/stale-session-reconciliation.test.ts src/agents/core/__tests__/BaseAgentAdapter.test.ts src/agents/plugins/opencode/__tests__/opencode-session-record.test.ts` | 5 files, 83 tests passing. Covers heartbeat persistence, endTime threading, working-directory preservation, analytics-context preference, BaseAgentAdapter centralized sweep, and ensure-session persistence. |

**Drift signal**: Yes — intentional and correct. The new implementation no longer matches the original "Pattern A/B only, no changes to `stale-session-reconciliation.ts` / `hook.ts`" constraint because review proved that design still allowed false stale finalization and cross-profile reconciliation drift. The docs/spec for this task are retained as historical delivery artifacts, with addenda marking the current architecture.

## Follow-up — Claude Desktop restart reconciliation (2026-10-15)

**Scope**: Task 8 in `plan.md` (`SessionStore.findActiveSessions`, `DesktopTelemetryRuntime.reconcilePersistedSessions`), plus a QA-driven failure-isolation fix (see below) and new wiring tests for `codex`/`pi` closing a pre-existing coverage gap from the original acceptance criteria.

| Gate | Status | Command | Notes |
|---|---|---|---|
| typecheck | PASS | `npx tsc --noEmit` | No diagnostics. |
| lint | PASS | `npm run lint` | Zero errors, zero warnings. |
| build | PASS | `npm run build` | `dist/` rebuilt successfully. |
| license-check | PASS | `npm run license-check` | No missing/stale headers. |
| secrets scan | PASS | `npm run validate:secrets` | No leaks found. |
| unit (full project) | PASS* | `npx vitest run --project unit` | 12 failed / 4776 total, same 4 pre-existing files as the original run above (`AgentCLI-model-source.test.ts`, `extensions-scan.test.ts`, `providers-core.test.ts`, `pi.extensions-scan.test.ts`) — none touched by this change; failure count/content unchanged from the baseline recorded earlier in this report. |
| integration (`cli` project) | PASS* | `npx vitest run --project cli` | 5 failed / 288 total: the same `sso-claude-plugin.test.ts` baseline failures from the original run, plus one `self-update.test.ts` failure that re-ran green in isolation on both `main` and this branch — network-timing flakiness in that test, not a regression. |
| `agent` project (exploratory, not part of `npm run ci`) | SKIPPED (environment) | `npx vitest run --project agent` | ~15 failures, all requiring a live CodeMie backend compatible with the installed CLI version plus real network access — unavailable in this sandbox, unrelated to any file touched by this ticket. |

\* Marked PASS on the same basis as the original run: failures are the identical pre-existing baseline (or confirmed-flaky/environmental), not regressions from this change.

**QA finding and fix — finalization failures must not block startup**: adversarial testing (forcing `SessionSyncer.sync()` to reject during a restart finalization) found that an unhandled `finalizeSession` rejection inside `reconcilePersistedSessions()` would propagate through `start()` and fail daemon startup entirely (`proxy-daemon.ts`'s outer catch calls `process.exit(1)`) — a single stranded session with a transient network/SSO issue would have taken down the whole proxy daemon, which is worse than the original stuck-session bug. Fixed by wrapping the `finalizeSession` call in its own try/catch (log-and-continue), matching the non-blocking convention used everywhere else in this reconciliation path. Regression test: `does not let one failed finalization abort reconciliation of the rest, or crash start()` in `DesktopTelemetryRuntime.test.ts`.

**Coverage gap closed**: the original ticket's acceptance criteria flagged that no wiring-level test asserted `onSessionStart` actually invokes reconciliation, "even for codex/pi" — this held through the Task 1-7 delivery (the 6 new plugins got wiring tests; codex/pi did not). Added `onSessionStart` → reconciliation wiring tests for both (`codex.plugin.lifecycle.test.ts`, new `pi.plugin.lifecycle.test.ts`), so all 8 plugins with this fallback now have equivalent coverage.

**Targeted suites** (all passing): `DesktopTelemetryRuntime.test.ts` (26 tests, including 9 restart-reconciliation cases), `SessionStore.index.test.ts`, `core-misc.test.ts`, `codex.plugin.lifecycle.test.ts`, `pi.plugin.lifecycle.test.ts`, full `src/telemetry` + `src/agents/core/session`.

**Drift signal**: No. The Desktop fix remains additive — no change to any Pattern A/B plugin, `reconcileStaleSessions`, or `hook.ts`. The codex/pi additions are new tests only, no production code changed in those two plugins.
