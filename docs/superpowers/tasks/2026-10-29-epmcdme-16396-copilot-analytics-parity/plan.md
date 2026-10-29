# Copilot Analytics Disable/Enable/Exclude/Include/Status Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `copilot-cli-otlp` and `copilot-chat-otlp` the same analytics disable/enable/exclude/include/status control that `claude-code-otlp` already has (EPMCDME-16396, PR #711), without touching the existing `CopilotConnectorScope`/`connect`/`disconnect` machinery.

**Architecture:** Add one new, CodeMie-owned, keyed-by-connector preferences store (`copilot-analytics.json`, mirroring `copilot-connectors.json`'s keying) plus one gate function that composes the new preferences with the existing `isCopilotProjectTracked`/`readCopilotConnectorScope` check — the exact same corrupt→disabled→excluded→delegate precedence already shipped for Claude. Wire the gate into both plugins' `isTracked()`, ahead of or alongside their existing guards, and extend `copilot-chat-otlp.plugin.ts`'s `onUntrackedHook()` with new messages for the new block reasons. Extend the existing `codemie proxy analytics` command with connector-selection flags reusing the already-shipped `*_AGENT_NAME` constants; the Claude code path is refactored to share the same tiny store abstraction but its behavior and tests stay byte-identical.

**Tech Stack:** TypeScript/ESM, `node:fs/promises` atomic writes, Vitest (`@group unit`), Commander.

**Spec:** `docs/superpowers/tasks/2026-10-29-epmcdme-16396-copilot-analytics-parity/technical-analysis.md` (no spec.md — sdlc-light has no spec stage; this file is the codebase-grounding research this plan argues from).

## Global Constraints

- ES modules; every relative import ends in `.js`; use the `@/` alias, never deep `../../..` relatives.
- No `any`; explicit return types on every exported function.
- Atomic writes: `writeFile(path + '.' + process.pid + '.tmp')` then `rename()`, `unlink(tempPath).catch(() => undefined)` on error — identical to `claude-code-otlp.preferences.ts` and `copilot-connector-scope.ts`.
- Read path never throws (`{kind:'ok'|'corrupt'}` discriminated union); `update*` throws `ConfigurationError` on a corrupt existing file and must not touch bytes on disk in that case.
- Must NOT modify `src/agents/core/copilot-connector-scope.ts`, `resolveScope()` in `src/cli/commands/proxy/connectors/copilot-cli-otlp.ts` / `copilot-chat-otlp.ts`, or any `connect`/`disconnect` logic.
- Must NOT add an `onUntrackedHook` override to `copilot-cli-otlp.plugin.ts` in this task — its absence is a documented pre-existing gap (see Known Gaps below), not something to fix here.
- `codemie proxy analytics` with no connector flag must keep meaning `claude-code-otlp` exactly as today — zero breaking change for existing callers/tests.
- Reuse `CLAUDE_CODE_OTLP_AGENT_NAME` / `COPILOT_CLI_OTLP_AGENT_NAME` / `COPILOT_CHAT_OTLP_AGENT_NAME` from their respective `*.constants.ts` files for both the plugin `this.name` values and the new CLI flag names — do not invent new strings.
- `copilot-chat-otlp.plugin.ts` has no `CODEMIE_SESSION_ID` guard anywhere today (confirmed by direct read: `isTracked()` only checks `readCopilotConnectorScope` + `hasRequiredIdentity`) — do not write a test asserting such a guard exists or claiming parity with `copilot-cli-otlp` on this point.

## Known Gaps (documented, not fixed by this plan)

- `copilot-cli-otlp.plugin.ts` has no `onUntrackedHook` override (relies on `OtlpAgentAdapter`'s no-op default), so CLI enforced events (`userPromptTransformed`, `preToolUse`) get zero feedback on any untracked reason — old or new. User decision (2026-10-29): document as a known gap, mirroring the already-accepted Claude-side "no native binary E2E test" precedent; do not add new logic to this file in this task.

## Review Focus

- A `cwd` that is `undefined`/empty on an enforced hook event must resolve to "not excluded" (never throw), matching `isProjectExcluded`'s existing `if (!cwd) return false` contract — a crash here would break every hook call, not just excluded ones.
- Two sibling projects that share a path prefix (`/work/a` vs `/work/ab`) must not cross-exclude each other — `isPathInside` (real `path.relative` containment), never a string-prefix check.
- Excluding a child path after its parent is already excluded, or vice-versa, must never leave two overlapping entries or report false success — this is the exact `0309ed65` bug class; the fixed logic in `analytics-command.ts` must be reused verbatim, not reimplemented.
- A corrupt `copilot-analytics.json` must fail closed on the hook-read path (not tracked) and must refuse to be overwritten on the CLI-write path (exit code 1, bytes on disk unchanged) — silently "fixing" a corrupt file would hide a user's prior intent.
- Running `codemie proxy analytics disable` with no flag after this change must still produce byte-identical `claude-analytics.json` behavior and pass every existing test in `analytics-command.test.ts` unmodified — a regression here breaks the already-shipped, already-reviewed Claude feature.

---

### Task 1: Copilot analytics preferences store

**Files:**
- Create: `src/agents/core/copilot-analytics-preferences.ts`
- Test: `src/agents/core/__tests__/copilot-analytics-preferences.test.ts`

**Interfaces:**
- Produces:
  - `interface CopilotAnalyticsRecord { enabled: boolean; excludedProjects: string[] }`
  - `const DEFAULT_COPILOT_ANALYTICS_RECORD: CopilotAnalyticsRecord = { enabled: true, excludedProjects: [] }`
  - `function getCopilotAnalyticsPreferencesPath(): string` — returns `getCodemiePath('copilot-analytics.json')`
  - `type CopilotAnalyticsRecordState = { kind: 'ok'; value: CopilotAnalyticsRecord } | { kind: 'corrupt' }`
  - `async function readCopilotAnalyticsPreferences(connectorId: string): Promise<CopilotAnalyticsRecordState>`
  - `async function updateCopilotAnalyticsPreferences(connectorId: string, mutate: (current: CopilotAnalyticsRecord) => CopilotAnalyticsRecord | Promise<CopilotAnalyticsRecord>): Promise<CopilotAnalyticsRecord>`
  - `async function isCopilotAnalyticsProjectExcluded(cwd: string | undefined, excludedProjects: string[]): Promise<boolean>`

File shape on disk: `{ version: 1, connectors: Record<connectorId, CopilotAnalyticsRecord> }` — same keying as `copilot-connectors.json`, but a wholly separate file/module.

- [ ] **Step 1: Write the failing tests**

```ts
// absent file -> default record for any connectorId
it('returns the default record when the file is absent', async () => {
  expect(await readCopilotAnalyticsPreferences('copilot-cli-otlp')).toEqual({
    kind: 'ok',
    value: { enabled: true, excludedProjects: [] },
  });
});

// per-connector isolation: writing copilot-cli-otlp must not affect copilot-chat-otlp's record
it('update for one connector leaves the other connector at its default', async () => {
  await updateCopilotAnalyticsPreferences('copilot-cli-otlp', (c) => ({ ...c, enabled: false }));
  expect(await readCopilotAnalyticsPreferences('copilot-chat-otlp')).toEqual({
    kind: 'ok',
    value: { enabled: true, excludedProjects: [] },
  });
});

// merge-write preserves sibling connector's record (mirrors writeCopilotConnectorScope)
it('updating one connector preserves the other connectors already-written record', async () => {
  await updateCopilotAnalyticsPreferences('copilot-cli-otlp', (c) => ({ ...c, excludedProjects: ['/work/a'] }));
  await updateCopilotAnalyticsPreferences('copilot-chat-otlp', (c) => ({ ...c, enabled: false }));
  expect(await readCopilotAnalyticsPreferences('copilot-cli-otlp')).toMatchObject({
    kind: 'ok',
    value: { excludedProjects: ['/work/a'] },
  });
});

// corrupt JSON / wrong shape -> 'corrupt', never throws
it.each([
  'not json',
  JSON.stringify({ version: 1, connectors: 'not-an-object' }),
  JSON.stringify({ version: 1, connectors: { 'copilot-cli-otlp': { enabled: 'yes' } } }),
  JSON.stringify({ version: 1, connectors: { 'copilot-cli-otlp': { enabled: true, excludedProjects: [1] } } }),
])('treats malformed content as corrupt: %s', async (raw) => {
  await writeFile(getCopilotAnalyticsPreferencesPath(), raw, 'utf-8');
  expect(await readCopilotAnalyticsPreferences('copilot-cli-otlp')).toEqual({ kind: 'corrupt' });
});

// corrupt file refuses to be overwritten by update; bytes unchanged
it('update throws ConfigurationError and leaves a corrupt file untouched', async () => {
  const path = getCopilotAnalyticsPreferencesPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{not json', 'utf-8');
  const before = await readFile(path, 'utf-8');
  await expect(updateCopilotAnalyticsPreferences('copilot-cli-otlp', (c) => c)).rejects.toThrow(ConfigurationError);
  expect(await readFile(path, 'utf-8')).toBe(before);
});

// no leftover temp file after a successful write
it('leaves no .tmp file after a successful update', async () => {
  await updateCopilotAnalyticsPreferences('copilot-cli-otlp', (c) => ({ ...c, enabled: false }));
  const dir = dirname(getCopilotAnalyticsPreferencesPath());
  expect((await readdir(dir)).some((f) => f.endsWith('.tmp'))).toBe(false);
});

// isCopilotAnalyticsProjectExcluded: nested subdir, trailing slash, sibling-prefix false, undefined cwd
it('excludes a nested subdirectory of an excluded parent', async () => {
  expect(await isCopilotAnalyticsProjectExcluded('/work/a/nested', ['/work/a'])).toBe(true);
});
it('does not exclude a sibling that merely shares a path prefix', async () => {
  expect(await isCopilotAnalyticsProjectExcluded('/work/ab', ['/work/a'])).toBe(false);
});
it('normalizes a trailing slash on the excluded entry', async () => {
  expect(await isCopilotAnalyticsProjectExcluded('/work/a', ['/work/a/'])).toBe(true);
});
it('returns false for an undefined cwd', async () => {
  expect(await isCopilotAnalyticsProjectExcluded(undefined, ['/work/a'])).toBe(false);
});
```

Use the same temp-dir `getCodemiePath` mock pattern as `claude-code-otlp.preferences.test.ts` (`vi.mock('@/utils/paths.js', ...)` redirecting into an `mkdtemp`'d dir, `rm` in `afterEach`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/agents/core/__tests__/copilot-analytics-preferences.test.ts`
Expected: FAIL with "readCopilotAnalyticsPreferences is not a function" (module does not exist yet).

- [ ] **Step 3: Implement `src/agents/core/copilot-analytics-preferences.ts`**

Copy the exact structure of `claude-code-otlp.preferences.ts` (validation, `readFile`/ENOENT/empty-file/JSON.parse/shape-check, atomic `updateClaudeAnalyticsPreferences`-equivalent write) and `copilot-connector-scope.ts`'s keyed-file merge-on-write (`file.connectors = { ...existing, [connectorId]: next }`, refuse corrupt existing file in the writer too, matching `writeCopilotConnectorScope`'s `ConfigurationError` on an unreadable/corrupt file). `isCopilotAnalyticsProjectExcluded` is a direct copy of `claude-code-otlp.preferences.ts`'s `isProjectExcluded` body (uses `canonicalizePath`/`isPathInside` from `@/agents/core/project-allowlist.js`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/agents/core/__tests__/copilot-analytics-preferences.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/copilot-analytics-preferences.ts src/agents/core/__tests__/copilot-analytics-preferences.test.ts
git commit -m "feat(analytics): add copilot-analytics preferences store (EPMCDME-16396)"
```

---

### Task 2: Copilot analytics gate

**Files:**
- Create: `src/agents/core/copilot-analytics-gate.ts`
- Test: `src/agents/core/__tests__/copilot-analytics-gate.test.ts`

**Interfaces:**
- Consumes: `readCopilotAnalyticsPreferences`, `isCopilotAnalyticsProjectExcluded` (Task 1); `readCopilotConnectorScope`, `isCopilotProjectTracked` (existing, `@/agents/core/copilot-connector-scope.js`).
- Produces:
  - `type CopilotAnalyticsGateReason = 'preferences-corrupt' | 'analytics-disabled' | 'project-excluded' | 'scope-corrupt' | 'scope-disabled' | 'scope-untracked'`
  - `type CopilotAnalyticsGateDecision = { tracked: true } | { tracked: false; reason: CopilotAnalyticsGateReason }`
  - `async function evaluateCopilotAnalyticsGate(connectorId: string, cwd: string | undefined): Promise<CopilotAnalyticsGateDecision>`

Precedence, in order (first match wins): `preferences-corrupt` → `analytics-disabled` → `project-excluded` → `scope-corrupt` → `scope-disabled` → `scope-untracked` → `{tracked: true}`. The last three reasons exist so `isTracked()` call sites can delegate fully to this one function while `onUntrackedHook()` call sites can still build the exact same block messages the existing scope-based code already builds — the gate re-derives them from `readCopilotConnectorScope`/`isCopilotProjectTracked` rather than changing those functions.

- [ ] **Step 1: Write the failing tests**

```ts
// mock '@/agents/core/copilot-analytics-preferences.js' and '@/agents/core/copilot-connector-scope.js' with vi.fn() doubles, like claude-code-otlp.gate.test.ts mocks its two dependencies.

it('returns preferences-corrupt when preferences are corrupt, before checking scope', async () => {
  mockReadPrefs.mockResolvedValue({ kind: 'corrupt' });
  const decision = await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a');
  expect(decision).toEqual({ tracked: false, reason: 'preferences-corrupt' });
  expect(mockReadScope).not.toHaveBeenCalled();
});

it('returns analytics-disabled when preferences.enabled is false', async () => {
  mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: false, excludedProjects: [] } });
  expect(await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a')).toEqual({
    tracked: false,
    reason: 'analytics-disabled',
  });
});

