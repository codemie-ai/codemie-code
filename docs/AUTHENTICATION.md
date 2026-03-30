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
codemie profile login --url https://your-airun-codemie-instance.com

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
codemie profile login --url https://your-airun-codemie-instance.com

# Reset all configuration
codemie config reset
codemie setup                    # Run wizard again
```

## Enterprise SSO Features

AI/Run CodeMie SSO provides enterprise-grade features:

- **Secure Token Storage**: Credentials stored in system keychain
- **Automatic Refresh**: Seamless token renewal without interruption
- **Multi-Model Access**: Access to Claude, GPT, and other models through unified gateway
- **Automatic Plugin Installation**: Claude Code plugin auto-installs for session tracking
- **Audit Logging**: Enterprise audit trails for security compliance
- **Role-Based Access**: Model access based on organizational permissions

## JWT Bearer Authorization

For environments with external token management systems, CI/CD pipelines, or testing scenarios, CodeMie CLI supports JWT Bearer Authorization. This method provides tokens at runtime rather than during setup.

### Initial Setup

JWT setup only requires the API URL - tokens are provided later:

```bash
codemie setup
# Select: Bearer Authorization
```

**The wizard will:**
1. Prompt for the CodeMie base URL (e.g., `https://codemie.lab.epam.com`)
2. Optionally ask for a custom environment variable name (default: `CODEMIE_JWT_TOKEN`)
3. Save the configuration without requiring a token
4. Display instructions for providing tokens at runtime

### Providing JWT Tokens

Tokens can be provided in three ways, resolved in this priority order:

1. `--jwt-token <token>` CLI flag (highest priority)
2. `CODEMIE_JWT_TOKEN` environment variable
3. Credential store (saved by `codemie setup`)

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

`--jwt-token` works standalone — no `codemie setup` needed. Just supply `--base-url` if the URL is not already configured:

```bash
codemie-claude \
  --jwt-token "<YOUR_JWT_TOKEN>" \
  --base-url "https://codemie.lab.epam.com" \
  "analyze this code"
```

**Custom Environment Variable:**
```bash
# If you configured a custom env var name during setup
export MY_CUSTOM_TOKEN="<YOUR_JWT_TOKEN>"
codemie-claude "analyze this code"
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
| **Setup** | URL only | Browser-based flow |
| **Token Source** | Runtime (CLI/env) | Stored in keychain |
| **Best For** | CI/CD, external auth | Interactive development |
| **Token Refresh** | Manual (obtain new token) | Automatic |
| **Security** | Token management external | Managed by CLI |

### Troubleshooting JWT

**Token not found:**
```bash
# Check environment variable
echo $CODEMIE_JWT_TOKEN

# Verify variable name matches config
codemie profile status

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

**Configuration issues:**
```bash
# Reset and reconfigure
codemie setup  # Choose Bearer Authorization again

# Or manually edit config
cat ~/.codemie/codemie-cli.config.json
```
