# EPMCDME-14035 — codemie-claude hook path + unsupported effort param

> **For agentic workers:** This plan is executed inline via sdlc-light Stage 4 (superpowers:test-driven-development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two independent codemie-claude runtime failures: (1) Claude Code hooks fail with `codemie: command not found` because installed hooks call the bare `codemie` binary, and (2) requests to Claude models that don't support the `effort` parameter (e.g. `claude-4-5-sonnet`) 400 because the SSO proxy never strips `effort`.

**Architecture:**
- **Bug 1 (hook path):** A shared resolver rewrites hook commands to use the absolute, directly-invocable codemie path. It runs at install time (post-copy in `BaseExtensionInstaller.install()`, covering Claude + Gemini), at codemie-code inline-hook construction (`OPENCODE_HOOKS`), and via a one-time startup migration (006) for already-installed users.
- **Bug 2 (effort):** Add a handler to the Claude request-normalizer proxy plugin that strips `effort` (`output_config.effort` and top-level `effort`) for models that do **not** support the adaptive-thinking/effort API. Model gating is consolidated into a single `MODEL_CAPABILITY_TABLE` (pattern → `ModelCapabilities { thinking, effort, sampling, preserveDisabledThinking }`); `capabilitiesFor(model)` returns the matching row or `DEFAULT_CAPABILITIES` (`{ thinking: 'standard', effort: false, sampling: true }`), and the effort handler strips when `caps.effort === false`. This replaces the earlier separate `NO_THINKING_MODEL_PATTERNS` / `ADAPTIVE_THINKING_MODEL_PATTERNS` regex lists.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥ 20, Vitest, existing plugin/installer/migration frameworks in `codemie-code`.

## Global Constraints

- Node.js `>= 20.0.0`; ESM only — every relative import ends in `.js`. (verbatim: repo requirement)
- No `any` in exported signatures; explicit return types on exports. Use `interface` for shapes.
- Logging via `logger` from `src/utils/logger.js`; use `logger.debug`/`logger.warn`, never `console.log`. Never log secrets.
- Prefer the `@/` alias over deep relative imports where the surrounding file already uses it; otherwise match the file's existing import style.
- Hook rewriting and the migration are **non-fatal**: any failure logs and continues — installation and startup must never break because of them.
- Source template files (`.../plugin/hooks/hooks.json`, `.../extension/hooks/hooks.json`) stay machine-agnostic (bare `codemie`); only the **installed copy** and runtime-constructed hooks are localized to an absolute path.
- Tests: Vitest, colocated under `__tests__/`, `@group unit`. Mock `getCommandPath` via dynamic-import mocking per `.ai-run/guides/testing/testing-patterns.md`.

---

## File Structure

- **Create** `src/utils/hook-command.ts` — shared resolver: `resolveCodemieBinary()`, `resolveHookCommand()`, `rewriteHooksCommandTree()`.
- **Modify** `src/agents/core/extension/BaseExtensionInstaller.ts` — post-copy step that rewrites the installed `hooks/hooks.json` (covers Claude + Gemini via inheritance).
- **Modify** `src/agents/plugins/codemie-code.plugin.ts` — localize the inline `defaultHooks` commands before serializing to `OPENCODE_HOOKS`.
- **Create** `src/migrations/006-resolve-hook-command-paths.migration.ts` — one-time rewrite of installed Claude + Gemini hooks files.
- **Modify** `src/migrations/index.ts` — import/register migration 006.
- **Modify** `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts` — add `handleUnsupportedEffort` handler + wiring.
- **Tests:** colocated `__tests__/` for each of the above.

---

### Task 1: Shared hook-command resolver

**Files:**
- Create: `src/utils/hook-command.ts`
- Test: `src/utils/__tests__/hook-command.test.ts`

**Interfaces:**
- Consumes: `getCommandPath` from `src/utils/processes.js`.
- Produces:
  - `resolveCodemieBinary(): Promise<string>` — an absolute, directly-invocable command prefix for the codemie CLI (e.g. `/usr/local/bin/codemie`, already quoted if it contains whitespace/special chars). Falls back to `process.argv[1]` then the literal `codemie`.
  - `resolveHookCommand(command: string, binary: string): string` — if `command` is `codemie` or begins with `codemie ` (the token), replace that leading token with `binary`; otherwise return `command` unchanged.
  - `rewriteHooksCommandTree(node: unknown, binary: string): boolean` — recursively walk any hooks structure (arrays and objects at any depth), applying `resolveHookCommand` to every string-valued `command` field wherever it appears. Shape-agnostic: it handles the Claude/Gemini `{ SessionStart: [{ hooks: [{ type, command }] }], ... }` layout without hardcoding it. Mutates in place; returns `true` if any command changed.

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/__tests__/hook-command.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('hook-command resolver', () => {
  beforeEach(() => { vi.resetModules(); });

  it('resolveHookCommand replaces the leading codemie token, preserving args', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand('codemie hook', '/usr/local/bin/codemie'))
      .toBe('/usr/local/bin/codemie hook');
    expect(resolveHookCommand('codemie sound SessionStart', '/usr/local/bin/codemie'))
      .toBe('/usr/local/bin/codemie sound SessionStart');
    expect(resolveHookCommand('codemie', '/usr/local/bin/codemie'))
      .toBe('/usr/local/bin/codemie');
  });

  it('resolveHookCommand leaves non-codemie and already-absolute commands unchanged', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand('echo hi', '/usr/local/bin/codemie')).toBe('echo hi');
    expect(resolveHookCommand('/usr/local/bin/codemie hook', '/usr/local/bin/codemie'))
      .toBe('/usr/local/bin/codemie hook');
  });

  it('resolveCodemieBinary prefers getCommandPath and quotes spaces', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue('/opt/my apps/codemie') }));
    const { resolveCodemieBinary, resolveHookCommand } = await import('../hook-command.js');
    const bin = await resolveCodemieBinary();
    expect(bin).toBe('"/opt/my apps/codemie"');
    expect(resolveHookCommand('codemie hook', bin)).toBe('"/opt/my apps/codemie" hook');
  });

  it('resolveCodemieBinary falls back to process.argv[1] when getCommandPath is null', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(null) }));
    const spy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/home/u/.npm/bin/codemie']);
    const { resolveCodemieBinary } = await import('../hook-command.js');
    expect(await resolveCodemieBinary()).toBe('/home/u/.npm/bin/codemie');
    spy.mockRestore();
  });

  it('rewriteHooksCommandTree rewrites every command and reports change', async () => {
    const { rewriteHooksCommandTree } = await import('../hook-command.js');
    const hooks = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'codemie hook' }, { type: 'command', command: 'codemie sound SessionStart' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'codemie hook' }] }],
    };
    const changed = rewriteHooksCommandTree(hooks, '/abs/codemie');
    expect(changed).toBe(true);
    expect(hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');
    expect(hooks.SessionStart[0].hooks[1].command).toBe('/abs/codemie sound SessionStart');
    expect(hooks.Stop[0].hooks[0].command).toBe('/abs/codemie hook');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/__tests__/hook-command.test.ts`
Expected: FAIL — `Cannot find module '../hook-command.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/utils/hook-command.ts
import { getCommandPath } from './processes.js';

// Same special-char class BaseAgentAdapter uses to decide when a command path
// must be quoted before it lands in a shell string.
const NEEDS_QUOTING = /[ \t,;=()&|<>^%[\]{}]/;

function quoteIfNeeded(p: string): string {
  return NEEDS_QUOTING.test(p) && !p.startsWith('"') ? `"${p}"` : p;
}

/**
 * Absolute, directly-invocable command prefix for the codemie CLI.
 * Preference: PATH-resolved shim/symlink → the running entry (process.argv[1])
 * → the literal `codemie` (today's behavior, last resort).
 */
export async function resolveCodemieBinary(): Promise<string> {
  const resolved = await getCommandPath('codemie');
  if (resolved) return quoteIfNeeded(resolved);
  const argv1 = process.argv[1];
  if (argv1) return quoteIfNeeded(argv1);
  return 'codemie';
}

/** Rewrite a hook command's leading `codemie` token to `binary`. */
export function resolveHookCommand(command: string, binary: string): string {
  if (command === 'codemie') return binary;
  if (command.startsWith('codemie ')) return binary + command.slice('codemie'.length);
  return command;
}

/**
 * Recursively rewrite every string-valued `command` field found anywhere in a
 * hooks structure via resolveHookCommand. Shape-agnostic: handles the
 * Claude/Gemini `{ EventName: [{ hooks: [{ command }] }] }` layout and any other
 * nesting without hardcoding it. Mutates in place; returns true if anything changed.
 */
export function rewriteHooksCommandTree(node: unknown, binary: string): boolean {
  if (Array.isArray(node)) {
    let changed = false;
    for (const item of node) {
      if (rewriteHooksCommandTree(item, binary)) changed = true;
    }
    return changed;
  }

  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    let changed = false;
    for (const [key, value] of Object.entries(record)) {
      if (key === 'command' && typeof value === 'string') {
        const next = resolveHookCommand(value, binary);
        if (next !== value) { record[key] = next; changed = true; }
      } else if (rewriteHooksCommandTree(value, binary)) {
        changed = true;
      }
    }
    return changed;
  }

  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/__tests__/hook-command.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/hook-command.ts src/utils/__tests__/hook-command.test.ts
git commit -m "feat(hooks): add shared codemie hook-command path resolver [EPMCDME-14035]"
```

---

### Task 2: Rewrite installed hooks in BaseExtensionInstaller (Claude + Gemini)

**Files:**
- Modify: `src/agents/core/extension/BaseExtensionInstaller.ts` (add post-copy step inside `install()` after `verifyInstallation`, ~line 665; add `protected async localizeInstalledHooks(targetPath)`)
- Test: `src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts`

**Interfaces:**
- Consumes: `resolveCodemieBinary`, `rewriteHooksCommandTree` from `@/utils/hook-command.js`; `readFile`/`writeFile` from `fs/promises`.
- Produces: after a successful copy, `<targetPath>/hooks/hooks.json` contains absolute-path commands. No new public API.

- [ ] **Step 1: Write the failing test** — install into a temp dir from a fixture source tree; assert the installed `hooks/hooks.json` commands are absolute.

```ts
// src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('BaseExtensionInstaller localizes hook commands', () => {
  let src: string; let home: string;
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/utils/hook-command.js', () => ({
      resolveCodemieBinary: vi.fn().mockResolvedValue('/abs/codemie'),
      rewriteHooksCommandTree: (await vi.importActual<any>('@/utils/hook-command.js')).rewriteHooksCommandTree,
    }));
    src = await mkdtemp(join(tmpdir(), 'ext-src-'));
    home = await mkdtemp(join(tmpdir(), 'ext-home-'));
    await mkdir(join(src, 'hooks'), { recursive: true });
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '9.9.9' }));
    await writeFile(join(src, 'README.md'), '# x');
    await writeFile(join(src, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'codemie hook' }] }] },
    }));
  });
  afterEach(async () => { await rm(src, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });

  it('rewrites installed hooks.json commands to the absolute path', async () => {
    const { BaseExtensionInstaller } = await import('../BaseExtensionInstaller.js');
    class TestInstaller extends (BaseExtensionInstaller as any) {
      protected getSourcePath() { return src; }
      getTargetPath() { return join(home, 'ext'); }
      protected getManifestPath() { return '.claude-plugin/plugin.json'; }
      protected getCriticalFiles() { return ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'README.md']; }
    }
    const res = await new TestInstaller('test').install();
    expect(res.success).toBe(true);
    const installed = JSON.parse(await readFile(join(home, 'ext', 'hooks', 'hooks.json'), 'utf-8'));
    expect(installed.hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts`
Expected: FAIL — installed command is still `codemie hook`.

- [ ] **Step 3: Write minimal implementation** — add the call after `verifyInstallation` succeeds (inside the `if (action !== 'already_exists')` block), and the method:

```ts
// after: const isValid = await this.verifyInstallation(targetPath); ... (isValid true branch)
await this.localizeInstalledHooks(targetPath);
```

```ts
// new protected method on BaseExtensionInstaller
protected async localizeInstalledHooks(targetPath: string): Promise<void> {
  try {
    const { resolveCodemieBinary, rewriteHooksCommandTree } = await import('@/utils/hook-command.js');
    const hooksFile = join(targetPath, 'hooks', 'hooks.json');
    const raw = await readFile(hooksFile, 'utf-8');
    const parsed = JSON.parse(raw) as { hooks?: unknown };
    const binary = await resolveCodemieBinary();
    if (rewriteHooksCommandTree(parsed.hooks, binary)) {
      await writeFile(hooksFile, JSON.stringify(parsed, null, 2), 'utf-8');
      logger.info(`[${this.agentName}] Localized hook commands to ${binary}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[${this.agentName}] Could not localize hook commands (non-fatal): ${msg}`);
  }
}
```

Ensure `readFile, writeFile` are in the existing `fs/promises` import at the top of the file (they are already imported alongside `readFile`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/extension/BaseExtensionInstaller.ts src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts
git commit -m "fix(hooks): localize installed Claude/Gemini hook commands to absolute codemie path [EPMCDME-14035]"
```

---

### Task 3: Localize codemie-code inline hooks (OPENCODE_HOOKS)

**Files:**
- Modify: `src/agents/plugins/codemie-code.plugin.ts` (the `defaultHooks` construction near line 300, before `env.OPENCODE_HOOKS = JSON.stringify(...)` at line 337)
- Test: `src/agents/plugins/__tests__/codemie-code.hooks.test.ts`

**Interfaces:**
- Consumes: `resolveCodemieBinary`, `resolveHookCommand` from `@/utils/hook-command.js`.
- Produces: `env.OPENCODE_HOOKS` default hook commands use the absolute codemie path.

- [ ] **Step 1: Write the failing test** — assert the constructed `defaultHooks` (or `OPENCODE_HOOKS`) uses the absolute path. Isolate the smallest testable unit: extract a helper `buildDefaultHooks(binary: string)` in the plugin file and test it directly.

```ts
// src/agents/plugins/__tests__/codemie-code.hooks.test.ts
import { describe, it, expect } from 'vitest';
import { buildDefaultHooks } from '../codemie-code.plugin.js';

describe('codemie-code default hooks', () => {
  it('uses the resolved absolute codemie path for default hook commands', () => {
    const hooks = buildDefaultHooks('/abs/codemie') as any;
    expect(hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');
    expect(hooks.SessionEnd[0].hooks[0].command).toBe('/abs/codemie hook');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/__tests__/codemie-code.hooks.test.ts`
Expected: FAIL — `buildDefaultHooks` is not exported.

- [ ] **Step 3: Write minimal implementation** — extract and export a pure builder, resolve the binary once in `beforeRun`, and use it:

```ts
// near top-level of codemie-code.plugin.ts
export function buildDefaultHooks(binary: string): Record<string, unknown[]> {
  const hook = resolveHookCommand('codemie hook', binary);
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: hook, timeout: 5 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: hook, timeout: 10 }] }],
  };
}
```

```ts
// inside beforeRun, replacing the inline defaultHooks literal:
const codemieBinary = await resolveCodemieBinary();
const defaultHooks: Record<string, unknown[]> = buildDefaultHooks(codemieBinary);
```

Add import: `import { resolveCodemieBinary, resolveHookCommand } from '@/utils/hook-command.js';`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/__tests__/codemie-code.hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/codemie-code.plugin.ts src/agents/plugins/__tests__/codemie-code.hooks.test.ts
git commit -m "fix(hooks): localize codemie-code inline OPENCODE_HOOKS commands [EPMCDME-14035]"
```

---

### Task 4: One-time migration to fix already-installed hooks

**Files:**
- Create: `src/migrations/006-resolve-hook-command-paths.migration.ts`
- Modify: `src/migrations/index.ts` (import so it auto-registers)
- Test: `src/migrations/__tests__/006-resolve-hook-command-paths.migration.test.ts`

**Interfaces:**
- Consumes: `resolveCodemieBinary`, `rewriteHooksCommandTree` from `@/utils/hook-command.js`; `Migration`/`MigrationResult` from `./types.js`; `MigrationRegistry` from `./registry.js`.
- Produces: registered migration `006-resolve-hook-command-paths` that rewrites `~/.codemie/claude-plugin/hooks/hooks.json` and `~/.gemini/extensions/codemie/hooks/hooks.json`.

- [ ] **Step 1: Write the failing test**

```ts
// src/migrations/__tests__/006-resolve-hook-command-paths.migration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('006-resolve-hook-command-paths', () => {
  let home: string;
  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), 'mig006-'));
    vi.doMock('os', async (imp) => ({ ...(await imp<any>()), homedir: () => home }));
    vi.doMock('@/utils/hook-command.js', async (imp) => ({
      ...(await imp<any>()),
      resolveCodemieBinary: vi.fn().mockResolvedValue('/abs/codemie'),
    }));
    const dir = join(home, '.codemie', 'claude-plugin', 'hooks');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'codemie hook' }] }] },
    }));
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('rewrites bare codemie commands in installed claude hooks', async () => {
    const { RewriteHookCommandPathsMigration } = await import('../006-resolve-hook-command-paths.migration.js');
    const res = await new RewriteHookCommandPathsMigration().up();
    expect(res.success).toBe(true);
    expect(res.migrated).toBe(true);
    const installed = JSON.parse(await readFile(join(home, '.codemie', 'claude-plugin', 'hooks', 'hooks.json'), 'utf-8'));
    expect(installed.hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');
  });

  it('is a no-op when no installed hook files exist', async () => {
    await rm(join(home, '.codemie'), { recursive: true, force: true });
    const { RewriteHookCommandPathsMigration } = await import('../006-resolve-hook-command-paths.migration.js');
    const res = await new RewriteHookCommandPathsMigration().up();
    expect(res.success).toBe(true);
    expect(res.migrated).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/migrations/__tests__/006-resolve-hook-command-paths.migration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** (mirrors `003-remove-hooks-node.migration.ts`)

```ts
// src/migrations/006-resolve-hook-command-paths.migration.ts
import * as fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { resolveCodemieBinary, rewriteHooksCommandTree } from '@/utils/hook-command.js';
import { logger } from '../utils/logger.js';

class RewriteHookCommandPathsMigration implements Migration {
  id = '006-resolve-hook-command-paths';
  description = 'Rewrite installed Claude/Gemini hook commands to the absolute codemie path';
  minVersion = '0.1.0';

  private hookFiles(): string[] {
    return [
      path.join(homedir(), '.codemie', 'claude-plugin', 'hooks', 'hooks.json'),
      path.join(homedir(), '.gemini', 'extensions', 'codemie', 'hooks', 'hooks.json'),
    ];
  }

  async up(): Promise<MigrationResult> {
    let migrated = false;
    let binary: string | undefined;
    for (const file of this.hookFiles()) {
      try {
        const raw = await fs.readFile(file, 'utf-8');
        const parsed = JSON.parse(raw) as { hooks?: unknown };
        binary ??= await resolveCodemieBinary();
        if (rewriteHooksCommandTree(parsed.hooks, binary)) {
          await fs.writeFile(file, JSON.stringify(parsed, null, 2), 'utf-8');
          logger.info(`[006-resolve-hook-command-paths] Rewrote ${file}`);
          migrated = true;
        }
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          logger.warn(`[006-resolve-hook-command-paths] Skipped ${file}: ${error?.message ?? error}`);
        }
      }
    }
    return { success: true, migrated, reason: migrated ? undefined : 'nothing-to-rewrite' };
  }
}

MigrationRegistry.register(new RewriteHookCommandPathsMigration());
export { RewriteHookCommandPathsMigration };
```

Add to `src/migrations/index.ts`: `import './006-resolve-hook-command-paths.migration.js';` (match how 003/004/005 are imported there).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/migrations/__tests__/006-resolve-hook-command-paths.migration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/migrations/006-resolve-hook-command-paths.migration.ts src/migrations/index.ts src/migrations/__tests__/006-resolve-hook-command-paths.migration.test.ts
git commit -m "fix(hooks): add migration to fix already-installed hook command paths [EPMCDME-14035]"
```

---

### Task 5: Strip unsupported `effort` param for non-adaptive Claude models

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts` (add `handleUnsupportedEffort`; wire into `onRequest` outside the `if (body.thinking)` guard)
- Test: `src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts` (append cases)

**Interfaces:**
- Consumes: `capabilitiesFor(model): ModelCapabilities` from the consolidated `MODEL_CAPABILITY_TABLE` (first-match-wins; falls back to `DEFAULT_CAPABILITIES`). The thinking/sampling handlers are refactored to take the same `caps` object so every model decision reads from one source of truth.
- Produces: `handleUnsupportedEffort(body: any, caps: ModelCapabilities, model: string): boolean` — no-op when `caps.effort === true`; otherwise deletes `body.output_config.effort` (and `body.output_config` if it becomes empty) and any top-level `body.effort`; returns `true` if anything was stripped.

- [ ] **Step 1: Write the failing test** (append to the existing describe block)

```ts
describe('unsupported effort stripping', () => {
  it('strips output_config.effort for claude-4-5-sonnet (no thinking present)', async () => {
    const plugin = new ClaudeRequestNormalizerPlugin();
    const i = await plugin.createInterceptor(createPluginContext('codemie-claude', 'claude-4-5-sonnet'));
    const ctx = createProxyContext({ model: 'claude-4-5-sonnet', output_config: { effort: 'high' }, messages: [] });
    await i.onRequest(ctx);
    const out = JSON.parse(ctx.requestBody!.toString('utf-8'));
    expect(out.output_config?.effort).toBeUndefined();
    expect(out.output_config).toBeUndefined(); // emptied object removed
  });

  it('strips effort for the alternate spelling claude-sonnet-4-5', async () => {
    const plugin = new ClaudeRequestNormalizerPlugin();
    const i = await plugin.createInterceptor(createPluginContext('codemie-claude', 'claude-sonnet-4-5'));
    const ctx = createProxyContext({ model: 'claude-sonnet-4-5', output_config: { effort: 'medium', other: 1 }, messages: [] });
    await i.onRequest(ctx);
    const out = JSON.parse(ctx.requestBody!.toString('utf-8'));
    expect(out.output_config?.effort).toBeUndefined();
    expect(out.output_config?.other).toBe(1); // sibling keys preserved
  });

  it('strips a top-level effort field for a non-adaptive model', async () => {
    const plugin = new ClaudeRequestNormalizerPlugin();
    const i = await plugin.createInterceptor(createPluginContext('codemie-claude', 'claude-4-5-sonnet'));
    const ctx = createProxyContext({ model: 'claude-4-5-sonnet', effort: 'high', messages: [] });
    await i.onRequest(ctx);
    const out = JSON.parse(ctx.requestBody!.toString('utf-8'));
    expect(out.effort).toBeUndefined();
  });

  it('PRESERVES effort for adaptive models (claude-opus-4-7, claude-sonnet-5)', async () => {
    for (const model of ['claude-opus-4-7', 'claude-sonnet-5']) {
      const plugin = new ClaudeRequestNormalizerPlugin();
      const i = await plugin.createInterceptor(createPluginContext('codemie-claude', model));
      const ctx = createProxyContext({ model, output_config: { effort: 'high' }, messages: [] });
      await i.onRequest(ctx);
      const out = JSON.parse(ctx.requestBody!.toString('utf-8'));
      expect(out.output_config?.effort).toBe('high');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts`
Expected: FAIL — effort still present for sonnet cases.

- [ ] **Step 3: Write minimal implementation**

Add the handler:

```ts
function handleUnsupportedEffort(body: any, caps: ModelCapabilities, model: string): boolean {
  if (caps.effort) {
    return false; // models whose capabilities allow effort legitimately accept it
  }
  let stripped = false;
  const oc = body.output_config;
  if (oc && typeof oc === 'object' && 'effort' in oc) {
    delete oc.effort;
    stripped = true;
    if (Object.keys(oc).length === 0) delete body.output_config;
  }
  if ('effort' in body) {
    delete body.effort;
    stripped = true;
  }
  if (stripped) {
    logger.debug(`[claude-request-normalizer] Stripped unsupported effort parameter for model: ${model}`);
  }
  return stripped;
}
```

Wire it in `onRequest` (runs regardless of `body.thinking`, since Claude Code can send `effort` without `thinking`). Resolve `caps` once and pass it to every handler:

```ts
const caps = capabilitiesFor(model);

const modifiedBySampling = handleDeprecatedSamplingParams(body, caps, model);
const modifiedByEffort = handleUnsupportedEffort(body, caps, model);

let modifiedByThinking = false;
if (body.thinking) {
  modifiedByThinking = handleThinkingField(body, caps, model);
}

if (modifiedBySampling || modifiedByEffort || modifiedByThinking) {
  const newBodyStr = JSON.stringify(body);
  context.requestBody = Buffer.from(newBodyStr, 'utf-8');
  context.headers['content-length'] = String(context.requestBody.length);
}
```

The thinking normalization is consolidated into a single `handleThinkingField(body, caps, model)` that branches on `caps.thinking` (`none` → strip; `adaptive` → enabled→adaptive+effort, disabled→preserve-or-strip per `caps.preserveDisabledThinking`; `standard` → leave untouched), replacing the former `handleNoThinkingModels` / `handleAdaptiveThinkingTransform` pair. Also update the plugin's top-of-file doc comment to describe the capability table and the effort-stripping behavior for non-adaptive models.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts`
Expected: PASS (existing + 4 new cases).

- [ ] **Step 5: Commit**

```bash
git add src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts
git commit -m "fix(proxy): strip unsupported effort param for non-adaptive Claude models [EPMCDME-14035]"
```

---

### Task 6: Full-suite gate

- [ ] **Step 1:** `npx vitest run` — entire suite green.
- [ ] **Step 2:** `npm run typecheck` — no errors (esp. the new `@/utils/hook-command.js` imports and migration).
- [ ] **Step 3:** `npm run lint` — zero warnings.
- [ ] These run again under sdlc-light Stage 6 (qa-gates); this task is the pre-review self-check.

---

## Self-Review

**Spec coverage (acceptance criteria → task):**
- `codemie` available to hooks after setup → Tasks 2 (install-time) + 3 (codemie-code) + 4 (already-installed).
- `SessionStart`/`UserPromptSubmit` no longer fail with command-not-found → Task 2 rewrites all seven Claude hook events (SessionStart, UserPromptSubmit, Stop, SessionEnd, PermissionRequest, SubagentStop, PreCompact) since `rewriteHooksCommandTree` walks every event key.
- Requests to `claude-4-5-sonnet` don't include unsupported `effort` → Task 5.
- Model that doesn't support a param → CodeMie omits it before sending → Task 5 (effort), consistent with existing thinking/sampling handling.
- Works without admin rights (custom install prefix) → absolute-path resolution via `getCommandPath`/`process.argv[1]` is prefix-agnostic (Tasks 1–4).
- Regression validation → Task 6 + sdlc-light Stages 5–6.

**Placeholder scan:** none — every code step is concrete.

**Type consistency:** `resolveCodemieBinary`/`resolveHookCommand`/`rewriteHooksCommandTree` names and signatures are identical across Tasks 1–4; `handleUnsupportedEffort` matches its call site in Task 5.

**Scope note:** Two independent subsystems (hook path resolution, proxy effort stripping) share one ticket by the user's explicit choice. Tasks 1–4 vs Task 5 are independent and independently reviewable.
