# User-friendly agent version handling — Implementation Plan

> **For agentic workers:** This plan will be executed **inline** in the current sdlc-standard conversation via `superpowers:test-driven-development`. Do NOT dispatch subagents. Steps use `- [ ]` checkboxes for tracking.

**Goal:** Replace blocking per-agent version checks with a one-time non-blocking "untested version" warning per `(agent, agent-version, codemie-version)` tuple.

**Architecture:** New `VersionWarningStore` (Utils layer) records acknowledged tuples in `~/.codemie/version-warnings.json` (MigrationTracker pattern). New `BaseAgentAdapter.warnOnceIfUntested()` (Core layer) consults the store, emits `chalk.yellow` on interactive TTY / `logger.warn` on non-interactive, then records the marker. `AgentsCheck` (CLI/Doctor layer) reads the store to render Acknowledged / Untested / Not installed. Pinned per-agent constants disappear entirely from the Plugin layer.

**Tech Stack:** TypeScript, ES modules, Vitest, chalk, inquirer (removed from version-check paths).

## Global Constraints

- Repo layers (mandatory): `CLI → Registry → Plugin → Core → Utils`. Version-check logic lives in `Core` (`BaseAgentAdapter`), not in CLI commands.
- All state files live under `~/.codemie/` via `getCodemiePath()` from `src/utils/paths.ts`. `CODEMIE_HOME` env var overrides the home directory (used by `setupTestIsolation()`).
- No `console.log` for debug output; use `logger.debug/info/warn`. `console.log(chalk...)` is allowed only for interactive UI banners; must be guarded by `!metadata.silentMode && isInteractive()`.
- No `inquirer.prompt` in version-check paths. No `process.exit()` in version-check paths. No `throw` for version mismatches.
- All imports use `.js` extension; use `@/` alias where the repo already does; no `require()` / `__dirname`.
- Vitest patterns per `.ai-run/guides/testing/testing-patterns.md`: `vi.hoisted()` for factory refs used inside `vi.mock`, dynamic `await import(...)` after mocks, `beforeEach(() => vi.clearAllMocks())`.
- `setupTestIsolation()` from `tests/helpers/test-isolation.ts` sets `CODEMIE_HOME` to a temp dir — use it in any test that reads or writes `version-warnings.json`.
- Commit messages: Conventional Commits — `<type>(<scope>): <subject>`. Allowed scopes include `agents`, `cli`, `utils`, `tests`. Subject ≤ 100 chars.
- Ordering rule: intermediate commits MUST pass `npm run typecheck` and `npm run lint`. Tasks are ordered so that no intermediate state has a dangling import or missing type.

---

## File Structure

| Change | Path | Responsibility |
|---|---|---|
| Create | `src/utils/version-warnings.ts` | `VersionWarningStore` — read/write/clear `~/.codemie/version-warnings.json` |
| Create | `src/utils/__tests__/version-warnings.test.ts` | Unit tests for the store |
| Create | `src/utils/tty.ts` | `isInteractive()` helper |
| Create | `src/utils/__tests__/tty.test.ts` | Unit tests for `isInteractive()` |
| Modify | `src/agents/core/BaseAgentAdapter.ts` | Add `getVersionInfo()` + `warnOnceIfUntested()`; rewire `run()`; drop old `checkVersionCompatibility()` |
| Modify | `src/agents/core/__tests__/BaseAgentAdapter.test.ts` | Characterisation + regression tests for the new helper and `run()` behavior |
| Modify | `src/agents/core/types.ts` | Remove `supportedVersion` / `minimumSupportedVersion` from `AgentMetadata`; delete `VersionCompatibilityResult`; declare `AgentVersionInfo` |
| Modify | `src/agents/plugins/claude/claude.plugin.ts` | Remove `CLAUDE_SUPPORTED_VERSION`, `CLAUDE_MINIMUM_SUPPORTED_VERSION`, and the two metadata fields |
| Modify | `src/agents/plugins/codex/codex.plugin.ts` | Same removal for codex |
| Modify | `src/agents/plugins/gemini/gemini.plugin.ts` | Same removal for gemini |
| Modify | `src/agents/plugins/kimi/kimi.plugin.ts` | Same removal for kimi |
| Modify | `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts` | Rewrite: assert `warnOnceIfUntested()` contract instead of the old constant |
| Modify | `src/cli/commands/install.ts` | Route `--supported` and `'supported'` default to `'latest'`; drop `compat.supportedVersion` from user-facing strings |
| Modify | `src/cli/commands/update.ts` | Use `getVersionInfo()`; drop `checkVersionCompatibility()` references |
| Modify | `src/cli/commands/setup.ts` | Replace the Claude version-check chalk block with a `warnOnceIfUntested()` call |
| Modify | `src/cli/commands/doctor/index.ts` | Add `--reset-version-warnings` flag |
| Modify | `src/cli/commands/doctor/checks/AgentsCheck.ts` | Look up markers, render Acknowledged / Untested / Not installed |
| Modify | `tests/setup/agent-build-setup.ts` | Remove `CLAUDE_SUPPORTED_VERSION` import; install claude `--latest` (or skip if any version present) |

---

## Task 1 — Characterisation tests for BaseAgentAdapter.run() version-check branches

Test-first: yes — three failing tests capturing today's `run()` behavior for `isBelowMinimum`, `isNewer`, and `hasUpdate` before we change anything.

