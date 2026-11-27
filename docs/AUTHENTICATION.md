# Authentication & SSO Management

## Authentication Methods

CodeMie CLI supports multiple authentication methods:

- **CodeMie SSO** - Browser-based Single Sign-On (recommended for enterprise)
- **JWT Bearer Authorization** - Token-based authentication for CI/CD and external auth systems
- **API Key** - Direct API key authentication for other providers (OpenAI, Anthropic, etc.)

## AI/Run CodeMie SSO Setup

For enterprise environments with AI/Run CodeMie SSO (Single Sign-On):

### Initial Setup via Wizard

The setup wizard automatically detects and configures AI/Run CodeMie SSO:

```bash
codemie setup
```

**The wizard will:**
1. Detect if you have access to AI/Run CodeMie SSO
2. Guide you through the authentication flow
3. Fetch and display available projects (includes admin-only projects)
4. Test the connection with health checks
5. Save secure credentials to `~/.codemie/codemie-cli.config.json`

**Note**: If you have access to multiple projects, you'll be prompted to select one. Projects from both regular and admin access are included automatically.

### Manual SSO Authentication

If you need to authenticate separately or refresh your credentials:

```bash
# Authenticate with AI/Run CodeMie SSO
codemie profile login

# Check authentication status
codemie profile status

# Refresh expired tokens
codemie profile refresh

# Logout and clear credentials
codemie profile logout
```

## Token Management

SSO tokens are automatically managed, but you can control them manually:

### Token Refresh

AI/Run CodeMie CLI automatically refreshes tokens when they expire. For manual refresh:

```bash
# Refresh SSO credentials (extends session)
codemie profile refresh
```

**When to refresh manually:**
- Before long-running tasks
- After extended periods of inactivity
- When you receive authentication errors
- Before important demonstrations

### Authentication Status

Check your current authentication state:

```bash
codemie profile status
```

**Status information includes:**
- Connection status to AI/Run CodeMie SSO
- Token validity and expiration
- Available models for your account
- Provider configuration details

### Token Troubleshooting

Common authentication issues and solutions:

```bash
# Token expired
codemie profile refresh

# Connection issues
codemie doctor                    # Full system diagnostics
codemie profile status              # Check auth-specific issues

# Complete re-authentication
codemie profile logout
codemie profile login

# Reset all configuration
codemie config reset
codemie setup                    # Run wizard again
```

### Non-Interactive Environments (CI/Automation)

