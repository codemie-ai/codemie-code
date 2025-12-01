# Authentication & SSO Management

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
3. Test the connection with health checks
4. Fetch and display available models
5. Save secure credentials to `~/.codemie/config.json`

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
- **Audit Logging**: Enterprise audit trails for security compliance
- **Role-Based Access**: Model access based on organizational permissions
