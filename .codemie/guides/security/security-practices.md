# Security Practices

## Quick Summary

Security patterns for CodeMie Code: secrets management, input validation, credential storage, and data sanitization.

**Category**: Security
**Complexity**: High
**Prerequisites**: Security fundamentals, Node.js security

---

## Threat Model

### CodeMie Code Security Scope

| Component | Security Concerns | Mitigations |
|-----------|-------------------|-------------|
| **CLI Tool** | Local credentials, command injection | Sanitize args, secure credential storage |
| **HTTP Proxy** | MITM, request tampering | HTTPS, certificate validation |
| **Config Files** | Exposed API keys | Encrypt or use credential store |
| **Logs** | Leaked secrets/PII | Sanitize all log output |
| **Process Execution** | Command injection | Parameterized execution, validation |

**No web server** - this is a CLI tool with limited attack surface

---

## Secrets Management

### Pattern: No Secrets in Code

```typescript
// ✅ GOOD: Use environment variables or config
const apiKey = process.env.CODEMIE_API_KEY || config.authToken;

// ❌ BAD: Hardcoded secret
const apiKey = 'sk-1234567890abcdef'; // NEVER!

// ✅ GOOD: Load from secure credential store
const credentials = await CredentialStore.getInstance().retrieveSSOCredentials();
```

**Rules**:
- ✅ Use environment variables or credential store
- ✅ Encrypt stored credentials (AES-256-GCM)
- ✅ Never commit secrets to git
- ✅ Use `.gitignore` for config files
- ✅ Sanitize secrets from logs
- ❌ Hardcode API keys, tokens, passwords
- ❌ Log secrets or auth tokens
- ❌ Store secrets in plain text

**Sources**: src/utils/security.ts, src/utils/config.ts

---

## Credential Storage (Encrypted)

### Pattern: CredentialStore Class

```typescript
// Source: src/utils/security.ts:200+ (pattern)
export class CredentialStore {
  private static instance: CredentialStore;
  private masterKey: Buffer;
  private credentialsFile: string;

  static getInstance(): CredentialStore {
    if (!CredentialStore.instance) {
      CredentialStore.instance = new CredentialStore();
    }
    return CredentialStore.instance;
  }

  async storeSSOCredentials(credentials: SSOCredentials, baseUrl?: string): Promise<void> {
    const encrypted = this.encrypt(JSON.stringify(credentials));
    await fs.writeFile(this.credentialsFile, encrypted);
  }

  async retrieveSSOCredentials(baseUrl?: string): Promise<SSOCredentials | null> {
    const encrypted = await fs.readFile(this.credentialsFile, 'utf-8');
    const decrypted = this.decrypt(encrypted);
    return JSON.parse(decrypted);
  }
}
```

**Encryption**: AES-256-GCM with master key derived from machine-specific identifier

**Storage Location**: `~/.codemie/.credentials` (encrypted)

**Use Cases**: SSO cookies/tokens, OAuth credentials

---

## Data Sanitization (Logging)

### Sensitive Key Detection

```typescript
// Source: src/utils/security.ts:24-36
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /auth[_-]?token/i,
  /password/i,
  /secret/i,
  /cookie/i,
  /authorization/i
];
```

### Sensitive Value Detection

```typescript
// Source: src/utils/security.ts:41-47
const SENSITIVE_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/,               // OpenAI API keys
  /^sk-ant-[a-zA-Z0-9-_]{95,}$/,         // Anthropic API keys
  /^Bearer\s+[A-Za-z0-9-_.+/=]{20,}$/i,  // Bearer tokens
  /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/  // JWT tokens
];
```

### Sanitization Functions