When SSO credentials are missing or expired, the CLI normally offers an interactive
re-authentication prompt. In a non-interactive environment — no TTY attached to `stdin`, as in CI
pipelines, cron jobs, or piped/redirected invocations — that prompt is automatically skipped. The
CLI detects the missing TTY, fails fast with a clear message (e.g. "No valid SSO credentials found.
Please run `codemie setup` interactively before using this command."), and exits non-zero instead of
hanging.

There is no separate `--non-interactive` flag to set — detection is automatic, based solely on
whether `stdin` is a TTY. To run unattended in CI, either authenticate ahead of time
(`codemie profile login`) with credentials persisted before the run, or use
[JWT Bearer Authorization](#jwt-bearer-authorization) instead, which requires no interactive
session at all.

## Enterprise SSO Features

AI/Run CodeMie SSO provides enterprise-grade features:

- **Secure Token Storage**: Credentials stored in system keychain
- **Automatic Refresh**: Seamless token renewal without interruption
- **Multi-Model Access**: Access to Claude, GPT, and other models through unified gateway
- **Automatic Plugin Installation**: Claude Code plugin auto-installs for session tracking
- **MCP OAuth Proxy**: Automatic OAuth authorization for remote MCP servers
- **Audit Logging**: Enterprise audit trails for security compliance
- **Role-Based Access**: Model access based on organizational permissions

## JWT Bearer Authorization

For environments with external token management systems, CI/CD pipelines, or testing scenarios, CodeMie CLI supports JWT Bearer Authorization. This method provides tokens at runtime.

### Providing JWT Tokens

Tokens can be provided in two ways, resolved in this priority order:

1. `--jwt-token <token>` CLI flag (highest priority)
2. `CODEMIE_JWT_TOKEN` environment variable

**Environment Variable (Recommended for persistent use):**
```bash
# Set token in your shell profile or CI environment
export CODEMIE_JWT_TOKEN="<YOUR_JWT_TOKEN>"

# Run commands normally — token is picked up automatically
codemie-claude "analyze this code"
```

**CLI Flag (Per-command or ad-hoc):**
```bash
# Provide token inline — no prior setup required
codemie-claude --jwt-token "<YOUR_JWT_TOKEN>" "analyze this code"
```

**Without Any Prior Setup:**

`--jwt-token` works standalone — no `codemie setup` needed. Just supply `--base-url` if the URL is not already configured. You can pass either the root CodeMie host or the `/code-assistant-api` path directly — the CLI appends `/code-assistant-api` automatically when it's missing:

```bash
codemie-claude \
  --jwt-token "<YOUR_JWT_TOKEN>" \
  --base-url "https://codemie.lab.epam.com" \
  "analyze this code"
```

### JWT Token Management

JWT tokens are validated automatically:

```bash
# Check JWT authentication status
codemie doctor

# View token status and expiration
codemie profile status
```

**Token Validation:**
- Format validation (header.payload.signature)
- Expiration checking (warns if expiring within 7 days)
- Automatic error messages for expired tokens

### Use Cases

JWT Bearer Authorization is ideal for:

**CI/CD Pipelines (headless mode with `--task`):**

The `--task` flag runs the agent non-interactively — it executes the prompt and exits. Combined with `--jwt-token`, this gives a fully self-contained command that requires no prior login or setup:

```bash
# GitLab CI
script:
  - codemie-claude
      --jwt-token "$CODEMIE_JWT_TOKEN"
      --task "Review the changes in this commit and report any issues"

# GitHub Actions
- name: AI Code Review
  run: |
    codemie-claude \
      --jwt-token "${{ secrets.CODEMIE_JWT_TOKEN }}" \
      --task "Check for security issues in the staged files" \
      --silent

# OpenCode in CI
- run: |
    codemie-opencode \
      --jwt-token "${{ secrets.CODEMIE_JWT_TOKEN }}" \
      --task "Fix all findings from the code review"
```

**External Auth Systems:**
```bash
# Obtain token from your auth provider
TOKEN=$(curl -s https://auth.example.com/token | jq -r .access_token)

# Run a task with that token — no setup needed
codemie-claude --jwt-token "$TOKEN" --task "analyze this codebase"
```

**Testing & Development:**
```bash
# Use short-lived test tokens
export CODEMIE_JWT_TOKEN="test-token-expires-in-1h"
codemie-claude --task "run a quick code review"
```

### JWT vs SSO

| Feature | JWT Bearer Auth | CodeMie SSO |
|---------|----------------|-------------|
| **Setup** | None required | Browser-based flow |
| **Token Source** | Runtime (CLI/env) | Stored in keychain |
| **Best For** | CI/CD, external auth | Interactive development |
| **Token Refresh** | Manual (obtain new token) | Automatic |
| **Security** | Token management external | Managed by CLI |

### Troubleshooting JWT

**Token not found:**
```bash
# Check environment variable
echo $CODEMIE_JWT_TOKEN

# Provide via CLI instead
codemie-claude --jwt-token "your-token" "your prompt"
```

**Token expired:**
```bash
# Obtain new token from your auth provider
export CODEMIE_JWT_TOKEN="new-token-here"

# Verify expiration
codemie doctor
```

**Invalid token format:**
```bash
# JWT must have 3 parts (header.payload.signature)
# Check token structure
echo $CODEMIE_JWT_TOKEN | awk -F. '{print NF}'  # Should output: 3
```

**`API Error: 405 Not Allowed`:**

This means the request reached your CodeMie host but was rejected before hitting the Code Assistant API — usually because `--base-url` (or `CODEMIE_BASE_URL`) points at a path the API doesn't route requests through. The CLI automatically appends `/code-assistant-api` to a root URL, so both of these are equivalent and safe to use:

```bash
--base-url "https://<your-codemie-host>"
--base-url "https://<your-codemie-host>/code-assistant-api"
```

If you still see a 405 after this, confirm the host itself (not just the path) is correct, and check `~/.codemie/logs/` for the exact upstream URL the CLI attempted.

## MCP Server Authentication

CodeMie provides a stdio-to-HTTP proxy that enables MCP clients (like Claude Code) to connect to OAuth-protected remote MCP servers. The proxy handles the full OAuth 2.0 authorization code flow transparently.

### Setup

Register the proxy as an MCP server in your Claude Code configuration:

```bash
# Using the global binary
claude mcp add my-server -- codemie-mcp-proxy "https://mcp-server.example.com/sse"
```

Or configure `.mcp.json` directly:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "codemie-mcp-proxy",
      "args": ["https://mcp-server.example.com/sse"],
      "env": {
        "MCP_CLIENT_NAME": "Claude Code (my-server)"
      }
    }
  }
}
```

### OAuth Flow

When the remote MCP server requires authentication, the proxy handles it automatically:

1. **401 Unauthorized** — the remote server rejects the initial request
2. **Metadata discovery** — fetch resource metadata and authorization server metadata
3. **Dynamic Client Registration** — register a client with `client_name` from `MCP_CLIENT_NAME` (default: `CodeMie CLI`)
4. **Browser authorization** — open the user's browser to the authorization endpoint
5. **Callback** — receive the authorization code via an ephemeral localhost HTTP server
6. **Token exchange** — exchange the code for access/refresh tokens
7. **Retry** — replay the original request with the Bearer token

When several MCP servers start together, their proxies take turns: a lock file (`~/.codemie/mcp-auth.lock`) lets only one browser login be in flight at a time, because concurrent logins in one browser can invalidate each other. After the initial login, an expired or rejected access token is renewed in place — silently with the refresh token when one is held in memory, otherwise through the browser — without dropping the server from the session.

The login (access token, refresh token and the client registration the refresh token belongs to) is stored per MCP server under `~/.codemie/mcp-auth` (directory `0700`, files `0600`). Restarting the CLI then reuses it, or renews it silently with the refresh token, and only opens the browser when that is no longer possible. The files (`<hash>.enc`) hold a long-lived credential, so their content is encrypted with the same machine-bound key as the stored SSO and JWT credentials: a copy taken by a backup, a sync tool or a support bundle cannot be read on another machine. The key is derived from the machine rather than from a secret, so another process running as your user can still decrypt them; keep treating the directory like your SSH keys. Delete the directory to log out of every server. Set `MCP_PROXY_PERSIST_TOKENS=off` to keep everything in memory only, in which case re-authorization is required each session.

Two deliberate limits of this store:

- **No keychain.** Unlike the SSO and JWT credentials, which prefer the platform `CredentialStore` (OS keychain), the MCP login store always uses the encrypted file. Every proxy process reads it unattended and on its own, and that read must never raise a keychain prompt.
- **POSIX-only protection.** The `0700`/`0600` modes and the machine-bound key protect the files on Linux and macOS. On Windows `chmod` is largely a no-op, so the files rely on the ACLs of your user profile.

Several proxies for the same server can share one login file. When the server refuses a refresh token, the proxy reads the file again before giving up: if a sibling process has already rotated the refresh token and saved the new one, the proxy adopts that login (with its own client registration) instead of discarding it. It renews at most once with the adopted login, and only if the adopted access token needs it.

### SSO Integration

When running through the CodeMie SSO proxy, the MCP Auth Plugin provides additional capabilities:

- **URL rewriting**: Auth metadata URLs are rewritten to route through the proxy (`/mcp_auth` and `/mcp_relay` routes)
- **Client name override**: `client_name` in Dynamic Client Registration is replaced with the `MCP_CLIENT_NAME` value
- **SSRF protection**: Private/loopback origins are rejected before forwarding
- **Per-flow isolation**: Each MCP server flow is scoped by its root origin to prevent cross-flow confusion

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_CLIENT_NAME` | `CodeMie CLI` | Client name for OAuth Dynamic Client Registration |
| `MCP_PROXY_DEBUG` | (unset) | Set to `true` for verbose proxy logging |
| `MCP_PROXY_PERSIST_TOKENS` | (enabled) | Set to `off` to stop storing logins on disk |
| `MCP_PROXY_AUTH_TIMEOUT_SECONDS` | `300` | How long the proxy waits for the browser login to finish. A plain decimal integer of seconds from `10` to `3600`; anything else (`0`, fractions, negatives, non-numeric, empty or out-of-range values) is ignored with a debug log and the default `300` is used. Even a small accepted value such as `10` may be too short for a slow interactive login, and the real window is shorter than the setting because the clock starts when the proxy connects (see [Login timing and failure hints](#login-timing-and-failure-hints)) |
| `CODEMIE_PROXY_PORT` | (auto) | Fixed proxy port for stable auth callback URLs |

Logs: `~/.codemie/logs/mcp-proxy.log`

### Login timing and failure hints

**Timing.** The login window is `MCP_PROXY_AUTH_TIMEOUT_SECONDS` (default 300 seconds). The callback listener is started when the proxy connects, before the `401`, before the wait for the shared login lock and before the browser opens, so everything that happens before the browser opens comes out of the same window. A proxy queued behind other logins therefore has less time left than the setting suggests. With the default, a proxy that waits close to the maximum for the lock has only a minute or so left once its browser opens.

The lock timings derive from the same setting: a proxy gives up waiting for the lock after 0.75 times the timeout, and a lock older than 1.25 times the timeout is considered stale. The lock file records the stale age of the process that created it, so a proxy started with a different setting does not remove a live lock.

**Hints on stderr.** When a login fails, the proxy prints a hint to stderr (visible with `MCP_PROXY_DEBUG` off) and then fails with the original error:

- *Timeout.* The hint names `MCP_PROXY_AUTH_TIMEOUT_SECONDS` and the `MCP_CLIENT_NAME` in effect, and says that if the gateway page showed `insufficient_scope`, `MCP_CLIENT_NAME` is what to change.
- *`insufficient_scope` callback.* The hint names `MCP_CLIENT_NAME` only. A longer timeout is not suggested as the fix.

The client name in the hint is the one in the environment of the stdio proxy process. The SSO daemon rewrites `client_name` during registration, so the name it registered can differ from the one shown.

Hints never contain tokens, authorization codes, state or the callback URL. The callback page that the proxy serves on a login error HTML-escapes the error code and description sent by the identity provider, strips control characters, truncates each to 200 characters and is served with `Content-Security-Policy: default-src 'none'` and `X-Content-Type-Options: nosniff`.

**The `insufficient_scope` symptom.** The gateway's own page shows `Insufficient Scope - scopes not allowed by IDP: claudeai` and the login never completes.

Verified:

- The symptom was seen with `MCP_CLIENT_NAME="Claude Code (jira)"`.
- With the default name `CodeMie CLI` the same login succeeds.

Hypotheses, not confirmed:

- The gateway maps client names to scopes, so some names are granted scopes the identity provider does not allow. The proxy sends no `scope` parameter itself.
- The gateway shows that page itself instead of redirecting to the proxy's `/callback`. If so, the proxy sees no error and the usual symptom is a timeout, which is why the timeout hint also mentions `MCP_CLIENT_NAME`.
- Whether the MCP client restarts the proxy during a slow login has not been verified. If it does, the listener goes away and the browser fails to reach `/callback`; a longer timeout cannot fix that.

### Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Browser doesn't open during auth | `open`/`xdg-open` not available | Copy the URL from logs and open manually |
| OAuth timeout (300 seconds by default) | The browser login was not completed in time, or part of the window was spent waiting for another login | Re-trigger the MCP connection and authorize sooner, or raise `MCP_PROXY_AUTH_TIMEOUT_SECONDS`; see [Login timing and failure hints](#login-timing-and-failure-hints) |
| `insufficient_scope` hint, or gateway page "Insufficient Scope" | The gateway rejected the login for this client name | Change `MCP_CLIENT_NAME` (the default `CodeMie CLI` is known to log in); a longer timeout does not help |
| `401` persists after auth | Token expired or server rejected it | Check logs for token exchange errors |
| Connection refused | Remote MCP server unreachable | Verify the URL and network connectivity |

For architecture details, see [Proxy Architecture — MCP Auth Plugin](./ARCHITECTURE-PROXY.md#65-mcp-auth-plugin).