**Rationale:** `BaseAgentAdapter.run()` version-check branches have zero unit coverage today. Without pinning current behavior we cannot detect regressions when we rewrite the block in Task 5.

**Files:**
- Modify: `src/agents/core/__tests__/BaseAgentAdapter.test.ts` — add a new `describe('run() version-check (pre-refactor characterisation)', ...)` block.

**Interfaces produced:** none (tests only).

- [ ] **Step 1: Write the failing tests**

Add to `src/agents/core/__tests__/BaseAgentAdapter.test.ts`:

```typescript
describe('run() version-check (pre-refactor characterisation)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isBelowMinimum + silentMode currently throws', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    class TestAdapter extends BaseAgentAdapter {}
    const meta = {
      name: 'test', displayName: 'Test', cliCommand: 'test',
      supportedVersion: '2.0.0', minimumSupportedVersion: '1.5.0',
      silentMode: true,
    } as any;
    const adapter = new TestAdapter(meta);
    vi.spyOn(adapter as any, 'checkVersionCompatibility').mockResolvedValue({
      compatible: false, installedVersion: '1.0.0', supportedVersion: '2.0.0',
      isNewer: false, hasUpdate: false, isBelowMinimum: true,
      minimumSupportedVersion: '1.5.0',
    });
    await expect(adapter.run([], undefined, { dryRun: true })).rejects.toThrow(
      /below the minimum supported version/,
    );
  });

  it('isNewer + non-silent + non-interactive returns without prompting', async () => {
    // Assert: no inquirer.prompt call, run() completes when interactive checks disabled.
    // Note: this test EXISTS to lock behavior we will replace. It will be re-written
    // in Task 5 to assert the new one-time-warning behavior.
    process.env.CODEMIE_NO_PROMPTS = '1';
    // ... setup adapter with isNewer result, spy inquirer, assert prompt NOT called
    delete process.env.CODEMIE_NO_PROMPTS;
  });

  it('hasUpdate + compatible + non-silent shows blue info banner', async () => {
    // Assert: console.log called with a string matching chalk("new supported version") pattern
    // Also destined for rewrite in Task 5.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail or need clarification**

Run: `npx vitest run src/agents/core/__tests__/BaseAgentAdapter.test.ts -t "pre-refactor characterisation"`
Expected: some tests fail because `inquirer.prompt` isn't stubbed and would hang, OR pass because the code path exits before prompting. Iterate on the tests until each asserts a definite pre-refactor invariant.

- [ ] **Step 3: Stabilize the tests**

Mock `inquirer.prompt` at the file top:
```typescript
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
```
Adjust assertions until all three tests pass against the CURRENT `run()` implementation (before we change it). These are your safety net.

- [ ] **Step 4: Verify all three tests pass**

Run: `npx vitest run src/agents/core/__tests__/BaseAgentAdapter.test.ts`
Expected: PASS. All prior tests in the file must still pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/__tests__/BaseAgentAdapter.test.ts
git commit -m "test(agents): characterisation tests for BaseAgentAdapter run() version-check branches"
```

**Boundary note:** these tests will be rewritten in Task 5 to assert the new behavior. They exist only to catch accidental regressions between Task 1 and Task 5.

---

## Task 2 — VersionWarningStore utility module

Test-first: yes — write full unit test suite for `VersionWarningStore` before implementing it.

**Files:**
- Create: `src/utils/version-warnings.ts`
- Create: `src/utils/__tests__/version-warnings.test.ts`

**Interfaces produced (used by Tasks 3, 4, 6):**

```typescript
export interface VersionWarningRecord {
  agentName: string;
  agentVersion: string;
  codemieVersion: string;
  warnedAt: string; // ISO 8601
}

export interface VersionWarningHistory {
  version: 1;
  warnings: VersionWarningRecord[];
}

export class VersionWarningStore {
  static async loadHistory(): Promise<VersionWarningHistory>;
  static async hasWarned(
    agentName: string,
    agentVersion: string,
    codemieVersion: string,
  ): Promise<boolean>;
  static async recordWarning(
    agentName: string,
    agentVersion: string,
    codemieVersion: string,
  ): Promise<void>;
  static async clear(): Promise<{ removed: number }>;
}
```

Backing file: `getCodemiePath('version-warnings.json')`. Missing file → empty history. Corrupt JSON → treat as empty history (logger.warn once). `recordWarning` is a no-op if the exact tuple is already recorded. `clear` deletes the file; returns `{ removed: N }` where N is the count in the file before deletion (0 if file missing).

- [ ] **Step 1: Write the failing test suite**

