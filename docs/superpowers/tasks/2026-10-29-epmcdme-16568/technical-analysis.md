# Technical Research

**Task**: sso auth-gate hook reauth
**Generated**: 2026-10-29
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-16568 — [CLI Analitics][UX] Automatically resume blocked requests after successful SSO reauthentication

Background: When a CodeMie CLI request is rejected by an authentication-related hook (HTTP 401 / stale SSO credentials), the proxy daemon opens the browser for SSO reauthentication. After successful browser login, the terminal resumes silently or remains waiting with no guidance. The user must manually type 'retry' or resubmit the original prompt — confusing, especially for users unfamiliar with CodeMie hooks.
Goal: Automatically resume the blocked operation after successful authentication where technically supported, or provide clear, actionable recovery instructions when automatic resume is not possible.

Related: EPMCDME-15378 (Closed) hook timeout vs. browser sign-in duration; EPMCDME-16085 (Closed) telemetry delivery not recovering after SSO re-auth until proxy restart; EPMCDME-16308 (Ready for dev) wrong-profile SSO login blocking prompts.

Technical context (from ticket; verify line numbers, they may be stale):
- hook.ts: handleUserPromptSubmit (~line 533) calls enforceAnalyticsAuthGate (~552) on every UserPromptSubmit event.
- sso.auth-gate.ts: ensureCodeMieSsoAuth does a local credential check (reads ~/.codemie/analytics-auth-status.json) and may silently trigger browser re-auth before blocking. If credentials invalid, hook exits with process.exit(2) (Claude Code blocking exit code).
- sso.auth.ts: CodeMieSSO.authenticate() starts local HTTP server on random port, opens <codeMieBase>/v1/auth/login/<port>, handleCallback() decodes token, stores credentials, calls clearAnalyticsAuthStatus().
- metrics-api-client.ts: markAnalyticsAuthInvalid() (~line 90) writes stale-credential marker on 401/403 or HTML SSO redirect.
- auth-validation.ts: handleAuthValidationFailure() (~28) calls SSOSetupSteps.promptForReauth() when TTY present.
- No automatic retry: after the hook blocks, user must complete SSO and manually resubmit. HTTPClient.withRetry() in http-client.ts skips retries on 401/403 (~290).
- sso-auth.plugin.ts: SSOAuthPlugin throws AuthenticationError if SSO cookies invalid, directing users to run `codemie profile login`.

Acceptance criteria:
1. When a CLI hook rejects a request due to auth failure, a clear message explains what happened and what to do (e.g. 'Authentication required — your browser will open for login').
2. When browser SSO reauth completes successfully, the blocked CLI operation automatically resumes/retries without manual resubmit — where technically supported and safe.
3. Auto-retry generates no duplicate model requests, tool executions or analytics events.
4. If auth succeeds but auto-retry is not technically supported, an explicit message explains exactly how to resume manually.
5. If SSO fails, is cancelled or times out, the terminal shows clear recovery instructions and does not wait silently.
6. For security/policy denials (not credential expiry), the auto-retry path is never triggered.
7. Automated regression tests cover: successful login + auto-resume, auth failure, cancellation, retry limits, duplicate-event prevention.

Key research questions: In Claude Code's UserPromptSubmit hook, can the hook itself wait for browser SSO to complete and then exit 0 (allowing the prompt through = "auto-resume") instead of exit 2? What is the hook timeout configured for it (see EPMCDME-15378)? How do other agents (gemini, opencode, codemie-code hooks) hit the same gate? What message is currently printed on block, and on SSO failure/cancel/timeout?

---

## 2. Codebase Findings

### Existing Implementations
The ticket's picture is partly stale: since PR #624 (EPMCDME-15378) the gate no longer runs `CodeMieSSO.authenticate()` in-process. It starts a **detached** sign-in and returns at once.

