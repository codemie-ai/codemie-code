# Security Practices

## Quick Summary

Security patterns for CodeMie Code: credential storage, data sanitization, input validation, and secrets management.

**Category**: Security
**Complexity**: High
**Prerequisites**: Security fundamentals, Node.js security best practices

---

## Core Security Principles

| Principle | Implementation |
|-----------|----------------|
| No hardcoded secrets | Environment variables + CredentialStore |
| Input validation | Path security checks, sanitization |
| Data sanitization | Auto-redact sensitive data in logs |
| Secure storage | Encrypted credential storage (keytar + fallback) |
| Least privilege | File permissions, scoped access |

---

## Credential Storage

### CredentialStore Pattern

```typescript
// Source: src/utils/security.ts:200-230
import { CredentialStore } from './utils/security.js';

// Get singleton instance
const store = CredentialStore.getInstance();

// Store SSO credentials securely
await store.storeSSOCredentials({
  accessToken: 'token',
  refreshToken: 'refresh',
  expiresAt: Date.now() + 3600000
}, 'https://api.example.com');

// Retrieve credentials
const creds = await store.retrieveSSOCredentials('https://api.example.com');

// Delete credentials
await store.deleteSSOCredentials('https://api.example.com');
```

**Storage Method**:
- **Primary**: System keychain via keytar (macOS Keychain, Windows Credential Vault, Linux Secret Service)
- **Fallback**: Encrypted JSON file with AES-256-GCM (~/.codemie/.credentials.enc)

**Security Features**:
- Encryption key derived from machine ID + OS username
- Per-URL credential isolation
- Automatic rotation support
- Secure deletion

---

## Data Sanitization for Logging

### Auto-Redaction Pattern

```typescript
// Source: src/utils/security.ts:77-100
import { sanitizeValue, sanitizeLogArgs } from './utils/security.js';

// Sanitize before logging
logger.debug('API request', ...sanitizeLogArgs({
  url: request.url,
  headers: request.headers, // Auto-redacts Authorization, Cookie, etc.
  apiKey: 'sk-ant-...', // Auto-redacts based on key name
  token: 'bearer xyz...' // Auto-redacts based on value pattern
}));

// Manual sanitization
const safeValue = sanitizeValue(sensitiveData, 'apiKey');
```

**Automatic Detection**:
- **Sensitive Keys**: api_key, auth_token, password, secret, credential, private_key, cookie, authorization
- **Sensitive Values**: OpenAI keys (sk-*), Anthropic keys (sk-ant-*), JWT tokens, Bearer tokens, OAuth tokens

**Masking Strategy**:
```typescript
// Long values: Show first/last 4 chars
'sk-ant-abc...xyz [REDACTED]'

// Short values: Complete redaction
'[REDACTED]'

// Objects: Recursive sanitization
{ apiKey: '[REDACTED]', data: { nested: 'value' } }
```

---

## Input Validation

### Path Security

```typescript
// Source: src/agents/codemie-code/tools/path-security.test.ts:10-30
import { isPathWithinDirectory, validatePathDepth } from './utils/paths.js';
import { PathSecurityError } from './utils/errors.js';

// Validate path is within working directory
function validateFilePath(filePath: string, workingDir: string): void {
  const resolved = path.resolve(workingDir, filePath);

  if (!isPathWithinDirectory(workingDir, resolved)) {
    throw new PathSecurityError(
      filePath,
      'Path outside working directory'
    );
  }

  // Check depth to prevent deeply nested paths
  if (!validatePathDepth(resolved, workingDir, 10)) {
    throw new PathSecurityError(
      filePath,
      'Path depth exceeds limit'
    );
  }
}
```

**Path Validation Rules**:
- ✅ Always resolve relative paths
- ✅ Check paths stay within working directory
- ✅ Limit directory depth (prevent deep nesting attacks)
- ✅ Normalize path separators (cross-platform)
- ❌ Never trust user-provided paths directly
- ❌ No path traversal (../, ..\, etc.)

---

## Secrets Management

### Environment Variables

```bash
# Provider API keys (choose one)
ANTHROPIC_API_KEY=sk-ant-...           # For Claude
OPENAI_API_KEY=sk-...                  # For OpenAI
GOOGLE_AI_API_KEY=...                  # For Gemini

# SSO Configuration
SSO_BASE_URL=https://api.company.com   # Enterprise SSO
SSO_WORKSPACE=workspace-id             # SSO workspace

# Debug (non-sensitive)
CODEMIE_DEBUG=true                     # Debug logging
```

**Rules**:
- ✅ Use environment variables for all secrets
- ✅ Never commit .env files
- ✅ Use CredentialStore for long-term storage
- ✅ Validate env vars at startup
- ❌ Never hardcode secrets in code
- ❌ Never log secret values
- ❌ Never commit credentials to git

### Validating Secrets at Startup