Create `src/utils/__tests__/version-warnings.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestIsolation } from '../../../tests/helpers/test-isolation.js';
import * as fs from 'fs/promises';

describe('VersionWarningStore', () => {
  const isolation = setupTestIsolation('version-warnings');

  beforeEach(async () => { /* isolation is per-describe */ });
  afterEach(async () => { /* nothing */ });

  it('returns empty history when file missing', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    const history = await VersionWarningStore.loadHistory();
    expect(history).toEqual({ version: 1, warnings: [] });
  });

  it('hasWarned returns false on empty history', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    expect(await VersionWarningStore.hasWarned('claude', '2.1.0', '0.11.0')).toBe(false);
  });

  it('records a marker and hasWarned returns true for the exact tuple', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0', '0.11.0');
    expect(await VersionWarningStore.hasWarned('claude', '2.1.0', '0.11.0')).toBe(true);
  });

  it('hasWarned distinguishes tuples (different agent version)', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0', '0.11.0');
    expect(await VersionWarningStore.hasWarned('claude', '2.1.1', '0.11.0')).toBe(false);
  });

  it('hasWarned distinguishes tuples (different codemie version)', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0', '0.11.0');
    expect(await VersionWarningStore.hasWarned('claude', '2.1.0', '0.12.0')).toBe(false);
  });

  it('recordWarning is idempotent for the same tuple', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0', '0.11.0');
    await VersionWarningStore.recordWarning('claude', '2.1.0', '0.11.0');
    const history = await VersionWarningStore.loadHistory();
    expect(history.warnings.length).toBe(1);
  });

  it('clear returns removed count and deletes file', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0', '0.11.0');
    await VersionWarningStore.recordWarning('codex', '0.143.0', '0.11.0');
    const result = await VersionWarningStore.clear();
    expect(result.removed).toBe(2);
    const history = await VersionWarningStore.loadHistory();
    expect(history.warnings).toEqual([]);
  });

  it('clear on missing file returns removed: 0', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    const result = await VersionWarningStore.clear();
    expect(result.removed).toBe(0);
  });

  it('treats corrupt JSON as empty history', async () => {
    const { getCodemiePath } = await import('../paths.js');
    await fs.mkdir((await import('path')).dirname(getCodemiePath('version-warnings.json')), { recursive: true });
    await fs.writeFile(getCodemiePath('version-warnings.json'), '{ not json');
    const { VersionWarningStore } = await import('../version-warnings.js');
    const history = await VersionWarningStore.loadHistory();
    expect(history).toEqual({ version: 1, warnings: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (module missing)**

Run: `npx vitest run src/utils/__tests__/version-warnings.test.ts`
Expected: FAIL — `Cannot find module '../version-warnings.js'`.

- [ ] **Step 3: Implement `src/utils/version-warnings.ts`**

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';

export interface VersionWarningRecord {
  agentName: string;
  agentVersion: string;
  codemieVersion: string;
  warnedAt: string;
}

export interface VersionWarningHistory {
  version: 1;
  warnings: VersionWarningRecord[];
}

const FILE = () => getCodemiePath('version-warnings.json');

export class VersionWarningStore {
  static async loadHistory(): Promise<VersionWarningHistory> {
    try {
      const content = await fs.readFile(FILE(), 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed !== 'object' || !parsed || !Array.isArray(parsed.warnings)) {
        return { version: 1, warnings: [] };
      }
      return { version: 1, warnings: parsed.warnings as VersionWarningRecord[] };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { version: 1, warnings: [] };
      logger.warn('[VersionWarningStore] Corrupt or unreadable file — treating as empty', { file: FILE() });
      return { version: 1, warnings: [] };
    }
  }

  static async saveHistory(history: VersionWarningHistory): Promise<void> {
    await fs.mkdir(path.dirname(FILE()), { recursive: true });
    await fs.writeFile(FILE(), JSON.stringify(history, null, 2), 'utf-8');
  }

  static async hasWarned(
    agentName: string,
    agentVersion: string,
    codemieVersion: string,
  ): Promise<boolean> {
    const history = await this.loadHistory();
    return history.warnings.some(
      w =>
        w.agentName === agentName &&
        w.agentVersion === agentVersion &&
        w.codemieVersion === codemieVersion,
    );
  }

  static async recordWarning(
    agentName: string,
    agentVersion: string,
    codemieVersion: string,
  ): Promise<void> {
    const history = await this.loadHistory();
    const exists = history.warnings.some(
      w =>
        w.agentName === agentName &&
        w.agentVersion === agentVersion &&
        w.codemieVersion === codemieVersion,
    );
    if (exists) return;
    history.warnings.push({ agentName, agentVersion, codemieVersion, warnedAt: new Date().toISOString() });
    await this.saveHistory(history);
  }

  static async clear(): Promise<{ removed: number }> {
    try {
      const history = await this.loadHistory();
      const removed = history.warnings.length;
      await fs.unlink(FILE());
      return { removed };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { removed: 0 };
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/__tests__/version-warnings.test.ts`
Expected: PASS on all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/version-warnings.ts src/utils/__tests__/version-warnings.test.ts
git commit -m "feat(utils): add VersionWarningStore for one-time untested-version markers"
```

---

## Task 3 — `isInteractive()` helper (Utils layer)

Test-first: yes — assert TTY / non-TTY / `CODEMIE_NO_PROMPTS` behavior.

**Files:**
- Create: `src/utils/tty.ts`
- Create: `src/utils/__tests__/tty.test.ts`

**Interfaces produced:**

```typescript
export function isInteractive(): boolean; // process.stdin.isTTY === true && CODEMIE_NO_PROMPTS !== '1'
```

- [ ] **Step 1: Write the failing test**

`src/utils/__tests__/tty.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';

