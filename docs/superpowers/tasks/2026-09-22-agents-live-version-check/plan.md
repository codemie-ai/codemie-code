# Smarter Agent Version Recommendations (EPMCDME-14767) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five allowlisted agents' (Claude, Codex, Gemini, Kimi, Copilot CLI) hand-edited `supportedVersion` constants with a live, 24h-cached npm lookup; unify `checkVersionCompatibility()` and `checkAgentForUpdate()` onto that single accessor; add one global fail-safe-enabled toggle gating all three flows; reword the two "verified" UI strings.

**Architecture:** A new `getCachedLatestVersion()` (npm-view wrapper + JSON TTL cache) backs a new `resolveSupportedVersion()` accessor keyed on an explicit agent-name allowlist. `BaseAgentAdapter.checkVersionCompatibility()` (already `async`) and every `'supported'`-keyword `installVersion()` implementation call the accessor instead of reading `metadata.supportedVersion` directly; `metadata.supportedVersion` itself stays a static per-plugin constant and becomes the accessor's fallback-of-last-resort. `checkAgentForUpdate()` drops Claude's special case and routes all five allowlisted agents' "latest" lookup through the same accessor. A single `workspace.versionChecks.enabled` config field (existing `ConfigLoader` priority chain, `metrics.enabled` precedent) gates the accessor's live path; when off or on any fetch failure, the accessor returns the static fallback with zero network I/O. `codemie doctor --refresh-versions` and `codemie update --force-refresh` bypass only the cache's TTL by deleting the cache file before checks run — no signature changes needed on `HealthCheck`/`AgentAdapter` for this.

**Tech Stack:** TypeScript, Node.js, existing `npm view` wrapper (`getLatestVersion`), `ConfigLoader`/`WorkspaceConfig`, Vitest (no new tests per repo policy — see Global Constraints).

**Spec:** `docs/superpowers/tasks/2026-09-22-agents-live-version-check/spec.md`

## Global Constraints

- Commit per task using the repository's existing convention.
- No new tests are written for this ticket (repo policy: tests only on explicit request) — every task below is `Test-first: no`.
- `minimumSupportedVersion` / `isBelowMinimum` / `blockIfBelowMinimum` stay hardcoded and untouched — no task may edit these.
- opencode and pi agents are never touched.
- Live-tracking allowlist is exactly `['claude', 'codex', 'gemini', 'kimi', 'copilot-cli']`, checked by explicit agent name — never by `npmPackage` presence. `claude-acp` and any other plugin fall straight through to the static fallback.
- No per-agent toggle — one global `workspace.versionChecks.enabled` switch only.
- An invalid/unrecognized stored value for the toggle (env var or config field) must resolve to "checks enabled" — fail-safe, the inverse of the existing `CODEMIE_DEBUG === 'true'` fail-closed convention.
- Only two UI strings change wording: `update.ts:289` and `setup.ts:783`. `AgentsCheck.ts`'s "CodeMie recommends v..." string is already correct and must not change.

---

### Task 1: Global `versionChecks` config toggle

**Files:**
- Modify: `src/env/types.ts:105-144` (`WorkspaceConfig` interface)
- Modify: `src/utils/config.ts:562-572` (`WORKSPACE_KEYS`), `src/utils/config.ts:412-432` (`loadFromEnv()`)

**Interfaces:**
- Produces: `WorkspaceConfig.versionChecks?: { enabled?: boolean }`, read anywhere via `(await ConfigLoader.load()).versionChecks?.enabled`. Env var `CODEMIE_VERSION_CHECKS_ENABLED`.

- [ ] **Step 1: Add the field**

  Add `versionChecks?: { enabled?: boolean };` to `WorkspaceConfig` (`src/env/types.ts`), next to the existing `metrics` field, with a one-line doc comment noting the fail-safe default (`true` unless explicitly `false`).

- [ ] **Step 2: Register it as a workspace-scoped key**

  Add `'versionChecks'` to the `WORKSPACE_KEYS` array (`src/utils/config.ts:562-572`) — same whole-object-override treatment as `'metrics'`.

- [ ] **Step 3: Read the env var fail-safe**

  In `loadFromEnv()` (`src/utils/config.ts:412-432`), add: when `process.env.CODEMIE_VERSION_CHECKS_ENABLED !== undefined`, set `env.versionChecks = { enabled: process.env.CODEMIE_VERSION_CHECKS_ENABLED !== 'false' }` — only the literal string `'false'` disables; anything else enables.