```typescript
// Source: src/env/config-loader.ts:80-100
export class ConfigLoader {
  static async load(workingDir: string): Promise<Config> {
    // Load from environment
    const apiKey = process.env.ANTHROPIC_API_KEY
                || process.env.OPENAI_API_KEY
                || process.env.GOOGLE_AI_API_KEY;

    if (!apiKey && config.profile.provider.type !== 'sso') {
      throw new ConfigurationError(
        'No API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_AI_API_KEY'
      );
    }

    return config;
  }
}
```

---

## Sensitive Data Detection Patterns

### Key-Based Detection

| Pattern | Example Keys |
|---------|--------------|
| API Keys | `api_key`, `apiKey`, `API-KEY` |
| Auth Tokens | `auth_token`, `authToken`, `access_token` |
| Passwords | `password`, `passwd`, `pwd` |
| Secrets | `secret`, `secretKey`, `SECRET` |
| Credentials | `credential`, `credentials`, `creds` |
| Private Keys | `private_key`, `privateKey`, `PRIVATE_KEY` |
| Cookies | `cookie`, `cookies`, `set-cookie` |
| Authorization | `authorization`, `Authorization` |

### Value-Based Detection

| Pattern | Example Values |
|---------|----------------|
| OpenAI Keys | `sk-proj-[40+ alphanumeric]` |
| Anthropic Keys | `sk-ant-[95+ alphanumeric with hyphens]` |
| Google OAuth | `ya29.[100+ alphanumeric]` |
| JWT Tokens | `[base64].[base64].[base64]` |
| Bearer Tokens | `Bearer [20+ alphanumeric]` |

---

## Security Checklist

### For Development

- [ ] No hardcoded secrets in code
- [ ] All sensitive data sanitized before logging
- [ ] Input validation on all external data
- [ ] Path security checks for file operations
- [ ] Environment variables for configuration
- [ ] .env in .gitignore
- [ ] No secrets in test fixtures
- [ ] No console.log() of sensitive data

### For Production

- [ ] Use CredentialStore for persistent secrets
- [ ] Enable CODEMIE_DEBUG=false (default)
- [ ] Rotate API keys regularly
- [ ] Monitor for leaked secrets (pre-commit hooks)
- [ ] Audit logs for sensitive data exposure
- [ ] Review file permissions (~/.codemie/)

---

## Common Security Pitfalls

| ❌ Don't Do This | ✅ Do This Instead |
|------------------|-------------------|
| `logger.info('API key:', apiKey)` | `logger.debug('API request', ...sanitizeLogArgs({ apiKey }))` |
| `const key = 'sk-ant-abc123...'` | `const key = process.env.ANTHROPIC_API_KEY` |
| `fs.readFile(userPath)` | `validateFilePath(userPath, workingDir); fs.readFile(userPath)` |
| `console.log(headers)` | `logger.debug('Headers', ...sanitizeLogArgs(headers))` |
| Store tokens in plaintext file | Use CredentialStore |
| Trust user input paths | Validate with isPathWithinDirectory() |
| Log request/response bodies | Sanitize first with sanitizeLogArgs() |

---

## File System Security

### Permissions

```typescript
// Source: src/utils/security.ts:250-270
// Create secure directory
await fs.mkdir(secretDir, {
  recursive: true,
  mode: 0o700 // Owner only
});

// Write secure file
await fs.writeFile(secretFile, data, {
  mode: 0o600 // Owner read/write only
});
```

**File Permissions**:
- `~/.codemie/`: 0o700 (drwx------)
- `~/.codemie/.credentials.enc`: 0o600 (-rw-------)
- `~/.codemie/config.json`: 0o644 (-rw-r--r--)
- `~/.codemie/logs/`: 0o700 (drwx------)

---

## Pre-Commit Secret Detection

```bash
# Validate no secrets before commit
npm run validate:secrets

# Runs automatically via Husky pre-commit hook
# Checks for common secret patterns in staged files
```

**Checked Patterns**:
- API keys (sk-, sk-ant-, etc.)
- Private keys (-----BEGIN PRIVATE KEY-----)
- AWS credentials
- Bearer tokens
- Database passwords in connection strings

---

## Security Utilities Reference

| Function | Purpose | Source |
|----------|---------|--------|
| `sanitizeValue()` | Redact sensitive value | src/utils/security.ts:77 |
| `sanitizeLogArgs()` | Sanitize log arguments | src/utils/security.ts:130 |
| `sanitizeHeaders()` | Redact HTTP headers | src/utils/security.ts:150 |
| `sanitizeCookies()` | Redact cookies | src/utils/security.ts:170 |
| `CredentialStore` | Secure credential storage | src/utils/security.ts:200 |
| `isPathWithinDirectory()` | Validate path safety | src/utils/paths.ts:40 |
| `validatePathDepth()` | Check path depth | src/utils/paths.ts:60 |

---

## References

- **Security Utils**: `src/utils/security.ts`
- **Path Validation**: `src/utils/paths.ts`
- **Error Classes**: `src/utils/errors.ts` (PathSecurityError)
- **Config Validation**: `src/env/config-loader.ts`
- **OWASP Top 10**: https://owasp.org/www-project-top-ten/

---
