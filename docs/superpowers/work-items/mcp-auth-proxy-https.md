# Work Item: HTTPS support for `codemie mcp-auth-proxy`

- **ID:** mcp-auth-proxy-https
- **Status:** Open
- **External Ticket:** (none — external sync pending)
- **Source:** local/ISSUE-mcp-auth-proxy-claude-desktop-https.md (free-form + issue report)
- **Related:** [mcp-auth-proxy](mcp-auth-proxy.md) — base feature, branch `feat/mcp-auth-proxy`
- **Branch:** feat/mcp-auth-proxy (stacked on PR #407)

## Summary

Claude Desktop's `custom3p-mcp` OAuth client refuses to open non-`https://`
authorize URLs, so every `mcp-auth-proxy` route requiring interactive OAuth
fails in Claude Desktop with a generic "Connection to Server failed" toast.
The proxy hardcodes a plain-HTTP loopback origin (`http://127.0.0.1:<port>`)
in `src/mcp/auth-proxy/server.ts` and threads it into every OAuth AS metadata
rewrite (issuer / authorization_endpoint / token_endpoint /
registration_endpoint). Add local TLS termination so the proxy's origin can be
`https://127.0.0.1:<port>` and Claude Desktop can complete the browser-based
OAuth authorize step.

## Acceptance Criteria

Sourced from the issue's root-cause analysis and suggested next steps; final
criteria confirmed at the requirements phase.

## Linked Artifacts

- local/ISSUE-mcp-auth-proxy-claude-desktop-https.md
- docs/superpowers/runs/20260705-1519-feat-mcp-auth-proxy/requirements.md

## History

| When | Event | Notes |
|---|---|---|
| 2026-07-05T15:22 | created | Work item created by requirements-intake (run 20260705-1519-feat-mcp-auth-proxy) from free-form input + local issue report |
| 2026-07-05T15:22 | external-sync | pending — no ticket adapter invoked at intake; prepare_for_development to be emitted after branch guard |
| 2026-07-05T15:22 | linked-artifact | requirements.md written by requirements-intake |
| 2026-07-05T15:31 | assigned | Branch guard (HITL): continue on feat/mcp-auth-proxy, decision proceed-dirty (.codemie/codemie-cli.config.json left unstaged; analytics report never staged); upstream in-sync after fetch |
| 2026-07-05T15:31 | adapter-warning | prepare_for_development: no lifecycle adapter configured; external sync pending |
