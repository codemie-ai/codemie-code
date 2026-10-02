# Profile-URL-First Platform Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Direct CodeMie platform calls use the profile `baseUrl` (P) first and the workspace `codeMieUrl` (W) as fallback; analytics stays on W.

**Architecture:** Resolver + credentials-lookup helpers in `src/providers/core/codemie-auth-helpers.ts`; call sites swap `codeMieUrl || baseUrl` for the helpers. No schema change, no migration.

**Tech Stack:** TypeScript ESM (`.js` imports, `@/` alias, no `any`, explicit export return types, `logger.debug`), Vitest with dynamic-import mocking.

Commit per task using the repository's existing convention (Conventional Commits, husky hooks; never `--no-verify`). Run only the narrowest Vitest files while iterating; run `npm run lint` and `npm run typecheck` on touched files at the end of each task.

## Acceptance criteria
- Same-host profile (P and W) resolves the same stored credentials as today.
- baseUrl-only SSO profile: login, refresh, logout, doctor/health, agent-start model list, skills auth all work.
- codeMieUrl-only SSO profile still works.
- Miss under P falls back to W.
- anthropic-subscription / moonshot-subscription resolve W only (baseUrl never probed).
- JWT model-list branch and analytics sync sites are unchanged.
- `.ai-run/guides/usage/project-config.md` has the W-vs-P note and no false `CODEMIE_PROJECT` override claim.

## Global Constraints
- STAY on W (do not touch): `syncCodeMieUrl`, `CODEMIE_SYNC_API_URL`, `sso.proxy.ts` ~102, session-sync, subscription templates, `AgentCLI.ts` ~315, Claude statusline, `proxy connect`, `test-metrics.ts` ~79, `skills-metrics.ts` ~359.
- No new env var; do not repoint `CODEMIE_URL`; no config schema change.
- Known risks: proxy-rewritten `CODEMIE_BASE_URL` before `executeBeforeRun` (use `CODEMIE_PROFILE_CONFIG`); split-host (W fallback mandatory); non-CodeMie `baseUrl` for subscription providers; nested-session leak via `Object.assign(process.env, env)` (BaseAgentAdapter ~629) can put the proxy URL into a child `codemie` command's baseUrl -- noted, out of scope (W fallback covers it when W is set); thin existing coverage.

## Task 1: Resolver and credentials-lookup helpers

**Files:** Modify `src/providers/core/codemie-auth-helpers.ts`; Test `src/providers/core/__tests__/codemie-auth-helpers.test.ts`.

**Test-first: yes -- `getPlatformUrl({provider:'ai-run-sso', baseUrl:P})` returns P before the function exists; matrix P-only, W-only, both, neither, bearer-auth, anthropic-subscription/moonshot-subscription (W only, P ignored), env parse of `CODEMIE_PROFILE_CONFIG`, malformed JSON falls back to `CODEMIE_URL`, split-host miss-on-P then hit-on-W, same-origin P/W looked up once.**

**Interfaces (Produces):**
```ts
export interface PlatformUrlSource { provider?: string; baseUrl?: string; codeMieUrl?: string }
export function getPlatformUrlCandidates(src: PlatformUrlSource): string[]; // ordered, deduped by origin
export function getPlatformUrl(src: PlatformUrlSource): string | undefined; // candidates[0]
export function getPlatformUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined;
export function getPlatformUrlCandidatesFromEnv(env: NodeJS.ProcessEnv): string[];
export interface PlatformCredentials { credentials: SSOCredentials; url: string }
export async function getStoredPlatformCredentials(src: PlatformUrlSource): Promise<PlatformCredentials | null>;
export async function getStoredPlatformCredentialsFromEnv(env: NodeJS.ProcessEnv): Promise<PlatformCredentials | null>;
```
- [ ] Write failing tests for the matrix above (mock `CodeMieSSO` via dynamic import, as `authenticateWithCodeMie` already does at `codemie-auth-helpers.ts:84`; `SSOCredentials` type comes from `@/providers/core/types.js`).
- [ ] Implement. Rules: `ai-run-sso` and `bearer-auth` (`ProviderName` in `types.ts:48-49`) -> `[baseUrl, codeMieUrl]`; any other/unknown provider -> `[codeMieUrl]`. Dedupe by `new URL(x).origin` (credential key is host-only, so a same-origin retry is guaranteed identical and would only repeat the destructive expired-credential delete in `sso.auth.ts:175`). The lookup tries candidates in order and returns the first non-null `getStoredCredentials(url)`; document in a JSDoc that one expired miss deletes only that host's key. `FromEnv`: `JSON.parse(env.CODEMIE_PROFILE_CONFIG)` in try/catch (original baseUrl still present there); on absent/invalid use `[env.CODEMIE_URL]`. Never read `env.CODEMIE_BASE_URL` (proxy-rewritten at `BaseAgentAdapter.ts:~1061`).
- [ ] Run `npx vitest run src/providers/core/__tests__/codemie-auth-helpers.test.ts`; commit.

