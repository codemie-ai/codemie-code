# SSO Hook Session-Profile Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The OTLP hook SSO gate authenticates against the profile the agent session was launched with, not whatever `ConfigLoader.load(process.cwd())` resolves in the current subdirectory (EPMCDME-16308).

**Architecture:** One shared helper, `resolveHookAuthProfile()`, returns `{ provider, ssoUrl, baseUrl }` for the gate. It prefers the launch-time profile the launcher already exports in `CODEMIE_PROFILE_CONFIG`. When that is absent (native `claude` / Copilot launches) it falls back to `ConfigLoader.load()` from the nearest ancestor directory holding a local `.codemie` config. All three `ensureProxyAuth()` copies (Claude, Copilot CLI, Copilot Chat) call the helper. `ConfigLoader` itself is not changed.

**Tech Stack:** TypeScript (ESM, `@/` alias, `.js` import suffixes), Vitest.

**Spec:** none (`sdlc-light`). Requirements = ticket EPMCDME-16308 acceptance criteria 1-5 + `technical-analysis.md` in this directory.

## Global Constraints

- ESM only; every relative/alias import ends in `.js`; no `any`; explicit return types on exports; no `console.log` (use `logger.debug`).
- Gate contract unchanged: `ensureCodeMieSsoAuth({ provider, ssoUrl, baseUrl })` / `ensureCodeMieSsoAuthOrWait(input, opts)` in `src/providers/plugins/sso/sso.auth-gate.ts`. `ssoUrl` stays `codeMieUrl || baseUrl`.
- Fail-closed behaviour preserved: if the fallback `ConfigLoader.load` throws, the error propagates to the plugin's existing catch (blocks with "an internal CodeMie error"). The helper must NOT swallow it.
- Never read `CODEMIE_BASE_URL` (the proxy rewrites it to a loopback URL); `CODEMIE_PROFILE_CONFIG` keeps the original (see `platformSourceFromEnv` in `src/providers/core/codemie-auth-helpers.ts`).
- Tests: Vitest, co-located `__tests__/`, nested `describe`, one concept per `it`. Run only the files touched (no full suite).
- Commits: Conventional Commits, scope `agents` (commitlint scope-enum rejects `sso`), subject mentions EPMCDME-16308; trailer `Generated with AI` + `Co-Authored-By: codemie-ai <codemie.ai@gmail.com>`. Local only — no push, no PR.

## Review Focus

