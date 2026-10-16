# PR #576 Round-4 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close review findings CR-001..CR-005 on `feat/agents-live-version-check` (EPMCDME-14767).

**Architecture:** Four local fixes: non-secret cache key in `version-cache.ts` (+ spec text), a guarded fallback lookup in `BaseAgentAdapter.blockIfBelowMinimum`, a below-minimum discriminator in `version-resolution.ts`, and a CONNECT-proxy test for `npm-registry.ts`.

**Tech Stack:** TypeScript (ESM, `.js` imports), Vitest (`unit`, `cli` projects), `node:crypto`, `node:http`.

**Spec:** inline requirements; research in `technical-analysis.md` (same dir).

Commit per task using the repository's existing convention.

## Acceptance criteria

- [ ] `~/.codemie/version-cache.json` never contains the resolved registry URL, its userinfo or any path segment; keys are `<origin-without-userinfo>#<sha256(full registry URL)>|<package>`, shared by `packages` and `failures`.
- [ ] Entries in the old raw-URL key format are dropped on load, so the next write removes them from disk.
- [ ] With `minimumSupportedVersion` set, a rejecting `checkVersionCompatibility()` no longer aborts `run()`; the failure is logged at debug.
- [ ] Live latest below the minimum: detailed result carries `liveBelowMinimum: true` and `resolveSupportedInstallVersion` returns the minimum; checks off / lookup failed still return `'latest'`.
- [ ] A test proves an `https://` registry uses the user `.npmrc` `https-proxy` (CONNECT to the registry host) and ignores a dead `HTTP_PROXY`/`HTTPS_PROXY`.
- [ ] spec.md §1 describes the real cache shape.

## Global Constraints

- ES modules, `.js` import extensions, no `any`, `logger` not `console`.
- Commit messages: Conventional Commits (scopes `agents`, `utils`, ...), ending with `Generated with AI\n\nCo-Authored-By: codemie-ai <codemie.ai@gmail.com>`.
- Commit with env `CODEMIE_SKIP_SECRETS_SCAN=1`; never `--no-verify`; do not push.
- Never stage `.codemie/codemie-cli.config.json` or `docs/superpowers/reviews/`.
- Every new test must be shown failing against the pre-fix code.

## Review Focus

- Registry URL that `new URL()` cannot parse — key must still be produced (origin placeholder `invalid-registry`), never the raw string. Test in Task 1.
- Secret in the failure path (`failures` map), not just `packages`. Test in Task 1.
- A valid new-format key must survive load (no wipe of the whole cache). Covered by Task 1's existing tests once `KEY` is computed.
- `run()` logging before its local `logger` declaration (TDZ) — logging only inside `blockIfBelowMinimum`. Task 2.
- Other fallback `toEqual` cases (checks off, prerelease, failed lookup) must not gain the new field. Task 3 keeps the existing assertions unchanged.

---

### Task 1: Non-secret version-cache key (CR-005) and spec §1 (CR-004)

**Files:**
- Modify: `src/utils/version-cache.ts:1-20` (imports), `:61-85` (`loadCache`), `:131-133` (key)
- Modify: `docs/superpowers/tasks/2026-09-22-agents-live-version-check/spec.md:48-50`
- Test: `src/utils/__tests__/version-cache.test.ts`

**Interfaces:**
- Produces: `export function versionCacheKey(registry: string, packageName: string): string`

Test-first: yes — a registry `https://user:s3cret@npm.example.com/tok-SECRET123/` written via both a successful and a failed lookup leaves neither `s3cret` nor `tok-SECRET123` in the cache file; a seeded legacy key `https://u:s3cret@npm.example.com/|<pkg>` is gone after the next write.

- [ ] **Step 1: Write the failing tests.** In `version-cache.test.ts` replace the literal `KEY` (L25) and the mirror literal (L160) with `versionCacheKey(<registry>, PKG)`. Add three tests: (a) success path with the secret registry (`state.registry`), read the written file, assert `not.toContain('s3cret')` / `'tok-SECRET123'` / `'user:'`; (b) same for the failure path (fetch mock returns `null`); (c) seed `packages` with the legacy key plus a fresh new-format entry, trigger a write for another package, assert the legacy key and secret are absent and the new-format entry remains. Add (d) unparsable registry `'not a url ${TOKEN}'` → key starts with `invalid-registry#`.
- [ ] **Step 2: Run** `npx vitest run --project unit src/utils/__tests__/version-cache.test.ts` — expect FAIL (`versionCacheKey` not exported; secret present).
- [ ] **Step 3: Implement.**