it('returns project-excluded when cwd is under an excluded project, even with scope fully open', async () => {
  mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: ['/work/a'] } });
  mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'user' } });
  expect(await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a')).toEqual({
    tracked: false,
    reason: 'project-excluded',
  });
});

it('returns scope-corrupt when preferences are fine but connector scope is corrupt', async () => {
  mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
  mockReadScope.mockResolvedValue({ kind: 'corrupt' });
  expect(await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a')).toEqual({
    tracked: false,
    reason: 'scope-corrupt',
  });
});

it('returns scope-disabled when preferences are fine but the connector scope itself is disabled', async () => {
  mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
  mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: false } });
  expect(await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a')).toEqual({
    tracked: false,
    reason: 'scope-disabled',
  });
});

it('returns scope-untracked when scope is enabled/project but cwd is outside its paths', async () => {
  mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
  mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'project', paths: ['/work/b'] } });
  expect(await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a')).toEqual({
    tracked: false,
    reason: 'scope-untracked',
  });
});

it('returns tracked:true when preferences allow it and scope tracks the project', async () => {
  mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
  mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'user' } });
  expect(await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a')).toEqual({ tracked: true });
});

it('falls through to scope-untracked (not a throw) when cwd is undefined and scope is project-scoped', async () => {
  mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
  mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'project', paths: ['/work/a'] } });
  expect(await evaluateCopilotAnalyticsGate('copilot-cli-otlp', undefined)).toEqual({
    tracked: false,
    reason: 'scope-untracked',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/agents/core/__tests__/copilot-analytics-gate.test.ts`
Expected: FAIL with "evaluateCopilotAnalyticsGate is not a function"

- [ ] **Step 3: Implement `src/agents/core/copilot-analytics-gate.ts`**

```ts
export async function evaluateCopilotAnalyticsGate(
  connectorId: string,
  cwd: string | undefined
): Promise<CopilotAnalyticsGateDecision> {
  const prefs = await readCopilotAnalyticsPreferences(connectorId);
  if (prefs.kind === 'corrupt') return { tracked: false, reason: 'preferences-corrupt' };
  if (!prefs.value.enabled) return { tracked: false, reason: 'analytics-disabled' };
  if (await isCopilotAnalyticsProjectExcluded(cwd, prefs.value.excludedProjects)) {
    return { tracked: false, reason: 'project-excluded' };
  }
  const scope = await readCopilotConnectorScope(connectorId);
  if (scope.kind === 'corrupt') return { tracked: false, reason: 'scope-corrupt' };
  if (!scope.value.enabled) return { tracked: false, reason: 'scope-disabled' };
  if (!(await isCopilotProjectTracked(cwd, scope))) return { tracked: false, reason: 'scope-untracked' };
  return { tracked: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/agents/core/__tests__/copilot-analytics-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/copilot-analytics-gate.ts src/agents/core/__tests__/copilot-analytics-gate.test.ts
git commit -m "feat(analytics): add evaluateCopilotAnalyticsGate (EPMCDME-16396)"
```

---

### Task 3: Wire the gate into `copilot-cli-otlp.plugin.ts`

**Files:**
- Modify: `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts` (`isTracked()`, currently lines ~50-58)
- Modify: `src/agents/plugins/copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts`

**Interfaces:**
- Consumes: `evaluateCopilotAnalyticsGate` (Task 2), existing `COPILOT_CLI_OTLP_AGENT_NAME` (already imported as `this.name`).

- [ ] **Step 1: Write the failing tests**

```ts
it('isTracked delegates to evaluateCopilotAnalyticsGate for the default (no env var) case', async () => {
  vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: false, reason: 'analytics-disabled' });
  expect(await plugin['isTracked']({ cwd: '/work/a', ... } as CopilotCliHookInput)).toBe(false);
  expect(evaluateCopilotAnalyticsGate).toHaveBeenCalledWith(COPILOT_CLI_OTLP_AGENT_NAME, '/work/a');
});

it('CODEMIE_SESSION_ID still short-circuits before the gate is ever consulted', async () => {
  vi.stubEnv('CODEMIE_SESSION_ID', 'managed-session-1');
  vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: true });
  expect(await plugin['isTracked']({ cwd: '/work/a', ... } as CopilotCliHookInput)).toBe(false);
  expect(evaluateCopilotAnalyticsGate).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

it('isTracked returns true when the gate tracks the project (no env var set)', async () => {
  vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: true });
  expect(await plugin['isTracked']({ cwd: '/work/a', ... } as CopilotCliHookInput)).toBe(true);
});
```

Mock `@/agents/core/copilot-analytics-gate.js` with a `vi.fn()` for `evaluateCopilotAnalyticsGate`; keep the existing `isCopilotProjectTracked`/`readCopilotConnectorScope` mocks only if other tests in this file still exercise them directly (they should not need to any more for `isTracked`, since the gate now owns that call internally — do not delete tests that cover other methods of this plugin).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/agents/plugins/copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts`
Expected: FAIL (new tests expect `evaluateCopilotAnalyticsGate` to be called; current code never imports it)

