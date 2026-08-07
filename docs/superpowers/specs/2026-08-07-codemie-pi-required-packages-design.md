# Design: Install Required Pi Packages with `codemie install pi`

**Status:** Approved for implementation  
**Scope:** Extend the `codemie-pi` agent plugin so that running `codemie install pi` installs Pi and then installs the three required Pi packages globally.

## 1. Goal

When a user runs:

```bash
codemie install pi
```

CodeMie must:

1. Install the Pi CLI (`@earendil-works/pi-coding-agent`) via the existing npm-based installation flow.
2. Install the following required Pi packages globally:
   - `git:github.com/obra/superpowers`
   - `npm:pi-subagents`
   - `npm:pi-mcp-adapter`

These packages live in `~/.pi/agent/git/` and `~/.pi/agent/npm/` after installation and are later copied into a project-local Pi agent directory by the existing `preparePiAgentDir` logic.

## 2. Background

- `PiPlugin` (`src/agents/plugins/pi/pi.plugin.ts`) extends `BaseAgentAdapter` and relies on `BaseAgentAdapter.install()` to install the npm package declared in `AgentMetadata.npmPackage`.
- `createInstallCommand` in `src/cli/commands/install.ts` calls `agent.additionalInstallation(options)` after the agent is installed.
- Pi’s own `pi install <source>` command installs packages globally by default.
- Pi already supports idempotent re-installation and skips unchanged packages.

## 3. High-level approach

**Approach B — Dedicated Pi package installer module.**

1. Create `src/agents/plugins/pi/pi.packages.ts`.
2. Export the list of required packages and an `installRequiredPiPackages()` function.
3. `PiPlugin.additionalInstallation()` invokes the installer after Pi itself is installed.

This keeps the package list and install logic isolated and testable without mixing it into the plugin metadata class.

## 4. File layout

```
src/agents/plugins/pi/
├── pi.plugin.ts          # Existing plugin; add additionalInstallation() override
├── pi.packages.ts        # NEW: required package list + installer
├── pi.setup.ts           # Existing agent directory preparation
├── pi.models.ts          # Existing live model generation
└── index.ts              # Existing re-exports
```

## 5. Implementation details

### 5.1 `pi.packages.ts`

```typescript
export const REQUIRED_PI_PACKAGES: readonly string[] = [
  'git:github.com/obra/superpowers',
  'npm:pi-subagents',
  'npm:pi-mcp-adapter',
];

export interface InstallPiPackagesOptions {
  /** Pi CLI command (default: 'pi') */
  cliCommand?: string;
  /** Working directory for the install process (default: process.cwd()) */
  cwd?: string;
  /** Per-package timeout in milliseconds (default: 300000) */
  timeout?: number;
}

export async function installRequiredPiPackages(
  options?: InstallPiPackagesOptions,
): Promise<void>
```

Behavior:

- Resolve `cliCommand` from options or fall back to `'pi'`.
- Run the following for each package in `REQUIRED_PI_PACKAGES`, sequentially:
  ```bash
  pi install <package>
  ```
- Use `exec` from `src/utils/exec.js`.
- Set `cwd` to `options.cwd ?? process.cwd()`.
- Set a per-package timeout (default 5 minutes).
- Log each package installation attempt using `logger.info` and success via `logger.success`.
- If a package installation returns a non-zero exit code, throw `AgentInstallationError` with the package and captured stderr/stdout (fail-fast).

### 5.2 `PiPlugin.additionalInstallation()`

Override in `src/agents/plugins/pi/pi.plugin.ts`:

```typescript
async additionalInstallation(
  _options?: import('../../core/types.js').AgentInstallationOptions,
): Promise<void> {
  await installRequiredPiPackages({ cliCommand: this.metadata.cliCommand });
}
```

The base adapter calls this after the npm install succeeds, so the `pi` binary is expected to be available in `PATH`.

### 5.3 Idempotency

`additionalInstallation()` is invoked every time `codemie install pi` runs, including when Pi is already installed. `pi install` handles already-installed packages efficiently, so no extra guard is required.

## 6. Error handling

| Scenario | Behavior |
|---|---|
| Pi binary missing after npm install | `exec` fails; throw `AgentInstallationError` with the command and failure reason. |
| One `pi install <pkg>` fails | Stop immediately; throw `AgentInstallationError` naming the failed package and including command output. |
| Network timeout during package install | `exec` timeout fires; propagate as `AgentInstallationError`. |
| Package already installed | `pi install` short-circuits; continue to the next package. |

## 7. Out of scope

- Installing packages project-locally (`pi install -l`). The user confirmed global install only.
- Pinning package versions or updating them separately from `codemie install pi`.
- Making the package list configurable via `codemie-cli.config.json` for this iteration.

## 8. Verification

Manual verification steps:

1. Run `codemie install pi`.
2. Confirm Pi CLI is installed: `pi --version`.
3. Confirm the three packages exist under `~/.pi/agent/`:
   - `~/.pi/agent/git/github.com/obra/superpowers`
   - `~/.pi/agent/npm/pi-subagents`
   - `~/.pi/agent/npm/pi-mcp-adapter`
4. Run `codemie-pi --task "hello"` in a test project and confirm `preparePiAgentDir` copies the packages into `<cwd>/.pi/codemie/agent/`.

## 9. References

- `src/agents/plugins/pi/pi.plugin.ts`
- `src/agents/plugins/pi/pi.setup.ts`
- `src/agents/core/BaseAgentAdapter.ts` — `additionalInstallation()` hook
- `src/cli/commands/install.ts` — install command flow
- `src/utils/exec.ts` — `exec()` utility
- `src/utils/errors.ts` — `AgentInstallationError`
- Pi README: `pi install <source>` semantics
