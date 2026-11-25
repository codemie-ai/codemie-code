# EPMCDME-16958: Headless SSO login (paste-back token)

## Problem

`CodeMieSSO.authenticate()` (`src/providers/plugins/sso/sso.auth.ts:74-182`) always starts a loopback HTTP server and opens a local browser. On a machine with no browser (e.g. Raspberry Pi) login cannot complete. Today the only options on `codemie profile login` and `src/bin/sso-login.ts` are `--url`. The `anthropic-subscription` provider has the same problem: its setup runs Claude Code's own `claude auth login`, which also expects a browser.

## Approach

Add an opt-in headless mode to `authenticate()`. It skips the local server and the browser, prints the login URL (`{apiBase}/v1/auth/login/{port}`, same shape as :116-117), and prompts for the result. The user opens the URL on any device, signs in, and copies either the raw token or the full redirected `http://localhost:<port>/?token=...` address from that device's address bar. The CLI accepts both forms.

The existing token parsing and credential resolution in `handleCallback` (:347-404: token query param, base64 JSON, `cookies` required, `/config.js` apiUrl lookup) is extracted into a pure parser so the HTTP callback and the paste path share it. Storage afterwards (`deriveExpiresAt`, `CredentialStore.storeSSOCredentials`, `withVerifiedOwner`, `clearAnalyticsAuthStatus`, :141-156) is unchanged.

The mode is never inferred. It is chosen by the user, either with a flag (`profile login`, `profile refresh`, `setup`) or at the interactive re-auth prompt.

## Behavior

- New optional field on `SSOAuthConfig` (`src/providers/core/types.ts:413-429`), for example `headless?: boolean`. Absent means current behavior, so existing callers and mocks are unaffected.
- `codemie profile login --no-browser` (alias `--headless`) sets it. `codemie profile refresh` re-enters login and passes the same flag.
- `codemie setup` gets a new `--no-browser` option (alias `--headless`); `src/cli/commands/setup.ts:37-38` defines only `--force` and `-v/--verbose` today. It reaches every browser login that setup triggers:
  - `authenticateWithCodeMie` (`src/providers/core/codemie-auth-helpers.ts:90`) gets an optional headless parameter that it passes to `CodeMieSSO.authenticate`.
  - `SSOSetupSteps.getCredentials` (`sso.setup-steps.ts` ~:135, the first-time SSO login in setup) passes it.
  - The analytics-sync login in `anthropic-subscription.setup-steps.ts:72` and `moonshot-subscription.setup-steps.ts:59` passes it.
  - `promptForReauth` (`sso.setup-steps.ts` ~:278-307) takes an optional headless parameter and passes it when invoked from setup. When called from `codemie setup --no-browser`, the choice prompt below is skipped and headless is used.