- [ ] **Step 3: Implement**

Replace the `isTracked()` body's final line:

```ts
protected async isTracked(input: CopilotCliHookInput): Promise<boolean> {
  if (process.env.CODEMIE_SESSION_ID) {
    return false;
  }
  return (await evaluateCopilotAnalyticsGate(this.name, input.cwd)).tracked;
}
```

Replace the `isCopilotProjectTracked, readCopilotConnectorScope` import from `@/agents/core/copilot-connector-scope.js` with `evaluateCopilotAnalyticsGate` from `@/agents/core/copilot-analytics-gate.js` (drop the now-unused scope import from this file only if nothing else in it still uses `isCopilotProjectTracked`/`readCopilotConnectorScope` directly — check the rest of the file first).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/agents/plugins/copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts src/agents/plugins/copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts
git commit -m "feat(analytics): wire copilot-analytics gate into copilot-cli-otlp isTracked (EPMCDME-16396)"
```

---

### Task 4: Wire the gate + extend `onUntrackedHook()` in `copilot-chat-otlp.plugin.ts`

**Files:**
- Modify: `src/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.plugin.ts` (`isTracked()` and `onUntrackedHook()`, currently lines ~40-76)
- Modify: `src/agents/plugins/copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts`

**Interfaces:**
- Consumes: `evaluateCopilotAnalyticsGate` (Task 2), existing `readCopilotConnectorScope` (kept, still used directly by `onUntrackedHook()`'s existing scope-branch code, unchanged), existing `hasRequiredIdentity`/`emitBlock`/`buildBlock` (unchanged).

- [ ] **Step 1: Write the failing tests**

```ts
describe('isTracked via the new analytics gate', () => {
  it('returns false when the gate blocks, without checking hasRequiredIdentity', async () => {
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: false, reason: 'analytics-disabled' });
    expect(await plugin['isTracked']({ ... } as CopilotChatHookInput)).toBe(false);
  });

  it('returns true only when the gate tracks AND hasRequiredIdentity is satisfied', async () => {
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: true });
    // existing hookInput fixture already satisfies hasRequiredIdentity in this suite
    expect(await plugin['isTracked'](validHookInput)).toBe(true);
  });

  it('returns false when the gate tracks but hasRequiredIdentity is not satisfied (existing behavior preserved)', async () => {
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: true });
    expect(await plugin['isTracked'](hookInputMissingIdentity)).toBe(false);
  });
});

