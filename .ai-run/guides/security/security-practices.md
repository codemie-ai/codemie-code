# Security Practices

Security patterns for CodeMie Code: credential storage, data sanitization, input validation, and secrets management.

**Category**: Security | **Complexity**: High

---

## Core Security Principles

| Principle | Implementation |
|-----------|----------------|
| No hardcoded secrets | Environment variables + CredentialStore |
| Input validation | Path security checks, sanitization |
| Data sanitization | Auto-redact sensitive data in logs |
| Secure storage | Encrypted credential storage (keytar + fallback) |
| Least privilege | File permissions, scoped access |
| **Request header integrity (project & user attribution)** | **Any add/remove/rewrite of project- or user-attribution headers is a CRITICAL change — security review required before merge** |

---

## CRITICAL: Project & User Attribution Headers

Any change that adds, removes, renames, or rewrites a header carrying **project identity**, **user identity**, or **session attribution** on outbound requests is a **CRITICAL, security-reviewed change**. This applies to headers, to fields that stand in for them (e.g. the Responses API `user` body field, JWT `sub` overrides), and to any derivation source that feeds them.

These identifiers back audit trails, tenant isolation, per-user budget accounting, abuse tracing, and analytics attribution. A silent rewrite — even a "harmless" hash, prefix, or normalization — can:

- break audit correlation between CLI action and server-side event,
- misattribute usage or billing across tenants/users,
- hide abuse behind an unreachable identifier,
- cross-attribute analytics between repositories/branches.

### Headers and identifier fields in scope

Injected today by `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts`:

| Header | Meaning |
|---|---|
| `X-CodeMie-Request-ID` | Per-request correlation ID |
| `X-CodeMie-Session-ID` (+ `x-litellm-session-id`) | Session attribution |
| `X-CodeMie-CLI` / `X-CodeMie-CLI-Model` / `X-CodeMie-CLI-Timeout` | Client attribution |
| `X-CodeMie-Client` | Agent client type |
| `X-CodeMie-Integration` | Integration/tenant identity |
| `X-CodeMie-Repository` / `X-CodeMie-Branch` / `X-CodeMie-Project` | Repository/branch/project attribution |

Also in scope even though they are body fields, not headers: the Responses API `user` field, JWT `sub` / `email` overrides, and any other identifier the server treats as authoritative for attribution.

### Rules for changes that touch any of the above

1. **Do not add, remove, rename, or rewrite** any project/user attribution header (or standin field) without an explicit security-review sign-off on the PR.
2. **Do not derive the value from a new source** (process introspection, environment guesswork, filesystem heuristics) without security review — the derivation is part of the surface.
3. **Do not silently normalize** (hash, truncate, hex-prefix) an identifier the server may treat as authoritative — normalization must be an intentional, documented protocol change agreed with the server side.
4. **Header injection lives in exactly one layer**: the proxy plugin `header-injection.plugin.ts`. Do not add a second injection path (telemetry runtime, adapter, CLI) that competes with it.
5. **Never log full header values** without `sanitizeHeaders()` — attribution headers carry PII (email, repository path).

### Bad vs. Good

| Bad | Good |
|-----|------|
| Rewriting `user` body field to `sha256(user).slice(0,32)` inside a proxy plugin, silently, for all clients | Route the change through security review; if the server can't accept the raw identifier, agree on a protocol with the server team and document it |
| Adding a second code path that sets `X-CodeMie-Repository` from `lsof` output outside `header-injection.plugin.ts` | Extend the single canonical injector with an audited derivation, or expose a typed contract the injector reads from |
| Reading `.git/HEAD` and stuffing the result into `X-CodeMie-Branch` with no worktree handling | Use `detectGitBranch()` from `src/utils/processes.ts` and treat any failure as "no attribution", not a guess |
| `logger.info('outbound headers', headers)` | `logger.debug('outbound headers', ...sanitizeLogArgs({ headers }))` |

### Reviewer checklist for header-touching PRs

Copy this into the PR review when the diff touches any attribution header, the `user` body field, JWT claim overrides, or the derivation source of any of them:

- [ ] Change is called out as **CRITICAL** in the PR description with the security-review sign-off recorded.
- [ ] Header injection stays in `header-injection.plugin.ts` — no competing injector added elsewhere.
- [ ] Derivation source is auditable and does not depend on unbounded OS introspection (`lsof`, process tree walks) unless explicitly approved.
- [ ] No silent normalization (hash/truncate/prefix) of an authoritative identifier without documented server-side agreement.
- [ ] Values are sanitized on every log path (`sanitizeHeaders`, `sanitizeLogArgs`).
- [ ] Tests cover: header present with expected value, header absent when attribution unknown (not a guessed default), header not leaked to logs.
- [ ] No new PII surface in URL query strings or filenames derived from the identifier.