describe('isInteractive', () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalNoPrompts = process.env.CODEMIE_NO_PROMPTS;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    if (originalNoPrompts === undefined) delete process.env.CODEMIE_NO_PROMPTS;
    else process.env.CODEMIE_NO_PROMPTS = originalNoPrompts;
  });

  it('returns true when TTY and CODEMIE_NO_PROMPTS unset', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    delete process.env.CODEMIE_NO_PROMPTS;
    const { isInteractive } = await import('../tty.js');
    expect(isInteractive()).toBe(true);
  });

  it('returns false when non-TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    delete process.env.CODEMIE_NO_PROMPTS;
    const { isInteractive } = await import('../tty.js');
    expect(isInteractive()).toBe(false);
  });

  it('returns false when CODEMIE_NO_PROMPTS=1 even on TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    process.env.CODEMIE_NO_PROMPTS = '1';
    const { isInteractive } = await import('../tty.js');
    expect(isInteractive()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/__tests__/tty.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/utils/tty.ts`**

```typescript
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.env.CODEMIE_NO_PROMPTS !== '1';
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npx vitest run src/utils/__tests__/tty.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/tty.ts src/utils/__tests__/tty.test.ts
git commit -m "feat(utils): add isInteractive() TTY + CODEMIE_NO_PROMPTS helper"
```

---

## Task 4 — Doctor `--reset-version-warnings` flag + AgentsCheck rendering

Test-first: yes — add a unit test for `AgentsCheck` that asserts the three states given a mocked `VersionWarningStore`, plus a doctor CLI test that asserts the flag clears the store.

**Files:**
- Modify: `src/cli/commands/doctor/index.ts` — add `.option('--reset-version-warnings', 'Clear one-time untested-version markers')`.
- Modify: `src/cli/commands/doctor/checks/AgentsCheck.ts` — render Acknowledged / Untested / Not installed.
- Create: `src/cli/commands/doctor/checks/__tests__/AgentsCheck.status.test.ts` — three-state rendering unit test.
- Modify: `tests/integration/cli-commands/doctor.test.ts` — integration test for `--reset-version-warnings`.

**Interfaces consumed:** `VersionWarningStore.{hasWarned, clear}` from Task 2.

**Interfaces produced:** the `--reset-version-warnings` CLI flag on `codemie doctor`.

- [ ] **Step 1: Write the failing unit test for AgentsCheck three-state rendering**

Create `src/cli/commands/doctor/checks/__tests__/AgentsCheck.status.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/version-warnings.js', () => ({
  VersionWarningStore: {
    hasWarned: vi.fn(),
  },
}));

vi.mock('../../../../utils/cli-updater.js', () => ({
  getCurrentVersion: vi.fn(async () => '0.11.0'),
}));