describe('onUntrackedHook: new analytics-gate messages', () => {
  it('emits a corrupt-preferences block message on an enforced event', async () => {
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: false, reason: 'preferences-corrupt' });
    await plugin['onUntrackedHook']({ hook_event_name: 'SessionStart', ... } as CopilotChatHookInput);
    expect(emitBlockSpy).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining('analytics preferences'),
    }));
  });

  it('emits an analytics-disabled block message naming the enable command', async () => {
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: false, reason: 'analytics-disabled' });
    await plugin['onUntrackedHook']({ hook_event_name: 'UserPromptSubmit', ... } as CopilotChatHookInput);
    expect(emitBlockSpy).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining('disabled'),
    }));
  });

  it('emits a project-excluded block message', async () => {
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: false, reason: 'project-excluded' });
    await plugin['onUntrackedHook']({ hook_event_name: 'PreToolUse', ... } as CopilotChatHookInput);
    expect(emitBlockSpy).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining('excluded'),
    }));
  });

  it('falls through to the existing scope-corrupt message unchanged when the gate reason is scope-corrupt', async () => {
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: false, reason: 'scope-corrupt' });
    mockReadScope.mockResolvedValue({ kind: 'corrupt' });
    await plugin['onUntrackedHook']({ hook_event_name: 'SessionStart', ... } as CopilotChatHookInput);
    expect(emitBlockSpy).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining('connector scope configuration is corrupt'),
    }));
  });

  it('still silently no-ops when scope.enabled is false (existing behavior preserved exactly)', async () => {
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: false, reason: 'scope-disabled' });
    mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: false } });
    await plugin['onUntrackedHook']({ hook_event_name: 'SessionStart', ... } as CopilotChatHookInput);
    expect(emitBlockSpy).not.toHaveBeenCalled();
  });

  it('still emits the existing identity-missing message when the gate reason is scope-untracked and identity is missing (existing behavior preserved exactly)', async () => {
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: false, reason: 'scope-untracked' });
    mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'user' } });
    await plugin['onUntrackedHook']({ hook_event_name: 'SessionStart', ... } as hookInputMissingIdentity);
    expect(emitBlockSpy).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining('required session identity'),
    }));
  });

  it('non-enforced events still return without calling the gate at all (existing behavior preserved)', async () => {
    await plugin['onUntrackedHook']({ hook_event_name: 'PostToolUse', ... } as CopilotChatHookInput);
    expect(evaluateCopilotAnalyticsGate).not.toHaveBeenCalled();
  });
});
```

All existing tests in this file for the pre-existing scope-corrupt/`!scope.value.enabled`/identity-missing branches must be re-run and pass unmodified — they are the regression guard for the "unchanged existing code path" claim below.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/agents/plugins/copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts`
Expected: FAIL (new tests reference `evaluateCopilotAnalyticsGate`, not yet imported/used)

