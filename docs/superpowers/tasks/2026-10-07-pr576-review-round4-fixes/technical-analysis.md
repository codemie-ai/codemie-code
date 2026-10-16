# Technical Research

**Task**: version-cache npm-registry version-resolution BaseAgentAdapter
**Generated**: 2026-10-07
**Research path**: codegraph

---

## 1. Original Context

Repo C:\Users\Yauheni_Hil\repos\codemie-code, branch feat/agents-live-version-check (PR #576, EPMCDME-14767, live npm version tracking). Fix five code-review findings (round-4 review: docs/superpowers/reviews/2026-10-07-pr576-live-version-4/code-review-final.json). Commit on the current branch; do not push. Do not touch .codemie/codemie-cli.config.json or docs/superpowers/reviews/.

1. CR-005 (security) src/utils/version-cache.ts:133 — cache key is `${resolveRegistry(pkg)}|${pkg}`; resolveRegistry returns the env-expanded user .npmrc registry, so a token in the URL (${NPM_TOKEN} or user:pass@ userinfo) is written in plaintext to ~/.codemie/version-cache.json. Fix: key by a non-secret identifier — URL origin without userinfo plus a SHA-256 hash of the full resolved registry URL. Same key for packages and failures maps. Test: a registry URL containing a secret never appears in the written cache file.
2. CR-001 src/agents/core/BaseAgentAdapter.ts ~line 510 — run() swallows a rejected shared checkVersionCompatibility() and passes undefined, but blockIfBelowMinimum then calls checkVersionCompatibility() again unguarded; all live-tracked agents have minimumSupportedVersion, so a failure still aborts launch, contradicting the comment in run(). Fix: in blockIfBelowMinimum, catch the fallback lookup and return (continue launch) if it fails. Note: run() redeclares a local `logger` later (const { logger } = await import(...)), so referencing logger in run() before that line throws (TDZ). Test: run() with default claude metadata (minimum set) whose checkVersionCompatibility always rejects → launch continues (pattern in src/agents/core/__tests__/BaseAgentAdapter.version-notice.test.ts: spy warnOnceIfUntested to reject with 'stop after version checks').
3. CR-002 src/agents/core/version-resolution.ts:~129 — when live latest is below minimumSupportedVersion the resolver returns fallback isCurrent:false, so resolveSupportedInstallVersion returns 'latest' and install --supported installs that same below-minimum release from the lagging registry. Fix: resolveSupportedInstallVersion returns minimumSupportedVersion in that specific case (live below minimum), still 'latest' for genuinely unknown (checks off / lookup failed). Distinguish the case in the detailed result (e.g. an extra field) without changing existing callers' behaviour. Test it.
4. CR-003 test only — src/utils/__tests__/npm-registry.test.ts: add a test for an https:// registry with user .npmrc `https-proxy=<local test proxy>` only, asserting the proxy receives the CONNECT and a dead HTTP_PROXY/HTTPS_PROXY env is not used. Existing tests use a local http server and set CODEMIE_NO_SYSTEM_PROXY=1; a CONNECT handler (server.on('connect')) can record the target and close the socket.
5. CR-004 spec only — docs/superpowers/tasks/2026-09-22-agents-live-version-check/spec.md §1: describe the real cache shape: { version: 1, packages: { '<registry-id>|<package>': { version, fetchedAt } }, failures: { '<registry-id>|<package>': failedAt } }, keyed by a non-secret registry id.

Project rules: ES modules with .js imports, no `any`, logger not console, Conventional Commits (scopes: agents, utils, cli...), commit message ends with "Generated with AI\n\nCo-Authored-By: codemie-ai <codemie.ai@gmail.com>". Commits need env CODEMIE_SKIP_SECRETS_SCAN=1 (no Docker); never --no-verify. Validate with npm run typecheck, eslint on changed files, npx vitest run --project unit and --project cli (bash, Windows host). Prove each new test fails against the pre-fix code.

---

## 2. Codebase Findings

### Existing Implementations
- `src/utils/version-cache.ts` (162 lines) — `getCachedLatestVersion(pkg, {bypassCache})`. L133 `const key = \`${resolveRegistry(packageName)}|${packageName}\``; same `key` used for `cache.packages[key]` (L136, L158), `cache.failures[key]` (L138, L152, L159). Imports `resolveRegistry` from `./npm-registry.js`. `CacheFile = { version: 1; packages: Record<string, CacheEntry>; failures: Record<string,string> }`. `loadCache` keeps only well-formed entries; no `crypto` import yet.
- `src/utils/npm-registry.ts` — `readNpmrc` expands `${VAR}` from env (L38); `resolveRegistry(pkg)` (L78) returns `@scope:registry` / `registry` / default `https://registry.npmjs.org/`, always trailing `/`. `proxyAgentFor` (L89-104): NO_PROXY/noproxy first; for https: `npmSetting('https-proxy') || npmSetting('proxy')` -> `new HttpsProxyAgent(npmProxy)`; without npm proxy -> `getProxyAgentForUrl` (env vars then system proxy/PAC). `fetchLatestVersionFromRegistry(pkg, {timeoutMs})` returns null on any failure.
- `src/agents/core/version-resolution.ts` — `ResolvedSupportedVersion { version; isCurrent }` (L80-93). `resolveSupportedVersionDetailed` (L103-142): below-minimum branch L129-136 returns the shared `fallback` object (same as checks-off/failed/prerelease). `resolveSupportedInstallVersion` (L149-152): `isCurrent && version ? version : 'latest'`.
- `src/agents/core/BaseAgentAdapter.ts` — `checkVersionCompatibility()` L294 (destructures `{version, isCurrent}` only); `warnOnceIfUntested(precomputed?)` L421, whole body in try/catch; `blockIfBelowMinimum(precomputed?)` L505-545: returns early if no supportedVersion/minimum, then L510 `precomputed ?? await this.checkVersionCompatibility()` unguarded; throws in silentMode, else `process.exit(1)`. `run()` L550-565: `.catch(() => undefined)` on shared check; comment L558-560 documents the TDZ; `const { logger } = await import(...)` at L599 shadows the module-level `logger` (imported L6). `blockIfBelowMinimum` itself is outside run(), so module `logger` is usable there.
- `installVersion('supported')` callers of `resolveSupportedInstallVersion`: `BaseAgentAdapter.installVersion` L188-222 (npm `installGlobal`, codex/gemini), `ClaudePlugin.installVersion` (claude.plugin.ts:746, native installer), `KimiPlugin.installVersion` (kimi.plugin.ts:342), plus `src/cli/commands/setup.ts`. All pass `minimumSupportedVersion`.

### Architecture and Layers Affected
- Utils layer: `version-cache.ts`, `npm-registry.ts` (test only).
- Agent core layer: `version-resolution.ts`, `BaseAgentAdapter.ts`.
- Docs: spec.md §1 (L46-59 currently says `{ [packageName]: { version, fetchedAt } }`, L48-50).

### Integration Points
- `checkVersionCompatibility` has 7 callers (doctor AgentsCheck, setup, install, BaseAgentAdapter); `resolveSupportedVersionDetailed` result is destructured, so an added optional field is non-breaking at runtime.
- `resolveSupportedInstallVersion` has 9 callers; agent plugins' tests mock it.

### Patterns and Conventions
- `@/` alias imports with `.js` in version-resolution.ts; relative `./x.js` in utils. Error-swallowing helpers log via `logger.warn/debug` with `{ error: String(error) }`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/security/security-practices.md` — cited by review: never store tokens in plaintext files.
- `.ai-run/guides/testing/testing-patterns.md` — Vitest, dynamic-import mocking.

### Architectural Decisions
- npm-registry.ts L63-66 comment: project .npmrc ignored because registry URLs may embed `${TOKEN}`; this is the leak vector CR-005 names.
- run() comment L555-560: version-check failure must never stop launch.

### Derived Conventions
- Version-resolution "unknown" states all collapse to `isCurrent:false`; callers treat it as "no supported version configured".

---

## 4. Testing Landscape

### Existing Coverage
- `src/utils/__tests__/version-cache.test.ts` — mocks `../npm-registry.js` (`resolveRegistry: () => state.registry`), `../paths.js`, logger; hardcodes `KEY = \`https://registry.npmjs.org/|${PKG}\`` (L25) used by seedCache, assertions at L59, 102, 114, 122, 135, 140, 159, and a mirror key literal at L160. Has a registry-isolation test (L151-161).
- `src/utils/__tests__/npm-registry.test.ts` — one local `http` server (`createServer`, 127.0.0.1); `ENV_KEYS` saved/cleared incl. `HTTP(S)_PROXY`, `npm_config_https_proxy`, `CODEMIE_NO_SYSTEM_PROXY=1`; `writeUserNpmrc` helper; proxy tests use only `http://registry.example.invalid/` and `proxy=` key (L212-245). No CONNECT handler, no https registry test.
- `src/agents/core/__tests__/version-resolution.test.ts` — L134-140 asserts below-minimum result `toEqual({ version: '0.154.0', isCurrent: false })`; `resolveSupportedInstallVersion` tests L206-218 (live, null -> 'latest'). No below-minimum install test.
- `src/agents/core/__tests__/BaseAgentAdapter.version-notice.test.ts` — mocks version-resolution; default metadata = claude with `minimumSupportedVersion: '2.1.208'`; L261-272 tests rejected shared check only with `minimumSupportedVersion: undefined`.

### Testing Framework and Patterns
- Vitest; `vi.hoisted` state, `vi.mock` of relative paths, `vi.spyOn(adapter, ...)`; projects `unit` and `cli`.

### Coverage Gaps
- run() with minimum set and a rejecting check (CR-001).
- https-proxy branch / CONNECT path (CR-003).
- Secret absence in cache file (CR-005); below-minimum install target (CR-002).

---

## 5. Configuration and Environment

### Environment Variables
- `npm_config_registry`, `npm_config_userconfig`, `npm_config_https_proxy`, `npm_config_proxy`, `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, `CODEMIE_NO_SYSTEM_PROXY`, `CODEMIE_VERSION_CHECKS_ENABLED`, `CODEMIE_SKIP_SECRETS_SCAN` (commit hook).

### Configuration Files
- `~/.codemie/version-cache.json` via `getCodemiePath('version-cache.json')`; user `~/.npmrc`.

### Feature Flags and Deployment Concerns
- `workspace.versionChecks.enabled` toggle (checks off -> fallback, no lookup).

---

## 6. Risk Indicators

- `version-cache.test.ts` hardcodes the raw-URL key in ~9 places; any key-format change breaks them all (needs a shared key helper or computed KEY in the test).
- Existing cache files contain old raw-URL keys (possibly with secrets); `loadCache` keeps any string key, so old entries persist on disk until overwritten — the review recommends "migrate/ignore old keys". Speculative: stripping non-matching keys on load/save would be needed to scrub already-leaked secrets.
- `version-resolution.test.ts` L139 uses `toEqual` on the below-minimum result; adding a field there changes that assertion. Other fallback `toEqual` cases stay intact only if the new field is absent on them.
- CR-003 test: HTTPS through `HttpsProxyAgent` issues CONNECT to the local http server; `server.on('connect')` must be added in this shared server (or a second server) and the socket destroyed so the fetch resolves null within timeout. `HTTPS_PROXY` is in ENV_KEYS already.
- BaseAgentAdapter TDZ: any logging added inside run() before L599 throws; logging belongs in `blockIfBelowMinimum` (module logger).
- Speculative: CR-002 path for claude/kimi native installer passes the minimum version to `installNativeAgent`; plugin tests mock the resolver so are unaffected.

---

## 7. Summary for Complexity Assessment

Changes span two layers: utils (`version-cache.ts` key derivation; `npm-registry.test.ts` new test) and agent core (`version-resolution.ts` result discriminator + install target; `BaseAgentAdapter.blockIfBelowMinimum` guard), plus a spec.md §1 text edit. Each fix is local to one function with an already-identified location; roughly 4 source/doc files and 4 test files.

Novelty is low: SHA-256 via `node:crypto` for the key, a `.catch` guard mirroring run(), an optional field on `ResolvedSupportedVersion`. The CR-003 test is the most mechanical-risk item (HTTPS CONNECT against a plain http test server). All four touched modules have dedicated test files with established mocking patterns.

Key risks: brittle hardcoded cache keys in version-cache tests, a `toEqual` assertion on the below-minimum result, legacy secret-bearing keys already on disk, and the run() logger TDZ.

---

## 8. External References

- `docs/superpowers/reviews/2026-10-07-pr576-live-version-4/code-review-final.json` — resolved. CR-005 recommendation: "Key the cache by a non-secret registry identifier — e.g. URL origin plus a SHA-256 of the full resolved URL, or the unexpanded registry string — stripping userinfo; migrate/ignore old keys, and add a test asserting no env-expanded value reaches the file." CR-001: "guard the fallback lookup (e.g. `const compat = precomputed ?? await this.checkVersionCompatibility().catch(() => undefined); if (!compat) return;`) ... log the swallowed error". CR-002: "abort with a clear error ... or install the minimum instead of falling back to 'latest'" (task chose: install minimum). CR-003: "https:// registry and a user .npmrc containing only https-proxy=<local proxy>, asserting the proxy receives the CONNECT and that a dead HTTP_PROXY is not used." CR-004: amend spec §1 to the registry-scoped shape with failures map.
- `docs/superpowers/tasks/2026-09-22-agents-live-version-check/spec.md` §1 — resolved; L48-50 text to replace: "Persists `{ [packageName]: { version, fetchedAt } }` to a new JSON file under `~/.codemie/`".
