# SSO Auth Gate: Wait-then-Allow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the prompt-time SSO gate starts a browser sign-in, hooks that can honour a block (Claude via `codemie hook`, claude-code-otlp, Gemini) wait for it and then allow the original prompt. Every other path gets clear, centralised manual-resume text.

**Architecture:** The detached child (`src/bin/sso-login.ts`) stamps failures into the existing lock as well as successes. A new poller in `sso.detached-login.ts` reads that lock. A new gate wrapper, `ensureCodeMieSsoAuthOrWait`, runs the gate, waits and then re-checks it. `hook.ts` and the claude-code-otlp adapter call the wrapper. Hook timeouts go up so the wait finishes before the host's timeout.

**Tech Stack:** TypeScript ESM, Vitest. **Spec:** inline requirements (EPMCDME-16568) + `technical-analysis.md` §1 AC1–AC7.

Commit per task using the repository's existing convention.

## Acceptance criteria

- [ ] AC1: An auth block message says the session expired, that this is expected (the prompt itself is fine), and what happens next.
- [ ] AC2: Claude (`codemie hook` and claude-code-otlp) and Gemini wait for a sign-in the gate started. On success the original prompt goes through with no resubmit.
- [ ] AC3: The prompt is let through once. The gate starts one sign-in, forwards no duplicate events and replays nothing.
- [ ] AC4: Kimi, OpenCode/codemie-code and programmatic (VSCode `config`) mode keep today's block/no-block behaviour. Their text tells the user to re-send the prompt after the login completes.
- [ ] AC5: If the sign-in fails, is cancelled or exceeds the wait limit, the hook blocks and shows the child's error plus `codemie profile login` recovery steps.
- [ ] AC6: No wait happens for a fail-closed gate error, when an API key is set, or on `cooldown`/`failed` outcomes.
- [ ] AC7: Vitest tests cover success+resume, failure, cancellation, wait limit, no duplicate events, and the message variants.

## Global Constraints

- Wait bound `SSO_LOGIN_WAIT_MS = 150_000`, poll `1_000` ms. Hook timeout for UserPromptSubmit is 180 s (Claude plugin `180`, otlp `180`, Gemini `180000`). The wait must stay below the timeout. We have not verified what Claude Code does when a hook times out, so treat the timeout as something the hook must never reach.
- All user-facing re-auth text stays in `describeLogin()`.
- Use `@/` imports with `.js` extensions and `logger`. Hook-gate stderr output is the documented exception (`console.error`).
- Out of scope: proxy-layer replay (`sso-session-expiry.plugin.ts`) and the shared cross-profile marker/lock (EPMCDME-16308). The re-check after a wait covers a lock released by another profile's login.

## Review Focus

- The lock was released by a different profile's login. The re-check must still block (Task 2 test).
- An `in-progress` login started by an earlier prompt. The wait applies, still bounded from this hook's start (Task 2 test).
- The child pid died without stamping the lock (crash). Treat it as failed immediately, not as a wait-limit expiry (Task 1 test).
- Programmatic mode must never wait (Task 3 test).
- Gemini is waited for on BeforeAgent only after the event normalises to UserPromptSubmit. Agent name `gemini` (Task 3 test).

---

### Task 1: Lock failure stamp, wait poller, message variants

**Files:** Modify `src/providers/plugins/sso/sso.detached-login.ts` (LoginLock :22-27, readLock :33-47, describeLogin :244-255) and `src/bin/sso-login.ts:28-38`. Test: `src/providers/plugins/sso/__tests__/sso.detached-login.test.ts`.

**Interfaces — Produces:**
```ts
export const SSO_LOGIN_WAIT_MS = 150_000;
export type LoginWaitResult = { status: 'succeeded' } | { status: 'failed'; error?: string } | { status: 'timeout' };
export async function releaseLoginLockOnFailure(error: string): Promise<void>;
export async function waitForDetachedSsoLogin(opts?: { timeoutMs?: number; pollMs?: number }): Promise<LoginWaitResult>;
export function describeLogin(outcome?: DetachedLoginOutcome, opts?: { resume?: 'auto' | 'manual'; wait?: LoginWaitResult }): string;
```