- `src/providers/plugins/sso/sso.auth-gate.ts:62` `ensureCodeMieSsoAuth(input)` — a local-only check: API key, or stored cookies via `getStoredAnalyticsCredentials`, plus the `analytics-auth-status.json` marker filtered by `markerAppliesToProfile` (baseUrl/syncApiUrl/loginUrl match). On failure it calls `startDetachedSsoLogin(loginUrl)` (skipped when an API key is set) and returns `{ok:false, reason, loginOutcome}`. It **never waits** for the login. Reasons: `'no valid CodeMie SSO credentials found'`, `'CodeMie metrics endpoint rejected the stored credentials (...)'`, `'...gate check failed unexpectedly'` (fails closed).
- `src/providers/plugins/sso/sso.detached-login.ts` — the lock `~/.codemie/sso-login.lock` `{pid, startedAt, succeededAt?}`. Outcomes are `started | in-progress | cooldown | failed`. `LOCK_MAX_AGE_MS=150s`, `COOLDOWN_MS=30s`. `releaseLoginLockOnSuccess()` stamps `succeededAt`. `describeLogin(outcome)` holds all user-facing text: "A browser sign-in window has been opened automatically. Complete the sign-in, then re-send your prompt. If you closed the browser window, run `codemie profile login`." On `cooldown`: "The previous sign-in attempt did not complete. Run `codemie profile login`, then re-send your prompt."
- `src/bin/sso-login.ts` — the detached child. It runs `CodeMieSSO.authenticate({timeout: 120_000, quiet: true})`. Failure, cancel and timeout are **only written to the log** (`logger.error`, exit 1). Nothing tells the terminal. Success → `releaseLoginLockOnSuccess()`.
- `src/providers/plugins/sso/sso.auth.ts:80` `CodeMieSSO.authenticate` — local callback server, opens `${codeMieBase}/v1/auth/login/${port}`, waits for the callback (default 120s, AbortController on SIGINT/SIGTERM → `'Authentication cancelled by user'`). It stores the credentials, then calls `clearAnalyticsAuthStatus()` at :148.
- `src/cli/commands/hook.ts:560` `handleUserPromptSubmit` → `enforceAnalyticsAuthGate` (:579). It builds the message `"CodeMie analytics authentication is invalid — session metrics are NOT being uploaded.\nReason: …\n" + describeLogin(...)`, prints it to stderr and calls `process.exit(2)`. In programmatic mode (`config` set, VSCode) it throws `Error(message)` instead. Any other gate error is swallowed (non-blocking).
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:433-468` — `ensureProxyAuth` + `onUserPromptSubmit`. It returns `{decision:'block', reason:"CodeMie SSO authentication is invalid - you are blocked until you re-authenticate (…)\n"+describeLogin, hookSpecificOutput:{hookEventName:'UserPromptSubmit', suppressOriginalPrompt:true}}`. The JSON goes to stdout through `OtlpAgentAdapter.emitBlock` (`src/agents/core/OtlpAgentAdapter.ts:99,151`). On a block, no events are forwarded.
- `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts:261` and `copilot-chat-otlp.plugin.ts:192` — these also call `ensureCodeMieSsoAuth`, through their own block protocols.
- `src/providers/plugins/sso/proxy/plugins/sso-session-expiry.plugin.ts:76-118` — the proxy side. On an oauth2 302 redirect it calls `markAnalyticsAuthInvalid(..., targetApiUrl)`, then `startDetachedSsoLogin`, then returns a synthetic 401 `authentication_error` whose text includes `describeLogin`. This is the path that "opens the browser" in the middle of a model request.
- `src/providers/plugins/sso/proxy/plugins/credential-refresh.ts:69-115` — the proxy picks up fresh credentials when the marker clears (EPMCDME-16085 / PR #652).
- `src/utils/analytics-auth-status.ts` — marker read/write/clear. Best-effort, never throws.
- `src/agents/core/AgentCLI.ts:300-356` — at launch, an interactive `handleAuthValidationFailure` → `promptForReauth`. This is TTY only, not the hook path.

### Architecture and Layers Affected
- CLI hook layer: `src/cli/commands/hook.ts` (the unified handler for claude, gemini, opencode/codemie-code, kimi).
- Agent/plugin layer: the `claude-code-otlp` and copilot OTLP adapters; the hook configs in `src/agents/plugins/claude/plugin/hooks/hooks.json`, `gemini/extension/hooks/hooks.json`, `kimi/kimi.hook-config-injector.ts` and `codemie-code-hooks/shell-hooks-source.ts`.
- Provider/SSO layer: `sso.auth-gate.ts`, `sso.detached-login.ts`, `sso.auth.ts`, `src/bin/sso-login.ts`.
- Proxy plugin layer: `sso-session-expiry.plugin.ts`, `credential-refresh.ts`.

### Integration Points
Hook timeouts in use (relevant if the hook waits for the browser):
- Claude plugin `UserPromptSubmit`: `"timeout": 60` (seconds), in `claude/plugin/hooks/hooks.json:77`.
- claude-code-otlp settings: `CODEMIE_HOOK_TIMEOUT_SECONDS = 30`, in `src/cli/commands/proxy/connectors/claude-code-otlp.ts:229`. A comment there says UserPromptSubmit "can never be async" because the gate depends on Claude Code waiting for its decision.
- Gemini `BeforeAgent` (mapped to UserPromptSubmit, `gemini.plugin.ts:120`): `timeout: 60000` (ms), in `gemini/extension/hooks/hooks.json:47`.
- Kimi `UserPromptSubmit`: 5s, in `kimi.hook-config-injector.ts:35`.
- OpenCode/codemie-code: `chat.message` runs the UserPromptSubmit commands with `swallowErrors=true` and **ignores the parsed responses** (`shell-hooks-source.ts:397-421`). The exit-2 block is therefore not enforced for these agents.
- The detached sign-in timeout is 120s. That is longer than every hook timeout above.

Cross-process state: `~/.codemie/analytics-auth-status.json` (marker), `~/.codemie/sso-login.lock`, and the credential store. A single global marker can be written by several profiles (EPMCDME-16308 context).

### Patterns and Conventions
- OTLP dispatch: one `ForwardDecision` handler per event, with a single `emitBlock`/`forwardToSpool` site (`docs/ARCHITECTURE-OTLP-PLUGIN.md`). Subclasses override `emitBlock` for other host protocols.
- All user-facing re-auth text is centralised in `describeLogin()`. The hook, the OTLP adapter and the proxy 401 all reuse it.
- Cross-process coordination uses lock/marker files with atomic rename (`writeLockAtomically`), and the bookkeeping is best-effort and never throws.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/integration/external-integrations.md` — SSO auth section and retry table ("SSO token expired: No retry"). It does not describe the detached gate.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md`, `docs/ARCHITECTURE-PROXY.md`, `docs/AUTHENTICATION.md`, `docs/HOOKS.md` (exit 0 = success, 2 = blocking).
- `docs/superpowers/tasks/2026-10-15-epmcdme-15316-expired-sso-session/technical-analysis.md` — earlier analysis. It records that PR #624 moved re-login to the detached child.

### Architectural Decisions
- The gate is deliberately local-only, with no network probe on each prompt (`sso.auth-gate.ts` docblock).
- Detached login was chosen so the browser never blocks the hook (`src/bin/sso-login.ts` header; EPMCDME-15378).
- A 30s post-success cooldown stops a burst of browser re-opens (PR #655 review, `releaseLoginLockOnSuccess` docblock).
- The marker is matched to the profile so one profile's expiry does not block another (PR #655/#661).

### Derived Conventions
Use `@/` imports with `.js` extensions, the `logger` (no `console.log` debug output), and error classes rather than bare `Error`. The hook gate is the one exception: it uses `console.error` and `process.exit(2)`, as the Claude protocol requires.

---

## 4. Testing Landscape

### Existing Coverage
- `src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts` — pass/block, API key, detached start without awaiting, marker profile matching, fail-closed.
- `src/providers/plugins/sso/__tests__/sso.detached-login.test.ts` — lock outcomes and cooldown.
- `tests/integration/analytics-auth-gate.test.ts` — spawns `codemie hook` and asserts exit 0 or 2.
- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts:1553` — "emits no event when the SSO gate blocks the prompt".
- `sso-session-expiry.plugin.test.ts`, `sso-auth.plugin.test.ts`, `analytics-auth-status.test.ts`, `hook-routing-contract.test.ts`, and the copilot OTLP plugin tests.