describe('AgentsCheck status field', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders Acknowledged when marker exists for installed version', async () => {
    const { VersionWarningStore } = await import('../../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(true);
    // Instantiate AgentsCheck with a stub registry returning one installed agent (claude 2.1.219),
    // run the check, assert the returned CheckResult.message contains "Acknowledged with CodeMie 0.11.0".
  });

  it('renders Untested when no marker exists', async () => {
    const { VersionWarningStore } = await import('../../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);
    // Assert message contains "Untested with CodeMie 0.11.0".
  });

  it('renders Not installed when getVersion() returns null', async () => {
    // Stub the registry so getVersion() returns null.
    // Assert message contains "Not installed".
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run: `npx vitest run src/cli/commands/doctor/checks/__tests__/AgentsCheck.status.test.ts`
Expected: FAIL — current `AgentsCheck` does not consult `VersionWarningStore`, so mocked calls are irrelevant and assertion strings do not appear in the output.

- [ ] **Step 3: Modify `AgentsCheck.ts`**

Update `AgentsCheck` to consult `VersionWarningStore.hasWarned` for each installed agent, look up `getCurrentVersion()` from `src/utils/cli-updater.ts` (add per-check caching to avoid repeated FS reads), and format the message as:

- Installed + marker present → `${agent.displayName} (${installedVersion}) — Acknowledged with CodeMie ${codemieVersion}` (with chalk.green on the status word).
- Installed + no marker → `${agent.displayName} (${installedVersion}) — Untested with CodeMie ${codemieVersion}` (with chalk.yellow).
- Not installed → `${agent.displayName} — Not installed` (with chalk.gray).

Preserve the existing deprecated-npm-install warning as a secondary line where applicable.

- [ ] **Step 4: Verify AgentsCheck unit tests pass**

Run: `npx vitest run src/cli/commands/doctor/checks/__tests__/AgentsCheck.status.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `--reset-version-warnings` flag to the doctor command**

In `src/cli/commands/doctor/index.ts`, extend the Commander command:

```typescript
command
  .description(...)
  .option('-v, --verbose', 'Enable verbose debug output with detailed API logs')
  .option('--reset-version-warnings', 'Clear ~/.codemie/version-warnings.json before running checks')
  .action(async (options: { verbose?: boolean; resetVersionWarnings?: boolean }) => {
    if (options.resetVersionWarnings) {
      const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
      const { removed } = await VersionWarningStore.clear();
      console.log(chalk.blueBright(`Cleared version-warnings.json — ${removed} marker(s) removed.`));
    }
    // ... existing action body
  });
```

- [ ] **Step 6: Add / update integration test for the flag**

In `tests/integration/cli-commands/doctor.test.ts`, add:

```typescript
it('--reset-version-warnings clears the store', async () => {
  // Use CODEMIE_HOME isolation; pre-write a version-warnings.json with one record.
  // Run: codemie doctor --reset-version-warnings
  // Assert stdout contains "Cleared version-warnings.json — 1 marker(s) removed."
  // Assert file no longer exists.
});
```

- [ ] **Step 7: Verify all doctor tests pass**

Run: `npx vitest run tests/integration/cli-commands/doctor.test.ts src/cli/commands/doctor/checks/__tests__/AgentsCheck.status.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/doctor/index.ts src/cli/commands/doctor/checks/AgentsCheck.ts \
        src/cli/commands/doctor/checks/__tests__/AgentsCheck.status.test.ts \
        tests/integration/cli-commands/doctor.test.ts
git commit -m "feat(cli): doctor --reset-version-warnings + Acknowledged/Untested status rendering"
```

**Boundary note:** this task depends only on Task 2 (VersionWarningStore). It does NOT depend on Task 5 (BaseAgentAdapter rewire), so it commits independently and typecheck stays green.

---

## Task 5 — Add `getVersionInfo()` + `warnOnceIfUntested()` and rewire `BaseAgentAdapter.run()`

Test-first: yes — write behavioral tests for the new helper before implementing it.

**Files:**
- Modify: `src/agents/core/BaseAgentAdapter.ts` — add `getVersionInfo()` and `warnOnceIfUntested()`; rewrite the version-check block inside `run()`.
- Modify: `src/agents/core/__tests__/BaseAgentAdapter.test.ts` — rewrite the characterisation tests from Task 1 to assert the NEW behavior; add new tests for `warnOnceIfUntested()`.

**Interfaces consumed:** `VersionWarningStore` (Task 2), `isInteractive()` (Task 3), `getCurrentVersion()` from `src/utils/cli-updater.ts`.

**Interfaces produced:**

```typescript
// Inside BaseAgentAdapter:
async getVersionInfo(): Promise<AgentVersionInfo>; // { installedVersion: string | null }
async warnOnceIfUntested(): Promise<void>; // never throws
```

- [ ] **Step 1: Rewrite characterisation tests to assert new behavior**

In `src/agents/core/__tests__/BaseAgentAdapter.test.ts`, replace the Task 1 `describe('run() version-check (pre-refactor characterisation)', ...)` with `describe('run() version-check (new one-time-warning contract)', ...)`:

- `run()` calls `warnOnceIfUntested()` exactly once before the session-start block.
- With marker present in store → helper emits no warning and does not log.
- With marker absent + interactive TTY + non-silent → helper logs a `chalk.yellow` banner to stderr AND `logger.warn`, then records the marker.
- With marker absent + `silentMode: true` → helper calls `logger.warn` only, never touches `console.error`, records the marker.
- With `installedVersion === null` → helper is a no-op (no warn, no record).
- With `silentMode: true` and no marker, the helper never throws — even if the historical `isBelowMinimum` case would have.
- `inquirer.prompt` is never called from within `run()` for a version-check case.

- [ ] **Step 2: Run tests to see them fail**

Run: `npx vitest run src/agents/core/__tests__/BaseAgentAdapter.test.ts -t "new one-time-warning contract"`
Expected: FAIL — `warnOnceIfUntested` does not exist.

- [ ] **Step 3: Implement `getVersionInfo()` and `warnOnceIfUntested()`**

Add to `BaseAgentAdapter`:

```typescript
async getVersionInfo(): Promise<AgentVersionInfo> {
  const installedVersion = await this.getVersion();
  return { installedVersion };
}

async warnOnceIfUntested(): Promise<void> {
  try {
    const { installedVersion } = await this.getVersionInfo();
    if (!installedVersion) return;

    const { getCurrentVersion } = await import('../../utils/cli-updater.js');
    const codemieVersion = (await getCurrentVersion()) ?? 'unknown';

    const { VersionWarningStore } = await import('../../utils/version-warnings.js');
    if (await VersionWarningStore.hasWarned(this.metadata.name, installedVersion, codemieVersion)) {
      return;
    }

    const { isInteractive } = await import('../../utils/tty.js');
    const isSilent = this.metadata.silentMode === true;
    const noticeLine = `CodeMie has not yet been tested with ${this.metadata.name} v${installedVersion} (running CodeMie v${codemieVersion}). Proceeding — this notice is shown once.`;

    logger.warn(noticeLine, {
      agent: this.metadata.name,
      installedVersion,
      codemieVersion,
    });

    if (!isSilent && isInteractive()) {
      console.error();
      console.error(chalk.yellow(`⚠  ${noticeLine}`));
      console.error(chalk.white(`   If anything looks off, you can install a different version with:`));
      console.error(chalk.blueBright(`     codemie install ${this.metadata.name} --latest`));
      console.error();
    }

    await VersionWarningStore.recordWarning(this.metadata.name, installedVersion, codemieVersion);
  } catch (err) {
    // Never let a version-check failure break launch
    logger.warn('[warnOnceIfUntested] non-fatal error, proceeding', { err: String(err) });
  }
}
```

- [ ] **Step 4: Rewire `BaseAgentAdapter.run()`**

Replace the entire block from `// Check version compatibility before running` (line 383) through `console.log(); // Add spacing before agent starts` at the end of the update-available branch (~line 506) with:

```typescript
await this.warnOnceIfUntested();
```

Remove the `if (this.metadata.supportedVersion)` outer guard — the helper handles the "no installed version" case internally.

- [ ] **Step 5: Verify new tests pass**

Run: `npx vitest run src/agents/core/__tests__/BaseAgentAdapter.test.ts`
Expected: PASS on all tests, including the pre-existing dryRun / reasoning / Windows-path tests.

- [ ] **Step 6: Commit**

```bash
git add src/agents/core/BaseAgentAdapter.ts src/agents/core/__tests__/BaseAgentAdapter.test.ts
git commit -m "feat(agents): warnOnceIfUntested() replaces blocking version-check in BaseAgentAdapter.run()"
```

**Boundary note:** the old `checkVersionCompatibility()` method and the `AgentMetadata.supportedVersion` / `minimumSupportedVersion` reads STILL EXIST in BaseAgentAdapter after this commit. They are only called via callers in install.ts / update.ts / setup.ts, which are refactored in Task 6, and finally removed in Task 7. This keeps typecheck green throughout.

---

## Task 6 — Rewire install.ts, update.ts, setup.ts callers

Test-first: yes — assert `install --supported` routes to `--latest`; assert `setup` runs `warnOnceIfUntested()` once for Claude.

**Files:**
- Modify: `src/cli/commands/install.ts` — `--supported` flag routes to `--latest`; drop reads of `compat.supportedVersion`; user-facing strings updated.
- Modify: `src/cli/commands/update.ts` — replace `checkVersionCompatibility()` with `getVersionInfo()`; no update gating on version comparison.
- Modify: `src/cli/commands/setup.ts` — replace the Claude `chalk.yellow(isNewer) / chalk.green(compatible)` block with `warnOnceIfUntested()`.
- Modify: `src/cli/commands/__tests__/install.version-selection.test.ts` — update expectations for `--supported → --latest` routing.
- Modify: `src/cli/commands/__tests__/setup.enforcement.test.ts` — assert `warnOnceIfUntested` is called in the Claude version-check path.

- [ ] **Step 1: Write / update the failing tests**

Update `install.version-selection.test.ts`:
- Existing tests asserting `--supported → metadata.supportedVersion` are rewritten to assert `--supported → 'latest'`.
- New test: `--supported` on a plugin with no `metadata.supportedVersion` still routes to `'latest'`.
- New test: default routing for Claude when neither `--supported` nor a version is passed → `'latest'`.
- User-facing string assertions no longer expect "(supported version)".

Update `setup.enforcement.test.ts`:
- Spy on `warnOnceIfUntested` on the injected Claude adapter; assert it is called exactly once when setup wizard reaches the Claude check.
- Remove assertions on chalk.yellow / chalk.green isNewer / compatible lines.

- [ ] **Step 2: Run tests to see them fail**

Run: `npx vitest run src/cli/commands/__tests__/install.version-selection.test.ts src/cli/commands/__tests__/setup.enforcement.test.ts`
Expected: FAIL — `install.ts` still resolves `--supported` via `compat.supportedVersion`; `setup.ts` still emits chalk lines.

- [ ] **Step 3: Update `install.ts`**

- Replace `if (options?.supported) { versionToInstall = 'supported'; ... actualVersionToInstall = compat.supportedVersion; }` with `versionToInstall = 'latest';` (drop `actualVersionToInstall` resolution — display the installed version post-install instead).
- Replace the default routing for Claude (`versionToInstall = 'supported'; actualVersionToInstall = compat.supportedVersion;`) with `versionToInstall = 'latest';`.
- Delete the post-install "installed version is newer than the supported version" chalk.yellow block (lines ~216–223).
- Update the `--supported` help text to `'Install the latest available version tested by the CodeMie team'`.
- Replace remaining reads of `compat.supportedVersion` in user-facing strings with `compat.installedVersion` (or drop the fragment entirely).
- Callers of `agent.checkVersionCompatibility()` in this file switch to `agent.getVersionInfo()`.

- [ ] **Step 4: Update `update.ts`**

- Replace `agent.checkVersionCompatibility()` with `agent.getVersionInfo()` and drop reads of `supportedVersion`, `isNewer`, `hasUpdate`.
- The "has update" check should be based on npm-registry `latest` (existing logic already does this for the update command's own purpose) — not on the removed `supportedVersion` field.
- Emit `warnOnceIfUntested()` in the update flow when the installed version differs from the target `latest` version.

- [ ] **Step 5: Update `setup.ts`**

Replace the `try { const compat = await Promise.race([...checkVersionCompatibility, 3s timeout]); ... chalk.yellow / chalk.green ... }` block at ~line 883 with:

```typescript
try {
  await Promise.race([
    claudeAdapter.warnOnceIfUntested(),
    new Promise<void>(resolve => setTimeout(resolve, 3000)),
  ]);
} catch { /* non-fatal */ }
```

- [ ] **Step 6: Verify all touched tests pass**

Run: `npx vitest run src/cli/commands/__tests__/install.version-selection.test.ts src/cli/commands/__tests__/setup.enforcement.test.ts`
Expected: PASS.

- [ ] **Step 7: Full unit run to catch collateral breakage**

Run: `npx vitest run src/cli/commands/__tests__/`
Expected: PASS on all CLI command tests, including tests that were not directly modified.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/install.ts src/cli/commands/update.ts src/cli/commands/setup.ts \
        src/cli/commands/__tests__/install.version-selection.test.ts \
        src/cli/commands/__tests__/setup.enforcement.test.ts
git commit -m "refactor(cli): install/update/setup use warnOnceIfUntested and --latest routing"
```

**Boundary note:** after this commit, `install.ts` still calls `agent.checkVersionCompatibility()` if any code path missed the refactor. That method still exists on `BaseAgentAdapter` (unused externally). It is deleted along with the pinned constants in Task 7.

---

## Task 7 — Atomic removal: constants, metadata fields, VersionCompatibilityResult, agent-build-setup.ts, codex version-support test rewrite

Test-first: yes — the rewritten `codex.plugin.version-support.test.ts` is the failing test for this task.

**Rationale for atomicity:** removing `CLAUDE_SUPPORTED_VERSION`, `supportedVersion` from `AgentMetadata`, `VersionCompatibilityResult`, and the `agent-build-setup.ts` import all in one commit avoids intermediate typecheck failures. Any smaller split leaves the tree with a dangling import or a type reference to a deleted symbol.

**Files:**
- Modify: `src/agents/core/types.ts` — remove `supportedVersion`, `minimumSupportedVersion` from `AgentMetadata`; delete `VersionCompatibilityResult`; add `export interface AgentVersionInfo { installedVersion: string | null }`; replace `checkVersionCompatibility?()` on the `AgentAdapter` interface with `getVersionInfo(): Promise<AgentVersionInfo>` and remove the optional marker (all built-in adapters extend `BaseAgentAdapter`, which now implements it).
- Modify: `src/agents/core/BaseAgentAdapter.ts` — delete `checkVersionCompatibility()` and its imports of `compareVersions`, `VersionCompatibilityResult`. Delete any residual chalk-line copy in the version-check block (already replaced in Task 5).
- Modify: `src/agents/plugins/claude/claude.plugin.ts` — delete `CLAUDE_SUPPORTED_VERSION` and `CLAUDE_MINIMUM_SUPPORTED_VERSION` consts and their metadata fields. Preserve all other exports.
- Modify: `src/agents/plugins/codex/codex.plugin.ts` — same for codex.
- Modify: `src/agents/plugins/gemini/gemini.plugin.ts` — same for gemini.
- Modify: `src/agents/plugins/kimi/kimi.plugin.ts` — same for kimi.
- Modify: `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts` — rewrite to cover the new one-time-warning contract instead of asserting the removed constant.
- Modify: `tests/setup/agent-build-setup.ts` — remove the `CLAUDE_SUPPORTED_VERSION` import; install claude `--latest` if the CLI is not present, and skip re-install if any version is present.

- [ ] **Step 1: Rewrite `codex.plugin.version-support.test.ts` as the failing test**

Replace the existing content with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/version-warnings.js', () => ({
  VersionWarningStore: {
    hasWarned: vi.fn(),
    recordWarning: vi.fn(),
  },
}));
vi.mock('../../../../utils/cli-updater.js', () => ({
  getCurrentVersion: vi.fn(async () => '0.11.0'),
}));

describe('CodexPlugin — one-time untested-version warning contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not export a supportedVersion constant', async () => {
    const mod = await import('../codex.plugin.js');
    expect((mod as any).CODEX_SUPPORTED_VERSION).toBeUndefined();
    expect((mod as any).CODEX_MINIMUM_SUPPORTED_VERSION).toBeUndefined();
    expect(mod.CodexPluginMetadata.supportedVersion).toBeUndefined();
    expect(mod.CodexPluginMetadata.minimumSupportedVersion).toBeUndefined();
  });

  it('warnOnceIfUntested emits warn + records marker on first launch with unacknowledged version', async () => {
    const { VersionWarningStore } = await import('../../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);
    const { CodexPlugin } = await import('../codex.plugin.js');
    const adapter = new (CodexPlugin as any)();
    vi.spyOn(adapter, 'getVersion').mockResolvedValue('0.143.0');
    await adapter.warnOnceIfUntested();
    expect(VersionWarningStore.recordWarning).toHaveBeenCalledWith('codex', '0.143.0', '0.11.0');
  });

  it('warnOnceIfUntested is silent + does not record when marker present', async () => {
    const { VersionWarningStore } = await import('../../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(true);
    const { CodexPlugin } = await import('../codex.plugin.js');
    const adapter = new (CodexPlugin as any)();
    vi.spyOn(adapter, 'getVersion').mockResolvedValue('0.143.0');
    await adapter.warnOnceIfUntested();
    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts`
Expected: FAIL — `CODEX_SUPPORTED_VERSION` still exists / metadata still has the fields.

- [ ] **Step 3: Delete the constants and metadata fields across all four plugins**

For each of `claude.plugin.ts`, `codex.plugin.ts`, `gemini.plugin.ts`, `kimi.plugin.ts`:
- Delete the two `const *_SUPPORTED_VERSION` and `*_MINIMUM_SUPPORTED_VERSION` declarations and their JSDoc.
- Delete the two lines that write these values into the plugin metadata literal.
- Verify no other code in the file reads these consts.

- [ ] **Step 4: Update `src/agents/core/types.ts`**

- Delete lines 198–210 (`export interface VersionCompatibilityResult { ... }`).
- Remove `supportedVersion?: string;` and `minimumSupportedVersion?: string;` from `AgentMetadata` (around lines 228 and 237).
- Add above (or below) `AgentMetadata`:

```typescript
export interface AgentVersionInfo {
  installedVersion: string | null;
}
```

- Replace `checkVersionCompatibility?(): Promise<VersionCompatibilityResult>;` on the `AgentAdapter` interface (line ~829) with `getVersionInfo(): Promise<AgentVersionInfo>;` (mandatory, not optional).

- [ ] **Step 5: Update `BaseAgentAdapter.ts`**

- Delete the `checkVersionCompatibility()` method (was lines 272–373).
- Delete the `import { compareVersions } from '../../utils/version-utils.js';` if not used elsewhere in this file (grep to confirm).
- Delete any remaining chalk / inquirer imports from the version-check block that are unused after Task 5.

- [ ] **Step 6: Update `tests/setup/agent-build-setup.ts`**

Replace lines 61–99 (the whole `CLAUDE_SUPPORTED_VERSION` block) with:

```typescript
// Install claude CLI if not present; do not pin a version.
const { ClaudePlugin } = await import(
  resolve(root, 'dist/agents/plugins/claude/claude.plugin.js')
);
const claudeAdapter = new ClaudePlugin();
const installedVersion = await claudeAdapter.getVersion();
if (installedVersion) {
  console.log(`[agent-integration] claude CLI v${installedVersion} already installed — skipping.\n`);
} else {
  console.log(`[agent-integration] claude CLI not found — installing latest...\n`);
  await claudeAdapter.installVersion('latest');
  console.log(`[agent-integration] claude CLI installed.\n`);
}
```

- [ ] **Step 7: Run typecheck and lint to confirm the tree is coherent**

Run: `npm run typecheck && npm run lint`
Expected: PASS both. Any dangling reference to `supportedVersion`, `minimumSupportedVersion`, `VersionCompatibilityResult`, or `checkVersionCompatibility` surfaces here — fix by re-running Tasks 5–7's edits until the tree is clean.

- [ ] **Step 8: Run all unit tests**

Run: `npx vitest run --project unit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/agents/core/types.ts src/agents/core/BaseAgentAdapter.ts \
        src/agents/plugins/claude/claude.plugin.ts \
        src/agents/plugins/codex/codex.plugin.ts \
        src/agents/plugins/gemini/gemini.plugin.ts \
        src/agents/plugins/kimi/kimi.plugin.ts \
        src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts \
        tests/setup/agent-build-setup.ts
git commit -m "refactor(agents): remove pinned supported-version constants and metadata fields"
```

**Boundary note:** this is the largest single commit in the plan, and by design it removes ~150 LOC across 8 files in one atomic step. Splitting it leaves typecheck broken.

---

## Task 8 — Final verification pass

Test-first: no — this task runs the full suite of guards; there is no new failing test.

**Files:** none modified.

- [ ] **Step 1: Full workspace lint**

Run: `npm run lint`
Expected: zero warnings (project standard).

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Full unit test project**

Run: `npx vitest run --project unit`
Expected: PASS on the entire unit project.

- [ ] **Step 4: CLI integration test project (fast subset)**

Run: `npx vitest run --project cli --exclude "**/agent-*.test.ts"`
Expected: PASS. If agent integration tests are within scope of the local run, run them too (they are the most likely place any lingering `supportedVersion` reference would surface).

- [ ] **Step 5: Search the tree for residual references**

Run: `git grep -nE 'supportedVersion|minimumSupportedVersion|SUPPORTED_VERSION|VersionCompatibilityResult|checkVersionCompatibility'`
Expected: only benign hits — comments in commit messages, docs, or the plan itself. No live TypeScript code should reference these symbols.

- [ ] **Step 6: Commit any docstring / comment cleanup uncovered by Step 5**

If Step 5 surfaces stale JSDoc referencing the removed constants, edit the docstrings and:

```bash
git commit -m "docs: drop references to removed supported-version constants"
```

- [ ] **Step 7: Handoff back to sdlc-standard Stage 6 (code review)**

Do NOT run `codemie-pr` or open a PR here. Control returns to sdlc-standard.

---

## Self-review — spec coverage

| Spec section | Covered by |
|---|---|
| Warn once per (agent, agentVersion, codemieVersion) tuple | Task 2 (store) + Task 5 (adapter helper) |
| Non-interactive / ACP: log + proceed, never throw | Task 5 (`warnOnceIfUntested` never throws; `silentMode` uses `logger.warn` only) |
| ACP `isBelowMinimum` throw → log-and-proceed | Task 5 (`run()` no longer branches on `isBelowMinimum`; helper never throws) |
| Reset mechanism (`codemie doctor --reset-version-warnings`) | Task 4 |
| Doctor shows Acknowledged / Untested / Not installed | Task 4 |
| Remove all pinned constants, no CodeMie release needed to keep users unblocked | Task 7 |
| `install --supported` → `--latest` (silent alias) | Task 6 |
| Fix `tests/setup/agent-build-setup.ts` coupling | Task 7 |
| Characterisation tests before behavior rewrite | Task 1 (safety net) + Task 5 (final assertions) |
| Cover Claude / Gemini / Kimi version-check paths (only Codex has a test today) | Task 5 (BaseAgentAdapter tests are adapter-agnostic — cover all four via one suite) + Task 7 (Codex plugin test rewrite) |
| Update `codex.plugin.version-support.test.ts` | Task 7 |
| Preserve `DISABLE_AUTOUPDATER=1` behavior | Not modified — no task touches lifecycle.beforeRun |
| Preserve deprecated-npm-install warning in AgentsCheck | Task 4 (explicit preservation note) |

No spec requirement is uncovered. No task depends on a symbol defined only in a later task. Ordering keeps typecheck green at every commit boundary.
