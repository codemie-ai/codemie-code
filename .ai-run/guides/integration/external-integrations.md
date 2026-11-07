# External Integrations

**Project**: @codemieai/code · **Stack**: TypeScript (ESM, target ES2022, module NodeNext) commander CLI · **Scope**: the MCP stdio bridge and provider HTTP calls; provider registration lives in `.ai-run/guides/architecture/architecture.md`, credential storage in `.ai-run/guides/security/security-practices.md`

## Integrated services

### Rules
- R1. In the MCP stdio bridge write diagnostics only through `logger.debug` and `proxyLog` (stdout carries JSON-RPC; `bin/codemie-mcp-proxy.js` skips migrations and update checks for the same reason). Evidence: `src/mcp/stdio-http-bridge.ts::StdioHttpBridge`

## Resilience

### Rules
- R2. Call provider endpoints through `HTTPClient` and pass `maxRetries: 1` for a non-idempotent POST (every `get`/`post` retries up to 3 attempts with 1s/2s backoff; only messages containing `401`, `403` or `SSO session expired` are not retried); do not add a second retry loop around `get`/`post`. Evidence: `src/providers/core/base/http-client.ts::HTTPClient.withRetry`