References:
- `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts` — canonical injection point
- `src/utils/security.ts` — `sanitizeHeaders`, `sanitizeLogArgs`
- `.ai-run/guides/standards/git-workflow.md` — Code Review Checklist

---

## Credential Storage

Use `CredentialStore` (singleton) for all persistent secret storage. Never store tokens in plaintext files.

- **Primary**: System keychain via keytar (macOS Keychain, Windows Credential Vault, Linux Secret Service)
- **Fallback**: Encrypted JSON file with AES-256-GCM (`~/.codemie/.credentials.enc`), key derived from machine ID + OS username

```typescript
// src/utils/security.ts:200-230
const store = CredentialStore.getInstance();
await store.storeSSOCredentials({ accessToken, refreshToken, expiresAt }, url);
const creds = await store.retrieveSSOCredentials(url);
await store.deleteSSOCredentials(url);
```

| Bad | Good |
|-----|------|
| Store tokens in a plaintext JSON file | `CredentialStore.getInstance().storeSSOCredentials(...)` |
| Hardcode `const key = 'sk-ant-abc123'` | `const key = process.env.ANTHROPIC_API_KEY` |

Reference: `src/utils/security.ts:200` — `CredentialStore`

---

## Data Sanitization for Logging

Always sanitize before logging. `sanitizeLogArgs()` auto-redacts sensitive keys and values recursively.

- **Sensitive keys detected**: `api_key`, `auth_token`, `password`, `secret`, `credential`, `private_key`, `cookie`, `authorization`
- **Sensitive value patterns**: OpenAI keys (`sk-*`), Anthropic keys (`sk-ant-*`), JWT tokens, Bearer tokens, OAuth tokens
- **Masking**: Long values → first/last 4 chars + `[REDACTED]`; short values → `[REDACTED]`

```typescript
// src/utils/security.ts:77-100
logger.debug('API request', ...sanitizeLogArgs({
  url: request.url,
  headers: request.headers, // Auto-redacts Authorization, Cookie, etc.
  apiKey: 'sk-ant-...',     // Redacted by key name
  token: 'bearer xyz...'    // Redacted by value pattern
}));
const safeValue = sanitizeValue(sensitiveData, 'apiKey');
```

| Bad | Good |
|-----|------|
| `logger.info('API key:', apiKey)` | `logger.debug('key', ...sanitizeLogArgs({ apiKey }))` |
| `console.log(headers)` | `logger.debug('Headers', ...sanitizeLogArgs(headers))` |
| Log request/response bodies raw | Sanitize first with `sanitizeLogArgs()` |

References: `src/utils/security.ts:77` — `sanitizeValue`; `src/utils/security.ts:130` — `sanitizeLogArgs`

---

## Input Validation — Path Security

Resolve and validate every file path before use. Throw `PathSecurityError` on violations.

- Always resolve relative paths before checking
- Confirm path stays within the working directory
- Limit depth to prevent deeply nested path attacks
- Never trust user-provided paths directly; reject `../` traversal

```typescript
// src/agents/codemie-code/tools/path-security.test.ts:10-30
import { isPathWithinDirectory, validatePathDepth } from './utils/paths.js';
import { PathSecurityError } from './utils/errors.js';

const resolved = path.resolve(workingDir, filePath);
if (!isPathWithinDirectory(workingDir, resolved))
  throw new PathSecurityError(filePath, 'Path outside working directory');
if (!validatePathDepth(resolved, workingDir, 10))
  throw new PathSecurityError(filePath, 'Path depth exceeds limit');
```

| Bad | Good |
|-----|------|
| `fs.readFile(userPath)` | Validate with `isPathWithinDirectory()` first |
| Trust user input paths | `validateFilePath(userPath, workingDir)` |

References: `src/utils/paths.ts:40` — `isPathWithinDirectory`; `src/utils/paths.ts:60` — `validatePathDepth`

---

## Secrets Management

### Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...           # For Claude
OPENAI_API_KEY=sk-...                  # For OpenAI
GOOGLE_AI_API_KEY=...                  # For Gemini
SSO_BASE_URL=https://api.company.com   # Enterprise SSO
SSO_WORKSPACE=workspace-id
CODEMIE_DEBUG=true                     # Debug (non-sensitive)
```

Rules:
- Use environment variables for all secrets; use `CredentialStore` for long-term storage
- Never hardcode secrets, never commit `.env` files, never log secret values

### Validating Secrets at Startup

```typescript
// src/env/config-loader.ts:80-100
const apiKey = process.env.ANTHROPIC_API_KEY
            || process.env.OPENAI_API_KEY
            || process.env.GOOGLE_AI_API_KEY;