- [ ] **Step 4: Commit**

  `git add src/env/types.ts src/utils/config.ts && git commit -m "feat(config): add global versionChecks.enabled toggle"`

**Test-first: no** — config plumbing, no new tests per repo policy.

---

### Task 2: Export `extractVersion` as a shared utility

**Files:**
- Modify: `src/utils/version-utils.ts` (add export)
- Modify: `src/cli/commands/update.ts:37-40` (remove local copy, import instead)

**Interfaces:**
- Produces: `extractVersion(versionString: string): string | null` from `src/utils/version-utils.ts` — needed by both `update.ts` (already has it, locally) and the new `version-resolution.ts` (Task 4).

- [ ] **Step 1: Move the function**

  Copy the existing `extractVersion()` body from `update.ts:37-40` into `src/utils/version-utils.ts` verbatim, exported.

- [ ] **Step 2: Update the caller**

  In `update.ts`, delete the local `extractVersion` definition (lines 37-40) and import it from `../../utils/version-utils.js` instead (same import line as `compareVersions`/`isValidSemanticVersion`).

- [ ] **Step 3: Commit**

  `git add src/utils/version-utils.ts src/cli/commands/update.ts && git commit -m "refactor(version-utils): share extractVersion across callers"`

**Test-first: no**

---

### Task 3: Version cache module

**Files:**
- Create: `src/utils/version-cache.ts`

**Interfaces:**
- Consumes: `getLatestVersion(packageName, options)` from `src/utils/processes.ts:315`; `getCodemiePath()` from `src/utils/paths.ts`.
- Produces: `getCachedLatestVersion(packageName: string): Promise<string | null>` and `clearVersionCache(): Promise<{ removed: number }>`, both used by Task 4's `resolveSupportedVersion()` and Tasks 8/9's force-refresh flags.

- [ ] **Step 1: Write the module**

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';
import { getLatestVersion } from './processes.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000; // keeps a stale/first-run lookup from stalling agent startup

interface CacheEntry { version: string; fetchedAt: string; }
interface CacheFile { version: 1; packages: Record<string, CacheEntry>; }

const filePath = (): string => getCodemiePath('version-cache.json');
const emptyCache = (): CacheFile => ({ version: 1, packages: {} });

async function loadCache(): Promise<CacheFile> {
  try {
    const content = await fs.readFile(filePath(), 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as CacheFile).packages === 'object') {
      return parsed as CacheFile;
    }
    return emptyCache();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return emptyCache();
    logger.warn('[version-cache] corrupt or unreadable file — treating as empty', { error: String(error) });
    return emptyCache();
  }
}

async function saveCache(cache: CacheFile): Promise<void> {
  const file = filePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cache, null, 2), 'utf-8');
}

export async function getCachedLatestVersion(packageName: string): Promise<string | null> {
  const cache = await loadCache();
  const entry = cache.packages[packageName];
  const isFresh = entry && Date.now() - Date.parse(entry.fetchedAt) < TTL_MS;
  if (isFresh) return entry.version;

  try {
    const live = await getLatestVersion(packageName, { timeout: FETCH_TIMEOUT_MS });
    if (!live) return entry?.version ?? null;
    cache.packages[packageName] = { version: live, fetchedAt: new Date().toISOString() };
    await saveCache(cache);
    return live;
  } catch (error) {
    logger.debug('[version-cache] live lookup failed, using stale cache if present', {
      packageName,
      error: String(error),
    });
    return entry?.version ?? null;
  }
}