- `CODEMIE_PROFILE_CONFIG` is malformed JSON or `{}` -> fall back to config resolution, do not return an empty profile (which would make the gate pass silently as "SSO not configured").
- Env profile is Production, cwd has no local config, global `activeProfile` is Preview -> gate input must be Production (the ticket's exact repro).
- Native launch (no `CODEMIE_PROFILE_*` env), session started in repo root with local config, hook cwd is a nested subfolder -> local profile still used via walk-up.
- `CLAUDE_PROJECT_DIR` set and differs from `process.cwd()` -> project dir wins as walk-up start.
- Non-SSO env profile (e.g. `litellm`) -> helper returns it unchanged, gate passes (`analyticsConfigured` false) — no regression to non-SSO sessions.

## File Structure

- Create `src/agents/core/hook-auth-profile.ts` — the helper (one responsibility: which profile does the gate check).
- Create `src/agents/core/__tests__/hook-auth-profile.test.ts` — real `ConfigLoader`, temp dirs.
- Modify `src/agents/core/event-fields/identity-fields.ts` — export existing `findNearestConfigDir` (no behaviour change).
- Modify the three plugins' `ensureProxyAuth()` and their existing plugin tests.

---

### Task 1: `resolveHookAuthProfile` helper

**Files:**
- Create: `src/agents/core/hook-auth-profile.ts`
- Modify: `src/agents/core/event-fields/identity-fields.ts` (add `export` to `findNearestConfigDir`, ~line 114)
- Test: `src/agents/core/__tests__/hook-auth-profile.test.ts`

**Interfaces:**
- Consumes: `ConfigLoader.load(dir)`, `ConfigLoader.hasLocalConfig(dir)` from `@/utils/config.js`; `findNearestConfigDir(startDir: string): Promise<string>`.
- Produces:
  ```ts
  export interface HookAuthProfile { provider?: string; ssoUrl?: string; baseUrl?: string }
  export async function resolveHookAuthProfile(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd()
  ): Promise<HookAuthProfile>
  ```

Test-first: yes — `resolveHookAuthProfile` does not exist; first test "returns the env launch profile even when cwd resolves to a different global profile" fails on import.

- [ ] **Step 1: Write failing tests** in `hook-auth-profile.test.ts`. Setup follows `src/utils/__tests__/config-project-override.test.ts`: `TEST_DIR` temp tree, `vi.spyOn(paths, 'getCodemieHome'/'getCodemiePath')` pointing the global config at `TEST_DIR/.codemie`, delete `CODEMIE_*` env vars in `beforeEach`, `fs.rm` in `afterEach`. Seed a global multi-provider config whose `activeProfile` is `standalone-qa` (`provider: 'ai-run-sso'`, `baseUrl: 'https://preview.example/code-assistant-api'`, `codeMieUrl: 'https://preview.example'`) and a repo-root local config with profile `control plane` (`baseUrl: 'https://prod.example/code-assistant-api'`, `codeMieUrl: 'https://prod.example'`). Pass `env` explicitly (never mutate `process.env` for the helper's inputs). Tests:
  - `describe('launch profile from env')`:
    - `it('returns provider, baseUrl and ssoUrl from CODEMIE_PROFILE_CONFIG regardless of cwd')` — cwd = nested dir without local config; expect prod `baseUrl`, `ssoUrl === 'https://prod.example'`, `provider === 'ai-run-sso'`; and `expect(profile.baseUrl).not.toContain('preview')`.
    - `it('uses baseUrl as ssoUrl when the profile has no codeMieUrl')`.
    - `it('returns non-SSO profiles unchanged')` — `provider: 'litellm'`.
    - `it('falls back to config resolution when CODEMIE_PROFILE_CONFIG is malformed JSON')`.
    - `it('falls back to config resolution when CODEMIE_PROFILE_CONFIG has no provider or baseUrl')` (`'{}'`).
  - `describe('fallback without launch env')`:
    - `it('walks up from a nested cwd to the nearest local config')` — env `{}`, cwd = `<repo>/a/b`; expect prod values.
    - `it('prefers CLAUDE_PROJECT_DIR over cwd as the walk-up start')`.
    - `it('uses the global profile when no ancestor has a local config')`.
    - `it('propagates ConfigLoader.load failures')` — spy `ConfigLoader.load` to reject; `await expect(...).rejects.toThrow('disk full')`.
- [ ] **Step 2: Run to verify failure:** `npx vitest run src/agents/core/__tests__/hook-auth-profile.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `resolveHookAuthProfile` in `src/agents/core/hook-auth-profile.ts`, and add `export` to `findNearestConfigDir`. Behaviour: (a) if `env.CODEMIE_PROFILE_CONFIG` parses to an object with a string `provider` or `baseUrl`, return `{ provider, baseUrl, ssoUrl: codeMieUrl || baseUrl }` (string-typed fields only); (b) otherwise `dir = await findNearestConfigDir(env.CLAUDE_PROJECT_DIR?.trim() || cwd)`, `config = await ConfigLoader.load(dir)`, return `{ provider: config.provider, baseUrl: config.baseUrl, ssoUrl: config.codeMieUrl || config.baseUrl }`. Parse errors in (a) fall through to (b) with `logger.debug`; errors in (b) propagate. Doc comment must state why `process.cwd()` and `CODEMIE_BASE_URL` are not used.
- [ ] **Step 4: Run to verify pass** — same command. Expected: all PASS.
- [ ] **Step 5: Commit** — `git add src/agents/core/hook-auth-profile.ts src/agents/core/__tests__/hook-auth-profile.test.ts src/agents/core/event-fields/identity-fields.ts`; message `fix(agents): resolve hook auth profile from the session launch config (EPMCDME-16308)`.

---

### Task 2: Wire the Claude Code OTLP plugin

**Files:**
- Modify: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:438-454` (`ensureProxyAuth`), drop the `ConfigLoader` import (line 24) if nothing else uses it.
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`

**Interfaces:**
- Consumes: `resolveHookAuthProfile(): Promise<HookAuthProfile>` (Task 1).
- Produces: `ensureProxyAuth()` passes `{ provider, ssoUrl, baseUrl }` from the helper to `ensureCodeMieSsoAuthOrWait`; timeout/wait logic untouched.

Test-first: yes — with `resolveHookAuthProfile` mocked to return the Production profile and `ConfigLoader.load` mocked to return a Preview config, a UserPromptSubmit must call `ensureCodeMieSsoAuthOrWait` with the Production `baseUrl`/`ssoUrl`; today it receives Preview, so the assertion fails.

- [ ] **Step 1: Write failing test** in the existing UserPromptSubmit describe (locate it by the `ensureCodeMieSsoAuthOrWait` usages in the file): `vi.mock('@/agents/core/hook-auth-profile.js', ...)` at the top with a `vi.fn`; add `hasLocalConfig: vi.fn(async () => false)` to the file's `ConfigLoader` mock. Test `it('checks SSO against the session profile, not the cwd-resolved config')`: helper -> `{ provider: 'ai-run-sso', ssoUrl: 'https://prod.example', baseUrl: 'https://prod.example/code-assistant-api' }`, `ConfigLoader.load` -> Preview values; assert `ensureCodeMieSsoAuthOrWait` first argument `toEqual` the helper's three fields, and that `ConfigLoader.load` was not called.
- [ ] **Step 2: Run:** `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` — Expected: new test FAILS.
- [ ] **Step 3: Implement** — replace the `ConfigLoader.load(process.cwd())` block with `const profile = await resolveHookAuthProfile();` and pass `profile.provider / profile.ssoUrl / profile.baseUrl`. Remove the now-unused import(s).
- [ ] **Step 4: Run** same command, plus `npx vitest run src/agents/core/__tests__/hook-auth-profile.test.ts`. Expected: PASS, and the pre-existing tests in the file still pass (update their mocks only if they relied on `ConfigLoader.load` feeding the gate).
- [ ] **Step 5: Commit** — `fix(agents): use the session profile for the Claude Code hook auth gate (EPMCDME-16308)`.

---

### Task 3: Wire the Copilot CLI and Copilot Chat OTLP plugins

**Files:**
- Modify: `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts:260-268`, `src/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.plugin.ts:187-195` (same replacement; drop unused `ConfigLoader` imports).
- Test: `src/agents/plugins/copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts`, `src/agents/plugins/copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts`

**Interfaces:**
- Consumes: `resolveHookAuthProfile()` (Task 1).
- Produces: both `ensureProxyAuth()` bodies call `ensureCodeMieSsoAuth({ provider, ssoUrl, baseUrl })` with the helper's values.

Test-first: yes — same shape as Task 2 for each plugin: with the helper mocked to Production and `ConfigLoader.load` mocked to Preview, the `ensureCodeMieSsoAuth` call must carry Production; fails today.

- [ ] **Step 1: Write failing test** in each file: `vi.mock('@/agents/core/hook-auth-profile.js', ...)`; `it('checks SSO against the session profile, not the cwd-resolved config')` on the same prompt-submit path the file's existing `ensureCodeMieSsoAuth` tests use; assert argument `toEqual` and `ConfigLoader.load` not called.
- [ ] **Step 2: Run:** `npx vitest run src/agents/plugins/copilot-cli-otlp src/agents/plugins/copilot-chat-otlp` — Expected: the two new tests FAIL.
- [ ] **Step 3: Implement** both replacements as in Task 2.
- [ ] **Step 4: Run** same command. Expected: all PASS. The existing "disk full" fail-closed tests mock `ConfigLoader.load` to reject: since the helper is now mocked in the new tests only, make sure those pre-existing tests still reach the real helper (unmock per-file via `vi.importActual`, or set the helper mock to delegate to `ConfigLoader.load` by default) so fail-closed stays covered.
- [ ] **Step 5: Commit** — `fix(agents): use the session profile for the Copilot hook auth gates (EPMCDME-16308)`.

---

## Self-Review

- AC1 (same profile as session): Tasks 1-3. AC2 (`--profile` preserved): `--profile` resolves into `CODEMIE_PROFILE_CONFIG` at launch (`AgentCLI.ts:221,418`); Task 1 env tests. AC3/AC4 (no env change on subdir move, Prod never opens Preview): Task 1 env + walk-up tests. AC5 (regression tests nested dirs + local/global): Task 1 uses the real `ConfigLoader` with both scopes.
- Out of scope (noted, not planned): `connect-orchestrator.ts:232` cwd-sensitivity; a `ConfigLoader` parent-directory walk-up (broad blast radius).
- Naming consistent: `resolveHookAuthProfile`, `HookAuthProfile`, `findNearestConfigDir` used identically across tasks.