- [ ] **Step 1: Write failing tests.**
  - `waitForDetachedSsoLogin` returns `succeeded` when `succeededAt` is stamped mid-wait.
  - It returns `failed` with error `'Authentication cancelled by user'` from `failedAt`/`error`.
  - It returns `failed` when the lock pid is dead and nothing was stamped.
  - It returns `timeout` with `{timeoutMs: 50, pollMs: 10}` and a live pid.
  - `describeLogin('started', {resume:'auto'})` contains `expected` and `continue automatically` and does not contain `re-send`.
  - `describeLogin('started')` contains `expected` and `re-send your prompt`.
  - `{wait:{status:'failed',error:'X'}}` contains `X` and `codemie profile login`.
  - `{wait:{status:'timeout'}}` contains `re-send your prompt`.
- [ ] **Step 2:** Run `npx vitest run src/providers/plugins/sso/__tests__/sso.detached-login.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Add optional `failedAt`/`error` to `LoginLock` and `readLock`. `acquireLock` semantics stay unchanged: a dead pid still leads to cooldown/replace.
  - `releaseLoginLockOnFailure` mirrors `releaseLoginLockOnSuccess` (owner-only, `writeLockAtomically`).
  - The poller reads the lock every `pollMs`. `succeededAt` → succeeded. `failedAt` → failed. A missing lock or dead pid → failed. Deadline → timeout. It never throws.
  - `describeLogin` opens every variant with one shared line: "Your CodeMie sign-in session has expired — this is expected and not a problem with your prompt."
  - `resume:'auto'` ends with "…CodeMie will continue your prompt automatically once you finish signing in."
  - `manual`/`wait` variants end with "After login completes, re-send your prompt." The failure text names `error`.
  - In `sso-login.ts`, call `releaseLoginLockOnFailure(result.error ?? 'unknown error')` on failure (keep the `logger.error`).
- [ ] **Step 4:** Re-run. Expect PASS.

Test-first: yes — the poller returns `failed`/`timeout`/`succeeded` from lock state, and describeLogin auto/manual/failed/timeout variants carry the expected wording.

### Task 2: `ensureCodeMieSsoAuthOrWait`

**Files:** Modify `src/providers/plugins/sso/sso.auth-gate.ts` (AuthGateResult :23-25, new export after :62). Test: `src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts`.

**Interfaces:**
- Consumes: Task 1 `waitForDetachedSsoLogin`, `describeLogin`, `SSO_LOGIN_WAIT_MS`.
- Produces: `AuthGateResult` failure gains `waitResult?: LoginWaitResult`, plus:
```ts
export async function ensureCodeMieSsoAuthOrWait(input: AuthGateInput, opts?: { waitMs?: number; onWaitStart?: (message: string) => void }): Promise<AuthGateResult>;
```

- [ ] **Step 1: Write failing tests** (mock `sso.detached-login.js` as the existing tests do).
  - Wait `succeeded` and re-check ok → `{ok:true}`, `startDetachedSsoLogin` called once, `onWaitStart` called once with the auto text.
  - Wait `succeeded` but re-check still invalid (another profile) → `ok:false`.
  - Wait `failed` (cancel) → `ok:false` with `waitResult.status === 'failed'`.
  - Wait `timeout` → `ok:false` with `waitResult.status === 'timeout'`.
  - Outcome `in-progress` waits. `cooldown`, `failed`, an API key, or the "gate check failed unexpectedly" path → no wait (poller not called).
- [ ] **Step 2:** Run `npx vitest run src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Call `ensureCodeMieSsoAuth`. Wait only when `loginOutcome` is `started` or `in-progress`. Call `onWaitStart(describeLogin(outcome,{resume:'auto'}))`, then wait. On `succeeded`, return the result of one re-check `ensureCodeMieSsoAuth(input)`. Otherwise return the first failure plus `waitResult`.
- [ ] **Step 4:** Re-run. Expect PASS.

Test-first: yes — the wrapper allows after a successful wait plus re-check, blocks on failure/timeout, and never waits on non-credential paths.

### Task 3: `codemie hook` gate waits for claude/gemini

