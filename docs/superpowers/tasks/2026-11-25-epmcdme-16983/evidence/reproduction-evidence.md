# EPMCDME-16983 - reproduction evidence

Date: 2026-11-25. Reproduced by: Zbigniew Sokolowski (Zbigniew_Sokolowski@epam.com), who completed the browser logins. Environment: WSL2 (Linux), Windows Chrome as the browser, installed `@codemieai/code` 0.17.2, gateway `https://mcp.epam.com/mcp/jira`.

## Conclusion

**Answer in one sentence:** the proxy does save OAuth logins to disk and reuses them; users are asked to authorize again at every start because, on their machines, **the first login never finishes**, so there is nothing to save.

### What was proven (reproduced on 2026-11-25, installed v0.17.2)

| # | Finding | Proof |
|---|---|---|
| 1 | **Persistence works.** After one completed login a file `~/.codemie/mcp-auth/22fd639749ee42b9.enc` was written, and the next proxy start used it: 941 ms, no browser prompt. | Timeline steps 7-8 |
| 2 | **The ticket's root cause is wrong.** It says the provider is memory-only and no token store exists on `main`. The store (`src/mcp/auth/token-store.ts`) is on `main` since PR #678, commit `623aa8a8`, 2026-11-09, first released in v0.16.7. | `git merge-base --is-ancestor 623aa8a8 main`; step 7 |
| 3 | **Cause A - the gateway rejects the client name `Claude Code (jira)`.** That name is set as `MCP_CLIENT_NAME` in the repo's `.mcp.json`. The gateway page says "Insufficient Scope - scopes not allowed by IDP: claudeai", so no authorization code is issued and no token can be saved. The same login with the default name `CodeMie CLI` succeeded. | Steps 2-3; screenshot 01 |
| 4 | **Cause B - the proxy gives the user only 120 s to finish the login.** The wait is hard-coded (`src/mcp/auth/callback-server.ts:33`) and has no setting. After 120 s the local callback address stops listening, and the browser shows `ERR_CONNECTION_REFUSED`. This happened twice, with a valid authorization code each time. With the wait raised to 600 s (test copy only) the login completed. | Steps 4-6; screenshots 02, 03, 04 |

Either cause alone is enough to make the user authorize again at the next start. Cause A makes the login fail every time; cause B makes it fail whenever the user is slower than 120 s, a window that also includes time spent waiting behind other servers' logins.

### What is not proven

- **Why the gateway maps `Claude Code (jira)` to the scope `claudeai`.** The proxy sends no scope, and client registration shows none for either name. Only the owners of `mcp.epam.com` can answer this.
- **The ticket's "up to 3 browser windows per server"** was not reproduced on 0.17.2.
- **Whether the MCP client restarts the proxy after its 30 s connect timeout during a login.** That would also lose the login, and nothing in this repository could fix it.

### What this means for EPMCDME-16983

The ticket asks to add token persistence. That is already done, so adding it again (for example by merging PR #708) would create a second token store. The defect that remains is that logins do not complete. The proposed change therefore targets that:

1. Make the login wait configurable (`MCP_PROXY_AUTH_TIMEOUT_SECONDS`), default 300 s.
2. On a timeout or an `insufficient_scope` error, tell the user to check `MCP_CLIENT_NAME`.
3. Harden the existing store (refresh-token race, tests, documentation).

Recommended outside this repository: ask the gateway owners to confirm the `claudeai` scope behaviour, and decide how to relate this ticket to EPMCDME-14795, which describes the same symptom.

## Timeline

| # | Step | Observation | Raw file (not committed) |
|---|---|---|---|
| 0 | `~/.codemie/mcp-auth/` before any login | directory did not exist, so no login had ever been persisted on this machine | - |
| 1 | Start proxy, `MCP_CLIENT_NAME="Claude Code (jira)"` | stderr: "Opening browser for MCP server authorization... Could not open browser automatically. Please open this URL:" (WSL cannot launch the browser) | `probe-run1.local.txt` |
| 2 | Open the authorize URL in the Windows browser | Gateway page "Insufficient Scope - The following scopes are not allowed by IDP: claudeai", error code `insufficient_scope`. No code is issued, so no token can ever be saved | `01-insufficient-scope.local.png` |
| 3 | Same flow, `MCP_CLIENT_NAME` left at default `CodeMie CLI` | IdP issued an authorization code (callback URL carried `code=...&iss=https://mcp.epam.com/idp/jira`), no scope error | - |
| 4 | Browser opened the callback about 3 min after the proxy started | `localhost:<port>/callback` -> `ERR_CONNECTION_REFUSED`; proxy had already exited. Repeated on a second attempt | `02-callback-refused-run3.local.png`, `03-callback-refused-run4.local.png` |
| 5 | Source check | `src/mcp/auth/callback-server.ts:33`: `options?.timeoutMs ?? 120_000`; the only caller does not pass `timeoutMs`; no env override | - |
| 6 | Same flow on a throwaway copy of the installed proxy with the timeout raised to 600 s (installed package untouched) | Browser showed "Authorization successful - You can close this tab" | `04-authorization-successful.local.png` |
| 6a | Consent pages the user approved during step 6 | EPAM MCP "Authorize Application - CodeMie CLI" (`05-gateway-consent-codemie-cli.png`), then Jira's own consent "mcp_epam_com would like to access your Jira account" for Zbigniew Sokolowski (`06-jira-consent-mcp-epam-com.png`) | committed screenshots |
| 7 | `~/.codemie/mcp-auth/` after step 6 | `22fd639749ee42b9.enc` (1228 bytes, mode `0600`, dir `0700`) created | - |
| 8 | New proxy start, installed build, default client name | `initialized after 941 ms; browser prompt seen: false` - the persisted login was reused | script output |
| 9 | `tools/list` and `jira_download_attachments` through the proxy | worked with the persisted login; 3 attachments of EPMCDME-16983 returned | `probe-run5-tools.local.txt` |

## Not verified

- Why the gateway maps `Claude Code (jira)` to the scope `claudeai` is unconfirmed. Dynamic client registration returned no scope for either client name, and the proxy sends no `scope`. This is a gateway-side question.
- "Up to 3 browser windows per server" from the ticket was not reproduced on 0.17.2.
- Whether the MCP client restarts the proxy after its 30 s `CONNECT_TIMEOUT` during a login (which would also kill the callback listener) was not observed.

## Side effects of the reproduction

- Two throwaway dynamic client registrations were created on the gateway (`Claude Code (jira)` and `CodeMie CLI`, redirect `http://localhost:51234/callback`). No tokens were issued for them.
- One persisted login for the gateway now exists in `~/.codemie/mcp-auth/` on this machine.
- The two consent-page screenshots (`05-`, `06-`) are committed with the user's consent; they show the user's name and email. The other screenshots and the probe output are in git-ignored `*.local.*` files next to this document, because the callback URLs in them carry single-use, expired authorization codes.
