# EPMCDME-10988 Settings Conflict Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add startup detection in `codemie-code` that reads `~/.claude/settings.json`, identifies if `ANTHROPIC_BASE_URL` is set there (which would silently override the active profile), and prints a visible warning before the Claude session begins.

**Architecture:** A new pure-function helper `settings-conflict.ts` reads and compares URLs; `claude.plugin.ts:beforeRun` calls it and emits a `chalk.yellow` warning to stderr when a conflict is found. Detection happens after `transformEnvVars()` sets `env.ANTHROPIC_BASE_URL`, so the comparison is meaningful.

**Tech Stack:** TypeScript, Node.js `fs`/`fs/promises`, `chalk` (already in project), Vitest

## Global Constraints

- ES modules only — all imports must use `.js` extension (e.g., `import ... from './settings-conflict.js'`)
- Node.js `>=20.0.0` required
- No `require()`, no `__dirname` — use ES-module patterns
- All new source files: TypeScript strict mode, explicit return types on exports
- `interface` for shape types, no `any`
- Tests: Vitest, dynamic imports inside `beforeEach` after mocks are set up
- Tests only on explicit request (this plan explicitly requests them)
- Git ops only on explicit request (this plan explicitly requests them)
- Branch: `EPMCDME-10988`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/agents/plugins/claude/settings-conflict.ts` | Pure detection helper — reads `~/.claude/settings.json`, compares URLs, returns `ConflictInfo \| null` |
| Create | `src/agents/plugins/claude/__tests__/settings-conflict.test.ts` | Unit tests for `detectSettingsConflict` (6 scenarios) |
| Modify | `src/agents/plugins/claude/claude.plugin.ts` | Add static import + call `detectSettingsConflict` in `beforeRun`; emit `chalk.yellow` warning |
| Create | `src/agents/plugins/claude/__tests__/claude.plugin.conflict.test.ts` | Integration tests: `beforeRun` emits warning on conflict, silent on no-conflict |
| Modify | `.ai-run/guides/usage/project-config.md` | Document `~/.claude/settings.json` ANTHROPIC_BASE_URL override and detection behaviour |

---

## Task 1: Create `detectSettingsConflict` helper (TDD)

**Test-first: yes — failing test: `detectSettingsConflict returns ConflictInfo when URLs differ`**

**Files:**
- Create: `src/agents/plugins/claude/__tests__/settings-conflict.test.ts`
- Create: `src/agents/plugins/claude/settings-conflict.ts`

**Interfaces:**
- Produces: `ConflictInfo` interface and `detectSettingsConflict(env)` function consumed by Task 2

---

- [ ] **Step 1.1: Write the failing tests**

Create `src/agents/plugins/claude/__tests__/settings-conflict.test.ts` with these exact contents:

```typescript
/**
 * Tests for detectSettingsConflict — detects when ~/.claude/settings.json
 * ANTHROPIC_BASE_URL would override the active profile value.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs/promises');
vi.mock('fs');
vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getCodemieHome: vi.fn(() => '/home/testuser/.codemie'),
  getCodemiePath: vi.fn((...parts: string[]) => `/home/testuser/.codemie/${parts.join('/')}`),
}));

describe('detectSettingsConflict', () => {
  let detectSettingsConflict: (env: NodeJS.ProcessEnv) => Promise<import('../settings-conflict.js').ConflictInfo | null>;
  let fsMod: typeof import('fs');
  let fsp: typeof import('fs/promises');

  const SETTINGS_PATH = '/home/testuser/claude/settings.json';
  const PROFILE_URL = 'https://ai-proxy.lab.epam.com';
  const SETTINGS_URL = 'https://other-proxy.example.com';

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();

    fsMod = await import('fs');
    fsp = await import('fs/promises');

    const mod = await import('../settings-conflict.js');
    detectSettingsConflict = mod.detectSettingsConflict;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when settings.json does not exist', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(false);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toBeNull();
  });

  it('returns null when settings.json has no ANTHROPIC_BASE_URL key', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ statusLine: 'some-value' }) as any);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toBeNull();
  });

  it('returns null when settings.json ANTHROPIC_BASE_URL equals env value', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ ANTHROPIC_BASE_URL: PROFILE_URL }) as any);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toBeNull();
  });

  it('returns ConflictInfo when settings.json URL differs from env URL', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ ANTHROPIC_BASE_URL: SETTINGS_URL }) as any);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toEqual({ settingsUrl: SETTINGS_URL, profileUrl: PROFILE_URL });
  });

  it('returns ConflictInfo with undefined profileUrl when env has no ANTHROPIC_BASE_URL', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ ANTHROPIC_BASE_URL: SETTINGS_URL }) as any);

    const result = await detectSettingsConflict({});

    expect(result).toEqual({ settingsUrl: SETTINGS_URL, profileUrl: undefined });
  });

  it('returns null when settings.json is malformed JSON', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue('{ not valid json' as any);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 1.2: Run the tests — confirm they FAIL**

```bash
npx vitest run src/agents/plugins/claude/__tests__/settings-conflict.test.ts
```

Expected: FAIL — `Cannot find module '../settings-conflict.js'`

- [ ] **Step 1.3: Implement `settings-conflict.ts`**

Create `src/agents/plugins/claude/settings-conflict.ts` with these exact contents:

```typescript
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { resolveHomeDir } from '../../../utils/paths.js';

export interface ConflictInfo {
  settingsUrl: string;
  profileUrl: string | undefined;
}

export async function detectSettingsConflict(
  env: NodeJS.ProcessEnv
): Promise<ConflictInfo | null> {
  const settingsPath = join(resolveHomeDir('.claude'), 'settings.json');

  if (!existsSync(settingsPath)) return null;

  let settings: Record<string, unknown>;
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const settingsUrl = settings.ANTHROPIC_BASE_URL;
  if (typeof settingsUrl !== 'string' || !settingsUrl) return null;

  const profileUrl = env.ANTHROPIC_BASE_URL;
  if (profileUrl !== undefined && settingsUrl === profileUrl) return null;

  return { settingsUrl, profileUrl };
}
```

- [ ] **Step 1.4: Run the tests — confirm they PASS**

```bash
npx vitest run src/agents/plugins/claude/__tests__/settings-conflict.test.ts
```

Expected: PASS — 6 tests, all green

- [ ] **Step 1.5: Typecheck the new file**

```bash
npm run typecheck 2>&1 | grep -E "settings-conflict|error" | head -20
```

Expected: no errors referencing `settings-conflict.ts`

- [ ] **Step 1.6: Commit**

```bash
git add src/agents/plugins/claude/settings-conflict.ts \
        src/agents/plugins/claude/__tests__/settings-conflict.test.ts
git commit -m "feat(EPMCDME-10988): add detectSettingsConflict helper"
```

---

## Task 2: Wire detection into `claude.plugin.ts` `beforeRun` (TDD)

**Test-first: yes — failing test: `beforeRun emits chalk warning when conflict is detected`**

**Files:**
- Create: `src/agents/plugins/claude/__tests__/claude.plugin.conflict.test.ts`
- Modify: `src/agents/plugins/claude/claude.plugin.ts`

**Interfaces:**
- Consumes: `detectSettingsConflict` from `./settings-conflict.js` (Task 1)
- Produces: `beforeRun` now emits `chalk.yellow` warning to stderr when `ConflictInfo` is returned

---

- [ ] **Step 2.1: Write the failing integration tests**

Create `src/agents/plugins/claude/__tests__/claude.plugin.conflict.test.ts` with these exact contents:

```typescript
/**
 * Tests for Claude Plugin beforeRun conflict detection — warns when
 * ~/.claude/settings.json ANTHROPIC_BASE_URL would override the profile value.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig } from '../../../core/types.js';

vi.mock('fs/promises');
vi.mock('fs');

vi.mock('../statusline-installer.js', () => ({
  installStatusline: vi.fn(),
}));

vi.mock('../settings-conflict.js', () => ({
  detectSettingsConflict: vi.fn(),
}));

vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getCodemieHome: vi.fn(() => '/home/testuser/.codemie'),
  getCodemiePath: vi.fn((...parts: string[]) => `/home/testuser/.codemie/${parts.join('/')}`),
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setProfileName: vi.fn(),
    setSessionId: vi.fn(),
  },
}));

vi.mock('../../../../utils/security.js', () => ({
  sanitizeLogArgs: vi.fn((...args: unknown[]) => args),
}));

type HookEnv = NodeJS.ProcessEnv;
type BeforeRunFn = (env: HookEnv, config: AgentConfig) => Promise<HookEnv>;

describe('Claude Plugin – settings conflict detection in beforeRun', () => {
  let beforeRun: BeforeRunFn;
  let conflictMod: { detectSettingsConflict: ReturnType<typeof vi.fn> };
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const mockConfig: AgentConfig = {};

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await import('../claude.plugin.js');
    beforeRun = mod.ClaudePluginMetadata.lifecycle!.beforeRun!;

    conflictMod = (await import('../settings-conflict.js')) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a chalk warning to stderr when detectSettingsConflict returns ConflictInfo', async () => {
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://other-proxy.example.com',
      profileUrl: 'https://ai-proxy.lab.epam.com',
    });

    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await beforeRun(env, mockConfig);

    const calls = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? ''));
    const warningCall = calls.find(s => s.includes('⚠️') || s.includes('ANTHROPIC_BASE_URL'));
    expect(warningCall).toBeDefined();

    const allOutput = calls.join('\n');
    expect(allOutput).toContain('https://other-proxy.example.com');
    expect(allOutput).toContain('https://ai-proxy.lab.epam.com');
  });

  it('emits warning showing "(not set)" when profileUrl is undefined', async () => {
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://other-proxy.example.com',
      profileUrl: undefined,
    });

    const env: HookEnv = {};
    await beforeRun(env, mockConfig);

    const allOutput = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('not set');
    expect(allOutput).toContain('https://other-proxy.example.com');
  });

  it('does not emit any conflict warning when detectSettingsConflict returns null', async () => {
    conflictMod.detectSettingsConflict.mockResolvedValue(null);

    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await beforeRun(env, mockConfig);

    const conflictCalls = consoleErrorSpy.mock.calls.filter(c =>
      String(c[0] ?? '').includes('⚠️') || String(c[0] ?? '').includes('settings.json')
    );
    expect(conflictCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2.2: Run the tests — confirm they FAIL**

```bash
npx vitest run src/agents/plugins/claude/__tests__/claude.plugin.conflict.test.ts
```

Expected: FAIL — `detectSettingsConflict` is not called from `beforeRun` yet

- [ ] **Step 2.3: Add import to `claude.plugin.ts`**

In `src/agents/plugins/claude/claude.plugin.ts`, add the import after the existing imports (around line 25, after the `detectInstallationMethod` import):

```typescript
import { detectSettingsConflict } from './settings-conflict.js';
```

Exact location — after this existing line:
```typescript
} from '../../../utils/installation-detector.js';
```

Add:
```typescript
import { detectSettingsConflict } from './settings-conflict.js';
```

- [ ] **Step 2.4: Add conflict detection call in `beforeRun`**

In `src/agents/plugins/claude/claude.plugin.ts`, inside `lifecycle.beforeRun(env)`, add the conflict detection block just before the final `return env;` statement (currently at line 224).

Replace:
```typescript
      return env;
    },
```

With:
```typescript
      // Detect ANTHROPIC_BASE_URL override in ~/.claude/settings.json
      // Claude Code reads settings.json at startup and silently overrides env vars;
      // warn the user so they know which endpoint is actually in use.
      const conflict = await detectSettingsConflict(env);
      if (conflict) {
        const profileDisplay = conflict.profileUrl ?? '(not set — direct Anthropic API)';
        console.error(chalk.yellow('\n⚠️  ANTHROPIC_BASE_URL override detected in ~/.claude/settings.json'));
        console.error(chalk.yellow('─'.repeat(60)));
        console.error(chalk.yellow(`  Profile URL  │ ${profileDisplay}`));
        console.error(chalk.yellow(`  Active URL   │ ${conflict.settingsUrl}  ← settings.json wins`));
        console.error(chalk.yellow(''));
        console.error(chalk.yellow('  ~/.claude/settings.json ANTHROPIC_BASE_URL takes precedence'));
        console.error(chalk.yellow('  over the profile value. Session will use the settings.json URL.'));
        console.error(chalk.yellow(''));
        console.error(chalk.yellow('  To fix: remove ANTHROPIC_BASE_URL from ~/.claude/settings.json'));
        console.error(chalk.yellow('─'.repeat(60)));
        console.error('');
      }

      return env;
    },
```

- [ ] **Step 2.5: Run the integration tests — confirm they PASS**

```bash
npx vitest run src/agents/plugins/claude/__tests__/claude.plugin.conflict.test.ts
```

Expected: PASS — 3 tests, all green

- [ ] **Step 2.6: Run the full unit test suite to confirm no regressions**

```bash
npm run test:unit
```

Expected: all pre-existing tests pass, plus 3 new conflict tests and 6 new settings-conflict tests

- [ ] **Step 2.7: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "error|claude.plugin" | head -20
```

Expected: no new errors

- [ ] **Step 2.8: Commit**

```bash
git add src/agents/plugins/claude/claude.plugin.ts \
        src/agents/plugins/claude/__tests__/claude.plugin.conflict.test.ts
git commit -m "feat(EPMCDME-10988): warn on ANTHROPIC_BASE_URL override in settings.json"
```

---

## Task 3: Update documentation

**Test-first: no — documentation-only change**

**Files:**
- Modify: `.ai-run/guides/usage/project-config.md`

---

- [ ] **Step 3.1: Add the ANTHROPIC_BASE_URL Override section**

In `.ai-run/guides/usage/project-config.md`, find the `## Troubleshooting` section and add a new section immediately before it:

```markdown
## Claude Code ANTHROPIC_BASE_URL Override

Claude Code reads `~/.claude/settings.json` at startup. If that file contains an
`ANTHROPIC_BASE_URL` key, Claude Code uses it instead of the environment variable —
silently overriding the value injected by the active `codemie-code` profile.

`codemie-code` detects this at startup and prints a warning showing:

- **Profile URL** — the URL the active profile tried to inject
- **Active URL** — the settings.json URL that will actually be used

**Precedence chain (highest wins):**

```
~/.claude/settings.json (ANTHROPIC_BASE_URL) > env.ANTHROPIC_BASE_URL (codemie-code profile)
```

**To resolve:** remove `ANTHROPIC_BASE_URL` from `~/.claude/settings.json`. You can open
the file at:

```bash
cat ~/.claude/settings.json
```

and delete the `"ANTHROPIC_BASE_URL"` key. The profile's value will then be used as intended.

```

- [ ] **Step 3.2: Commit**

```bash
git add .ai-run/guides/usage/project-config.md
git commit -m "docs(EPMCDME-10988): document ANTHROPIC_BASE_URL override detection in project-config guide"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Detect `ANTHROPIC_BASE_URL` override at startup | Task 1 (`detectSettingsConflict`) + Task 2 (wired in `beforeRun`) |
| Clear warning printed before session starts | Task 2 (chalk.yellow to stderr in `beforeRun`) |
| Banner / info reflects actual endpoint | Task 2 (warning shows `settingsUrl` as "Active URL") |
| Documentation updated | Task 3 |
| Tests covering override scenario | Task 1 (6 unit tests) + Task 2 (3 integration tests) |

All 5 acceptance criteria covered. ✓

**Placeholder scan:** No TBD, TODO, or "similar to Task N" patterns. All code blocks complete. ✓

**Type consistency:**
- `ConflictInfo` defined in Task 1 (`settings-conflict.ts`), consumed in Task 2 (`claude.plugin.ts`) via import — consistent.
- `detectSettingsConflict(env: NodeJS.ProcessEnv): Promise<ConflictInfo | null>` — signature consistent across definition (Task 1) and usage (Task 2).
- `conflict.settingsUrl` and `conflict.profileUrl` used consistently in Task 2 warning block. ✓