if (!apiKey && config.profile.provider.type !== 'sso')
  throw new ConfigurationError('No API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_AI_API_KEY');
```

Reference: `src/env/config-loader.ts:80`

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

## File System Security

Set restrictive permissions on all credential and config directories.

```typescript
// src/utils/security.ts:250-270
await fs.mkdir(secretDir, { recursive: true, mode: 0o700 });  // Owner only
await fs.writeFile(secretFile, data, { mode: 0o600 });         // Owner read/write only
```

| Path | Permission |
|------|------------|
| `~/.codemie/` | `0o700` (drwx------) |
| `~/.codemie/.credentials.enc` | `0o600` (-rw-------) |
| `~/.codemie/config.json` | `0o644` (-rw-r--r--) |
| `~/.codemie/logs/` | `0o700` (drwx------) |

Reference: `src/utils/security.ts:250`

---

## Pre-Commit Secret Detection

```bash
npm run validate:secrets  # Also runs automatically via Husky pre-commit hook
```

Checked patterns: API keys (`sk-`, `sk-ant-`), private keys (`-----BEGIN PRIVATE KEY-----`), AWS credentials, Bearer tokens, database passwords in connection strings.

---

## Security Utilities Reference

| Function | Purpose | Source |
|----------|---------|--------|
| `sanitizeValue()` | Redact sensitive value | `src/utils/security.ts:77` |
| `sanitizeLogArgs()` | Sanitize log arguments | `src/utils/security.ts:130` |
| `sanitizeHeaders()` | Redact HTTP headers | `src/utils/security.ts:150` |
| `sanitizeCookies()` | Redact cookies | `src/utils/security.ts:170` |
| `CredentialStore` | Secure credential storage | `src/utils/security.ts:200` |
| `isPathWithinDirectory()` | Validate path safety | `src/utils/paths.ts:40` |
| `validatePathDepth()` | Check path depth | `src/utils/paths.ts:60` |

---

## Common Security Pitfalls

| Bad | Good |
|-----|------|
| `logger.info('API key:', apiKey)` | `logger.debug('API request', ...sanitizeLogArgs({ apiKey }))` |
| `const key = 'sk-ant-abc123...'` | `const key = process.env.ANTHROPIC_API_KEY` |
| `fs.readFile(userPath)` | `validateFilePath(userPath, workingDir); fs.readFile(userPath)` |
| `console.log(headers)` | `logger.debug('Headers', ...sanitizeLogArgs(headers))` |
| Store tokens in plaintext file | Use `CredentialStore` |
| **Add/rewrite an `X-CodeMie-*` attribution header (or the Responses `user` field) without security review** | **Route the change through security review; keep injection in `header-injection.plugin.ts`; document any normalization** |
| **Add a second competing header-injection path (telemetry runtime, adapter, CLI)** | **Extend the single canonical injector or expose a typed contract it reads from** |

---

## Security Checklists

### Development
- [ ] No hardcoded secrets in code
- [ ] All sensitive data sanitized before logging (`sanitizeLogArgs`)
- [ ] Input validation on all external data
- [ ] Path security checks for file operations (`isPathWithinDirectory`)
- [ ] Environment variables for configuration
- [ ] `.env` in `.gitignore`
- [ ] No secrets in test fixtures
- [ ] No `console.log()` of sensitive data
- [ ] **No add/remove/rename/rewrite of project or user attribution headers (or the Responses `user` body field) without security-review sign-off** — see "CRITICAL: Project & User Attribution Headers" above

### Production
- [ ] Use `CredentialStore` for persistent secrets
- [ ] `CODEMIE_DEBUG=false` (default)
- [ ] Rotate API keys regularly
- [ ] Monitor for leaked secrets (pre-commit hooks)
- [ ] Audit logs for sensitive data exposure
- [ ] Review file permissions (`~/.codemie/`)

---

## References

- **Security Utils**: `src/utils/security.ts`
- **Path Validation**: `src/utils/paths.ts`
- **Error Classes**: `src/utils/errors.ts` (`PathSecurityError`)
- **Config Validation**: `src/env/config-loader.ts`
- **Related guides**: `.ai-run/guides/development/development-practices.md`, `.ai-run/guides/architecture/architecture.md`
- **OWASP Top 10**: https://owasp.org/www-project-top-ten/
