# Unified `codemie proxy connect` with Target Flags — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `connect desktop`/`connect vscode` subcommands with one `codemie proxy connect` command that takes orthogonal target flags, driven by a single testable `connectTargets()` orchestrator.

**Architecture:** Extract `connectTargets(options)` into a new `connect-orchestrator.ts` that owns the whole lifecycle: resolve SSO config → derive telemetry identity → one reconciled daemon lifecycle → per-target writer dispatch → summary + partial-failure exit/rollback. The unified `connect` action and the two deprecated aliases become thin wrappers that build a target set and delegate. Config writers are unchanged.

**Tech Stack:** TypeScript ESM, Commander, chalk, Vitest (dynamic-import mocking per `.ai-run/guides/testing/testing-patterns.md`).

**Commit** per task using the repository's existing Conventional Commits convention.

**Hard constraints (do not violate):**
- Config writers `connectors/desktop.ts`, `connectors/vscode.ts`, `connectors/vscode-claude-code.ts` are OUT OF SCOPE — mock them at the orchestrator boundary; never change their content.
- No telemetry value beyond the two existing ones (`claude-desktop`, `vscode-byok`).
- Preserve the `codemie proxy connect vscode` command string and its `vscode-byok` client type — asserted by `tests/integration/vscode-models.live.test.ts` (do not edit that test).

## File Structure
- Create `src/cli/commands/proxy/connect-orchestrator.ts` — `ConnectTargets`/`ConnectOptions` types, `deriveDaemonIdentity()`, the moved daemon-match + SSO helpers, and `connectTargets()`.
- Create `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` — unit tests with mocked writers, `daemon-manager`, and `health-check`.
- Modify `src/cli/commands/proxy/index.ts` — replace the two action bodies (`339-550`, `552-706`) with thin wrappers; add target flags + bare-connect list; add deprecated-alias notices.

---

### Task 1: Target types + telemetry-identity derivation (new module)

**Files:**
- Create: `src/cli/commands/proxy/connect-orchestrator.ts`
- Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`

**Test-first: yes** — table-driven test asserting `deriveDaemonIdentity()` collapses every target combination onto exactly the two existing identities (spec §3.3): any set including `claudeDesktop` or `vscodeClaudeCode` (with or without `vscode`) → `{ telemetryMode: 'claude-desktop' }`; `vscode` only → `{ telemetryMode: 'none', clientType: 'vscode-byok' }`. Assert no other value is ever produced.

- [ ] **Step 1 — Write the failing test** for `deriveDaemonIdentity` covering all seven non-empty flag combinations.
- [ ] **Step 2 — Run** `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3 — Create the module** with these new symbols:

```ts
export interface ConnectTargets {
  claudeDesktop?: boolean;
  vscode?: boolean;
  vscodeClaudeCode?: boolean;
}
export interface ConnectOptions {
  targets: ConnectTargets;
  profile?: string;
  insiders?: boolean;
  force?: boolean;
  verbose?: boolean;
}
export type DaemonIdentity =
  | { telemetryMode: 'claude-desktop'; clientType?: undefined }
  | { telemetryMode: 'none'; clientType: 'vscode-byok' };

export function deriveDaemonIdentity(t: ConnectTargets): DaemonIdentity {
  if (t.claudeDesktop || t.vscodeClaudeCode) return { telemetryMode: 'claude-desktop' };
  return { telemetryMode: 'none', clientType: 'vscode-byok' };
}
```

- [ ] **Step 4 — Run** the test. Expected: PASS.

---

### Task 2: `connectTargets` — no-write paths + one reconciled daemon lifecycle

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts`
- Modify: `src/cli/commands/proxy/index.ts:52-90,108` (move shared helpers out; see step 3)
- Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`

**Test-first: yes** — three failing tests: (a) empty target set → prints the spec §2 target list (`spec.md:49-62`), invokes no SSO/daemon/writer, leaves `process.exitCode` at 0; (b) `insiders` true with only `claudeDesktop` → emits the spec §3.6 warning (`spec.md:171-173`) and continues; (c) daemon reuse-vs-restart — with a running daemon, reuse when the strict `daemonMatchesRequest` passes and `checkProxyHealth({deep:true})` is healthy, restart (`stopDaemon`+`spawnDaemon`) when identity/profile/port mismatch, unhealthy, or `force`. Mock `daemon-manager` and `health-check`.