## Task 2: Utility, skills and SSO-model credential lookups

**Files:** Modify `src/utils/sdk-client.ts:~49` (update the "not baseUrl" comment), `src/cli/commands/skills/lib/skills-search-client.ts:~114,~132`, `src/cli/commands/skills/lib/require-auth.ts:~27`, `src/providers/plugins/sso/sso.models.ts:~82,~92`. Tests (create) `src/utils/__tests__/sdk-client.test.ts`, `src/cli/commands/skills/lib/__tests__/require-auth.test.ts`, `src/providers/plugins/sso/__tests__/sso.models.test.ts`; extend `skills-search-client.test.ts`.

**Test-first: yes -- with a baseUrl-only SSO config each site finds credentials via P (fails today: `codeMieUrl || baseUrl` only tries W); with P miss + W hit it still succeeds.**

- [ ] Replace each `getStoredCredentials(codeMieUrl || baseUrl)` with `getStoredPlatformCredentials(config)`; in `sso.models.ts` the apiUrl fallback becomes `credentials.apiUrl || url` from the result. Keep error messages, using `getPlatformUrl(config)` in "Run: codemie profile login --url" hints.
- [ ] Run the four test files; commit.

## Task 3: SSO setup steps (validateAuth, getAuthStatus, re-auth prompt)

**Files:** Modify `src/providers/plugins/sso/sso.setup-steps.ts:~203,~268-277,~300`; Test (create) `src/providers/plugins/sso/__tests__/sso.setup-steps.test.ts`.

**Test-first: yes -- `getAuthStatus`/`validateAuth` succeed for a baseUrl-only SSO config; `promptForReauth` no longer bails when `codeMieUrl` is missing and re-auths against the resolved URL; anthropic-subscription config never probes its vendor `baseUrl`.**

- [ ] Switch both lookups to `getStoredPlatformCredentials`; `promptForReauth` requires `getPlatformUrl(config)` instead of `config.codeMieUrl`. `AgentCLI.ts:~315` gating stays as is (non-SSO providers resolve W only through the helper).
- [ ] Run the test file; commit.

## Task 4: profile login / logout / refresh

**Files:** Modify `src/cli/commands/profile/auth.ts:~64,~106,~124-134`; Test (create) `src/cli/commands/profile/__tests__/auth.test.ts`.

**Test-first: yes -- baseUrl-only config: `handleRefresh` proceeds (fails today on `!config.codeMieUrl`), clears and logs in with the SAME url; `handleLogin` uses `url || getPlatformUrl(config)`; logout clears every candidate URL.**

- [ ] `handleLogin`: `const codeMieUrl = url || getPlatformUrl(config)`. `handleRefresh`: keep the `authType === 'sso'` check, drop the W requirement; pick `url = getStoredPlatformCredentials(config)?.url ?? getPlatformUrl(config)`, error out if none, `clearStoredCredentials(url)` then `handleLogin(url)`. `handleLogout`: `clearStoredCredentials` for each of `getPlatformUrlCandidates(config)` (idempotent).
- [ ] Run the test file; commit.

## Task 5: Health and doctor

**Files:** Modify `src/providers/plugins/sso/sso.health.ts:~42-112` (including `modelProxy.setBaseUrl` at ~112), `src/cli/commands/doctor/checks/AIConfigCheck.ts:~76`; Test (create) `src/providers/plugins/sso/__tests__/sso.health.test.ts`; extend `src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts`.