```ts
import { createHash } from 'node:crypto';

const KEY_PATTERN = /^[^|#\s]+#[0-9a-f]{64}\|/;

/** Cache key that never embeds the resolved registry URL (it may carry a token). */
export function versionCacheKey(registry: string, packageName: string): string {
  let origin = 'invalid-registry';
  try {
    origin = new URL(registry).origin; // origin excludes userinfo, path and query
  } catch {
    // keep the placeholder
  }
  const hash = createHash('sha256').update(registry).digest('hex');
  return `${origin}#${hash}|${packageName}`;
}
```

  In `loadCache`, skip any `packages`/`failures` key not matching `KEY_PATTERN` (comment: legacy raw-URL keys may hold secrets; dropping them lets the next save scrub the file). At L133 use `versionCacheKey(resolveRegistry(packageName), packageName)`.
- [ ] **Step 4: Spec.** Replace "Persists `{ [packageName]: { version, fetchedAt } }`" in spec §1 with the shape `{ version: 1, packages: { '<registry-id>|<package>': { version, fetchedAt } }, failures: { '<registry-id>|<package>': failedAt } }`, stating the registry id is the URL origin without userinfo plus a SHA-256 of the full resolved URL, and that old raw-URL keys are dropped on load.
- [ ] **Step 5: Run** the test file again — expect PASS.

### Task 2: Guard fallback lookup in blockIfBelowMinimum (CR-001)

**Files:**
- Modify: `src/agents/core/BaseAgentAdapter.ts:510`
- Test: `src/agents/core/__tests__/BaseAgentAdapter.version-notice.test.ts` (next to L261-272)

Test-first: yes — `adapterFor('2.1.230')` (default claude metadata, minimum `2.1.208`) with `checkVersionCompatibility` always rejecting and `warnOnceIfUntested` rejecting `'stop after version checks'`: `run([])` rejects with `'stop after version checks'`, `warnOnceIfUntested` called with `undefined`, `process.exit` not called.

- [ ] **Step 1:** Add the test; run `npx vitest run --project unit src/agents/core/__tests__/BaseAgentAdapter.version-notice.test.ts` — expect FAIL (rejects with the lookup error).
- [ ] **Step 2:** At L510, when `precomputed` is absent, `await this.checkVersionCompatibility()` inside try/catch; on failure `logger.debug('[BaseAgentAdapter] minimum-version check failed, continuing launch', { agent: this.metadata.name, error: String(error) })` (module-level `logger`) and `return`. Do not add logging in `run()`.
- [ ] **Step 3:** Re-run — expect PASS.

### Task 3: Install the minimum when live latest is below it (CR-002)

**Files:**
- Modify: `src/agents/core/version-resolution.ts:80-93`, `:129-136`, `:144-152`
- Test: `src/agents/core/__tests__/version-resolution.test.ts:134-140`, `:206-218`

**Interfaces:**
- Produces: `ResolvedSupportedVersion.liveBelowMinimum?: true` — set only by the below-minimum branch.

Test-first: yes — live `0.154.0` below minimum: detailed result `toEqual({ version: <fallback>, isCurrent: false, liveBelowMinimum: true })`, and `resolveSupportedInstallVersion` returns the `minimumSupportedVersion`.

- [ ] **Step 1:** Update the L134-140 expectation to include `liveBelowMinimum: true`; add the install-target test beside L206-218 (existing `'latest'` cases stay). Run `npx vitest run --project unit src/agents/core/__tests__/version-resolution.test.ts` — expect FAIL.
- [ ] **Step 2:** Add the optional documented field to the interface; in the below-minimum branch return `{ ...fallback, liveBelowMinimum: true }`; in `resolveSupportedInstallVersion` return `input.minimumSupportedVersion` when `result.liveBelowMinimum && input.minimumSupportedVersion`, else the existing rule. Update its JSDoc.
- [ ] **Step 3:** Re-run — expect PASS.

### Task 4: https-proxy CONNECT test (CR-003)

**Files:**
- Test: `src/utils/__tests__/npm-registry.test.ts` (near the proxy tests, L212-245)

Test-first: no — test-only coverage of existing behaviour; prove it can fail by temporarily removing `npmSetting('https-proxy')` from `proxyAgentFor` (`src/utils/npm-registry.ts:89-104`), observing the failure, then reverting.

- [ ] **Step 1:** Register `server.on('connect', (req, socket) => { connectTargets.push(req.url ?? ''); socket.destroy(); })` on the existing local server (reset `connectTargets` in `beforeEach`). Test: user `.npmrc` with `registry=https://registry.example.invalid/` and `https-proxy=http://127.0.0.1:<port>/` only; set `HTTP_PROXY`/`HTTPS_PROXY` to `http://127.0.0.1:1` (dead); `fetchLatestVersionFromRegistry(pkg, { timeoutMs: 2000 })` resolves `null`, and `connectTargets` equals `['registry.example.invalid:443']`. Run `npx vitest run --project unit src/utils/__tests__/npm-registry.test.ts` — PASS; perform the mutation check above, then revert.
