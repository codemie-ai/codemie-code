# Plugins Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate four cross-plugin code duplications and add a `PLUGIN_GUIDE.md` that makes the plugin contract explicit.

**Architecture:** Each task is independently mergeable. Tasks 1–3 touch the plugin layer only. Task 4 refactors the session-adapter layer by converting the `SessionAdapter` interface to an abstract class. Task 5 adds documentation only.

**Tech Stack:** TypeScript, Node.js ≥ 20, Vitest, ES modules (`.js` extensions on all imports), `@/` alias for deep imports.

## Global Constraints

- ES modules only — all imports use `.js` extension, no `require()`.
- `@/` alias for imports crossing more than two directory levels (e.g. `@/utils/paths.js`).
- No `console.log` — use `logger.debug/info/warn/error`.
- No `any` — use explicit types.
- `interface` for external shapes; `class` for implementations.
- No tests or git operations unless explicitly requested.

---

## File Map

| File | Change |
|---|---|
| `src/agents/core/utils/args.ts` | **Create** — `getExplicitModelArg()` shared utility |
| `src/agents/core/BaseAgentAdapter.ts` | **Modify** — update `getVersion()` and `isInstalled()` |
| `src/agents/plugins/claude/claude.plugin.ts` | **Modify** — add `dataPaths.binary`, remove `getVersion()` and `isInstalled()` overrides |
| `src/agents/plugins/codex/codex.plugin.ts` | **Modify** — remove `getExplicitModelArg()`, remove `getVersion()` override |
| `src/agents/plugins/gemini/gemini.plugin.ts` | **Modify** — remove `getVersion()` override |
| `src/agents/plugins/kimi/kimi.plugin.ts` | **Modify** — remove `getExplicitModelArg()`, remove `getVersion()` and `isInstalled()` overrides |
| `src/agents/core/session/BaseSessionAdapter.ts` | **Modify** — add `AbstractBaseSessionAdapter` abstract class (interface stays) |
| `src/agents/plugins/claude/claude.session.ts` | **Modify** — extend `AbstractBaseSessionAdapter`, remove processor boilerplate |
| `src/agents/plugins/codex/codex.session.ts` | **Modify** — extend `AbstractBaseSessionAdapter`, remove processor boilerplate |
| `src/agents/plugins/gemini/gemini.session-adapter.ts` | **Modify** — extend `AbstractBaseSessionAdapter`, remove processor boilerplate |
| `src/agents/plugins/kimi/kimi.session.ts` | **Modify** — extend `AbstractBaseSessionAdapter`, remove processor boilerplate |
| `src/agents/plugins/opencode/opencode.session.ts` | **Modify** — extend `AbstractBaseSessionAdapter`, remove processor boilerplate |
| `src/agents/plugins/PLUGIN_GUIDE.md` | **Create** — plugin authoring guide |

---

## Task 1: Extract `getExplicitModelArg()` to a shared utility

**Files:**
- Create: `src/agents/core/utils/args.ts`
- Modify: `src/agents/plugins/codex/codex.plugin.ts` (line 429, the module-private function)
- Modify: `src/agents/plugins/kimi/kimi.plugin.ts` (line 384, the module-private function)

**Interfaces:**
- Produces: `getExplicitModelArg(args: string[]): string | undefined` — exported from `args.ts`
- Consumed by: Task 1 only (Codex and Kimi plugins)

- [ ] **Step 1: Create `src/agents/core/utils/args.ts`**

```typescript
/**
 * Shared CLI argument utilities for agent plugins.
 */

/**
 * Returns the value of the first -m / --model / --model=<val> argument found,
 * or undefined if none is present.
 */
export function getExplicitModelArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || arg === '--model') {
      return args[i + 1];
    }
    if (arg.startsWith('--model=')) {
      return arg.slice('--model='.length);
    }
  }
  return undefined;
}
```

- [ ] **Step 2: Update `codex/codex.plugin.ts` — import from utils, delete local copy**

At the top of the file, add the import:
```typescript
import { getExplicitModelArg } from '../../core/utils/args.js';
```