- [ ] **Step 3: Implement**

```ts
protected async isTracked(hookInput: CopilotChatHookInput): Promise<boolean> {
  const analytics = await evaluateCopilotAnalyticsGate(this.name, hookInput.cwd);
  return analytics.tracked && this.hasRequiredIdentity(hookInput);
}

protected async onUntrackedHook(hookInput: CopilotChatHookInput): Promise<void> {
  if (!ENFORCED_EVENTS.has(hookInput.hook_event_name)) {
    return;
  }

  const analytics = await evaluateCopilotAnalyticsGate(this.name, hookInput.cwd);
  if (!analytics.tracked && analytics.reason === 'preferences-corrupt') {
    this.emitBlock(this.buildBlock(hookInput.hook_event_name, 'analytics preferences configuration is corrupt; repair it and reconnect', false));
    return;
  }
  if (!analytics.tracked && analytics.reason === 'analytics-disabled') {
    this.emitBlock(this.buildBlock(hookInput.hook_event_name, `analytics collection is disabled for ${this.name} (run \`codemie proxy analytics enable --${this.name}\`)`, false));
    return;
  }
  if (!analytics.tracked && analytics.reason === 'project-excluded') {
    this.emitBlock(this.buildBlock(hookInput.hook_event_name, `this project is excluded from analytics collection (run \`codemie proxy analytics include --${this.name}\`)`, false));
    return;
  }

  // --- existing logic below, UNCHANGED ---
  const scope = await readCopilotConnectorScope(this.name);
  if (scope.kind === 'corrupt') {
    this.emitBlock(this.buildBlock(hookInput.hook_event_name, 'connector scope configuration is corrupt; repair it and reconnect', false));
    return;
  }
  if (!scope.value.enabled) {
    return;
  }
  if (!this.hasRequiredIdentity(hookInput)) {
    this.emitBlock(this.buildBlock(hookInput.hook_event_name, 'required session identity or working directory is missing', false));
  }
}
```

Add the `evaluateCopilotAnalyticsGate` import from `@/agents/core/copilot-analytics-gate.js`. Do not touch the `readCopilotConnectorScope`/`isCopilotProjectTracked` imports — both are still used (the gate uses them internally; `onUntrackedHook`'s unchanged tail still calls `readCopilotConnectorScope` directly, exactly as today).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/agents/plugins/copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.plugin.ts src/agents/plugins/copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts
git commit -m "feat(analytics): wire copilot-analytics gate into copilot-chat-otlp, extend onUntrackedHook messages (EPMCDME-16396)"
```