- [ ] **Step 1 — Write the failing tests** above (mock `../daemon-manager.js`, `../health-check.js`, and `resolveSsoProxyConfig`).
- [ ] **Step 2 — Run** the test file. Expected: FAIL (`connectTargets` undefined).
- [ ] **Step 3 — Move the shared primitives** the orchestrator needs out of `index.ts` into this module and re-import them in `index.ts` (avoids a circular import): `RequestedDaemonConfig` (`index.ts:52`), `getEffectiveClientType` (`index.ts:74`), `daemonMatchesRequest` (`index.ts:80`), and `resolveSsoProxyConfig` (`index.ts:108`). This makes the strict matcher the single shared match path (spec §3.2).
- [ ] **Step 4 — Implement `connectTargets`** up to daemon-ready: if no target flag is set, print the §2 list and return before any SSO/daemon call. Then, if `insiders && !vscode && !vscodeClaudeCode`, print the §3.6 warning and continue. Call `resolveSsoProxyConfig`, build a `RequestedDaemonConfig` from `deriveDaemonIdentity()` + profile/port/project/provider/targetUrl, then ensure the daemon via `checkStatus` → `daemonMatchesRequest` (strict, for all callers — the loose `telemetryMode !== 'claude-desktop'` gate at `index.ts:354` is not carried over) → `checkProxyHealth({ deep: true })` → `stopDaemon`/`spawnDaemon(identity)`, setting `startedInThisRun = true` only when this run spawned it. On startup failure, roll back if started this run, `printProxyError`, and rethrow (matches today; per-target dispatch is Task 3).
- [ ] **Step 5 — Run** the test. Expected: PASS.

---

### Task 3: Per-target writer dispatch + summary + partial-failure semantics

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts`
- Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`

**Test-first: yes** — tests for the spec §3.4 rules with writers mocked to resolve/reject: all-success → `process.exitCode` stays 0 and daemon kept; one target fails while another succeeds → `process.exitCode === 1`, `stopDaemon` NOT called (daemon kept), summary lists `✓`/`✗` with a one-line reason in fixed order; all requested targets fail and daemon was started this run → `stopDaemon` called and exitCode 1; partial failure where daemon was NOT started this run → daemon still not stopped.

- [ ] **Step 1 — Write the failing tests** above.
- [ ] **Step 2 — Run** the test file. Expected: FAIL.
- [ ] **Step 3 — Implement dispatch:** after the daemon is ready, iterate requested targets in fixed order — Claude Desktop, VS Code BYOK, VS Code Claude Code — each in its own `try/catch` capturing `{ target, ok, error }`. Reuse the existing per-target write sequences unchanged: desktop = `fetchManagedMcpServers` + `mapCanonicalToDesktop` + `writeDesktopConfig` (from `index.ts` desktop body ~470-503); VS Code BYOK = `writeVsCodeLanguageModelsConfig(url, insiders)` + `displaySetupInstructions` when `requiresSecretConfiguration` (from vscode body ~640-700); VS Code Claude Code = `writeVsCodeClaudeCodeConfig(gatewayUrl, gatewayKey, insiders)` (from `index.ts:504-533`). Then print the §3.4 summary and apply: any failure → `process.exitCode = 1`; all failed **and** `startedInThisRun` → `stopDaemon()`; at least one success → keep the daemon.
- [ ] **Step 4 — Run** the test. Expected: PASS.

---

### Task 4: Unified `connect` action + deprecated aliases (index.ts wiring)

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:336-724`
- Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` (or a co-located `index` test)

**Test-first: yes** — with `connect-orchestrator` mocked, drive `createProxyCommand().parseAsync(...)` and assert: `connect desktop` prints the highlighted notice (`spec.md:156`) then calls `connectTargets` with `{ claudeDesktop: true }` and originally-released modifiers only; `connect vscode` prints its notice (`spec.md:157`) then calls with `{ vscode: true }`, preserving the `vscode-byok` identity; unified `connect --claude-desktop --vscode --vscode-claude-code` calls with all three flags mapped to the target set; the `desktop`/`vscode` aliases expose no `--vscode-claude-code` option.

- [ ] **Step 1 — Write the failing tests** above.
- [ ] **Step 2 — Run** the test. Expected: FAIL.
- [ ] **Step 3 — Rewire `index.ts`:** on the `connect` command (`index.ts:336`) add `--claude-desktop`, `--vscode`, `--vscode-claude-code` target options plus shared modifiers `--profile/--force/--verbose/--insiders`, and an `.action` that builds `ConnectTargets` from the flags and calls `connectTargets` (a bare invocation with no target flag passes an empty set — Task 2 prints the list). Replace the `desktop` action body (`339-550`) with a wrapper that prints a `chalk.bold.yellow` deprecation notice then calls `connectTargets({ targets: { claudeDesktop: true }, ... })`, and the `vscode` action body (`552-706`) likewise for `{ vscode: true }`. Drop the `--vscode-claude-code` option from the `desktop` alias (`index.ts:345`) — it lives only on unified `connect` (spec §3.5). Remove the now-dead `DesktopConnectOptions.vscodeClaudeCode` field (`index.ts:41`) and any code referencing the moved helpers.
- [ ] **Step 4 — Run** the test. Expected: PASS.
