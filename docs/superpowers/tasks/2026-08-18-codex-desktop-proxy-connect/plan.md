# Codex Desktop Proxy Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--codex-desktop` target to `codemie proxy connect` that points the Codex desktop app at CodeMie models by splicing a managed provider block into `~/.codex/config.toml`, plus a `codemie proxy disconnect` counterpart that removes it.

**Architecture:** A pure zero-IO string module owns the TOML splice/strip logic so it can be tested exhaustively. A connector module wraps it with path resolution, app detection, model discovery, backup and atomic write. The existing connect orchestrator gains one target flag, a third daemon client type, and one per-target runner; a new disconnect orchestrator reverses the write using marker state written ahead of the config.

**Tech Stack:** TypeScript ESM (Node >= 20), Commander 11, `@iarna/toml` 2.2 (validation only — never used to re-stringify the user's file), Vitest 4.1, chalk 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/cli/commands/proxy/connectors/codex-config-toml.ts` | **Create.** Pure functions over strings. No fs, no net, no logging. Owns marker sentinels, region discovery, splice, strip, displaced-key comment/restore. |
| `src/cli/commands/proxy/connectors/codex-desktop.ts` | **Create.** Path + app resolution, model discovery through the proxy, backup policy, marker state, atomic write. All external paths injectable for tests. |
| `src/cli/commands/proxy/connectors/vscode.ts` | **Modify.** Export `writeAtomically` (already exported — verify only). |
| `src/cli/commands/proxy/connect-orchestrator.ts` | **Modify.** `ConnectTargets.codexDesktop`, third `EffectiveClientType`, `deriveDaemonIdentity` priority, `hasAnyTarget`, `describeTargets`, `TARGET_LIST`, `runCodexDesktop`, dispatch line. |
| `src/cli/commands/proxy/disconnect-orchestrator.ts` | **Create.** `disconnectTargets` — marker-driven surgical removal with backup fallback. |
| `src/cli/commands/proxy/index.ts` | **Modify.** `--codex-desktop` + `--model` options on connect; new `disconnect` subcommand. |
| `src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts` | **Create.** The heaviest suite — pure, no IO. |
| `src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts` | **Create.** Writer behaviour over `TempWorkspace`. |
| `src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts` | **Create.** Disconnect paths. |
| `src/cli/commands/proxy/__tests__/connect-wiring.test.ts` | **Modify.** New flag + disconnect surface. |
| `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` | **Modify.** Identity priority. |
| `docs/COMMANDS.md` | **Modify.** Document the target and the disconnect command. |

---

## Task 1: TOML marker sentinels and region discovery

**Files:**
- Create: `src/cli/commands/proxy/connectors/codex-config-toml.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts`

**Test-first: yes — `findManagedRegions` returns `{ header: null, table: null }` for a file with no sentinels, and character ranges for both regions when they are present.**

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Pure TOML splice helpers for the Codex desktop connector.
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import {
  HEADER_OPEN,
  HEADER_CLOSE,
  TABLE_OPEN,
  TABLE_CLOSE,
  findManagedRegions,
} from '../codex-config-toml.js';

describe('findManagedRegions', () => {
  it('returns null ranges for a file with no managed sentinels', () => {
    const text = 'model = "gpt-5"\n\n[history]\npersistence = "none"\n';
    expect(findManagedRegions(text)).toEqual({ header: null, table: null });
  });

  it('returns character ranges for both regions when present', () => {
    const text = [
      HEADER_OPEN,
      'model_provider = "codemie"',
      HEADER_CLOSE,
      '',
      '[history]',
      'persistence = "none"',
      '',
      TABLE_OPEN,
      '[model_providers.codemie]',
      TABLE_CLOSE,
      '',
    ].join('\n');

    const regions = findManagedRegions(text);

    expect(regions.header).not.toBeNull();
    expect(regions.table).not.toBeNull();
    expect(text.slice(regions.header!.start, regions.header!.end)).toContain('model_provider = "codemie"');
    expect(text.slice(regions.table!.start, regions.table!.end)).toContain('[model_providers.codemie]');
  });

  it('treats a region whose close sentinel is missing as absent', () => {
    const text = `${HEADER_OPEN}\nmodel_provider = "codemie"\n`;
    expect(findManagedRegions(text).header).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts`
Expected: FAIL — `Failed to resolve import "../codex-config-toml.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Pure string surgery for the CodeMie-managed regions of `~/.codex/config.toml`.
 *
 * Nothing here touches the filesystem, the network, or the logger. The Codex
 * config file is user-owned, so the managed content is spliced in as delimited
 * text rather than round-tripped through a TOML serializer: `@iarna/toml`'s
 * `stringify` discards comments and key order, which would silently rewrite the
 * user's file on every connect.
 *
 * TOML permits bare top-level keys only *before* the first table header, so the
 * managed content cannot be one contiguous block. It is two regions: a header
 * region prepended to the file (holding `model_provider` and `model`) and a
 * table region appended to it (holding `[model_providers.codemie]`).
 */

export const HEADER_OPEN = '# >>> codemie proxy connect (codex-desktop) header - managed block, do not edit';
export const HEADER_CLOSE = '# <<< codemie proxy connect (codex-desktop) header';
export const TABLE_OPEN = '# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit';
export const TABLE_CLOSE = '# <<< codemie proxy connect (codex-desktop) provider';

/** A half-open character range `[start, end)` covering a managed region. */
export interface Region {
  start: number;
  end: number;
}

export interface ManagedRegions {
  header: Region | null;
  table: Region | null;
}

function locate(text: string, open: string, close: string): Region | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  const closeAt = text.indexOf(close, start + open.length);
  if (closeAt === -1) return null;
  return { start, end: closeAt + close.length };
}

/**
 * Locate both managed regions. A region whose close sentinel is missing is
 * reported as absent rather than guessed at — a truncated block is treated as
 * unmanaged text so the writer never deletes content it cannot delimit.
 */
export function findManagedRegions(text: string): ManagedRegions {
  return {
    header: locate(text, HEADER_OPEN, HEADER_CLOSE),
    table: locate(text, TABLE_OPEN, TABLE_CLOSE),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/codex-config-toml.ts src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts
git commit -m "feat(proxy): add managed-region discovery for Codex config.toml"
```

---

## Task 2: Displaced-key commenting and restoration

**Files:**
- Modify: `src/cli/commands/proxy/connectors/codex-config-toml.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts`

An unmanaged top-level `model_provider` or `model` left in place would collide with the managed header region and make the file unparseable. Each such line is rewritten in place as a comment carrying a recognizable prefix, so the original text survives verbatim and can be restored exactly.

**Test-first: yes — `commentDisplacedKeys` turns `model = "gpt-5"` into a prefixed comment while leaving keys inside `[tables]` and already-commented lines untouched; `restoreDisplacedKeys` is its exact inverse.**

- [ ] **Step 1: Write the failing test**

```ts
import { commentDisplacedKeys, restoreDisplacedKeys, DISPLACED_PREFIX } from '../codex-config-toml.js';

describe('displaced keys', () => {
  it('comments out unmanaged top-level model and model_provider keys', () => {
    const text = 'model = "gpt-5"\nmodel_provider = "mine"\n\n[history]\npersistence = "none"\n';

    const out = commentDisplacedKeys(text);

    expect(out).toContain(`${DISPLACED_PREFIX}model = "gpt-5"`);
    expect(out).toContain(`${DISPLACED_PREFIX}model_provider = "mine"`);
    expect(out).toContain('persistence = "none"');
  });

  it('leaves same-named keys inside a table untouched', () => {
    const text = '[profiles.work]\nmodel = "gpt-5"\n';
    expect(commentDisplacedKeys(text)).toBe(text);
  });

  it('is idempotent — already-displaced lines are not double-commented', () => {
    const once = commentDisplacedKeys('model = "gpt-5"\n');
    expect(commentDisplacedKeys(once)).toBe(once);
  });

  it('restoreDisplacedKeys is the exact inverse', () => {
    const original = 'model = "gpt-5"\nmodel_provider = "mine"\n\n[history]\npersistence = "none"\n';
    expect(restoreDisplacedKeys(commentDisplacedKeys(original))).toBe(original);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts -t 'displaced keys'`
Expected: FAIL — `commentDisplacedKeys is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `codex-config-toml.ts`:

```ts
/** Marks a user key the connector commented out so it can be restored verbatim. */
export const DISPLACED_PREFIX = '#codemie-displaced# ';

/** Top-level keys the managed header region owns and therefore must displace. */
const DISPLACED_KEYS = ['model', 'model_provider'];

const DISPLACED_KEY_PATTERN = new RegExp(`^\\s*(?:${DISPLACED_KEYS.join('|')})\\s*=`);

/**
 * True once the scan has passed the first table header. TOML bare keys after
 * that point belong to that table, not to the document root, so they are none
 * of our business.
 */
function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

/**
 * Comment out unmanaged root-level `model` / `model_provider` assignments.
 * Idempotent: a line already carrying `DISPLACED_PREFIX` is left alone.
 */
export function commentDisplacedKeys(text: string): string {
  const lines = text.split('\n');
  let inRootScope = true;

  const out = lines.map((line) => {
    if (isTableHeader(line)) {
      inRootScope = false;
      return line;
    }
    if (!inRootScope) return line;
    if (line.startsWith(DISPLACED_PREFIX)) return line;
    if (!DISPLACED_KEY_PATTERN.test(line)) return line;
    return `${DISPLACED_PREFIX}${line}`;
  });

  return out.join('\n');
}

/** Exact inverse of `commentDisplacedKeys`. */
export function restoreDisplacedKeys(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.startsWith(DISPLACED_PREFIX) ? line.slice(DISPLACED_PREFIX.length) : line))
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/codex-config-toml.ts src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts
git commit -m "feat(proxy): comment and restore displaced Codex top-level keys"
```

---

## Task 3: Splice and strip the managed regions

**Files:**
- Modify: `src/cli/commands/proxy/connectors/codex-config-toml.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts`

**Test-first: yes — `spliceManagedBlocks` prepends the header and appends the table while preserving every other byte including comments; splicing twice equals splicing once; and `stripManagedRegions(spliceManagedBlocks(x, b)) === x` for inputs with and without pre-existing tables.**

- [ ] **Step 1: Write the failing test**

```ts
import { spliceManagedBlocks, stripManagedRegions } from '../codex-config-toml.js';

const BLOCKS = {
  header: 'model_provider = "codemie"\nmodel = "gpt-5-codex"',
  table: '[model_providers.codemie]\nname = "CodeMie"\nbase_url = "http://127.0.0.1:4001/v1"\nwire_api = "responses"',
};

describe('spliceManagedBlocks', () => {
  it('preserves the user comments and key order outside the managed regions', () => {
    const original = '# my notes\nsandbox_mode = "workspace-write"\n\n[history]\n# keep this\npersistence = "none"\n';

    const out = spliceManagedBlocks(original, BLOCKS);

    expect(out).toContain('# my notes');
    expect(out).toContain('# keep this');
    expect(out).toContain('sandbox_mode = "workspace-write"');
    expect(out.indexOf('model_provider = "codemie"')).toBeLessThan(out.indexOf('[history]'));
    expect(out.indexOf('[model_providers.codemie]')).toBeGreaterThan(out.indexOf('[history]'));
  });

  it('is idempotent — splicing twice equals splicing once', () => {
    const original = 'sandbox_mode = "workspace-write"\n\n[history]\npersistence = "none"\n';
    const once = spliceManagedBlocks(original, BLOCKS);
    expect(spliceManagedBlocks(once, BLOCKS)).toBe(once);
  });

  it('round-trips: strip(splice(x)) === x when x has tables', () => {
    const original = '# notes\nsandbox_mode = "workspace-write"\n\n[history]\npersistence = "none"\n';
    expect(stripManagedRegions(spliceManagedBlocks(original, BLOCKS))).toBe(original);
  });

  it('round-trips: strip(splice(x)) === x when x is empty', () => {
    expect(stripManagedRegions(spliceManagedBlocks('', BLOCKS))).toBe('');
  });

  it('round-trips: strip(splice(x)) === x when x has displaced keys', () => {
    const original = 'model = "gpt-5"\n\n[history]\npersistence = "none"\n';
    expect(stripManagedRegions(spliceManagedBlocks(original, BLOCKS))).toBe(original);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts -t 'spliceManagedBlocks'`
Expected: FAIL — `spliceManagedBlocks is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `codex-config-toml.ts`:

```ts
export interface ManagedBlocks {
  /** Body of the header region — bare top-level keys, no sentinels. */
  header: string;
  /** Body of the table region — the `[model_providers.codemie]` table. */
  table: string;
}

function cutRegions(text: string): string {
  // Remove the table region before the header region: both are located by index,
  // and removing the earlier one first would invalidate the later one's offsets.
  const regions = findManagedRegions(text);
  let out = text;
  for (const region of [regions.table, regions.header].filter((r): r is Region => r !== null)) {
    const before = out.slice(0, region.start);
    const after = out.slice(region.end);
    // A managed region always owns the newline that terminates it, plus the
    // blank separator line the writer added, so the surrounding text closes up
    // exactly as it was before the region was inserted.
    out = before + after.replace(/^\n\n/, '');
  }
  return out;
}

/**
 * Insert both managed regions, replacing any that already exist. The header is
 * prepended (TOML bare keys must precede the first table header) and the table
 * is appended. Every byte outside the two regions is preserved.
 */
export function spliceManagedBlocks(text: string, blocks: ManagedBlocks): string {
  const base = commentDisplacedKeys(cutRegions(text));

  const header = `${HEADER_OPEN}\n${blocks.header}\n${HEADER_CLOSE}\n\n`;
  const table = `\n\n${TABLE_OPEN}\n${blocks.table}\n${TABLE_CLOSE}\n`;

  // Normalize the seam so a file that already ends in a newline does not gain a
  // second one, and a file that does not gains exactly one.
  const body = base.endsWith('\n') ? base.slice(0, -1) : base;

  return `${header}${body}${table}`;
}

/**
 * Remove both managed regions and restore any keys the splice displaced,
 * yielding the text the file held before `spliceManagedBlocks` ran.
 */
export function stripManagedRegions(text: string): string {
  const withoutRegions = cutRegions(text);
  const restored = restoreDisplacedKeys(withoutRegions);
  return restored.endsWith('\n') || restored === '' ? restored : `${restored}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts`
Expected: PASS — 12 tests. If a round-trip test fails on trailing-newline handling, adjust the seam normalization in `spliceManagedBlocks`/`stripManagedRegions` until the property holds; the property is the specification, not the implementation.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/codex-config-toml.ts src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts
git commit -m "feat(proxy): splice and strip managed Codex config regions"
```

---

## Task 4: Build the managed block bodies

**Files:**
- Modify: `src/cli/commands/proxy/connectors/codex-config-toml.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts`

**Test-first: yes — `buildManagedBlocks` emits `wire_api = "responses"`, the bearer header, and a TOML-escaped base URL, and the spliced output parses cleanly under `@iarna/toml`.**

- [ ] **Step 1: Write the failing test**

```ts
import TOML from '@iarna/toml';
import { buildManagedBlocks, spliceManagedBlocks } from '../codex-config-toml.js';

describe('buildManagedBlocks', () => {
  it('emits the responses wire API, the bearer header and the pinned model', () => {
    const blocks = buildManagedBlocks({
      baseUrl: 'http://127.0.0.1:4001/v1',
      gatewayKey: 'codemie-proxy',
      model: 'gpt-5-codex',
    });

    expect(blocks.header).toContain('model_provider = "codemie"');
    expect(blocks.header).toContain('model = "gpt-5-codex"');
    expect(blocks.table).toContain('wire_api = "responses"');
    expect(blocks.table).toContain('base_url = "http://127.0.0.1:4001/v1"');
    expect(blocks.table).toContain('Authorization = "Bearer codemie-proxy"');
  });

  it('produces a file that parses as valid TOML', () => {
    const blocks = buildManagedBlocks({
      baseUrl: 'http://127.0.0.1:4001/v1',
      gatewayKey: 'codemie-proxy',
      model: 'gpt-5-codex',
    });
    const spliced = spliceManagedBlocks('model = "gpt-5"\n\n[history]\npersistence = "none"\n', blocks);

    const parsed = TOML.parse(spliced) as Record<string, unknown>;

    expect(parsed.model_provider).toBe('codemie');
    expect(parsed.model).toBe('gpt-5-codex');
    expect(parsed.history).toEqual({ persistence: 'none' });
  });

  it('escapes quotes and backslashes in values', () => {
    const blocks = buildManagedBlocks({
      baseUrl: 'http://h/v1?q="x"\\y',
      gatewayKey: 'k"1',
      model: 'm',
    });
    expect(() => TOML.parse(spliceManagedBlocks('', blocks))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts -t 'buildManagedBlocks'`
Expected: FAIL — `buildManagedBlocks is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `codex-config-toml.ts`:

```ts
/** The provider id CodeMie owns in the user's Codex config. */
export const CODEMIE_PROVIDER_ID = 'codemie';

export interface ManagedBlockInput {
  baseUrl: string;
  gatewayKey: string;
  model: string;
}

/** Escape a value for a TOML basic string. */
function toTomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Render the two managed region bodies.
 *
 * `wire_api` is always `responses`: Codex removed the `chat` wire API in
 * February 2026, so a custom provider that declares anything else fails at
 * startup. The gateway key travels as a static `http_headers` entry rather than
 * an `env_key`, because a desktop app does not inherit the shell environment,
 * and never via `~/.codex/auth.json`, because writing there flips the app into
 * API-key auth mode and disables its ChatGPT-account features.
 */
export function buildManagedBlocks(input: ManagedBlockInput): ManagedBlocks {
  const header = [
    `model_provider = ${toTomlString(CODEMIE_PROVIDER_ID)}`,
    `model = ${toTomlString(input.model)}`,
  ].join('\n');

  const table = [
    `[model_providers.${CODEMIE_PROVIDER_ID}]`,
    `name = ${toTomlString('CodeMie')}`,
    `base_url = ${toTomlString(input.baseUrl)}`,
    'wire_api = "responses"',
    `[model_providers.${CODEMIE_PROVIDER_ID}.http_headers]`,
    `Authorization = ${toTomlString(`Bearer ${input.gatewayKey}`)}`,
  ].join('\n');

  return { header, table };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/codex-config-toml.ts src/cli/commands/proxy/connectors/__tests__/codex-config-toml.test.ts
git commit -m "feat(proxy): render the CodeMie Codex provider block"
```

---

## Task 5: Config path resolution and app detection

**Files:**
- Create: `src/cli/commands/proxy/connectors/codex-desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`

**Test-first: yes — `getCodexDesktopConfigPath` honours `CODEX_HOME` and otherwise resolves `<home>/.codex/config.toml`, and `findCodexDesktopApp` returns null when none of its candidate paths exist.**

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Codex desktop connector — path resolution, app detection and config writing.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { TempWorkspace } from '../../../../../../tests/helpers/temp-workspace.js';

describe('getCodexDesktopConfigPath', () => {
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    vi.resetModules();
  });

  it('honours a user-set CODEX_HOME', async () => {
    process.env.CODEX_HOME = '/tmp/custom-codex';
    const { getCodexDesktopConfigPath } = await import('../codex-desktop.js');
    expect(getCodexDesktopConfigPath()).toBe(join('/tmp/custom-codex', 'config.toml'));
  });

  it('falls back to <home>/.codex/config.toml', async () => {
    delete process.env.CODEX_HOME;
    const { homedir } = await import('os');
    const { getCodexDesktopConfigPath } = await import('../codex-desktop.js');
    expect(getCodexDesktopConfigPath()).toBe(join(homedir(), '.codex', 'config.toml'));
  });
});

describe('findCodexDesktopApp', () => {
  let workspace: TempWorkspace;

  beforeEach(() => { workspace = new TempWorkspace('codemie-codex-app-'); });
  afterEach(() => { workspace.cleanup(); vi.resetModules(); });

  it('returns null when no candidate path exists', async () => {
    const { findCodexDesktopApp } = await import('../codex-desktop.js');
    expect(findCodexDesktopApp([join(workspace.path, 'missing.app')])).toBeNull();
  });

  it('returns the first candidate that exists', async () => {
    const present = workspace.writeFile('ChatGPT.app/Contents/Info.plist', '<plist/>');
    const appDir = join(workspace.path, 'ChatGPT.app');
    const { findCodexDesktopApp } = await import('../codex-desktop.js');
    expect(findCodexDesktopApp([join(workspace.path, 'missing.app'), appDir])).toBe(appDir);
    expect(present).toContain('Info.plist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`
Expected: FAIL — `Failed to resolve import "../codex-desktop.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Connector that points the Codex desktop app (Codex inside the ChatGPT desktop
 * app) at the local CodeMie proxy by splicing a managed provider block into the
 * user's `~/.codex/config.toml`.
 *
 * CodeMie never installs, launches or patches the app — the shared config file
 * is the whole integration seam.
 */
import { existsSync } from 'fs';
import { copyFile, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import TOML from '@iarna/toml';

import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { getCodemiePath } from '@/utils/paths.js';

import { writeAtomically } from './vscode.js';
import {
  buildManagedBlocks,
  findManagedRegions,
  spliceManagedBlocks,
  stripManagedRegions,
  CODEMIE_PROVIDER_ID,
} from './codex-config-toml.js';

/**
 * Resolve the config file the desktop app reads.
 *
 * Deliberately NOT `getCodexHomePath()` from the codex agent plugin: that helper
 * is used by code paths that redirect `CODEX_HOME` to a CodeMie-isolated home
 * for the spawned CLI, which the desktop app never reads. A `CODEX_HOME` visible
 * here belongs to the user, and upstream documents the app respecting it.
 */
export function getCodexDesktopConfigPath(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'config.toml');
}

/** Where the connector records what it owns, mirroring the Claude Desktop precedent. */
export function getCodexDesktopStatePath(): string {
  return getCodemiePath('proxy', 'codex-desktop-state.json');
}

/** Install locations for the ChatGPT desktop app, which is what ships Codex. */
export function getCodexDesktopAppCandidates(): string[] {
  const home = homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/ChatGPT.app',
      join(home, 'Applications', 'ChatGPT.app'),
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      join(localAppData, 'Programs', 'ChatGPT'),
      join(programFiles, 'ChatGPT'),
    ];
  }
  return [];
}

/** First candidate path that exists, or null. */
export function findCodexDesktopApp(
  candidates: string[] = getCodexDesktopAppCandidates()
): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`
Expected: PASS — 4 tests. If `TempWorkspace` has no `cleanup()` method, use the disposal method it does expose (check `tests/helpers/temp-workspace.ts`) and keep it in `afterEach`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/codex-desktop.ts src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts
git commit -m "feat(proxy): resolve Codex desktop config path and app location"
```

---

## Task 6: Backup policy keyed on marker presence

**Files:**
- Modify: `src/cli/commands/proxy/connectors/codex-desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`

The Kimi injector backs up only when no backup exists, so a second connect leaves a stale backup that restores an ancient config. This keys the decision on whether *our marker* is already in the file instead.

**Test-first: yes — `backupIfUnmanaged` writes a backup when the config has no managed region, and leaves an existing backup untouched when it does.**

- [ ] **Step 1: Write the failing test**

```ts
describe('backupIfUnmanaged', () => {
  let workspace: TempWorkspace;

  beforeEach(() => { workspace = new TempWorkspace('codemie-codex-backup-'); });
  afterEach(() => { workspace.cleanup(); vi.resetModules(); });

  it('backs up a config that carries no managed region', async () => {
    const configPath = workspace.writeFile('config.toml', 'model = "gpt-5"\n');
    const { backupIfUnmanaged } = await import('../codex-desktop.js');

    const backupPath = await backupIfUnmanaged(configPath, 'model = "gpt-5"\n');

    expect(backupPath).toBe(`${configPath}.codemie-backup`);
    expect(workspace.readFile('config.toml.codemie-backup')).toBe('model = "gpt-5"\n');
  });

  it('does not overwrite the backup when the config is already managed', async () => {
    const { HEADER_OPEN, HEADER_CLOSE } = await import('../codex-config-toml.js');
    const managed = `${HEADER_OPEN}\nmodel_provider = "codemie"\n${HEADER_CLOSE}\n`;
    const configPath = workspace.writeFile('config.toml', managed);
    workspace.writeFile('config.toml.codemie-backup', 'ORIGINAL\n');
    const { backupIfUnmanaged } = await import('../codex-desktop.js');

    await backupIfUnmanaged(configPath, managed);

    expect(workspace.readFile('config.toml.codemie-backup')).toBe('ORIGINAL\n');
  });

  it('returns null when there is no config file to back up', async () => {
    const { backupIfUnmanaged } = await import('../codex-desktop.js');
    expect(await backupIfUnmanaged(join(workspace.path, 'absent.toml'), '')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts -t 'backupIfUnmanaged'`
Expected: FAIL — `backupIfUnmanaged is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `codex-desktop.ts`:

```ts
/** Suffix for the pre-connect snapshot of the user's Codex config. */
export const BACKUP_SUFFIX = '.codemie-backup';

/**
 * Snapshot the config only when CodeMie does not already own part of it.
 *
 * Keying on marker presence rather than backup presence is deliberate: once our
 * block is in the file, the existing backup is the true pre-CodeMie original and
 * must not be replaced by a copy that already contains our block.
 */
export async function backupIfUnmanaged(
  configPath: string,
  currentText: string
): Promise<string | null> {
  if (!existsSync(configPath)) return null;

  const backupPath = `${configPath}${BACKUP_SUFFIX}`;
  const regions = findManagedRegions(currentText);
  const alreadyManaged = regions.header !== null || regions.table !== null;

  if (alreadyManaged && existsSync(backupPath)) {
    logger.debug('[proxy] Codex config already managed; keeping existing backup', { backupPath });
    return backupPath;
  }

  await copyFile(configPath, backupPath);
  logger.debug('[proxy] Backed up Codex config', { configPath, backupPath });
  return backupPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/codex-desktop.ts src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts
git commit -m "feat(proxy): back up Codex config keyed on marker presence"
```

---

## Task 7: Model discovery through the local proxy

**Files:**
- Modify: `src/cli/commands/proxy/connectors/codex-desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`

`desktop.ts`'s selectors are `^claude-` bound and stay untouched. `codex-models.ts` already owns GPT/Codex compatibility via `isCodexCompatibleModelName`; reuse it, but source the candidates from the local proxy the way every other connector does.

**Test-first: yes — `discoverCodexModels` calls `/v1/llm_models?include_all=true` with the bearer gateway key, keeps only Codex-compatible ids, and throws `ConfigurationError` when none survive.**

- [ ] **Step 1: Write the failing test**

```ts
describe('discoverCodexModels', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('requests the gateway model list with the bearer key and keeps Codex-compatible ids', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [
        { deployment_name: 'gpt-5-codex', enabled: true },
        { deployment_name: 'claude-sonnet-4-6', enabled: true },
        { deployment_name: 'text-embedding-3-large', enabled: true },
      ],
    } as unknown as Response);

    const { discoverCodexModels } = await import('../codex-desktop.js');
    const models = await discoverCodexModels('http://127.0.0.1:4001', 'codemie-proxy');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/v1/llm_models?include_all=true');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer codemie-proxy' });
    expect(models).toContain('gpt-5-codex');
    expect(models).not.toContain('claude-sonnet-4-6');
    expect(models).not.toContain('text-embedding-3-large');
  });

  it('throws ConfigurationError when the proxy exposes no compatible model', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ deployment_name: 'claude-sonnet-4-6', enabled: true }],
    } as unknown as Response);

    const { discoverCodexModels } = await import('../codex-desktop.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    await expect(discoverCodexModels('http://127.0.0.1:4001', 'k')).rejects.toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when the proxy returns a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 502 } as unknown as Response);

    const { discoverCodexModels } = await import('../codex-desktop.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    await expect(discoverCodexModels('http://127.0.0.1:4001', 'k')).rejects.toThrow(ConfigurationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts -t 'discoverCodexModels'`
Expected: FAIL — `discoverCodexModels is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the import and function to `codex-desktop.ts`:

```ts
import { isCodexCompatibleModelName } from '@/agents/plugins/codex/codex-models.js';

/** Shape of the entries the gateway model list returns that this connector reads. */
interface GatewayModelEntry {
  deployment_name?: string;
  base_name?: string;
  enabled?: boolean;
}

/**
 * Discover Codex-compatible model ids through the local proxy.
 *
 * Model discovery goes through the proxy rather than the backend so the
 * connector exercises exactly the path the app will use, and so a broken proxy
 * fails here rather than after the config is written.
 */
export async function discoverCodexModels(
  proxyUrl: string,
  gatewayKey: string
): Promise<string[]> {
  const url = new URL('/v1/llm_models?include_all=true', proxyUrl).toString();

  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${gatewayKey}` } });
  } catch (error) {
    throw new ConfigurationError(
      `Could not reach the local proxy at ${proxyUrl} to list models: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    throw new ConfigurationError(
      `Local proxy returned ${response.status} for ${url}.`
    );
  }

  const payload = (await response.json()) as GatewayModelEntry[] | { data?: GatewayModelEntry[] };
  const entries = Array.isArray(payload) ? payload : (payload.data ?? []);

  const ids = entries
    .filter((entry) => entry.enabled !== false)
    .map((entry) => entry.deployment_name ?? entry.base_name)
    .filter(isCodexCompatibleModelName);

  if (ids.length === 0) {
    throw new ConfigurationError(
      'The local proxy exposes no GPT/Codex-compatible model. ' +
      'Enable a GPT-5/Codex deployment in CodeMie, then re-run this command.'
    );
  }

  return ids;
}

/**
 * Choose the model to pin. An explicit request must exist in the discovered set —
 * silently substituting a different model would mean the user runs something
 * other than what they asked for.
 */
export function selectCodexModel(discovered: string[], requested?: string): string {
  if (!requested) return discovered[0];
  if (discovered.includes(requested)) return requested;
  throw new ConfigurationError(
    `Model "${requested}" is not available through the proxy. Available: ${discovered.join(', ')}`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/codex-desktop.ts src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts
git commit -m "feat(proxy): discover Codex-compatible models via the local proxy"
```

---

## Task 8: The connector write path

**Files:**
- Modify: `src/cli/commands/proxy/connectors/codex-desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`

**Test-first: yes — `writeCodexDesktopConfig` validates then splices and writes atomically, records marker state before the config write, rejects malformed TOML without touching the file, and rejects a foreign `model_provider` unless forced.**

- [ ] **Step 1: Write the failing test**

```ts
describe('writeCodexDesktopConfig', () => {
  let workspace: TempWorkspace;

  beforeEach(() => { workspace = new TempWorkspace('codemie-codex-write-'); });
  afterEach(() => { workspace.cleanup(); vi.restoreAllMocks(); vi.resetModules(); });

  const opts = (configPath: string, statePath: string, extra: Record<string, unknown> = {}) => ({
    configPath,
    statePath,
    proxyUrl: 'http://127.0.0.1:4001',
    baseUrl: 'http://127.0.0.1:4001/v1',
    gatewayKey: 'codemie-proxy',
    model: 'gpt-5-codex',
    ...extra,
  });

  it('splices the managed block and preserves unrelated keys and comments', async () => {
    const configPath = workspace.writeFile('config.toml', '# keep me\nsandbox_mode = "workspace-write"\n\n[history]\npersistence = "none"\n');
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig(opts(configPath, statePath));

    const written = workspace.readFile('config.toml');
    expect(written).toContain('# keep me');
    expect(written).toContain('persistence = "none"');
    expect(written).toContain('model_providers.codemie');
    expect(written).toContain('wire_api = "responses"');
  });

  it('writes marker state before the config so ownership is never lost', async () => {
    const configPath = workspace.writeFile('config.toml', 'model = "gpt-5"\n');
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig(opts(configPath, statePath));

    const state = JSON.parse(workspace.readFile('state.json'));
    expect(state).toMatchObject({ configPath, model: 'gpt-5-codex' });
    expect(state.backupPath).toBe(`${configPath}${'.codemie-backup'}`);
  });

  it('creates the config when none exists', async () => {
    const configPath = join(workspace.path, 'fresh', 'config.toml');
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig(opts(configPath, statePath));

    expect(workspace.readFile('fresh/config.toml')).toContain('model_provider = "codemie"');
  });

  it('rejects malformed TOML and leaves the file untouched', async () => {
    const malformed = 'this is [not = toml\n';
    const configPath = workspace.writeFile('config.toml', malformed);
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    await expect(writeCodexDesktopConfig(opts(configPath, statePath))).rejects.toThrow(ConfigurationError);
    expect(workspace.readFile('config.toml')).toBe(malformed);
  });

  it('refuses a foreign model_provider unless forced', async () => {
    const existing = 'model_provider = "someone-else"\n\n[model_providers.someone-else]\nbase_url = "http://x/v1"\n';
    const configPath = workspace.writeFile('config.toml', existing);
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    await expect(writeCodexDesktopConfig(opts(configPath, statePath))).rejects.toThrow(/someone-else/);
    expect(workspace.readFile('config.toml')).toBe(existing);

    await expect(
      writeCodexDesktopConfig(opts(configPath, statePath, { force: true }))
    ).resolves.toBeDefined();
    void ConfigurationError;
  });

  it('is idempotent — a second write does not duplicate the managed block', async () => {
    const configPath = workspace.writeFile('config.toml', 'sandbox_mode = "workspace-write"\n');
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig(opts(configPath, statePath));
    const first = workspace.readFile('config.toml');
    await writeCodexDesktopConfig(opts(configPath, statePath));

    expect(workspace.readFile('config.toml')).toBe(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts -t 'writeCodexDesktopConfig'`
Expected: FAIL — `writeCodexDesktopConfig is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `codex-desktop.ts`:

```ts
export interface CodexDesktopState {
  configPath: string;
  backupPath: string | null;
  model: string;
  writtenAt: string;
}

export interface WriteCodexDesktopConfigOptions {
  configPath: string;
  statePath: string;
  proxyUrl: string;
  baseUrl: string;
  gatewayKey: string;
  model: string;
  force?: boolean;
}

/** Read the config, or empty text when the file does not exist yet. */
async function readConfigText(configPath: string): Promise<string> {
  if (!existsSync(configPath)) return '';
  return readFile(configPath, 'utf-8');
}

/**
 * Reject a config whose active provider is somebody else's. Overwriting it would
 * silently take a user's deliberate provider choice away from them.
 */
function assertNoForeignProvider(text: string, force: boolean): void {
  if (force || text.trim() === '') return;

  let parsed: Record<string, unknown>;
  try {
    parsed = TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigurationError(
      `Codex config is not valid TOML and was not changed: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  const active = parsed.model_provider;
  if (typeof active === 'string' && active !== CODEMIE_PROVIDER_ID) {
    throw new ConfigurationError(
      `Codex config already selects model_provider "${active}". ` +
      `Re-run with --force to replace it with the CodeMie provider.`
    );
  }
}

/**
 * Splice the managed block into the user's Codex config and record ownership.
 *
 * The marker state is written BEFORE the config on purpose. If the config write
 * then fails, the marker over-claims — and disconnect's removal is idempotent,
 * so that is harmless. The reverse order is genuinely unsafe: a written config
 * with no marker is one CodeMie can no longer recognize as its own.
 */
export async function writeCodexDesktopConfig(
  options: WriteCodexDesktopConfigOptions
): Promise<CodexDesktopState> {
  const currentText = await readConfigText(options.configPath);

  // Validate before touching anything. A malformed file fails here, unwritten.
  if (currentText.trim() !== '') {
    try {
      TOML.parse(currentText);
    } catch (error) {
      throw new ConfigurationError(
        `Codex config at ${options.configPath} is not valid TOML and was not changed: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  assertNoForeignProvider(currentText, Boolean(options.force));

  const backupPath = await backupIfUnmanaged(options.configPath, currentText);

  const state: CodexDesktopState = {
    configPath: options.configPath,
    backupPath,
    model: options.model,
    writtenAt: new Date().toISOString(),
  };
  await writeAtomically(options.statePath, `${JSON.stringify(state, null, 2)}\n`);

  const blocks = buildManagedBlocks({
    baseUrl: options.baseUrl,
    gatewayKey: options.gatewayKey,
    model: options.model,
  });
  await writeAtomically(options.configPath, spliceManagedBlocks(currentText, blocks));

  logger.info(
    '[proxy] Codex desktop configuration written',
    ...sanitizeLogArgs({
      configPath: options.configPath,
      backupPath,
      model: options.model,
      baseUrl: options.baseUrl,
      gatewayKey: options.gatewayKey,
    })
  );

  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/codex-desktop.ts src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts
git commit -m "feat(proxy): write the Codex desktop provider config atomically"
```

---

## Task 9: The connector removal path

**Files:**
- Modify: `src/cli/commands/proxy/connectors/codex-desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`

**Test-first: yes — `removeCodexDesktopConfig` strips the managed regions and restores displaced keys so the file matches its pre-connect content, falls back to the backup when the stripped result will not parse, and is a no-op when no marker state exists.**

- [ ] **Step 1: Write the failing test**

```ts
describe('removeCodexDesktopConfig', () => {
  let workspace: TempWorkspace;

  beforeEach(() => { workspace = new TempWorkspace('codemie-codex-remove-'); });
  afterEach(() => { workspace.cleanup(); vi.restoreAllMocks(); vi.resetModules(); });

  it('restores the pre-connect content by stripping the managed regions', async () => {
    const original = '# notes\nmodel = "gpt-5"\n\n[history]\npersistence = "none"\n';
    const configPath = workspace.writeFile('config.toml', original);
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig, removeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig({
      configPath, statePath,
      proxyUrl: 'http://127.0.0.1:4001',
      baseUrl: 'http://127.0.0.1:4001/v1',
      gatewayKey: 'k',
      model: 'gpt-5-codex',
    });
    const result = await removeCodexDesktopConfig(statePath);

    expect(result.removed).toBe(true);
    expect(result.usedBackup).toBe(false);
    expect(workspace.readFile('config.toml')).toBe(original);
  });

  it('reports a clean no-op when no marker state exists', async () => {
    const { removeCodexDesktopConfig } = await import('../codex-desktop.js');
    const result = await removeCodexDesktopConfig(join(workspace.path, 'absent.json'));
    expect(result).toMatchObject({ removed: false, usedBackup: false });
  });

  it('falls back to the backup when the stripped result will not parse', async () => {
    const configPath = workspace.writeFile('config.toml', 'model = "gpt-5"\n');
    workspace.writeFile('config.toml.codemie-backup', 'model = "gpt-5"\n');
    const statePath = workspace.writeFile('state.json', JSON.stringify({
      configPath,
      backupPath: `${configPath}.codemie-backup`,
      model: 'gpt-5-codex',
      writtenAt: new Date().toISOString(),
    }));

    const tomlModule = await import('../codex-config-toml.js');
    vi.spyOn(tomlModule, 'stripManagedRegions').mockReturnValue('broken [ = toml\n');

    const { removeCodexDesktopConfig } = await import('../codex-desktop.js');
    const result = await removeCodexDesktopConfig(statePath);

    expect(result.usedBackup).toBe(true);
    expect(workspace.readFile('config.toml')).toBe('model = "gpt-5"\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts -t 'removeCodexDesktopConfig'`
Expected: FAIL — `removeCodexDesktopConfig is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `codex-desktop.ts`:

```ts
export interface RemoveCodexDesktopResult {
  removed: boolean;
  usedBackup: boolean;
  configPath: string | null;
}

/**
 * Remove the managed block, restoring the file to its pre-connect content.
 *
 * The surgical strip is the primary path rather than a wholesale backup restore:
 * a blind restore would also throw away any edits the user made to their Codex
 * config while connected. The backup is the fallback for when the strip cannot
 * produce a parseable file.
 */
export async function removeCodexDesktopConfig(
  statePath: string = getCodexDesktopStatePath()
): Promise<RemoveCodexDesktopResult> {
  if (!existsSync(statePath)) {
    return { removed: false, usedBackup: false, configPath: null };
  }

  let state: CodexDesktopState;
  try {
    state = JSON.parse(await readFile(statePath, 'utf-8')) as CodexDesktopState;
  } catch (error) {
    throw new ConfigurationError(
      `CodeMie Codex desktop state at ${statePath} is unreadable: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!existsSync(state.configPath)) {
    await writeAtomically(statePath, '');
    return { removed: false, usedBackup: false, configPath: state.configPath };
  }

  const currentText = await readFile(state.configPath, 'utf-8');
  const stripped = stripManagedRegions(currentText);

  let usedBackup = false;
  let nextText = stripped;
  try {
    if (stripped.trim() !== '') TOML.parse(stripped);
  } catch {
    if (!state.backupPath || !existsSync(state.backupPath)) {
      throw new ConfigurationError(
        `Removing the CodeMie block from ${state.configPath} produced invalid TOML ` +
        `and no backup is available to restore.`
      );
    }
    nextText = await readFile(state.backupPath, 'utf-8');
    usedBackup = true;
    logger.warn(
      '[proxy] Surgical removal of the CodeMie Codex block failed; restored the backup',
      ...sanitizeLogArgs({ configPath: state.configPath, backupPath: state.backupPath })
    );
  }

  await writeAtomically(state.configPath, nextText);
  await writeAtomically(statePath, '');

  return { removed: true, usedBackup, configPath: state.configPath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts`
Expected: PASS — 19 tests. If the `stripManagedRegions` spy does not take effect because the connector holds a static import binding, change the assertion to write a config whose stripped form is genuinely unparseable instead of spying.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/codex-desktop.ts src/cli/commands/proxy/connectors/__tests__/codex-desktop.test.ts
git commit -m "feat(proxy): remove the Codex desktop block with backup fallback"
```

---

## Task 10: Orchestrator target plumbing and the third client type

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:47-90`
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:250-263` (`hasAnyTarget`, `describeTargets`, `TARGET_LIST`)
- Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`

**Test-first: yes — `deriveDaemonIdentity({ codexDesktop: true })` yields clientType `codex-desktop` with no telemetry mode, and `claude-desktop` still wins when both targets are requested.**

- [ ] **Step 1: Write the failing test**

Append to `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`:

```ts
describe('deriveDaemonIdentity — codex-desktop', () => {
  it('gives the Codex desktop target its own client type and no telemetry mode', async () => {
    const { deriveDaemonIdentity } = await import('../connect-orchestrator.js');

    expect(deriveDaemonIdentity({ codexDesktop: true })).toEqual({
      clientType: 'codex-desktop',
      spawnOptions: { clientType: 'codex-desktop' },
    });
  });

  it('keeps claude-desktop as the primary identity when combined', async () => {
    const { deriveDaemonIdentity } = await import('../connect-orchestrator.js');

    expect(deriveDaemonIdentity({ claudeDesktop: true, codexDesktop: true }).clientType)
      .toBe('claude-desktop');
  });

  it('prefers codex-desktop over vscode-byok', async () => {
    const { deriveDaemonIdentity } = await import('../connect-orchestrator.js');

    expect(deriveDaemonIdentity({ codexDesktop: true, vscode: true }).clientType)
      .toBe('codex-desktop');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts -t 'codex-desktop'`
Expected: FAIL — the identity comes back as `vscode-byok`.

- [ ] **Step 3: Write minimal implementation**

In `connect-orchestrator.ts`, extend the target interface:

```ts
/** The orthogonal targets a single `connect` invocation may configure. */
export interface ConnectTargets {
  claudeDesktop?: boolean;
  vscode?: boolean;
  vscodeClaudeCode?: boolean;
  codexDesktop?: boolean;
}
```

Add the model override to the options:

```ts
export interface ConnectOptions {
  targets: ConnectTargets;
  profile?: string;
  insiders?: boolean;
  force?: boolean;
  verbose?: boolean;
  /** Pin a specific model for the Codex desktop target. */
  model?: string;
}
```

Widen the client type and identity:

```ts
/** Effective client type used by `daemonMatchesRequest`. */
export type EffectiveClientType = 'claude-desktop' | 'vscode-byok' | 'codex-desktop';

export interface DaemonIdentity {
  clientType: EffectiveClientType;
  spawnOptions:
    | { telemetryMode: 'claude-desktop' }
    | { clientType: 'vscode-byok' }
    | { clientType: 'codex-desktop' };
}

/**
 * Derive the single daemon identity for a target set. The two Anthropic-gateway
 * targets share the `claude-desktop` identity; the Codex desktop app gets its
 * own so `daemonMatchesRequest` never treats a Codex daemon and a VS Code BYOK
 * daemon as interchangeable, and so analytics do not attribute Codex-app traffic
 * to VS Code.
 */
export function deriveDaemonIdentity(targets: ConnectTargets): DaemonIdentity {
  if (targets.claudeDesktop || targets.vscodeClaudeCode) {
    return { clientType: 'claude-desktop', spawnOptions: { telemetryMode: 'claude-desktop' } };
  }
  if (targets.codexDesktop) {
    return { clientType: 'codex-desktop', spawnOptions: { clientType: 'codex-desktop' } };
  }
  return { clientType: 'vscode-byok', spawnOptions: { clientType: 'vscode-byok' } };
}
```

Teach the target helpers about the flag:

```ts
function hasAnyTarget(t: ConnectTargets): boolean {
  return Boolean(t.claudeDesktop || t.vscode || t.vscodeClaudeCode || t.codexDesktop);
}
```

In `describeTargets`, add before the `label` computation:

```ts
  if (t.codexDesktop) { flags.push('--codex-desktop'); labels.push('Codex Desktop'); }
```

In the `TARGET_LIST` string, add after the `--vscode-claude-code` line:

```ts
  '  --codex-desktop        Codex desktop app (writes ~/.codex/config.toml)',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts && npx tsc --noEmit`
Expected: PASS, and `tsc` clean. `DaemonState.clientType` is typed as `string`, so the widened union needs no change there; if `tsc` reports otherwise, widen `SpawnOptions.clientType` in `daemon-manager.ts` to accept `'codex-desktop'`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connect-orchestrator.ts src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts
git commit -m "feat(proxy): add codex-desktop target and daemon identity"
```

---

## Task 11: The `runCodexDesktop` per-target runner

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts` (after `runVscodeClaudeCode`, and the dispatch block in `connectTargets`)
- Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`

**Test-first: yes — `connectTargets` with `{ codexDesktop: true }` returns a failed `TargetResult` rather than throwing when the connector rejects, and reports the app-missing error when detection finds nothing.**

- [ ] **Step 1: Write the failing test**

Append to `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`:

```ts
describe('runCodexDesktop', () => {
  it('surfaces a connector failure as a failed target rather than throwing', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      findCodexDesktopApp: vi.fn().mockReturnValue('/Applications/ChatGPT.app'),
      getCodexDesktopConfigPath: vi.fn().mockReturnValue('/tmp/config.toml'),
      getCodexDesktopStatePath: vi.fn().mockReturnValue('/tmp/state.json'),
      getCodexDesktopAppCandidates: vi.fn().mockReturnValue(['/Applications/ChatGPT.app']),
      discoverCodexModels: vi.fn().mockRejectedValue(new Error('proxy down')),
      selectCodexModel: vi.fn(),
      writeCodexDesktopConfig: vi.fn(),
    }));

    const { runCodexDesktopForTest } = await import('../connect-orchestrator.js');
    const result = await runCodexDesktopForTest(
      { url: 'http://127.0.0.1:4001', gatewayKey: 'k' } as never,
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('proxy down');
  });

  it('fails with an app-not-found message when detection finds nothing', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      findCodexDesktopApp: vi.fn().mockReturnValue(null),
      getCodexDesktopConfigPath: vi.fn().mockReturnValue('/tmp/config.toml'),
      getCodexDesktopStatePath: vi.fn().mockReturnValue('/tmp/state.json'),
      getCodexDesktopAppCandidates: vi.fn().mockReturnValue(['/Applications/ChatGPT.app']),
      discoverCodexModels: vi.fn(),
      selectCodexModel: vi.fn(),
      writeCodexDesktopConfig: vi.fn(),
    }));

    const { runCodexDesktopForTest } = await import('../connect-orchestrator.js');
    const result = await runCodexDesktopForTest(
      { url: 'http://127.0.0.1:4001', gatewayKey: 'k' } as never,
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ChatGPT.app');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts -t 'runCodexDesktop'`
Expected: FAIL — `runCodexDesktopForTest is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `connect-orchestrator.ts`:

```ts
import {
  discoverCodexModels,
  findCodexDesktopApp,
  getCodexDesktopAppCandidates,
  getCodexDesktopConfigPath,
  getCodexDesktopStatePath,
  selectCodexModel,
  writeCodexDesktopConfig,
} from './connectors/codex-desktop.js';
```

Add the runner after `runVscodeClaudeCode`:

```ts
interface CodexDesktopRunOptions {
  force?: boolean;
  model?: string;
  verbose?: boolean;
}

async function runCodexDesktop(
  state: DaemonState,
  options: CodexDesktopRunOptions
): Promise<TargetResult> {
  const label = 'Codex Desktop';
  try {
    const appPath = findCodexDesktopApp();
    if (!appPath && !options.force) {
      throw new ConfigurationError(
        'Could not find the ChatGPT desktop app (which ships Codex). Looked in: ' +
        `${getCodexDesktopAppCandidates().join(', ')}. ` +
        'Install it, or re-run with --force to write the config anyway.'
      );
    }

    const configPath = getCodexDesktopConfigPath();
    if (options.verbose) {
      console.log(chalk.cyan(`Codex config: ${configPath}`));
    }

    const discovered = await discoverCodexModels(state.url, state.gatewayKey);
    const model = selectCodexModel(discovered, options.model);

    await writeCodexDesktopConfig({
      configPath,
      statePath: getCodexDesktopStatePath(),
      proxyUrl: state.url,
      baseUrl: new URL('/v1', state.url).toString(),
      gatewayKey: state.gatewayKey,
      model,
      force: options.force,
    });

    console.log(chalk.green(`✓ Codex Desktop configured (model: ${model})`));
    console.log(chalk.yellow('⚠ Quit and reopen the ChatGPT desktop app to apply the change.'));
    console.log(chalk.dim('  The model picker will show "Custom" — requests use the pinned model.'));
    return { label, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Codex Desktop configuration failed', ...sanitizeLogArgs({ error: message }));
    return { label, ok: false, error: message };
  }
}

/** Test seam — the runner is otherwise only reachable through `connectTargets`. */
export const runCodexDesktopForTest = runCodexDesktop;
```

Add the dispatch line in `connectTargets`, after the `vscodeClaudeCode` line:

```ts
  if (targets.codexDesktop) {
    results.push(await runCodexDesktop(state, {
      force: Boolean(opts.force),
      model: opts.model,
      verbose,
    }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts && npx tsc --noEmit`
Expected: PASS, `tsc` clean. Ensure `ConfigurationError` is already imported in `connect-orchestrator.ts`; if not, add it from `@/utils/errors.js`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connect-orchestrator.ts src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts
git commit -m "feat(proxy): add the Codex Desktop per-target runner"
```

---

## Task 12: The disconnect orchestrator

**Files:**
- Create: `src/cli/commands/proxy/disconnect-orchestrator.ts`
- Test: `src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts`

**Test-first: yes — `disconnectTargets({ codexDesktop: true })` reports the removal, prints the target list when no target flag is given, and reports a clean no-op when nothing was connected.**

- [ ] **Step 1: Write the failing test**

```ts
/**
 * `proxy disconnect` orchestration.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('disconnectTargets', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => { consoleLogSpy.mockRestore(); vi.clearAllMocks(); });

  it('prints the target list when no target is selected', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: {} });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--codex-desktop'));
  });

  it('reports the removal for the Codex desktop target', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockResolvedValue({
        removed: true, usedBackup: false, configPath: '/home/u/.codex/config.toml',
      }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Codex Desktop disconnected'));
  });

  it('reports a clean no-op when nothing was connected', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockResolvedValue({
        removed: false, usedBackup: false, configPath: null,
      }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to disconnect'));
  });

  it('sets a failing exit code when removal throws', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockRejectedValue(new Error('permission denied')),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts`
Expected: FAIL — `Failed to resolve import "../disconnect-orchestrator.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * `codemie proxy disconnect` — reverse what `connect` wrote for a target.
 *
 * The daemon is deliberately left running: it may still be serving other
 * connected targets, and stopping it is `codemie proxy stop`'s job.
 */
import chalk from 'chalk';

import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

import { removeCodexDesktopConfig } from './connectors/codex-desktop.js';

export interface DisconnectTargets {
  codexDesktop?: boolean;
}

export interface DisconnectOptions {
  targets: DisconnectTargets;
}

const DISCONNECT_TARGET_LIST = [
  'Select at least one target to disconnect:',
  '',
  '  --codex-desktop        Codex desktop app (removes the CodeMie block from ~/.codex/config.toml)',
  '',
  'Example:',
  '  codemie proxy disconnect --codex-desktop',
].join('\n');

export async function disconnectTargets(opts: DisconnectOptions): Promise<void> {
  if (!opts.targets.codexDesktop) {
    console.log(DISCONNECT_TARGET_LIST);
    return;
  }

  try {
    const result = await removeCodexDesktopConfig();

    if (!result.removed) {
      console.log(chalk.dim('Codex Desktop: nothing to disconnect.'));
      return;
    }

    console.log(chalk.green(`✓ Codex Desktop disconnected (${result.configPath})`));
    if (result.usedBackup) {
      console.log(chalk.yellow('⚠ Restored the backup because the managed block could not be removed cleanly.'));
    }
    console.log(chalk.yellow('⚠ Quit and reopen the ChatGPT desktop app to apply the change.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Codex Desktop disconnect failed', ...sanitizeLogArgs({ error: message }));
    console.log(chalk.red(`✗ Codex Desktop  — ${message}`));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/disconnect-orchestrator.ts src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts
git commit -m "feat(proxy): add proxy disconnect orchestration"
```

---

## Task 13: CLI wiring for the flag and the disconnect subcommand

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:31` (`UnifiedConnectOptions`), `:246-266` (options + action), and the subcommand list
- Test: `src/cli/commands/proxy/__tests__/connect-wiring.test.ts`

**Test-first: yes — `proxy connect --codex-desktop --model gpt-5-codex` reaches `connectTargets` with `{ codexDesktop: true }` and `model: 'gpt-5-codex'`, and `proxy disconnect --codex-desktop` reaches `disconnectTargets`.**

- [ ] **Step 1: Write the failing test**

Append to `src/cli/commands/proxy/__tests__/connect-wiring.test.ts`, and add the disconnect mock to the existing `vi.mock` block at the top of the file:

```ts
vi.mock('../disconnect-orchestrator.js', () => ({
  disconnectTargets: vi.fn().mockResolvedValue(undefined),
}));
```

```ts
  it('maps --codex-desktop and --model onto the connect options', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(
      ['connect', '--codex-desktop', '--model', 'gpt-5-codex'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({ codexDesktop: true }),
        model: 'gpt-5-codex',
      })
    );
  });

  it('routes `proxy disconnect --codex-desktop` to disconnectTargets', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--codex-desktop'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith({ targets: { codexDesktop: true } });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-wiring.test.ts -t 'codex-desktop'`
Expected: FAIL — `codexDesktop` is absent from the recorded call, and `disconnect` is an unknown command.

- [ ] **Step 3: Write minimal implementation**

Extend `UnifiedConnectOptions` in `index.ts`:

```ts
interface UnifiedConnectOptions {
  claudeDesktop?: boolean;
  vscode?: boolean;
  vscodeClaudeCode?: boolean;
  codexDesktop?: boolean;
  profile?: string;
  force?: boolean;
  verbose?: boolean;
  insiders?: boolean;
  model?: string;
}
```

Add the two options to the `connect` command, after `--vscode-claude-code`:

```ts
    .option('--codex-desktop', 'Configure the Codex desktop app (writes ~/.codex/config.toml)')
    .option('--model <slug>', 'Pin a specific model for --codex-desktop (default: best available)')
```

Extend the action's payload:

```ts
      await connectTargets({
        targets: {
          claudeDesktop: Boolean(opts.claudeDesktop),
          vscode: Boolean(opts.vscode),
          vscodeClaudeCode: Boolean(opts.vscodeClaudeCode),
          codexDesktop: Boolean(opts.codexDesktop),
        },
        profile: opts.profile,
        insiders: Boolean(opts.insiders),
        force: Boolean(opts.force),
        verbose: Boolean(opts.verbose),
        model: opts.model,
      });
```

Add the import and the new subcommand alongside the other proxy subcommands:

```ts
import { disconnectTargets } from './disconnect-orchestrator.js';
```

```ts
  proxy
    .command('disconnect')
    .description('Remove CodeMie proxy configuration from a client')
    .option('--codex-desktop', 'Remove the CodeMie block from ~/.codex/config.toml')
    .action(async (opts: { codexDesktop?: boolean }) => {
      await disconnectTargets({ targets: { codexDesktop: Boolean(opts.codexDesktop) } });
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-wiring.test.ts && npx tsc --noEmit`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/index.ts src/cli/commands/proxy/__tests__/connect-wiring.test.ts
git commit -m "feat(cli): wire --codex-desktop and proxy disconnect"
```

---

## Task 14: Documentation

**Files:**
- Modify: `docs/COMMANDS.md` (the `proxy connect` section, around lines 68-244)

**Test-first: no — documentation only; no behaviour changes and nothing to assert.**

- [ ] **Step 1: Add the target to the connect table and a disconnect section**

Document, in the existing style of that file:

- `--codex-desktop` as a connect target: which file it writes (`~/.codex/config.toml`), that the app must be quit and reopened, that the model picker shows "Custom" while requests use the pinned model, and that `--model <slug>` overrides the pinned choice.
- `--force`'s second meaning for this target: it bypasses both the app-not-found check and the foreign-`model_provider` refusal.
- `codemie proxy disconnect --codex-desktop`: removes the managed block, keeps the backup at `~/.codex/config.toml.codemie-backup`, and leaves the daemon running (`codemie proxy stop` stops it).
- A note that the Codex desktop app and the `codemie-codex` CLI use different Codex homes by design, so settings and history differ between the two surfaces.

- [ ] **Step 2: Verify the docs build/lint gate passes**

Run: `npm run lint`
Expected: PASS with zero warnings.

- [ ] **Step 3: Commit**

```bash
git add docs/COMMANDS.md
git commit -m "docs(proxy): document the codex-desktop target and disconnect"
```

---

## Task 15: Full gate run

**Files:** none — verification only.

**Test-first: no — this task runs the existing gates; it adds no behaviour.**

- [ ] **Step 1: Run the full check**

Run: `npm run lint && npm run typecheck && npm run build && npm run test:unit`
Expected: all four PASS. Zero lint warnings is the project policy.

- [ ] **Step 2: Confirm no unrelated files are staged**

Run: `git status --short`
Expected: `.claude/settings.json` and `.codemie/codemie-cli.config.json` still show as modified and **unstaged** — they are pre-existing local changes unrelated to this task and must not enter any commit.

- [ ] **Step 3: Commit only if the gate run required a fix**

```bash
git add -u src/ docs/
git commit -m "fix(proxy): resolve quality gate findings for codex-desktop target"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §3.1 pure layer → Tasks 1-4; §3.2 block format → Tasks 1, 3, 4; §3.3 displaced keys → Task 2; §3.4 orchestrator → Tasks 10-11; §3.5 path resolution → Task 5; §3.6 app detection → Tasks 5, 11; §3.7 model selection → Task 7; §4 connect flow → Task 8; §4.1 write-ahead → Task 8; §4.2 rollback via atomicity → Task 8; §5 disconnect → Tasks 9, 12; §6 error table → Tasks 7, 8, 11, 12; §7 state/ownership → Tasks 5, 6, 8; §8 testing → every task; §10 documented limitations → Task 14.

**Placeholder scan.** No TBD/TODO. Every code step carries complete code. Task 14 is prose-only by nature and enumerates the exact points to document rather than saying "update the docs".

**Type consistency.** `ManagedBlocks{header,table}` is produced by `buildManagedBlocks` (Task 4) and consumed by `spliceManagedBlocks` (Task 3) — same shape. `CodexDesktopState{configPath,backupPath,model,writtenAt}` is written in Task 8 and read in Task 9. `RemoveCodexDesktopResult{removed,usedBackup,configPath}` is returned by Task 9 and consumed by Task 12. `EffectiveClientType` gains `'codex-desktop'` in Task 10 and is used by the runner in Task 11. `findManagedRegions` is defined in Task 1 and reused in Tasks 3 and 6.

**Known adjustment points**, called out at the step that may need them rather than hidden: the trailing-newline seam in Task 3 (the round-trip property is the specification), `TempWorkspace`'s disposal method name in Task 5, the `stripManagedRegions` spy in Task 9, and `SpawnOptions.clientType` widening in Task 10.