---

### Task 5: Multi-connector `codemie proxy analytics` CLI

**Files:**
- Modify: `src/cli/commands/proxy/analytics-command.ts`
- Modify: `src/cli/commands/proxy/analytics-status.ts`
- Modify: `src/cli/commands/proxy/__tests__/analytics-command.test.ts`

**Interfaces:**
- Consumes: `CLAUDE_CODE_OTLP_AGENT_NAME`, `COPILOT_CLI_OTLP_AGENT_NAME`, `COPILOT_CHAT_OTLP_AGENT_NAME`; `readCopilotAnalyticsPreferences`/`updateCopilotAnalyticsPreferences`/`getCopilotAnalyticsPreferencesPath` (Task 1); existing `readClaudeAnalyticsPreferences`/`updateClaudeAnalyticsPreferences`/`getClaudeAnalyticsPreferencesPath` (unchanged).
- Produces:
  - `type AnalyticsConnectorId = typeof CLAUDE_CODE_OTLP_AGENT_NAME | typeof COPILOT_CLI_OTLP_AGENT_NAME | typeof COPILOT_CHAT_OTLP_AGENT_NAME`
  - `interface AnalyticsStore { configPath(): string; read(): Promise<{kind:'ok', value:{enabled:boolean, excludedProjects:string[]}} | {kind:'corrupt'}>; update(mutate: (c: {enabled:boolean, excludedProjects:string[]}) => {enabled:boolean, excludedProjects:string[]} | Promise<{enabled:boolean, excludedProjects:string[]}>): Promise<void> }`
  - `function resolveAnalyticsConnector(opts: { claudeCodeOtlp?: boolean; copilotCliOtlp?: boolean; copilotChatOtlp?: boolean }): AnalyticsConnectorId` — throws `ConfigurationError` if more than one flag is `true`; defaults to `CLAUDE_CODE_OTLP_AGENT_NAME` if none are set.
  - `function storeForConnector(connectorId: AnalyticsConnectorId): AnalyticsStore`