### Testing Framework and Patterns
Vitest, with dynamic-import mocking after `vi.mock` (`.ai-run/guides/testing/testing-patterns.md`). The integration tests spawn the CLI with a temporary `CODEMIE_HOME`.

### Coverage Gaps
- Nothing tests `src/bin/sso-login.ts`, the child's failure, cancel or timeout reporting.
- Nothing tests waiting for or polling a login.
- Nothing tests that OpenCode/codemie-code ignore the gate's block.
- No test checks that a timed-out hook is handled.

---

## 5. Configuration and Environment

### Environment Variables
The gate reads `CODEMIE_PROVIDER`, `CODEMIE_URL`, `CODEMIE_SYNC_API_URL`, `CODEMIE_TARGET_API_URL` (falling back to `CODEMIE_BASE_URL`, which the proxy rewrites), `CODEMIE_API_KEY` and `CODEMIE_PROFILE_CONFIG` (`hook.ts:581-600`).

### Configuration Files
- Hook timeout configs as listed in Section 2.
- `~/.codemie/analytics-auth-status.json` and `~/.codemie/sso-login.lock` (resolved via `getCodemiePath`).

### Feature Flags and Deployment Concerns
No feature flag exists for the gate. Its trigger condition is `provider === 'ai-run-sso' || (ssoUrl && syncApiUrl)`. The detached child ships as `dist/bin/sso-login.js`, resolved relative to the module (`sso.detached-login.ts:237`).