**Files:** Modify `src/cli/commands/hook.ts:579-624`. Test: create `src/cli/commands/__tests__/hook.auth-gate-wait.test.ts` (mock `@/providers/plugins/sso/sso.auth-gate.js`, spy `process.exit`, call `processEvent(event)` with `CODEMIE_AGENT` in env, following `hook.analytics-wiring.test.ts`).

**Interfaces — Consumes:** Task 2 wrapper, Task 1 `describeLogin` opts.

- [ ] **Step 1: Write failing tests.**
  - `CODEMIE_AGENT=claude` and `gemini`: the wrapper is called and an ok result means no `process.exit(2)`.
  - A failed `waitResult` exits 2 with stderr containing the error and `re-send your prompt`.
  - `kimi`/`opencode`/`codemie-code`: plain `ensureCodeMieSsoAuth` is called (no wait) and stderr says `re-send your prompt`.
  - Programmatic `config` throws without calling the wrapper.
- [ ] **Step 2:** Run `npx vitest run src/cli/commands/__tests__/hook.auth-gate-wait.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Add `const AUTH_WAIT_AGENTS = new Set(['claude', 'gemini'])` (Kimi's 5 s budget and OpenCode's ignored block cannot wait). When `!config` and the agent is in the set, call `ensureCodeMieSsoAuthOrWait(authInput, { onWaitStart: (m) => console.error(m) })`; otherwise call `ensureCodeMieSsoAuth`. Replace the "invalid — NOT being uploaded" lead line with `Reason:` + `describeLogin(outcome, { wait: authResult.waitResult })`.
- [ ] **Step 4:** Re-run. Expect PASS.

Test-first: yes — claude/gemini allow after a successful wait, and non-waiting agents and programmatic mode keep blocking with manual-resume text.

### Task 4: claude-code-otlp adapter waits

**Files:** Modify `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:433-467`. Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` (next to the :1553 block test).

- [ ] **Step 1: Write failing tests.**
  - A gate that resolves ok after waiting → exactly one UserPromptSubmit event forwarded (no duplicate) and no block emitted.
  - A wait timeout → block, the reason contains `re-send your prompt`, and no event is forwarded.
- [ ] **Step 2:** Run `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** `ensureProxyAuth` calls `ensureCodeMieSsoAuthOrWait(..., { onWaitStart: (m) => process.stderr.write(m + '\n') })`. The block reason becomes `describeLogin(outcome, { wait })` with the reason in parentheses. Keep `suppressOriginalPrompt`.
- [ ] **Step 4:** Re-run. Expect PASS.

Test-first: yes — a successful wait forwards the prompt once, and a timed-out wait blocks with manual text.

### Task 5: Raise UserPromptSubmit hook timeouts

**Files:**
- Modify `src/cli/commands/proxy/connectors/claude-code-otlp.ts:229,586`: add `CODEMIE_USER_PROMPT_HOOK_TIMEOUT_SECONDS = 180` for `UserPromptSubmit` and update the :231-239 comment.
- Modify `src/agents/plugins/claude/plugin/hooks/hooks.json:77`: `60` → `180`.
- Modify `src/agents/plugins/gemini/extension/hooks/hooks.json:47`: `60000` → `180000`.
- Test: `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts:88,226`.

- [ ] **Step 1:** Update the expectations so `UserPromptSubmit` expects `CODEMIE_USER_PROMPT_HOOK_TIMEOUT_SECONDS` (180) and other events keep `CODEMIE_HOOK_TIMEOUT_SECONDS`.
- [ ] **Step 2:** Run `npx vitest run src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`. Expect FAIL.
- [ ] **Step 3:** Apply the three config changes.
- [ ] **Step 4:** Re-run. Expect PASS.

Test-first: yes — the installed otlp settings give UserPromptSubmit a 180 s timeout.

---

**Negative-constraint pass:**
- No proxy replay: no task touches `sso-session-expiry.plugin.ts`.
- No waiting in programmatic mode: Task 3 test.
- No wait for non-credential reasons: Task 2 test.
- Wait bounded below the timeout: 150 s < 180 s (Global Constraints, Task 5).
- No duplicate events or replay: Task 2 and Task 4 tests.
- Shared marker (EPMCDME-16308) not changed: covered only by the re-check.
- Text not scattered: all of it lives in `describeLogin` (Task 1).