- [ ] **Step 1: Write the failing tests**

```ts
// connector selection
it('defaults to claude-code-otlp when no connector flag is given (backward compatibility)', async () => {
  await runCommand(['disable']);
  expect(await readClaudePreferences()).toMatchObject({ enabled: false });
});

it('disable --copilot-cli-otlp writes to the copilot-analytics store under that connector id, not claude-analytics.json', async () => {
  await runCommand(['disable', '--copilot-cli-otlp']);
  expect(await readCopilotAnalyticsPrefs('copilot-cli-otlp')).toMatchObject({ enabled: false });
  expect(await readClaudePreferences()).toMatchObject({ enabled: true }); // untouched
});

it('disable --copilot-chat-otlp and --copilot-cli-otlp together is rejected', async () => {
  process.exitCode = undefined;
  await runCommand(['disable', '--copilot-cli-otlp', '--copilot-chat-otlp']);
  expect(process.exitCode).toBe(1);
  process.exitCode = undefined;
});

it('exclude/include for copilot-cli-otlp reuse the exact CR-003/0309ed65 covering-parent logic', async () => {
  await runCommand(['exclude', '/work/a', '--copilot-cli-otlp']);
  await runCommand(['exclude', '/work/a/nested', '--copilot-cli-otlp']);
  const prefs = await readCopilotAnalyticsPrefs('copilot-cli-otlp');
  expect(prefs.excludedProjects).toHaveLength(1); // parent absorbs child, no redundant entry

  logSpy.mockClear();
  await runCommand(['include', '/work/a/nested', '--copilot-cli-otlp']);
  expect(logSpy.mock.calls.flat().join(' ')).toContain('still excluded via');
});

it('status --copilot-chat-otlp --json reports that connector only', async () => {
  await runCommand(['exclude', '/work/a', '--copilot-chat-otlp']);
  logSpy.mockClear();
  await runCommand(['status', '--copilot-chat-otlp', '--json']);
  const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
  expect(parsed).toMatchObject({ excludedProjects: [expect.any(String)] });
});
```

Every existing test in this file (no-flag disable/enable/exclude/include/status, CR-003 case-insensitive, CR-004 registration/status/json, corrupt-file-on-disable) must be re-run and pass unmodified.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/cli/commands/proxy/__tests__/analytics-command.test.ts`
Expected: FAIL (no `--copilot-cli-otlp`/`--copilot-chat-otlp` options registered yet)

- [ ] **Step 3: Implement**

Add `resolveAnalyticsConnector`/`AnalyticsStore`/`storeForConnector` to `analytics-command.ts`. `storeForConnector('claude-code-otlp')` wraps the existing `readClaudeAnalyticsPreferences`/`updateClaudeAnalyticsPreferences`/`getClaudeAnalyticsPreferencesPath` (adapting the `version` field away on read, back in on write — behavior identical to today). `storeForConnector('copilot-cli-otlp' | 'copilot-chat-otlp')` wraps `readCopilotAnalyticsPreferences(connectorId)`/`updateCopilotAnalyticsPreferences(connectorId, ...)`/`getCopilotAnalyticsPreferencesPath()`. Rewrite `setEnabled`, `excludeProject`, `includeProject` to take a `store: AnalyticsStore` parameter and operate purely through it — keep every line of the existing covering-parent/redundant-entry logic (the `0309ed65`/CR-003 fix) exactly as written, just reading from `store` instead of calling the Claude-specific functions directly. Register `.option('--claude-code-otlp')`/`.option('--copilot-cli-otlp')`/`.option('--copilot-chat-otlp')` on all five subcommands; each `.action()` calls `resolveAnalyticsConnector(opts)` then `storeForConnector(...)`. Extend `analytics-status.ts`'s `collectClaudeAnalyticsStatus`/`formatClaudeAnalyticsStatus` to accept the same `AnalyticsStore` + a connector label, or add a thin parallel `collectCopilotAnalyticsStatus` that reuses the same formatting function parametrized by store — whichever keeps `formatClaudeAnalyticsStatus`'s existing output byte-identical for the no-flag case.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/cli/commands/proxy/__tests__/analytics-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/analytics-command.ts src/cli/commands/proxy/analytics-status.ts src/cli/commands/proxy/__tests__/analytics-command.test.ts
git commit -m "feat(analytics): add --copilot-cli-otlp/--copilot-chat-otlp connector flags to proxy analytics (EPMCDME-16396)"
```

