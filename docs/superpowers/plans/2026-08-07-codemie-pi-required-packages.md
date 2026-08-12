# Install Required Pi Packages with `codemie install pi` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `codemie install pi` install Pi and then globally install the three required Pi packages (`superpowers`, `pi-subagents`, `pi-mcp-adapter`).

**Architecture:** Add a dedicated `pi.packages.ts` module that runs `pi install <source>` for each required package, and wire it into `PiPlugin.additionalInstallation()` so it executes after the npm install of Pi succeeds.

**Tech Stack:** TypeScript, ES modules, Node.js `child_process` via the project’s `exec()` utility, project error classes.

## Global Constraints

- Packages must be installed **globally** (no `-l` project-local flag).
- Use the existing `exec()` utility from `src/utils/exec.ts` for all command execution.
- Fail-fast: if any package install fails, throw `AgentInstallationError` and abort the remaining installs.
- Respect `CODEMIE_PI_BIN` by using `this.metadata.cliCommand` from `PiPluginMetadata`.
- Per-package timeout default is 5 minutes (`300000` ms).
- Do not write or run tests unless the user explicitly asks; validate with `typecheck` and `lint` instead.
- Do not perform git operations unless the user explicitly asks.

---

### Task 1: Create the Pi package installer module

**Files:**
- Create: `src/agents/plugins/pi/pi.packages.ts`

**Interfaces:**
- Consumes: `exec` from `@/utils/exec.js`, `AgentInstallationError` from `@/utils/errors.js`, `logger` from `@/utils/logger.js`.
- Produces: `REQUIRED_PI_PACKAGES: readonly string[]`, `InstallPiPackagesOptions` interface, `installRequiredPiPackages(options): Promise<void>`.

- [ ] **Step 1: Write `src/agents/plugins/pi/pi.packages.ts`**

```typescript
import { exec } from '@/utils/exec.js';
import { logger } from '@/utils/logger.js';
import { AgentInstallationError } from '@/utils/errors.js';

export const REQUIRED_PI_PACKAGES: readonly string[] = [
  'git:github.com/obra/superpowers',
  'npm:pi-subagents',
  'npm:pi-mcp-adapter',
];

export interface InstallPiPackagesOptions {
  /** Pi CLI command name or path (default: 'pi') */
  cliCommand?: string;
  /** Working directory for the install commands (default: process.cwd()) */
  cwd?: string;
  /** Per-package timeout in milliseconds (default: 300000) */
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export async function installRequiredPiPackages(
  options: InstallPiPackagesOptions = {},
): Promise<void> {
  const cliCommand = options.cliCommand || 'pi';
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  logger.info(`[pi] Installing required Pi packages using ${cliCommand}`);

  for (const pkg of REQUIRED_PI_PACKAGES) {
    logger.info(`[pi] Installing package: ${pkg}`);

    const result = await exec(cliCommand, ['install', pkg], {
      cwd,
      timeout,
    });

    if (result.code !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      throw new AgentInstallationError(
        'pi',
        `Failed to install Pi package "${pkg}": ${output}`,
      );
    }

    logger.success(`[pi] Installed package: ${pkg}`);
  }
}
```

- [ ] **Step 2: Verify the new module compiles in isolation**

Run:
```bash
npx tsc --noEmit src/agents/plugins/pi/pi.packages.ts
```

Expected: no TypeScript errors.

---

### Task 2: Wire the installer into `PiPlugin.additionalInstallation()`

**Files:**
- Modify: `src/agents/plugins/pi/pi.plugin.ts`

**Interfaces:**
- Consumes: `installRequiredPiPackages` and `InstallPiPackagesOptions` from `./pi.packages.js`.
- Produces: `PiPlugin.additionalInstallation()` override.

- [ ] **Step 1: Add the import**

Add this import after the existing imports in `src/agents/plugins/pi/pi.plugin.ts`:

```typescript
import { installRequiredPiPackages } from './pi.packages.js';
```

- [ ] **Step 2: Add the `additionalInstallation` method to `PiPlugin`**

Insert the following method inside the `PiPlugin` class (after the `constructor`):

```typescript
  async additionalInstallation(
    _options?: import('../../core/types.js').AgentInstallationOptions,
  ): Promise<void> {
    await installRequiredPiPackages({ cliCommand: this.metadata.cliCommand });
  }
```

The full `PiPlugin` class should now look like:

```typescript
export class PiPlugin extends BaseAgentAdapter {
  constructor() {
    super(PiPluginMetadata);
  }

  async additionalInstallation(
    _options?: import('../../core/types.js').AgentInstallationOptions,
  ): Promise<void> {
    await installRequiredPiPackages({ cliCommand: this.metadata.cliCommand });
  }
}
```

- [ ] **Step 3: Verify the modified plugin compiles**

Run:
```bash
npx tsc --noEmit src/agents/plugins/pi/pi.plugin.ts
```

Expected: no TypeScript errors.

---

### Task 3: Project-wide validation

**Files:**
- (no new files; validates changes from Tasks 1 and 2)

- [ ] **Step 1: Run TypeScript typecheck**

Run:
```bash
npm run typecheck
```

Expected: zero TypeScript errors.

- [ ] **Step 2: Run linter**

Run:
```bash
npm run lint
```

Expected: zero ESLint warnings or errors.

- [ ] **Step 3: Run build**

Run:
```bash
npm run build
```

Expected: build completes successfully.

---

### Task 4: Manual smoke test (optional, requires Pi not already installed)

**Files:**
- (no new files)

- [ ] **Step 1: Run the install command**

```bash
codemie install pi
```

Expected output includes three sequential `pi install` steps and ends with success messages for all packages.

- [ ] **Step 2: Verify the packages exist globally**

```bash
ls ~/.pi/agent/git/github.com/obra/superpowers
ls ~/.pi/agent/npm/pi-subagents
ls ~/.pi/agent/npm/pi-mcp-adapter
```

Expected: all three directories exist.

---

## Self-Review

**Spec coverage:**
- Install Pi via existing flow → unchanged, still handled by `BaseAgentAdapter`.
- Install `git:github.com/obra/superpowers` → Task 1 `REQUIRED_PI_PACKAGES`.
- Install `npm:pi-subagents` → Task 1 `REQUIRED_PI_PACKAGES`.
- Install `npm:pi-mcp-adapter` → Task 1 `REQUIRED_PI_PACKAGES`.
- Global install only → Task 1 uses `pi install <pkg>` without `-l`.
- Fail-fast on error → Task 1 throws `AgentInstallationError` when `result.code !== 0`.
- Use configured CLI command → Task 2 passes `this.metadata.cliCommand`.

**Placeholder scan:** No TBD, TODO, or vague instructions remain.

**Type consistency:** `installRequiredPiPackages` accepts `InstallPiPackagesOptions` and is called with `{ cliCommand: string | undefined }`, which matches the optional `cliCommand` property.