**Test-first: yes -- health check on a baseUrl-only profile no longer errors on missing `codeMieUrl`; AIConfigCheck displays the resolved platform URL for SSO.**

- [ ] Use `getPlatformUrl` / `getStoredPlatformCredentials`; AIConfigCheck keeps its non-SSO Base URL branch untouched.
- [ ] Run both test files; commit.

## Task 6: Model lists -- claude, gemini, codex

**Files:** Modify `src/agents/plugins/claude/claude.models.ts:~157-180`, `gemini/gemini.models.ts:~96-103`, `codex/codex-models.ts:~381`; Tests: existing `claude/__tests__/claude.models.test.ts`, `gemini/__tests__/gemini.models.test.ts`, `codex/__tests__/codex-models.test.ts`.

**Test-first: yes -- with `CODEMIE_URL` unset and `CODEMIE_PROFILE_CONFIG` holding only `baseUrl`, the SSO branch fetches models (returns `[]` today); `CODEMIE_BASE_URL=http://localhost:PORT` is ignored; JWT branch tests stay green untouched.**

- [ ] In each SSO branch replace the `env.CODEMIE_URL` guard and lookup with `getStoredPlatformCredentialsFromEnv(env)`; return `[]`/existing behavior on null. Claude: cache key becomes `sso:${getPlatformUrlFromEnv(env) ?? ''}`. Leave the JWT branch byte-identical.
- [ ] Run the three test files; commit.

## Task 7: Model lists -- pi, kimi, copilot-cli

**Files:** Modify `pi/pi.models.ts:~258`, `kimi/kimi.models.ts:~139`, `copilot-cli/copilot-cli.models.ts:~157`; Tests: existing `pi.models.test.ts`, `kimi.models.test.ts`, `copilot-cli.models.test.ts` under each `__tests__`.

**Test-first: yes -- same baseUrl-only-in-`CODEMIE_PROFILE_CONFIG` case as Task 6 per file.**

- [ ] Same mechanical substitution as Task 6, including the "Run: codemie profile login --url ..." hint using `getPlatformUrlFromEnv(env)`. Run the three test files; commit.

## Task 8: Model lists -- opencode family

**Files:** Modify `src/agents/plugins/opencode/opencode-dynamic-models.ts:~146-173`, callers `src/agents/plugins/codemie-code.plugin.ts:~269` and `opencode/opencode.plugin.ts:~292` (pass `env` instead of `env.CODEMIE_URL`; adjust the function signature and any exported types); Test (create) `src/agents/plugins/opencode/__tests__/opencode-dynamic-models.test.ts`; keep `codemie-code-plugin.test.ts` and `opencode-gpt55-routing.test.ts` green.

**Test-first: yes -- baseUrl-only profile via `CODEMIE_PROFILE_CONFIG` resolves credentials; caller tests assert env is passed through.**

- [ ] Implement, run the three test files; commit.

## Task 9: Guide

**Files:** Modify `.ai-run/guides/usage/project-config.md` (~150-168).

**Test-first: no -- documentation only.**

- [ ] Add a short note: P (`baseUrl`) drives direct platform interaction (credentials, login/refresh/logout, model list, health/doctor), W (`workspace.codeMieUrl` -> `codeMieUrl`) drives analytics and is the fallback; subscription providers use W only. Correct the CI/CD section: `loadFromEnv` (`src/utils/config.ts:~449-500`) never reads `CODEMIE_PROJECT`; it is only exported to child env / `X-CodeMie-Project` / session records when config has no project. Commit.

## Self-review

- negative-constraints: (a) no new env var / no `CODEMIE_URL` repoint -- Task 1 reads `CODEMIE_PROFILE_CONFIG` only; (b) no baseUrl probing for non-CodeMie providers -- Task 1 candidate rule, asserted in Tasks 1 and 3; (c) no schema/migration -- no task touches config schema; (d) JWT branch and analytics/W-only sites untouched -- Tasks 6-8 keep JWT branch byte-identical, Global Constraints lists W-only files, no task touches them; (e) do not double-run destructive expired lookup -- Task 1 origin-dedupe.
- Coverage: requirements 1 -> Task 1; 2 -> Tasks 2-8; 3 -> Global Constraints; 4 -> Task 9.