export async function clearVersionCache(): Promise<{ removed: number }> {
  const file = filePath();
  const cache = await loadCache();
  const removed = Object.keys(cache.packages).length;
  try {
    await fs.unlink(file);
    return { removed };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { removed: 0 };
    logger.warn('[version-cache] clear() failed; cache left in place', { file, code });
    return { removed: 0 };
  }
}
```

  This mirrors `version-warnings.ts`'s file-store shape (`{version, <collection>}`, ENOENT-tolerant load, best-effort save). Concurrent-CLI-invocation last-write-wins is acceptable per spec's Open Risks.

- [ ] **Step 2: Commit**

  `git add src/utils/version-cache.ts && git commit -m "feat(version-cache): add 24h TTL npm-lookup cache"`

**Test-first: no**

---

### Task 4: `resolveSupportedVersion()` accessor and live-tracked allowlist

**Files:**
- Create: `src/agents/core/version-resolution.ts`

**Interfaces:**
- Consumes: `getCachedLatestVersion` (Task 3), `ConfigLoader.load()` (`src/utils/config.ts`), `extractVersion` (Task 2), `logger` (`src/utils/logger.ts`).
- Produces: `LIVE_TRACKED_AGENT_NAMES`, `isLiveTrackedAgent(agentName: string): boolean`, `resolveSupportedVersion(input: ResolveSupportedVersionInput): Promise<string | undefined>` — consumed by Tasks 5, 6, 7, 8.

- [ ] **Step 1: Write the module**

```typescript
import { getCachedLatestVersion } from '../../utils/version-cache.js';
import { extractVersion } from '../../utils/version-utils.js';
import { ConfigLoader } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

export const LIVE_TRACKED_AGENT_NAMES = ['claude', 'codex', 'gemini', 'kimi', 'copilot-cli'] as const;

export function isLiveTrackedAgent(agentName: string): boolean {
  return (LIVE_TRACKED_AGENT_NAMES as readonly string[]).includes(agentName);
}

export interface ResolveSupportedVersionInput {
  agentName: string;
  npmPackage?: string | null;
  fallbackSupportedVersion?: string;
}