---

### Task 6: Full regression verification

**Files:** none changed — verification only.

- [ ] **Step 1: Run the full existing Copilot and Claude analytics-related suites**

Run: `npm run test:unit -- src/agents/core/__tests__/copilot-connector-scope.test.ts src/agents/plugins/copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts src/agents/plugins/copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.preferences.test.ts src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.gate.test.ts src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.disable-matrix.test.ts src/cli/commands/proxy/__tests__/analytics-command.test.ts`
Expected: PASS — every test, including every pre-existing one, with zero modifications beyond what Tasks 1-5 already made.

- [ ] **Step 2: Run the full unit + cli test projects and lint/typecheck**

Run: `npm run lint && npm run typecheck && npm run test:unit && npm run test:cli`
Expected: PASS, zero lint warnings (zero-warning policy), zero type errors.

- [ ] **Step 3: Confirm no changes were made to the explicitly out-of-scope files**

Run: `git diff --name-only <merge-base>...HEAD -- src/agents/core/copilot-connector-scope.ts src/cli/commands/proxy/connectors/`
Expected: empty output.

No commit for this task — it is a verification gate, not a code change.

---

## Self-Review

1. **Spec coverage**: Requirement 1 (preferences store) → Task 1. Requirement 2 (gate) → Task 2. Requirement 3 (wiring, preserving existing guards) → Tasks 3-4. Requirement 4 (`onUntrackedHook` extension) → Task 4. Requirement 5 (document, don't fix, the `copilot-cli-otlp` gap) → "Known Gaps" section, Task 3 explicitly does not touch `onUntrackedHook`. Requirement 6 (CLI flags) → Task 5. Requirement 7 (full lesson-learned test matrix + regression) → spread across Tasks 1/2/5 test lists plus Task 6. Requirement 8 (`Test-first: yes` per task) → every task above opens with a failing-test step.
2. **Step scan**: each step names an exact file, exact signature, or exact command; no "handle edge cases"/TBD lines remain.
3. **Type consistency**: `CopilotAnalyticsRecord` (Task 1) is the exact shape `evaluateCopilotAnalyticsGate` (Task 2) and `AnalyticsStore` (Task 5) consume — checked across all three tasks' Interfaces blocks.
4. **Review Focus**: all five lines above are each pinned to an explicit test in Task 1 (undefined cwd, sibling-prefix), Task 1 (trailing slash is also here), Task 1/5 (covering-parent dup-entry reuse), Task 1 (corrupt fail-closed), Task 5/6 (no-flag Claude regression).
5. **Proportion**: six tasks, each with a handful of named tests and a short implementation sketch — the plan is grounded in two already-existing, already-reviewed templates (`claude-code-otlp.*.ts`, `copilot-connector-scope.ts`), so code shown is signatures and assertions, not full bodies, except where an exact algorithm (the gate's precedence chain) is the thing being specified.

---

**Lifecycle note:** `artifact_published` intent is emitted for this plan per `sdlc-light` Stage 3 step 5, reading `.ai-run/guides/project.md`'s Ticket Adapter configuration.

---

## Amendments after code review (code-review.final, 2026-10-29)

- **Task 4 (superseded behavior):** the plan's `onUntrackedHook` block messages for `analytics-disabled` / `project-excluded` / `preferences-corrupt` were wrong. In Copilot Chat a block is `continue:false` / `permissionDecision:deny`, which stops the user's session, prompts and tools, so opting out of analytics would disable Copilot Chat. Shipped behavior (CR-002): those three reasons return silently before the unchanged scope/identity tail; `codemie proxy analytics status` is the explanation channel.
- **Task 1 (tightened):** `updateCopilotAnalyticsPreferences` and `readCopilotAnalyticsPreferences` share one file-shape validator (numeric `version`, non-array object `connectors`) so the writer never accepts what the reader fails closed on (CR-001).
- **Deferred, shared with the Claude/connector-scope stores (not introduced here):** lost update on concurrent CLI writes, transient EBUSY/EPERM read classed as corrupt, Windows rename over an open file, shared mutable default record, no schema-version upgrade handling.