- Carrying the flag: `ProviderSetupSteps.getCredentials(isUpdate?: boolean)` (`src/providers/core/types.ts:300`, called at `setup.ts:252`) gains a second optional parameter `options?: { headless?: boolean }`. Setup steps that do not log in through the browser (bedrock, jwt, litellm, ollama) keep their current signatures and ignore it; TypeScript accepts implementations with fewer parameters, so they need no edit.
- Agent-launch re-auth prompt: `promptForReauth` is reached from `handleAuthValidationFailure` (`src/providers/core/auth-validation.ts`) via `AgentCLI.ts:343/385`, `profile/index.ts:145` and `src/utils/auth.ts` `promptReauthentication`. It stops asking yes/no "Re-authenticate now?" and offers three choices: sign in with the browser (the default, matching today's yes), paste a token (runs headless mode), or no. The prompt appears only when a TTY is attached; the `isNonInteractiveEnvironment` guard is unchanged, so without a TTY it still prints the error and returns false. There is no flag on agent commands.
- Prompt input is read without echo. The pasted value is never logged or printed; logging goes through the existing sanitizer (`sanitizeLogArgs`). Parse errors map to fixed messages that never include the input.
- Input is trimmed and validated. A pasted URL has its `token`/`auth`/`data` param extracted. Anything that is not a valid base64 JSON payload with `cookies` gives a clear project error and may be retried a limited number of times under one overall deadline, then fails.
- The port in the printed URL is a random high port per attempt that is never bound. Assumption: the backend accepts any port in `/v1/auth/login/{port}` and redirects there, so the address bar on the other device shows the token. This is unverified.
- Headless mode shows no spinner, and prints the URL and prompt even when `quiet` is set. Ctrl+C aborts cleanly, the terminal is restored (echo back on) in all exits, and the timeout applies to the prompt. In `refresh`, existing credentials are cleared only after a successful store.
- Without a TTY on stdin, headless mode fails fast with a message instead of hanging.

### anthropic-subscription browserless login

Facts (from code read, Claude Code docs and a local check, not re-verified here):
- `AnthropicSubscriptionSetupSteps.getCredentials` (`anthropic-subscription.setup-steps.ts:29-50`) runs `claude auth status --json`; if not logged in it runs `runClaudeBrowserLogin()` (`anthropic-subscription.auth.ts:18`: `exec('claude', ['auth','login'], {timeout: 300000, interactive: true})`), re-checks, and throws `ConfigurationError` "Claude Code authentication is required. Complete `claude auth login` and run setup again." if still not logged in.
- Local `claude auth login --help` (Claude Code 2.1.327) has only `--claudeai`, `--console`, `--email`, `--sso`; there is no `--no-browser`.
- Claude Code docs: when no browser opens, `claude auth login` prints a login URL; the user opens it on any device, signs in and pastes the code at a "Paste code here" prompt read from stdin. `claude setup-token`, run on a machine with a browser, prints a one-year token for Pro/Max/Ultra/Team/Enterprise; set as `CLAUDE_CODE_OAUTH_TOKEN` on the headless machine, it covers model requests only.
- Local check: `CLAUDE_CODE_OAUTH_TOKEN=<anything> claude auth status --json` returns `loggedIn: true`, `authMethod: "oauth_token"` (the token is not validated by status), so the existing status check already accepts the env-token route. The provider's `beforeRun` (`anthropic-subscription.template.ts:42-67`) removes `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` but not `CLAUDE_CODE_OAUTH_TOKEN`.

Design, kept minimal and adding no claude flag:
1. With `codemie setup --no-browser`, before running `claude auth login`, the step prints instructions: open the URL that Claude prints on any device, sign in, and paste the code back at the prompt. `claude auth login` runs interactively with stdin/stdout passed through so the paste prompt works, with a clear timeout message. Without a TTY, the step fails fast with a message instead of hanging.
2. If status already reports `loggedIn` (including `authMethod: oauth_token`), the login is skipped, as today. When login is needed in headless mode, the failure and instruction messages also point to the alternative: run `claude setup-token` on a machine with a browser, then export `CLAUDE_CODE_OAUTH_TOKEN` on this machine.
3. The final-status `ConfigurationError` message mentions both routes: `claude auth login` (paste the code from any device) and `claude setup-token` plus `CLAUDE_CODE_OAUTH_TOKEN`. Without the flag the browser path is unchanged and only that error text changes.

Rejected alternatives:
- Wrapping the token into CodeMie config or storage: adds a second secret store and a custom refresh and expiry story for something Claude Code already handles.
- Passing a `BROWSER` override or similar to suppress the browser: depends on undocumented Claude Code behavior, and Claude already prints the URL when no browser opens.
- A new `claude auth login` flag: none exists, so it cannot be relied on.
- Re-implementing Claude's OAuth in codemie: far larger scope and a security risk.

### Headless hint (text only)

Where the CLI tells a user to sign in, it also mentions `codemie profile login --no-browser` for machines without a browser. Strings only, no behavior change:

- `describeLogin()` in `src/providers/plugins/sso/sso.detached-login.ts:401-440`: the started/in-progress case (which says a browser window opened) gets one added line; the failed, succeeded-but-still-unauthenticated, timeout, cooldown and open-failed cases that name `codemie profile login` also name the `--no-browser` form.
- `requireAuthenticatedSession` message in `src/cli/commands/skills/lib/require-auth.ts:17` gets the same addition.
- The "Re-authenticate later with: codemie profile login --url ..." message (`AgentCLI.ts:389`) also names the `--no-browser` form.
- The detached `sso-login.ts`, the hook gate (`sso.auth-gate.ts`), the proxy daemon and the session-expiry plugin keep their behavior: no headless mode there.
- Existing tests that assert these message texts are updated.

## Acceptance criteria

1. `codemie profile login --no-browser` (and `--headless`) prints the login URL, starts no HTTP server and opens no browser.
2. The command then prompts for the token without echoing it.
3. Pasting the raw token or the full `localhost:<port>/?token=...` URL both succeed and store credentials exactly as the browser flow does.
4. An invalid or empty paste gives a clear error, stores nothing, and allows only a limited number of retries within one deadline.
5. `codemie profile refresh` honors the flag; without it behavior is unchanged. A failed headless `refresh` does not leave the user logged out.
6. `codemie setup --no-browser` (and `--headless`) is accepted. Every SSO login setup triggers (first-time SSO credentials, setup re-auth, and the anthropic- and moonshot-subscription analytics-sync login) uses headless mode and opens no browser or server, and setup's re-auth skips the choice prompt. Without the flag, setup behaves as today. Other provider setup steps are unaffected.
7. The agent-launch re-auth prompt, when a TTY is attached, offers browser / paste token / no; the browser option is the default and behaves as today's "yes".
8. Choosing paste token at that prompt runs headless mode and stores credentials on success; choosing no declines as today.
9. With no TTY the re-auth prompt still prints the error and returns false, with no choice shown.
10. `codemie setup --no-browser` with the anthropic-subscription provider prints instructions for pasting the code from any device, then runs `claude auth login` interactively with stdin/stdout passed through.
11. In that flow, if status already reports `loggedIn` (including `authMethod: oauth_token`), the login is skipped.
12. In that flow, with no TTY, setup fails fast with a clear message instead of hanging.
13. The instruction and failure messages, and the final-status `ConfigurationError`, mention both `claude auth login` (paste the code) and `claude setup-token` plus `CLAUDE_CODE_OAUTH_TOKEN`. No claude flag that does not exist is used.
14. Without the flag, the anthropic-subscription setup runs the browser login as today; only the error text changes.
15. Without the flag, `authenticate()` behaves as today, and `SSOAuthConfig` consumers compile unchanged.
16. The token and cookies never appear in logs or console output or error messages.
17. No TTY, timeout and Ctrl+C each end headless mode with a clear message and a restored terminal.
18. `src/bin/sso-login.ts` and the hook/daemon auth gate keep their behavior; only their user-facing message text changes.
19. The `describeLogin()` messages (started/in-progress, failed, still-not-authenticated, timeout, cooldown, open-failed), the `requireAuthenticatedSession` message and the `AgentCLI.ts:389` message mention `codemie profile login --no-browser`; existing text assertions are updated.
20. Before merge, the SSO flow is exercised once against a real backend to confirm the redirect shows a parsable token (see open risks).

## Non-goals

- No automatic headless detection and no env var trigger; the mode is chosen by the user (flag on `profile login`/`refresh`/`setup`, or the choice at the interactive re-auth prompt), never inferred.
- No flag on agent commands.
- No headless behavior in the detached `sso-login.ts`, hook/daemon auth gates, proxy daemon or session-expiry plugin, which cannot prompt. Their message strings may change (hint only).
- No hint added to other messages that mention `codemie profile login` outside `describeLogin()`, `require-auth.ts` and `AgentCLI.ts:389`.
- No re-implementation of Claude Code's login, no storing a Claude token in CodeMie config, no `BROWSER` override, and no use of a claude flag that does not exist.
- No change to `beforeRun` or how `CLAUDE_CODE_OAUTH_TOKEN` is passed to Claude at run time.
- No headless offer for anthropic-subscription outside `codemie setup --no-browser` (no interactive provider-choice or re-auth prompt for it).
- No backend changes and no true device-code (server-polling) flow.
- No change to credential storage, cookie format or expiry logic.
- No new third-party dependencies, if the existing prompt tooling suffices.
- No change to the `quiet` contract for non-headless callers.

## Decisions

- Raw token or full redirect URL both accepted over raw-token-only, because the user copies from the address bar and no backend change is needed — user
- Flag on `profile login`/`refresh`/`setup`, with no auto-detection and no env var, over inferring headless — user
- Interactive three-way choice (browser / paste token / no) at the agent-launch re-auth prompt over hint only or a launch flag; a deliberate exception where the user picks the mode at the prompt, never inferred — user
- Headless mode on `profile login`, `profile refresh` and `setup` over login only or all callers — user
- `setup` flag reaches every browser SSO login setup triggers (first-time, re-auth, subscription analytics-sync) over re-auth only — user
- Browserless login for the anthropic-subscription provider in scope over leaving `claude auth login` out of scope — user
- Detached `sso-login.ts` and hook/daemon gates unchanged over giving them headless mode — user
- Local server and browser skipped entirely in headless mode over keeping the server alongside the prompt — user
- Headless hint added to `describeLogin()`, `require-auth.ts` and the `AgentCLI.ts:389` message only over leaving messages untouched or hinting every login mention — user
- anthropic-subscription uses Claude's own printed-URL and paste-code flow, plus the `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` route, over wrapping the token into CodeMie config or a `BROWSER` override
- anthropic-subscription headless offer only via `setup --no-browser` over also adding it to a provider-choice or re-auth prompt
- `promptForReauth` called from `setup --no-browser` skips the choice and uses headless over asking again
- Setup flag carried as a second optional `options` parameter on `ProviderSetupSteps.getCredentials` over a new method or a module-level global
- Extract and share `handleCallback` parsing as a pure function over duplicating it in the paste path
- No-echo prompt over a visible one
- Optional boolean on `SSOAuthConfig` over a separate method or class
- Random high port per attempt over a fixed port in the printed URL
- Credentials cleared in `refresh` only after a successful store over clearing first

## Open risks

- Backend contract unverified: that `/v1/auth/login/{port}` works with a never-bound port and shows the token in the redirect address. Issue #229 was not read. If the backend rejects this, a backend change is needed.
- A pasted token is not bound to this login attempt, so a user tricked into pasting an attacker's token would sign in as the attacker. No backend state value or token TTL is known. Showing the resolved account and API URL for confirmation before storing is not in this spec.
- A pasted URL points at an unreachable localhost page on the other device and lands in its browser history. The CLI output tells the user to copy the address even if the browser shows a connection error.
- A headless user's session cannot be renewed by the hook gate, which stays browser-only; the hint only tells them the command to run.
- Claude Code behavior with no browser and no clipboard, and on Raspberry Pi / ARM, is unconfirmed.
- `claude auth status` does not validate `CLAUDE_CODE_OAUTH_TOKEN`, so a bad or expired env token passes setup and fails at the first model request. The `setup-token` token lasts one year and covers model requests only.
- Changing the re-auth prompt from yes/no to a choice alters a shared prompt used by several callers; their tests and any mocks of the prompt need updating.
- The prompt library's Ctrl+C and abort behavior and whether `profile login` takes the login lock are unverified.