Delete the module-level private function at the bottom of the file (lines 429–441):
```typescript
// DELETE THIS ENTIRE FUNCTION:
function getExplicitModelArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || arg === '--model') {
      return args[i + 1];
    }
    if (arg.startsWith('--model=')) {
      return arg.slice('--model='.length);
    }
  }
  return undefined;
}
```

- [ ] **Step 3: Update `kimi/kimi.plugin.ts` — import from utils, delete local copy**

At the top of the file, add the import alongside the other imports:
```typescript
import { getExplicitModelArg } from '../../core/utils/args.js';
```

Delete the module-level private function at the bottom of the file (lines 384–396):
```typescript
// DELETE THIS ENTIRE FUNCTION:
function getExplicitModelArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || arg === '--model') {
      return args[i + 1];
    }
    if (arg.startsWith('--model=')) {
      return arg.slice('--model='.length);
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Verify build passes**

```bash
npm run typecheck
```

Expected: zero errors.

---

## Task 2: Centralise `getVersion()` in `BaseAgentAdapter`

This task updates the base `getVersion()` to try `dataPaths.binary` first (on non-win32) and parse semver from stdout — then removes the redundant overrides in Claude, Gemini, Kimi, and Codex. It also adds `dataPaths.binary` to Claude's metadata (Kimi already has it).

**Files:**
- Modify: `src/agents/core/BaseAgentAdapter.ts` — update `getVersion()` (~line 232)
- Modify: `src/agents/plugins/claude/claude.plugin.ts` — add `dataPaths.binary`, delete `getVersion()` override
- Modify: `src/agents/plugins/gemini/gemini.plugin.ts` — delete `getVersion()` override (~line 224)
- Modify: `src/agents/plugins/kimi/kimi.plugin.ts` — delete `getVersion()` override (~line 292)
- Modify: `src/agents/plugins/codex/codex.plugin.ts` — delete `getVersion()` override (~line 497)

**Interfaces:**
- Consumes: `exec` from `src/utils/processes.ts`, `resolveHomeDir` from `src/utils/paths.ts`
- Produces: `BaseAgentAdapter.getVersion(): Promise<string | null>` — now tries binary path + parses semver

- [ ] **Step 1: Update `BaseAgentAdapter.getVersion()` (~line 232)**

Replace the current implementation:
```typescript
// BEFORE:
async getVersion(): Promise<string | null> {
  if (!this.metadata.cliCommand) {
    return null;
  }

  try {
    const result = await exec(this.metadata.cliCommand, ['--version']);
    return result.stdout.trim();
  } catch {
    return null;
  }
}
```

With:
```typescript
// AFTER:
async getVersion(): Promise<string | null> {
  if (!this.metadata.cliCommand) {
    return null;
  }

  const parseVersion = (stdout: string): string | null => {
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : stdout.trim() || null;
  };

  // On non-win32, prefer the native binary path when configured.
  // This handles agents installed outside PATH (e.g. ~/.local/bin/claude, ~/.kimi-code/bin/kimi).
  if (process.platform !== 'win32' && this.metadata.dataPaths?.binary) {
    const { resolveHomeDir } = await import('../../utils/paths.js');
    const binaryPath = resolveHomeDir(this.metadata.dataPaths.binary);
    try {
      const result = await exec(binaryPath, ['--version']);
      return parseVersion(result.stdout);
    } catch {
      // Binary path unavailable — fall through to cliCommand
    }
  }

  try {
    const result = await exec(this.metadata.cliCommand, ['--version']);
    return parseVersion(result.stdout);
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Add `dataPaths.binary` to `ClaudePluginMetadata` in `claude/claude.plugin.ts`**

The `dataPaths` object already exists in Claude's metadata. Add the `binary` field:
```typescript
// BEFORE:
dataPaths: {
  home: '.claude',
},

// AFTER:
dataPaths: {
  home: '.claude',
  binary: '.local/bin/claude',
},
```

- [ ] **Step 3: Delete `getVersion()` override from `claude/claude.plugin.ts` (~line 319)**

Remove the entire method (lines 319–358 approximately):
```typescript
// DELETE THIS ENTIRE METHOD from ClaudePlugin class:
async getVersion(): Promise<string | null> {
  if (!this.metadata.cliCommand) {
    return null;
  }

  const { exec } = await import('../../../utils/processes.js');

  // Try full path first on Unix systems (native installer places binary at ~/.local/bin/claude)
  if (process.platform !== 'win32') {
    const fullPath = resolveHomeDir('.local/bin/claude');
    try {
      const result = await exec(fullPath, ['--version']);

      // Parse version from output like '2.1.23 (Claude Code)'
      const versionMatch = result.stdout.trim().match(/^(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        return versionMatch[1];
      }

      return result.stdout.trim();
    } catch {
      // Full path check failed, fall through to PATH check
    }
  }

  // Fall back to command in PATH (works for npm installations, Windows, etc.)
  try {
    const result = await exec(this.metadata.cliCommand, ['--version']);

    // Parse version from output like '2.1.23 (Claude Code)'
    // Extract just the version number
    const versionMatch = result.stdout.trim().match(/^(\d+\.\d+\.\d+)/);
    if (versionMatch) {
      return versionMatch[1];
    }

    return result.stdout.trim();
  } catch {
    return null;
  }
}
```

After deletion, check whether the `resolveHomeDir` import is still needed (it is — used in `afterRun` and `isInstalled`). Leave it.

- [ ] **Step 4: Delete `getVersion()` override from `gemini/gemini.plugin.ts` (~line 224)**

Remove the entire method from `GeminiPlugin`:
```typescript
// DELETE THIS ENTIRE METHOD:
async getVersion(): Promise<string | null> {
  if (!this.metadata.cliCommand) {
    return null;
  }

  try {
    const { exec } = await import('../../../utils/processes.js');
    const result = await exec(this.metadata.cliCommand, ['--version']);

    // Parse semver from output (handles both '0.29.5' and '0.29.5 (Gemini CLI)' formats)
    const versionMatch = result.stdout.trim().match(/^(\d+\.\d+\.\d+)/);
    if (versionMatch) {
      return versionMatch[1];
    }

    return result.stdout.trim();
  } catch {
    return null;
  }
}
```

After deletion, remove the dynamic `import('../../../utils/processes.js')` if `exec` is no longer used anywhere in the file — but check first, since `exec` may be used elsewhere. In this file it is not used elsewhere, so if you imported it at the top level, check for remaining usages.

- [ ] **Step 5: Delete `getVersion()` override from `kimi/kimi.plugin.ts` (~line 292)**

Remove the entire method from `KimiPlugin`:
```typescript
// DELETE THIS ENTIRE METHOD:
override async getVersion(): Promise<string | null> {
  if (!this.metadata.cliCommand) {
    return null;
  }

  const parseVersion = (output: string): string | null => {
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : output.trim() || null;
  };

  // Try native installer full path first on Unix systems
  // (native installer places binary at ~/.kimi-code/bin/kimi)
  if (process.platform !== 'win32') {
    const nativePath = resolveHomeDir(KIMI_NATIVE_BINARY_PATH);
    try {
      const result = await exec(nativePath, ['--version']);
      return parseVersion(result.stdout);
    } catch {
      // Native path check failed, fall through to legacy path
    }

    // Legacy / npm location
    const fullPath = resolveHomeDir('.local/bin/kimi');
    try {
      const result = await exec(fullPath, ['--version']);
      return parseVersion(result.stdout);
    } catch {
      // Full path check failed, fall through to PATH check
    }
  }

  // Fall back to command in PATH
  try {
    const result = await exec(this.metadata.cliCommand, ['--version']);
    return parseVersion(result.stdout);
  } catch {
    return null;
  }
}
```

Note: Kimi's `dataPaths.binary` is already `'.kimi-code/bin/kimi'` (= `KIMI_NATIVE_BINARY_PATH`), so the base now covers the primary path. The legacy `'.local/bin/kimi'` fallback is intentionally dropped — it was an npm installation artefact superseded by the native installer.

- [ ] **Step 6: Delete `getVersion()` override from `codex/codex.plugin.ts` (~line 497)**

Remove the entire method from `CodexPlugin`:
```typescript
// DELETE THIS ENTIRE METHOD:
async getVersion(): Promise<string | null> {
  if (!this.metadata.cliCommand) {
    return null;
  }

  try {
    const result = await exec(this.metadata.cliCommand, ['--version']);
    const output = result.stdout.trim();
    const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
    return versionMatch ? versionMatch[1] : output;
  } catch {
    return null;
  }
}
```

Codex has no `dataPaths.binary` (it is npm-only), so the base falls straight to `exec(cliCommand)` — behaviour is identical.

- [ ] **Step 7: Verify build passes**

```bash
npm run typecheck
```

Expected: zero errors.

---

## Task 3: Centralise `isInstalled()` in `BaseAgentAdapter`

Updates the base `isInstalled()` to check `dataPaths.binary` first on non-win32, then removes the overrides in Claude and Kimi.

**Files:**
- Modify: `src/agents/core/BaseAgentAdapter.ts` — update `isInstalled()` (~line 215)
- Modify: `src/agents/plugins/claude/claude.plugin.ts` — delete `isInstalled()` override
- Modify: `src/agents/plugins/kimi/kimi.plugin.ts` — delete `isInstalled()` override

**Interfaces:**
- Consumes: `resolveHomeDir` from `src/utils/paths.ts`, `exec` and `commandExists` from `src/utils/processes.ts`
- Produces: `BaseAgentAdapter.isInstalled(): Promise<boolean>` — tries binary path before PATH

- [ ] **Step 1: Update `BaseAgentAdapter.isInstalled()` (~line 215)**

Replace the current implementation:
```typescript
// BEFORE:
async isInstalled(): Promise<boolean> {
  if (!this.metadata.cliCommand) {
    return true; // Built-in agents are always "installed"
  }

  try {
    // Use commandExists which handles Windows (where) vs Unix (which)
    const { commandExists } = await import('../../utils/processes.js');
    return await commandExists(this.metadata.cliCommand);
  } catch {
    return false;
  }
}
```

With:
```typescript
// AFTER:
async isInstalled(): Promise<boolean> {
  if (!this.metadata.cliCommand) {
    return true; // Built-in agents are always "installed"
  }

  // On non-win32, try the native binary path first when configured.
  // Agents installed outside PATH (e.g. native installers) set dataPaths.binary.
  if (process.platform !== 'win32' && this.metadata.dataPaths?.binary) {
    const { resolveHomeDir } = await import('../../utils/paths.js');
    const binaryPath = resolveHomeDir(this.metadata.dataPaths.binary);
    try {
      const result = await exec(binaryPath, ['--version']);
      if (result.code === 0) {
        return true;
      }
    } catch {
      // Binary path unavailable — fall through to PATH check
    }
  }

  try {
    const { commandExists } = await import('../../utils/processes.js');
    return await commandExists(this.metadata.cliCommand);
  } catch {
    return false;
  }
}
```

Note: `exec` is already imported at the top of `BaseAgentAdapter.ts` — no new import needed.

- [ ] **Step 2: Delete `isInstalled()` override from `claude/claude.plugin.ts` (~line 382)**

Remove the entire method from `ClaudePlugin`:
```typescript
// DELETE THIS ENTIRE METHOD:
async isInstalled(): Promise<boolean> {
  if (!this.metadata.cliCommand) {
    return true; // Built-in agents are always "installed"
  }

  // On Unix systems, check full path first (native installer places binary at ~/.local/bin/claude)
  // This avoids PATH issues where ~/.local/bin is not in user's PATH
  if (process.platform !== 'win32') {
    const fullPath = resolveHomeDir('.local/bin/claude');
    try {
      const { exec } = await import('../../../utils/processes.js');
      const result = await exec(fullPath, ['--version']);
      if (result.code === 0) {
        return true;
      }
    } catch {
      // Full path check failed, fall through to PATH check
    }
  }

  // Fall back to base implementation (checks if command is in PATH)
  return super.isInstalled();
}
```

- [ ] **Step 3: Delete `isInstalled()` override from `kimi/kimi.plugin.ts` (~line 139)**

Remove the entire method from `KimiPlugin`:
```typescript
// DELETE THIS ENTIRE METHOD:
override async isInstalled(): Promise<boolean> {
  if (!this.metadata.cliCommand) {
    return true;
  }

  if (await commandExists(this.metadata.cliCommand)) {
    return true;
  }

  if (process.platform !== 'win32') {
    // Native installer location
    const nativePath = resolveHomeDir(KIMI_NATIVE_BINARY_PATH);
    try {
      const result = await exec(nativePath, ['--version']);
      if (result.code === 0) {
        return true;
      }
    } catch {
      // Native path check failed, fall through
    }

    // Legacy / npm location
    const fullPath = resolveHomeDir('.local/bin/kimi');
    try {
      const result = await exec(fullPath, ['--version']);
      return result.code === 0;
    } catch {
      // Full path check failed, fall through to PATH check already performed
    }
  }

  logger.debug('[kimi-plugin] Kimi not installed. Install with:');
  logger.debug('[kimi-plugin]   codemie install kimi');

  return false;
}
```

Note: after deletion, check whether `commandExists` is still imported in `kimi.plugin.ts`. It is used in `installNative` indirectly via the base — but the direct `commandExists` import in this file was only used by the deleted override. Remove it from the import line if it is no longer used:
```typescript
// BEFORE:
import { commandExists, exec, getCommandPath } from '../../../utils/processes.js';

// AFTER (if commandExists is unused elsewhere in the file):
import { exec, getCommandPath } from '../../../utils/processes.js';
```

- [ ] **Step 4: Verify build passes**

```bash
npm run typecheck
```

Expected: zero errors.

---

## Task 4: Convert `SessionAdapter` to an abstract class and update all five adapters

Introduces `AbstractBaseSessionAdapter` — an abstract class that owns `processors`, `registerProcessor()`, and calls the abstract `initializeProcessors()` from its constructor. The existing `SessionAdapter` interface is kept for backward compatibility.

**Files:**
- Modify: `src/agents/core/session/BaseSessionAdapter.ts` — add `AbstractBaseSessionAdapter` abstract class
- Modify: `src/agents/plugins/claude/claude.session.ts`
- Modify: `src/agents/plugins/codex/codex.session.ts`
- Modify: `src/agents/plugins/gemini/gemini.session-adapter.ts`
- Modify: `src/agents/plugins/kimi/kimi.session.ts`
- Modify: `src/agents/plugins/opencode/opencode.session.ts`

**Interfaces:**
- Produces: `AbstractBaseSessionAdapter` — exported from `BaseSessionAdapter.ts`
- Consumed by: all five session adapter files

- [ ] **Step 1: Add `AbstractBaseSessionAdapter` to `BaseSessionAdapter.ts`**

Append the following to the bottom of `src/agents/core/session/BaseSessionAdapter.ts` (after the existing `SessionAdapter` interface — do not remove anything):

```typescript
import type { SessionProcessor } from './BaseProcessor.js';
import type { AgentMetadata } from '../types.js';

/**
 * Abstract base class for all session adapters.
 *
 * Owns the processor registry so each adapter only overrides
 * initializeProcessors() to register its own processors.
 * The SessionAdapter interface is kept for external type consumers.
 */
export abstract class AbstractBaseSessionAdapter implements SessionAdapter {
  protected readonly processors: SessionProcessor[] = [];

  constructor(protected readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  /**
   * Register agent-specific processors. Called once from the constructor.
   * Subclasses call this.registerProcessor() for each processor they need.
   */
  protected abstract initializeProcessors(): void;

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
  }

  abstract readonly agentName: string;
  abstract parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession>;
  abstract processSession(
    filePath: string,
    sessionId: string,
    context: import('./BaseProcessor.js').ProcessingContext,
  ): Promise<AggregatedResult>;
}
```

- [ ] **Step 2: Update `claude/claude.session.ts`**

Change the class declaration to extend `AbstractBaseSessionAdapter`:

```typescript
// ADD to imports:
import { AbstractBaseSessionAdapter } from '../../core/session/BaseSessionAdapter.js';

// CHANGE class declaration:
// BEFORE:
export class ClaudeSessionAdapter implements SessionAdapter {
  readonly agentName = 'claude';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new MetricsProcessor());
    logger.debug(`[claude-adapter] Registered processor: metrics`);
    this.registerProcessor(new ConversationsProcessor());
    logger.debug(`[claude-adapter] Registered processor: conversations`);
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[claude-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

// AFTER:
export class ClaudeSessionAdapter extends AbstractBaseSessionAdapter {
  readonly agentName = 'claude';

  constructor(metadata: AgentMetadata) {
    super(metadata);
  }

  protected initializeProcessors(): void {
    this.registerProcessor(new MetricsProcessor());
    this.registerProcessor(new ConversationsProcessor());
  }
```

Remove the `implements SessionAdapter` (now inherited from the base class), remove the `private processors: SessionProcessor[] = []` field, and remove the `registerProcessor()` method body — it now lives in the base.

Also remove the `SessionAdapter` type import if it is no longer directly referenced in the file (the class no longer needs to name it in its declaration).

- [ ] **Step 3: Update `codex/codex.session.ts`**

```typescript
// ADD to imports:
import { AbstractBaseSessionAdapter } from '../../core/session/BaseSessionAdapter.js';

// CHANGE class declaration:
// BEFORE:
export class CodexSessionAdapter implements SessionAdapter {
  ...
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new CodexMetricsProcessor());
    this.registerProcessor(new CodexConversationsProcessor());
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    ...
  }

// AFTER:
export class CodexSessionAdapter extends AbstractBaseSessionAdapter {
  ...
  constructor(metadata: AgentMetadata) {
    super(metadata);
  }

  protected initializeProcessors(): void {
    this.registerProcessor(new CodexMetricsProcessor());
    this.registerProcessor(new CodexConversationsProcessor());
  }
```

Remove `processors` field, `registerProcessor()` method, `implements SessionAdapter`.

- [ ] **Step 4: Update `gemini/gemini.session-adapter.ts`**

```typescript
// ADD to imports:
import { AbstractBaseSessionAdapter } from '../../core/session/BaseSessionAdapter.js';

// CHANGE class declaration:
// BEFORE:
export class GeminiSessionAdapter implements SessionAdapter {
  ...
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new GeminiMetricsProcessor());
    this.registerProcessor(new GeminiConversationsProcessor());
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
  }

// AFTER:
export class GeminiSessionAdapter extends AbstractBaseSessionAdapter {
  ...
  constructor(metadata: AgentMetadata) {
    super(metadata);
  }

  protected initializeProcessors(): void {
    this.registerProcessor(new GeminiMetricsProcessor());
    this.registerProcessor(new GeminiConversationsProcessor());
  }
```

Remove `processors` field, `registerProcessor()` method, `implements SessionAdapter`.

- [ ] **Step 5: Update `kimi/kimi.session.ts`**

```typescript
// ADD to imports:
import { AbstractBaseSessionAdapter } from '../../core/session/BaseSessionAdapter.js';

// CHANGE class declaration:
// BEFORE:
export class KimiSessionAdapter implements SessionAdapter {
  readonly agentName = 'kimi';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new KimiMetricsProcessor());
    logger.debug(`[kimi-adapter] Initialized ${this.processors.length} processors`);
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[kimi-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

// AFTER:
export class KimiSessionAdapter extends AbstractBaseSessionAdapter {
  readonly agentName = 'kimi';

  constructor(metadata: AgentMetadata) {
    super(metadata);
  }

  protected initializeProcessors(): void {
    this.registerProcessor(new KimiMetricsProcessor());
  }
```

Remove `processors` field, `registerProcessor()` method, `implements SessionAdapter`.

- [ ] **Step 6: Update `opencode/opencode.session.ts`**

```typescript
// ADD to imports:
import { AbstractBaseSessionAdapter } from '../../core/session/BaseSessionAdapter.js';

// CHANGE class declaration:
// BEFORE:
export class OpenCodeSessionAdapter implements SessionAdapter {
  ...
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new OpenCodeMetricsProcessor());
    this.registerProcessor(new OpenCodeConversationsProcessor());
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
  }

// AFTER:
export class OpenCodeSessionAdapter extends AbstractBaseSessionAdapter {
  ...
  constructor(metadata: AgentMetadata) {
    super(metadata);
  }

  protected initializeProcessors(): void {
    this.registerProcessor(new OpenCodeMetricsProcessor());
    this.registerProcessor(new OpenCodeConversationsProcessor());
  }
```

Remove `processors` field, `registerProcessor()` method, `implements SessionAdapter`.

- [ ] **Step 7: Verify build passes**

```bash
npm run typecheck
```

Expected: zero errors.

---

## Task 5: Add `PLUGIN_GUIDE.md`

**Files:**
- Create: `src/agents/plugins/PLUGIN_GUIDE.md`

- [ ] **Step 1: Create `src/agents/plugins/PLUGIN_GUIDE.md`**

```markdown
# Plugin Authoring Guide

Reference for adding a new agent plugin to CodeMie. Read this before touching any plugin file.

---

## Checklist: minimum files for a new plugin

| File | Required | Purpose |
|---|---|---|
| `<agent>/<agent>.plugin.ts` | Yes | Metadata object + class extending `BaseAgentAdapter` |
| `<agent>/<agent>.session.ts` | Yes | Class extending `AbstractBaseSessionAdapter` |
| `<agent>/session/processors/<agent>.metrics-processor.ts` | Yes | Extracts tool usage to `MetricDelta` JSONL |
| `<agent>/session/processors/<agent>.conversations-processor.ts` | Yes | Extracts conversation history to JSONL |
| `<agent>/__tests__/` | Yes | Plugin lifecycle smoke, `enrichArgs` unit, metrics processor fixture |

---

## What the base handles — do not override

| Behaviour | How to enable |
|---|---|
| npm install / uninstall | Provided by `BaseAgentAdapter`; set `metadata.npmPackage` |
| Version compatibility check | Provided by `BaseAgentAdapter`; set `supportedVersion` + `minimumSupportedVersion` |
| Semver extraction from `--version` output | Set `metadata.dataPaths.binary` for native-path first; base parses `/(\d+\.\d+\.\d+)/` |
| Native binary path check in `isInstalled` | Set `metadata.dataPaths.binary`; base tries it before PATH |
| Processor registration + priority sort | Extend `AbstractBaseSessionAdapter`; call `this.registerProcessor()` in `initializeProcessors()` |

---

## When you MUST override

- **Native installer** — override `install()` / `installVersion()` when the agent ships a shell-script installer (not npm). See `claude.plugin.ts` and `kimi.plugin.ts` for examples.
- **Arg enrichment** — override `lifecycle.enrichArgs` for any transformation beyond the `flagMappings` config (subcommand injection, model provider config, etc.).
- **Hook transformer** — implement `getHookTransformer()` when the agent emits non-standard hook event names. See `gemini.hook-transformer.ts` and `kimi.hook-transformer.ts`.

---

## Required metadata fields

```typescript
const metadata: AgentMetadata = {
  name: 'myagent',                     // snake_case; used as CLI selector and log prefix
  displayName: 'My Agent CLI',         // human-readable
  description: 'One-sentence summary',
  npmPackage: '@vendor/myagent',        // omit if native-only
  cliCommand: 'myagent',

  supportedVersion: '1.2.3',           // latest version tested with CodeMie backend
  minimumSupportedVersion: '1.1.0',    // rule: ~10 patch/minor versions below supportedVersion

  dataPaths: {
    home: '.myagent',                  // required; e.g. ~/.myagent
    binary: '.myagent/bin/myagent',    // set when agent installs outside PATH on Unix
  },

  envMapping: {
    baseUrl: ['MYAGENT_BASE_URL'],     // CODEMIE_BASE_URL is written here
    apiKey:  ['MYAGENT_API_KEY'],      // CODEMIE_API_KEY is written here
    model:   ['MYAGENT_MODEL'],        // CODEMIE_MODEL is written here (empty [] = not forwarded)
  },

  supportedProviders: ['ai-run-sso', 'litellm', 'bearer-auth'],
  ssoConfig: { enabled: true, clientType: 'codemie-myagent' },

  extensionsConfig: {
    project: '.myagent',
    global: '~/.myagent',
    skillsEntryFile: 'SKILL.md',
  },
};
```

---

## Async rules

### Dynamic imports in lifecycle hooks are intentional

`await import(...)` inside `beforeRun` / `onSessionEnd` avoids circular dependencies at module load time. Do not hoist these to top-level `import` statements.

```typescript
// Correct — dynamic import inside lifecycle hook
async beforeRun(env) {
  const { processEvent } = await import('../../../cli/commands/hook.js');
  await processEvent(...);
  return env;
}
```

### Fire-and-forget pattern

Use `void promise.catch(err => logger.debug(...))` for non-blocking side effects (e.g. stale session reconciliation, incremental sync start). Never leave a bare `void` with no `.catch()`.

```typescript
// Correct
void reconcileStale(env).catch(err => {
  logger.debug(`[myagent] Reconciliation failed (non-blocking): ${err instanceof Error ? err.message : err}`);
});

// Wrong — unhandled rejection
void reconcileStale(env);
```

### `isInstalled()` must be side-effect free

No writes to stdout, no mutations, no file creation. `logger.debug()` (file-only) is acceptable. This method is called by `codemie doctor` and must not produce output or side effects.

### `onSessionEnd` failures must never throw

Metrics or sync failure must be caught and swallowed — an uncaught error here blocks agent process exit.

```typescript
async onSessionEnd(exitCode, env) {
  try {
    await processMetrics(env);
  } catch (error) {
    // Non-fatal — log and continue
    logger.error(`[myagent] Metrics processing failed (non-blocking): ${error instanceof Error ? error.message : error}`);
  }
}
```

---

## Testing rules

### Unit-test `enrichArgs` and version parsing

These are pure transformations. Test them without any I/O, mocks, or subprocess calls.

```typescript
// Example: enrichArgs test
it('prepends --model when config.model is set', () => {
  const result = metadata.lifecycle!.enrichArgs!(['--task', 'do something'], { model: 'my-model' } as AgentConfig);
  expect(result[0]).toBe('--model');
  expect(result[1]).toBe('my-model');
});
```

### Use fixture JSONL/JSON files for processor tests

Place fixtures in `__tests__/fixtures/`, named for the scenario they cover — not for dates or versions.

```
__tests__/fixtures/
  session-empty.jsonl           # empty session — processor returns no deltas
  session-single-turn.jsonl     # one user prompt, one assistant response with tool use
  session-error-response.jsonl  # API error in assistant message
```

### Mock the filesystem, not the adapter

Pass a fixture file path into the processor under test. Do not mock the session adapter.

```typescript
it('extracts one delta per assistant turn', async () => {
  const processor = new MyAgentMetricsProcessor();
  const session = await adapter.parseSessionFile(
    path.join(__dirname, 'fixtures/session-single-turn.jsonl'),
    'test-session-id',
  );
  const result = await processor.process(session, mockContext);
  expect(result.success).toBe(true);
});
```

### Don't test lifecycle hooks with real subprocesses

Inject env vars and spy on `processEvent`. No end-to-end agent invocations in unit tests.

```typescript
it('calls processEvent with SessionStart on session start', async () => {
  const processEvent = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../../../cli/commands/hook.js', () => ({ processEvent }));
  await plugin.metadata.lifecycle!.onSessionStart!('test-id', { CODEMIE_URL: 'http://local' });
  expect(processEvent).toHaveBeenCalledWith(
    expect.objectContaining({ hook_event_name: 'SessionStart' }),
    expect.any(Object),
  );
});
```

### One fixture per edge case

Each fixture covers exactly one scenario. Prefer fewer, named fixtures over large catch-all files.
```

- [ ] **Step 2: Verify build passes**

```bash
npm run typecheck
```

Expected: zero errors.
```