export async function resolveSupportedVersion(
  input: ResolveSupportedVersionInput
): Promise<string | undefined> {
  const { agentName, npmPackage, fallbackSupportedVersion } = input;

  if (!isLiveTrackedAgent(agentName) || !npmPackage) {
    return fallbackSupportedVersion;
  }

  let enabled = true;
  try {
    const config = await ConfigLoader.load();
    enabled = config.versionChecks?.enabled !== false; // fail-safe: only explicit `false` disables
  } catch (error) {
    logger.debug('[resolveSupportedVersion] config load failed, defaulting to enabled', { error: String(error) });
  }
  if (!enabled) {
    return fallbackSupportedVersion;
  }

  try {
    const live = await getCachedLatestVersion(npmPackage);
    const extracted = live ? extractVersion(live) : null;
    return extracted ?? fallbackSupportedVersion;
  } catch (error) {
    logger.debug('[resolveSupportedVersion] live lookup failed, using fallback', { agentName, error: String(error) });
    return fallbackSupportedVersion;
  }
}
```

  This is exactly Design §2's four-step decision (allowlist check → toggle check → cache lookup → fallback-on-failure) from the spec, and satisfies the fail-safe requirement from Task 1 by construction (`!== false`).

- [ ] **Step 2: Commit**

  `git add src/agents/core/version-resolution.ts && git commit -m "feat(agents): add resolveSupportedVersion live-tracking accessor"`

**Test-first: no**

---

### Task 5: Wire `BaseAgentAdapter` to the accessor

**Files:**
- Modify: `src/agents/core/BaseAgentAdapter.ts:284-319` (`checkVersionCompatibility`), `src/agents/core/BaseAgentAdapter.ts:180-199` (`installVersion`, default impl used by Codex/Gemini/Copilot-cli)

**Interfaces:**
- Consumes: `resolveSupportedVersion` (Task 4).
- Produces: `checkVersionCompatibility()`'s returned `supportedVersion` field is now the live-resolved value for allowlisted agents; downstream callers (`update.ts`, `setup.ts`, `install.ts`, `AgentsCheck.ts`) are unaffected in signature — none needed changing, since `checkVersionCompatibility()` was already `async`/awaited everywhere.

- [ ] **Step 1: Resolve the recommended version live**

  In `checkVersionCompatibility()` (`BaseAgentAdapter.ts:285`), replace `const supportedVersion = this.metadata.supportedVersion || 'latest';` with a call to `resolveSupportedVersion({ agentName: this.metadata.name, npmPackage: this.metadata.npmPackage, fallbackSupportedVersion: this.metadata.supportedVersion })`, then `const supportedVersion = resolved || 'latest';`. Update the `if (!this.metadata.supportedVersion)` guard at line 309 to `if (!resolved)` — same semantics for agents with no fallback defined, correct for allowlisted agents whose live value is now the source of truth.

- [ ] **Step 2: Resolve the `'supported'` install keyword live**

  In `installVersion()` (`BaseAgentAdapter.ts:186-196`), the `version === 'supported'` branch currently reads `this.metadata.supportedVersion` directly. Replace with the same `resolveSupportedVersion(...)` call as Step 1 so `codemie install <agent> --supported` installs the version `checkVersionCompatibility()` actually displayed, not a stale static constant. Keep the existing "throw if nothing resolved" guard, now checking the resolved value instead of `this.metadata.supportedVersion`.

- [ ] **Step 3: Commit**

  `git add src/agents/core/BaseAgentAdapter.ts && git commit -m "feat(agents): resolve supportedVersion live in BaseAgentAdapter"`

**Test-first: no**

---

### Task 6: Wire Claude plugin's `'supported'` install resolution

**Files:**
- Modify: `src/agents/plugins/claude/claude.plugin.ts:605-622` (`installVersion` override)

**Interfaces:**
- Consumes: `resolveSupportedVersion` (Task 4).

- [ ] **Step 1: Resolve live in the override**

  Same change as Task 5 Step 2, applied to Claude's own `installVersion()` override (it doesn't call the base implementation): the `version === 'supported'` branch (lines 610-617) currently sets `resolvedVersion = metadata.supportedVersion`. Replace with `resolvedVersion = await resolveSupportedVersion({ agentName: metadata.name, npmPackage: metadata.npmPackage, fallbackSupportedVersion: metadata.supportedVersion })`, keeping the existing throw-if-undefined guard. This is also what fixes `update.ts`'s `updateAgent()` Claude branch (`installVersion('supported')`, `update.ts:212-213`, unchanged) so the installed version matches what `checkAgentForUpdate()` reported as available.

- [ ] **Step 2: Commit**

  `git add src/agents/plugins/claude/claude.plugin.ts && git commit -m "feat(claude): resolve --supported install version live"`

**Test-first: no**

---

### Task 7: Wire Kimi plugin's `'supported'` install resolution

**Files:**
- Modify: `src/agents/plugins/kimi/kimi.plugin.ts:336-356` (`installVersion` override)

**Interfaces:**
- Consumes: `resolveSupportedVersion` (Task 4).

- [ ] **Step 1: Resolve live in the override**

  Same change as Task 6, applied to Kimi's `installVersion()` override: the `version === 'supported'` branch (lines 339-346) currently sets `resolvedVersion = this.metadata.supportedVersion`. Replace with the live-resolved value via `resolveSupportedVersion(...)`, same guard pattern. The `'npm'|'latest'|'stable'` branch (351-356) is untouched.

- [ ] **Step 2: Commit**

  `git add src/agents/plugins/kimi/kimi.plugin.ts && git commit -m "feat(kimi): resolve --supported install version live"`

**Test-first: no**

---

### Task 8: Unify `checkAgentForUpdate()`, drop the Claude special case, add `--force-refresh`

**Files:**
- Modify: `src/cli/commands/update.ts:45-141` (`checkAgentForUpdate`), `src/cli/commands/update.ts:286-292` (already-up-to-date message), `src/cli/commands/update.ts:238-252` (command options/action)

**Interfaces:**
- Consumes: `isLiveTrackedAgent`, `resolveSupportedVersion` (Task 4); `clearVersionCache` (Task 3).

- [ ] **Step 1: Delete the Claude special case**

  Remove the `if (agent.name === 'claude' && agent.checkVersionCompatibility) { ... }` block (`update.ts:58-79`) entirely. Claude has `metadata.npmPackage` set, so it now falls through to the standard npm-based-agents branch below.

- [ ] **Step 2: Route the five allowlisted agents' "latest" lookup through the accessor**

  In the standard npm-based-agents branch (`update.ts:108-140`), replace the unconditional `const latestVersion = await npm.getLatestVersion(npmPackage);` with: if `isLiveTrackedAgent(agent.name)`, call `resolveSupportedVersion({ agentName: agent.name, npmPackage, fallbackSupportedVersion: agent.metadata.supportedVersion })`; otherwise keep the existing direct `npm.getLatestVersion(npmPackage)` call unchanged (covers opencode/pi and any other manageable npm agent, per Non-goals). The rest of the function (`extractVersion`, `compareVersions`, return shape) is unchanged.

- [ ] **Step 3: Collapse the "already up to date" message**

  Replace the `if (agent.name === 'claude') { ... } else { ... }` split at `update.ts:287-292` with the single non-Claude message unconditionally: `` spinner.succeed(`${agent.displayName} is already up to date (${result.currentVersion})`); `` — Claude no longer needs distinct "verified" wording since it now goes through the same uniform check.

- [ ] **Step 4: Add `--force-refresh`**

  Add `.option('-f, --force-refresh', 'Bypass the 24h version cache and re-check npm')` to the `update` command (`update.ts:238-242`). At the top of the action handler, when `options?.forceRefresh` is set, `await clearVersionCache()` before either the single-agent or check-all-agents path runs. (When `versionChecks.enabled` is `false`, `resolveSupportedVersion()` never reads the cache regardless, so this is naturally a no-op per spec — no extra gating needed.)

- [ ] **Step 5: Commit**

  `git add src/cli/commands/update.ts && git commit -m "feat(update): unify version checks across all allowlisted agents"`

**Test-first: no**

---

### Task 9: Reword `setup.ts`'s "verified" string

**Files:**
- Modify: `src/cli/commands/setup.ts:783`

- [ ] **Step 1: Reword**

  Change `` console.log(chalk.yellow(`   CodeMie has only tested and verified v${compat.supportedVersion}`)); `` to `` console.log(chalk.yellow(`   A newer version is available: v${compat.supportedVersion}`)); ``. No other change — `checkAndInstallClaude()`'s existing `await claude.checkVersionCompatibility()` (already inside a 3s race-timeout guard, `setup.ts:772-777`) picks up the live-resolved value automatically via Task 5.

- [ ] **Step 2: Commit**

  `git add src/cli/commands/setup.ts && git commit -m "fix(setup): reword Claude version copy to newer-version framing"`

**Test-first: no**

---

### Task 10: `codemie doctor --refresh-versions`

**Files:**
- Modify: `src/cli/commands/doctor/index.ts:31-39`

**Interfaces:**
- Consumes: `clearVersionCache` (Task 3).

- [ ] **Step 1: Add the flag**

  Add `.option('--refresh-versions', 'Force a fresh agent version check (bypasses the 24h cache)')` alongside the existing `--reset-version-warnings` option (`doctor/index.ts:34`). In the action handler, when `options.refreshVersions` is set, call `await clearVersionCache()` and log a one-line confirmation (`Cleared version cache — N entries removed.`), mirroring the existing `--reset-version-warnings` block (`doctor/index.ts:36-38`) immediately above/below it. `AgentsCheck.buildDetail()` (`doctor/checks/AgentsCheck.ts:37-68`) needs no change — it already calls `agent.checkVersionCompatibility()`, which now transparently re-fetches once the cache file is gone.

- [ ] **Step 2: Commit**

  `git add src/cli/commands/doctor/index.ts && git commit -m "feat(doctor): add --refresh-versions to bypass the version cache"`

**Test-first: no**

---

## Self-Review Notes

- **Spec coverage:** Design §1 → Task 3. §2 → Tasks 4, 5, 6, 7, 8. §3 → Task 1 (+ fail-safe read in Task 4). §4 (notice-dedup) → no code change needed, confirmed no task touches `version-warnings.ts`. §5 (UI copy) → Tasks 8 Step 3, 9. Force-refresh (doctor/update) → Tasks 3, 8 Step 4, 10.
- **Negative constraints:** `minimumSupportedVersion`/`isBelowMinimum`/`blockIfBelowMinimum` — no task edits `BaseAgentAdapter.ts:472-` or any minimum-version constant. opencode/pi — never referenced by any task. Structural-vs-named allowlist — `isLiveTrackedAgent()` (Task 4) checks agent name, never `npmPackage` presence. No per-agent toggle — single `workspace.versionChecks.enabled` field (Task 1), no per-plugin field added. Fail-safe default — env var only disables on literal `'false'` (Task 1), config read only disables on literal `false` (Task 4). UI copy — exactly two strings reworded (Tasks 8, 9); `AgentsCheck.ts` explicitly left untouched (Task 10 note). No new tests — every task is `Test-first: no`.
- **Type consistency:** `resolveSupportedVersion(input: ResolveSupportedVersionInput): Promise<string | undefined>` (Task 4) is the single signature reused verbatim by Tasks 5, 6, 7, 8 — same field names (`agentName`, `npmPackage`, `fallbackSupportedVersion`) throughout. `getCachedLatestVersion`/`clearVersionCache` (Task 3) signatures match their call sites in Tasks 4, 8, 10.