| Function | Purpose | Example |
|----------|---------|---------|
| `sanitizeValue()` | Sanitize single value | `sanitizeValue(apiKey)` → `'sk-1234...[REDACTED]'` |
| `sanitizeObject()` | Recursively sanitize object | `sanitizeObject(config)` |
| `sanitizeLogArgs()` | Sanitize multiple log args | `logger.debug('msg', ...sanitizeLogArgs(obj))` |
| `sanitizeCookies()` | Sanitize cookies for logs | `'3 cookie(s): session, token [values redacted]'` |
| `sanitizeHeaders()` | Sanitize HTTP headers | Redact Authorization, Cookie |
| `sanitizeAuthToken()` | Partially mask token | `'sk-1234...[25 chars, redacted]'` |

**Source**: src/utils/security.ts:77-190

---

## Input Validation

### Command Injection Prevention

```typescript
// ✅ GOOD: Use parameterized execution
import { exec } from './utils/exec.js';
await exec('npm', ['install', packageName]); // Safe: args are parameters

// ❌ BAD: String concatenation
await exec(`npm install ${packageName}`); // VULNERABLE!
```

**Pattern**: Always pass arguments as array, never concat into command string

**Source**: src/utils/exec.ts, src/utils/processes.ts

---

### Path Traversal Prevention

```typescript
// Source: src/agents/codemie-code/tools/__tests__/path-security.test.ts (pattern)
export function validatePath(filePath: string, workingDir: string): boolean {
  const resolvedPath = path.resolve(workingDir, filePath);

  // Check 1: Path must be within working directory
  if (!resolvedPath.startsWith(workingDir)) {
    throw new PathSecurityError('Path traversal detected');
  }

  // Check 2: No suspicious patterns
  if (filePath.includes('..')) {
    throw new PathSecurityError('Path contains .. component');
  }

  return true;
}
```

**Rules**:
- ✅ Resolve paths with `path.resolve()`
- ✅ Verify path is within allowed directory
- ✅ Block `..` components
- ✅ Whitelist allowed directories
- ❌ Trust user-provided paths directly

---

### Configuration Validation

```typescript
// Pattern: Validate at boundaries
export function validateConfig(config: unknown): Config {
  if (!config || typeof config !== 'object') {
    throw new ConfigurationError('Invalid config format');
  }

  const { provider, model } = config as any;

  if (!provider || typeof provider !== 'string') {
    throw new ConfigurationError('Missing or invalid provider');
  }

  if (!model || typeof model !== 'string') {
    throw new ConfigurationError('Missing or invalid model');
  }

  return config as Config;
}
```

**Rules**:
- ✅ Validate at entry points (CLI, config loading)
- ✅ Use type guards for runtime checks
- ✅ Throw specific errors (ConfigurationError)
- ❌ Trust data from files/user input

---

## Secrets Detection (CI/CD)

### Gitleaks Integration

```yaml
# Source: .github/workflows/ci.yml:39-55
secrets-detection:
  runs-on: ubuntu-latest
  steps:
    - name: Run Gitleaks
      uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Prevents**: Committing API keys, tokens, passwords

**Runs**: On every PR (blocking merge if secrets detected)

---

## Log Security

### Pattern: Always Sanitize

```typescript
// ✅ GOOD: Sanitize before logging
import { sanitizeLogArgs } from './utils/security.js';

logger.debug('Config loaded', ...sanitizeLogArgs(config));
logger.debug('API request', ...sanitizeLogArgs({ headers, body }));

// ❌ BAD: Direct logging (leaks secrets)
logger.debug('Config loaded', config); // May contain apiKey!
logger.debug('API request', { headers }); // May contain Authorization header!
```

**Sanitization Coverage**:
- API keys/tokens (redacted)
- Authorization headers (redacted)
- Cookies (count + names only, values redacted)
- Passwords (redacted)
- JWTs (redacted)

**Source**: src/utils/security.ts:11-190, src/utils/logger.ts

---

## HTTPS/TLS Configuration

### Pattern: Secure by Default

```typescript
// Source: src/providers/plugins/sso/proxy/proxy-http-client.ts:39-43 (pattern)
const agentOptions = {
  rejectUnauthorized: options.rejectUnauthorized ?? false,  // Configurable for dev
  keepAlive: true,
  maxSockets: 50
};

