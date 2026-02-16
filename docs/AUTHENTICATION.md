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
codemie auth login --url https://your-airun-codemie-instance.com

# Check authentication status
codemie auth status

# Refresh expired tokens
codemie auth refresh

# Logout and clear credentials
codemie auth logout
```

## Token Management

SSO tokens are automatically managed, but you can control them manually:

### Token Refresh

AI/Run CodeMie CLI automatically refreshes tokens when they expire. For manual refresh:

```bash
# Refresh SSO credentials (extends session)
codemie auth refresh
```

**When to refresh manually:**
- Before long-running tasks
- After extended periods of inactivity
- When you receive authentication errors
- Before important demonstrations

### Authentication Status

Check your current authentication state:

```bash
codemie auth status
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
codemie auth refresh

# Connection issues
codemie doctor                    # Full system diagnostics
codemie auth status              # Check auth-specific issues

# Complete re-authentication
codemie auth logout
codemie auth login --url https://your-airun-codemie-instance.com

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

After setup, provide tokens via environment variable or CLI option:

**Environment Variable (Recommended):**
```bash
# Set token in your environment
export CODEMIE_JWT_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Run commands normally
codemie-claude "analyze this code"
```

**CLI Option:**
```bash
# Provide token per command
codemie-claude --jwt-token "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." "analyze this code"
```

**Custom Environment Variable:**
```bash
# If you configured a custom env var during setup
export MY_CUSTOM_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
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

**CI/CD Pipelines:**
```bash
# GitLab CI example
script:
  - export CODEMIE_JWT_TOKEN="${CI_JOB_JWT}"
  - codemie-claude --task "review changes in this commit"
```

**External Auth Systems:**
```bash
# Obtain token from your auth provider
TOKEN=$(curl -s https://auth.example.com/token | jq -r .access_token)

# Use with CodeMie
codemie-claude --jwt-token "$TOKEN" "your prompt"
```

**Testing & Development:**
```bash
# Use short-lived test tokens
export CODEMIE_JWT_TOKEN="test-token-expires-in-1h"
codemie-claude "run tests"
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