---

## 6. Risk Indicators

- Hook timeouts are shorter than the sign-in: 30s (otlp), 60s (claude plugin, gemini) and 5s (kimi), against 120s for the sign-in. Speculative: having the hook wait and then exit 0 would need longer timeouts per agent, or it would be killed mid-wait. What Claude Code does on a hook timeout (fail-open or not) is not verified in this repo.
- Sign-in failure is silent. `src/bin/sso-login.ts` writes failure, cancel and timeout only to the log. No channel back to the terminal exists, which is the gap behind AC5. The next prompt only shows the generic `cooldown` text.
- The OTLP block sets `suppressOriginalPrompt: true` (`claude-code-otlp.plugin.ts:464`). The block message then omits the original prompt, which makes the manual resubmit described in AC4 harder.
- OpenCode/codemie-code ignore the UserPromptSubmit block (`shell-hooks-source.ts:421`). Their resume behaviour already differs from Claude's.
- Two independent gates (`hook.ts` and `claude-code-otlp`) carry different message text. Both rely on `describeLogin`.
- There are two triggers. The prompt-time gate is one. The other is a mid-turn proxy 401 from `sso-session-expiry.plugin.ts`, where the model request has already failed inside the agent. Speculative: auto-resume at the proxy layer (replaying a request) is where the AC3 duplicate-request risk lives.
- AC6 distinction: the gate's `reason` strings only cover credential states. A policy denial does not reach this gate today. The proxy's 403 handling is outside this analysis.
- The global marker and lock are shared across profiles (EPMCDME-16308), so a waiting hook could be released by another profile's login.
- Programmatic (VSCode) mode throws instead of exiting. Any new wait or retry behaviour has to respect the `config` branch.

---

## 7. Summary for Complexity Assessment

The change sits in the SSO provider layer (`sso.auth-gate.ts`, `sso.detached-login.ts`, `src/bin/sso-login.ts`), the CLI hook layer (`hook.ts` `enforceAnalyticsAuthGate`) and the OTLP adapter (`claude-code-otlp.plugin.ts` `onUserPromptSubmit`, and the copilot adapters that share `ensureCodeMieSsoAuth`). Per-agent hook timeout configs (Claude plugin 60s, otlp 30s, Gemini 60000ms, Kimi 5s) and possibly the proxy `sso-session-expiry` 401 path are adjacent. The core surface is about 4-8 files. All user-facing text is already centralised in `describeLogin()`.

The ticket's description is stale. The gate no longer runs SSO in-process: it starts a detached child and blocks immediately with "re-send your prompt" guidance. Auto-resume at the prompt gate would mean the hook waits on the lock or credentials to succeed. That collides with every agent's hook timeout, all shorter than the 120s sign-in. The child's failure, cancel and timeout outcomes are never surfaced; they are only logged. Gate semantics differ by agent: Claude and Gemini honour exit 2 or JSON block, OpenCode and codemie-code ignore it, and Kimi has a 5s budget. Whether the host fails open on a timeout is an external, unverified behaviour.

Unit coverage of the gate, the lock and the OTLP block is good, as is the integration coverage of exit codes. There is no coverage of the detached child's outcome reporting or of any wait/resume flow. The key risks are the timeout mismatch, silent sign-in failure, cross-profile shared state, and duplicate-request risk if resume is attempted at the proxy layer.

---

## 8. External References

None named by the task.