const httpsAgent = new https.Agent(agentOptions);
```

**Rules**:
- ✅ Use HTTPS for external API calls
- ✅ Validate certificates in production (`rejectUnauthorized: true`)
- ✅ Allow insecure mode only for dev/testing (with warning)
- ❌ Disable certificate validation in production

**Dev Mode**: `rejectUnauthorized: false` allowed (self-signed certs for testing)

---

## Endpoint Security (SSO Proxy)

### Pattern: Endpoint Blocking

```typescript
// Source: src/providers/plugins/sso/proxy/plugins/endpoint-blocker.plugin.ts (pattern)
const DANGEROUS_ENDPOINTS = [
  '/v1/admin',
  '/v1/organizations',
  '/internal'
];

export class EndpointBlockerPlugin implements ProxyPlugin {
  transformRequest(req: ProxyRequest): Promise<ProxyRequest> {
    if (this.isDangerous(req.url)) {
      throw new ProxyError('Access to dangerous endpoint blocked');
    }
    return Promise.resolve(req);
  }
}
```

**Purpose**: Block access to administrative or dangerous endpoints via proxy

**Use Case**: Prevent CLI from accessing sensitive API endpoints

---

## Security Checklist

### Pre-Commit

- [ ] No hardcoded secrets (API keys, tokens, passwords)
- [ ] Sensitive data sanitized in logs
- [ ] Config files in `.gitignore`
- [ ] No SQL injection vectors (not applicable - no DB)
- [ ] Command injection prevented (parameterized execution)
- [ ] Path traversal prevented (validated paths)

### Pre-Deployment

- [ ] Secrets in environment variables or credential store
- [ ] HTTPS enabled for external APIs
- [ ] Certificate validation enabled
- [ ] Gitleaks scan passing (CI)
- [ ] Error messages don't leak sensitive info
- [ ] Debug logs disabled in production

### Code Review

- [ ] New config fields sanitized in logs
- [ ] User input validated before use
- [ ] External process execution uses parameterized args
- [ ] File paths validated for traversal
- [ ] HTTP clients use HTTPS
- [ ] No new secrets added to code

---

## Common Vulnerabilities

| Vulnerability | CodeMie Code Risk | Mitigation |
|---------------|-------------------|------------|
| **Hardcoded Secrets** | High (API keys in code) | Use config/env vars, sanitize logs |
| **Command Injection** | Medium (npm/git execution) | Parameterized args only |
| **Path Traversal** | Medium (file operations) | Validate paths, block `..` |
| **Log Injection** | Low (sanitization implemented) | `sanitizeLogArgs()` everywhere |
| **MITM** | Low (HTTPS default) | Validate certificates |
| **Credential Theft** | Medium (local config files) | Encrypt credentials, file permissions |

**Not Applicable** (CLI tool, not web app): XSS, CSRF, SQL injection, session hijacking

---

## Security Resources

### Tools

| Tool | Purpose | Usage |
|------|---------|-------|
| **Gitleaks** | Secrets detection | CI/CD (automatic) |
| **npm audit** | Dependency vulnerabilities | `npm audit` (manual) |
| **ESLint** | Code quality & security | `npm run lint` |

---

## References

- **Security Utils**: `src/utils/security.ts`
- **Credential Store**: `src/utils/security.ts:200+`
- **Process Execution**: `src/utils/exec.ts`, `src/utils/processes.ts`
- **Path Security Tests**: `src/agents/codemie-code/tools/__tests__/path-security.test.ts`
- **Sanitization Tests**: `src/utils/__tests__/security.test.ts`
- **CI Secrets Detection**: `.github/workflows/ci.yml:39-55`
- **OWASP Top 10**: https://owasp.org/www-project-top-ten/
- **Node.js Security**: https://nodejs.org/en/docs/guides/security/

---

## Related Guides

- Development Practices: .codemie/guides/development/development-practices.md
- Code Quality: .codemie/guides/standards/code-quality.md
- Testing Patterns: .codemie/guides/testing/testing-patterns.md
