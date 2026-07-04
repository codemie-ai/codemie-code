# Work Item: MCP OAuth Rewriting Proxy (`codemie mcp-auth-proxy`)

- **ID:** mcp-auth-proxy
- **Status:** Ready for review
- **External Ticket:** (none — external sync pending)
- **Source Story:** docs/SPEC-mcp-auth-proxy.md
- **Branch:** feat/mcp-auth-proxy

## Summary

Implement `codemie mcp-auth-proxy` — a local, transparent, loopback-only HTTP proxy between
MCP clients (Claude Code) and remote MCP servers implementing MCP Authorization (OAuth 2.1,
spec revision 2025-11-25). The proxy forwards all MCP and OAuth traffic unchanged except
surgical rewrites of `client_name` (RFC 7591 DCR) and `scope` (401/403 challenge, PRM, AS
metadata, DCR body, authorize query, token body) plus `resource` (RFC 8707) restoration to
the upstream canonical URI. Multiple upstream servers are served concurrently on isolated
routes. The proxy holds no tokens, preserves Claude Code's lazy browser auth, and keeps
registration fully dynamic. New module `src/mcp/auth-proxy/`, daemon entry
`src/bin/mcp-auth-proxy-daemon.ts`, CLI command `start`/`stop`/`status`.

## Acceptance Criteria

See `docs/SPEC-mcp-auth-proxy.md` § Acceptance Criteria (10 items, authoritative).

## Linked Artifacts

- docs/SPEC-mcp-auth-proxy.md
- docs/superpowers/specs/2026-07-03-mcp-auth-proxy-design.md
- docs/superpowers/plans/2026-07-03-mcp-auth-proxy.md
- docs/superpowers/runs/20260703-1845-mcp-auth-proxy/requirements.md
- docs/superpowers/runs/20260703-1845-mcp-auth-proxy/qa-report.md

## History

| When | Event | Notes |
|---|---|---|
| 2026-07-03T18:48 | created | Work item created by requirements-intake (run 20260703-1845-mcp-auth-proxy) from docs/SPEC-mcp-auth-proxy.md |
| 2026-07-03T18:48 | external-sync | pending — no ticket adapter invoked at intake; prepare_for_development to be emitted after branch guard |
| 2026-07-03T18:48 | linked-artifact | requirements.md written by requirements-intake |
| 2026-07-03T18:52 | assigned | Branch feat/mcp-auth-proxy created from up-to-date main; branch guard decision: continue (no tracked modifications; foreign untracked file codemie-analytics-2026-06-25.report.json excluded from staging) |
| 2026-07-03T18:52 | adapter-warning | prepare_for_development: no lifecycle adapter configured; external sync pending |
| 2026-07-04T00:30 | code-review | Round 1 request-changes (CR-001 daemon-crash, CR-002 proto-route-404, CR-003 SSRF-hint) → fix-up 62c4ac6 → Round 2 approve |
| 2026-07-04T00:50 | qa | All 7 guide gates PASS (license/lint/typecheck/build/unit 2272/integration 220/commitlint); feature-verification not required (no UI surface) |
| 2026-07-04T01:00 | complexity | Actual 26/36 (L), delta +2 vs initial heuristic 24 |
| 2026-07-04T01:05 | transitioned | Status → Ready for review; branch feat/mcp-auth-proxy ready for MR |
