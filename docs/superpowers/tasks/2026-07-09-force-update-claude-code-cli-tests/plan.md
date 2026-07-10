# Claude Code CLI Version Enforcement in Test Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure agent integration tests always run against `CLAUDE_SUPPORTED_VERSION` by replacing the binary presence check in `agent-build-setup.ts` with a version-aware check that force-installs the supported version when the installed version differs or is missing.

**Architecture:** Export `CLAUDE_SUPPORTED_VERSION` from `claude.plugin.ts`, then import it from the compiled dist in `agent-build-setup.ts` (after the build step). Compare against the running `claude --version` output; install via `ClaudePlugin.installVersion('supported')` only when the version differs or the binary is absent.

**Tech Stack:** TypeScript, Node.js `execSync`, Vitest globalSetup, `installNativeAgent` (via `ClaudePlugin.installVersion`)

---

### Task 1: Export CLAUDE_SUPPORTED_VERSION

**Test-first:** no — one-word additive change, no behaviour change

**Files:**
- Modify: `src/agents/plugins/claude/claude.plugin.ts:37`

- [ ] **Step 1: Add `export` to the constant declaration**

Open `src/agents/plugins/claude/claude.plugin.ts`. Line 37 currently reads:

```typescript
const CLAUDE_SUPPORTED_VERSION = '2.1.199';
```

Change it to:

```typescript
export const CLAUDE_SUPPORTED_VERSION = '2.1.199';
```

No other changes to this file.

- [ ] **Step 2: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: exits 0 with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agents/plugins/claude/claude.plugin.ts
git commit -m "feat(claude): export CLAUDE_SUPPORTED_VERSION constant"
```

---

### Task 2: Version-aware claude CLI check in agent-build-setup.ts

**Test-first:** no — no unit tests per spec; correctness verified by the existing agent integration test suite which uses this setup file

**Files:**
- Modify: `tests/setup/agent-build-setup.ts:52-70` (replace presence-only try/catch block)

- [ ] **Step 1: Replace the presence-only try/catch block with version-aware logic**

In `tests/setup/agent-build-setup.ts`, find the block starting at line 52:

```typescript
  try {
    execSync('claude --version', { stdio: 'pipe' });
    console.log('[agent-integration] claude CLI found.\n');
  } catch {
    console.log('[agent-integration] claude CLI not found — installing via codemie...');
    try {
      // Installer may exit non-zero on Windows when it warns that ~/.local/bin
      // is not yet in the system PATH — installation itself succeeds.
      execSync(`node ${resolve(root, 'bin/codemie.js')} install claude`, { cwd: root, stdio: 'inherit' });
    } catch {
      // Ignore exit code — verify the binary is actually present below.
    }
    // Re-add localBin in case the installer modified PATH during its run.
    if (!(process.env.PATH ?? '').includes(localBin)) {
      process.env.PATH = `${localBin}${pathSep}${process.env.PATH ?? ''}`;
    }
    execSync('claude --version', { stdio: 'pipe' }); // throws if install genuinely failed
    console.log('[agent-integration] claude CLI installed.\n');
  }
```

Replace it entirely with:

```typescript
  // Import supported version and plugin class from the just-built dist.
  // CLAUDE_SUPPORTED_VERSION is the single source of truth; when a developer
  // bumps it locally and runs tests, this block installs the correct version.
  const { CLAUDE_SUPPORTED_VERSION, ClaudePlugin } = await import(
    resolve(root, 'dist/agents/plugins/claude/claude.plugin.js')
  ) as {
    CLAUDE_SUPPORTED_VERSION: string;
    ClaudePlugin: new () => { installVersion(v: string): Promise<void> };
  };

  let installedVersion: string | null = null;
  try {
    const versionOutput = execSync('claude --version', { stdio: 'pipe' }).toString().trim();
    const match = versionOutput.match(/^(\d+\.\d+\.\d+)/);
    installedVersion = match ? match[1] : null;
  } catch {
    // Binary not found — installedVersion stays null.
  }

  if (installedVersion === CLAUDE_SUPPORTED_VERSION) {
    console.log(`[agent-integration] claude CLI ${CLAUDE_SUPPORTED_VERSION} already installed — skipping.\n`);
  } else {
    if (installedVersion) {
      console.log(
        `[agent-integration] claude CLI version mismatch (installed: ${installedVersion}, required: ${CLAUDE_SUPPORTED_VERSION}) — installing supported version...`,
      );
    } else {
      console.log(
        `[agent-integration] claude CLI not found — installing supported version ${CLAUDE_SUPPORTED_VERSION}...`,
      );
    }
    await new ClaudePlugin().installVersion('supported');
    // Re-add localBin in case the installer modified PATH during its run.
    if (!(process.env.PATH ?? '').includes(localBin)) {
      process.env.PATH = `${localBin}${pathSep}${process.env.PATH ?? ''}`;
    }
    execSync('claude --version', { stdio: 'pipe' }); // throws if install genuinely failed
    console.log(`[agent-integration] claude CLI ${CLAUDE_SUPPORTED_VERSION} installed.\n`);
  }
```

- [ ] **Step 2: Verify the build and typecheck pass**

```bash
npm run build
```

Expected: exits 0. If TypeScript errors appear, fix them before proceeding.

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add tests/setup/agent-build-setup.ts
git commit -m "feat(tests): enforce CLAUDE_SUPPORTED_VERSION in agent-build-setup"
```
