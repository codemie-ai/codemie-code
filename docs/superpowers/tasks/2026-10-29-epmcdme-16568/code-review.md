---
schema: sdlc-factory/code-review@1
decision: request-changes
reviewed_head: ecbf2f5211bc0d2d7c2bb49def78b5bf0b565158
---

# Code review — 2026-10-29-epmcdme-16568

**Decision:** request-changes (final round, confidence low)  
**Reviewed head:** `ecbf2f5` · **Rounds:** final

No story/spec acceptance audit ran (no-spec round), so confidence is low; CR-005 is an introduced ambiguity kept blocking. 6 blocking findings (claude-code-otlp 150s wait vs existing 30s hook timeouts, copilot gates missing the required wording, misleading expiry lead, untested hook timeouts, stderr-only wait notice, import type standard); 0 deferred; 15 lens candidates dismissed after reading the code (e.g. marker is cleared by CodeMieSSO.authenticate on success).

## Open — 6

### CR-001 · code · major — Type-only import missing import type

`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:22` · not re-checked

**Problem:** code-quality.md Imports rule requires `import type` for type-only imports; the line rewritten in this change imports the type AuthGateResult as a value alongside ensureCodeMieSsoAuthOrWait.

**Impact:** Violates a documented project standard on a line this change edited; no lint/typecheck gate enforces it (verbatimModuleSyntax is false, no consistent-type-imports rule).

**Recommendation:** Change to `import { type AuthGateResult, ensureCodeMieSsoAuthOrWait } from '@/providers/plugins/sso/sso.auth-gate.js';` per code-quality.md Imports rule.

### CR-002 · code · major — OTLP wait exceeds existing 30s hook timeout

`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:434` · not re-checked

**Problem:** ensureProxyAuth now always calls ensureCodeMieSsoAuthOrWait with the default 150s SSO_LOGIN_WAIT_MS, but the 180s UserPromptSubmit timeout is only written by writeClaudeCodeOtlpConfig (the explicit connect flow). Settings.json files written before this change keep CODEMIE_HOOK_TIMEOUT_SECONDS (30s) and nothing upgrades them; the plugin never checks that its wait fits the installed timeout (unlike the canWait guard in hook.ts).

**Impact:** For every upgraded claude-code-otlp user with expired SSO, Claude Code kills the hook at 30s mid-wait; a timed-out hook is a non-blocking error, so the prompt proceeds ungated, the block/re-send message is never shown and the prompt event is not forwarded — a behavior regression versus the previous immediate block.

**Recommendation:** Do not wait longer than the hook timeout that is actually installed. Either pass a `waitMs` that fits under CODEMIE_HOOK_TIMEOUT_SECONDS (30s) minus headroom when the configured UserPromptSubmit timeout is not known to be >= CODEMIE_USER_PROMPT_HOOK_TIMEOUT_SECONDS, or upgrade the stale codemie UserPromptSubmit timeout in managed settings.json automatically (e.g. on proxy/daemon start or via a migration) so upgraded users get 180s without re-running the connect flow.

### CR-003 · code · major — Bundled prompt-hook timeouts not pinned by tests

`src/agents/plugins/claude/plugin/hooks/hooks.json:77` · not re-checked

**Problem:** The claude UserPromptSubmit timeout (60->180 s) and gemini BeforeAgent timeout (60000->180000 ms) in the bundled hooks.json files are what let the hook survive the new 150s SSO_LOGIN_WAIT_MS wait, but no test reads them (installer tests mock readFile with `{hooks:{}}`; hook.auth-gate-wait.test.ts mocks the gate). The 'timeout must exceed the wait' invariant lives only in comments; only the claude-code-otlp connector constant is pinned.

**Impact:** If either value regresses or SSO_LOGIN_WAIT_MS is raised, the agent kills `codemie hook` mid-wait: the prompt is neither held nor given the block/re-send message, and the test suite stays green. Consumer: enforceAnalyticsAuthGate wait path in src/cli/commands/hook.ts:607-610.

**Recommendation:** Add a unit test that JSON-parses src/agents/plugins/claude/plugin/hooks/hooks.json and src/agents/plugins/gemini/extension/hooks/hooks.json and asserts the codemie UserPromptSubmit timeout (seconds) and BeforeAgent timeout (ms) exceed SSO_LOGIN_WAIT_MS with headroom.

### CR-004 · code · major — Copilot gates miss expected-expiry wording

`src/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.plugin.ts:148` · not re-checked

**Problem:** The task requires every block/error message to say the expiry is expected and to tell manual-resume agents to re-send after login. CopilotChatOtlpPlugin.buildBlock still hardcodes 'CodeMie SSO authentication is invalid ... A browser sign-in window has been opened automatically ...' and copilot-cli-otlp.plugin.ts:222 hardcodes 'CodeMie sign-in required ...'; neither uses describeLogin, which this change made the single home of re-auth text.

**Impact:** VS Code Copilot Chat and Copilot CLI users get neither the required 'this is expected / session expired' wording nor consistent guidance, and Copilot Chat claims a browser opened even on cooldown/failed outcomes — the user-requested message change is not delivered for these agents.

**Recommendation:** Build the auth-failure block text in CopilotChatOtlpPlugin.buildBlock and CopilotCliOtlpPlugin.buildBlock from describeLogin(loginOutcome) (manual resume), so they state the session expired as expected, say to re-send the prompt, and stop claiming a browser opened when the outcome was cooldown/failed. Update copilot-cli-otlp.plugin.test.ts:192 which asserts the old wording.

### CR-005 · code · major — Auto-resume notice likely invisible during wait

`src/cli/commands/hook.ts:609` · not re-checked

**Problem:** The 'finish signing in and your prompt will continue automatically' notice is written to stderr (console.error in hook.ts, process.stderr.write in claude-code-otlp.plugin.ts:444) while a prompt hook that will later exit 0 holds the prompt for up to 150s.

**Impact:** Reachability unconfirmed: depends on host behavior outside this repo. Claude Code surfaces exit-0 hook stderr only in verbose mode, so users likely see a prompt hanging up to 150s with no explanation, and the user-requested 'we will continue automatically after login' text never reaches them.

**Recommendation:** Confirm how Claude Code and Gemini surface stderr from a still-running prompt hook that later exits 0. If it is hidden, surface the auto-continue text through a channel the host displays (e.g. the browser sign-in landing page or a documented hook status/systemMessage output) and document any limitation. Ambiguous (no spec): the right channel needs a product decision.

### CR-006 · code · major — Expected-expiry lead used for non-expiry failures

`src/providers/plugins/sso/sso.detached-login.ts:310` · not re-checked

**Problem:** describeLogin defaults outcome to 'failed' and prepends EXPIRED_LEAD ('session has expired — this is expected') to every message. ensureCodeMieSsoAuth returns loginOutcome undefined when CODEMIE_API_KEY is set (metrics rejected the key) and when the gate itself throws ('auth gate check failed unexpectedly'); both now tell the user their sign-in session expired, that this is expected, and to run `codemie profile login`.

**Impact:** API-key users and users hitting an unexpected gate error are given a false cause and wrong remedy, with the prompt blocked; reachable from hook.ts and claude-code-otlp block paths.

**Recommendation:** Only prepend EXPIRED_LEAD when a browser sign-in outcome or wait result exists (no default 'failed' for an undefined outcome); for API-key and unexpected-error cases give neutral text and do not recommend `codemie profile login` to API-key users.

## Coverage

Standards: commit-format pass · code-quality partial · security pass
