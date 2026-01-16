# External Integrations

## Quick Summary

External integration patterns for CodeMie Code: LLM providers, package managers (npm), version control (git), and workflow generation.

**Category**: Integration
**Complexity**: Medium
**Prerequisites**: HTTP APIs, npm, git

---

## Integration Overview

| Integration | Type | Purpose | Implementation |
|-------------|------|---------|----------------|
| **LLM Providers** | HTTP API | AI model inference | Provider plugins |
| **npm** | Process execution | Package management | `src/utils/processes.ts` |
| **git** | Process execution | Version control detection | `src/utils/processes.ts` |
| **GitHub/GitLab** | Workflow generation | CI/CD setup | `src/workflows/` |
| **Keychain** | Native module | Secure credential storage | `keytar` (optional) |

---

## LLM Provider Integration

### Provider Architecture

```typescript
// Source: src/providers/core/types.ts:48-100
export interface ProviderTemplate {
  name: string;                      // 'openai', 'anthropic', 'sso', etc.
  displayName: string;
  defaultBaseUrl: string;            // API endpoint
  requiresAuth?: boolean;
  authType?: AuthenticationType;     // 'api-key', 'sso', 'oauth'
  recommendedModels: string[];
  capabilities: ProviderCapability[];
}
```

### Built-in Providers

| Provider | Auth Type | Base URL | Capabilities |
|----------|-----------|----------|--------------|
| **OpenAI** | API key | `api.openai.com` | streaming, tools, vision, json-mode |
| **Anthropic** | API key | `api.anthropic.com` | streaming, tools, vision |
| **SSO** | OAuth/SSO | Configurable | streaming, tools, sso-auth |
| **Bedrock** | AWS credentials | Bedrock endpoints | streaming, tools |
| **Ollama** | None | `localhost:11434` | streaming, model-management |
| **LiteLLM** | Configurable | Configurable | streaming (proxy to any provider) |

**Source**: src/providers/plugins/

---

## HTTP Client Pattern

### Streaming HTTP Client

```typescript
// Source: src/providers/plugins/sso/proxy/proxy-http-client.ts:28-80
export class ProxyHTTPClient {
  private httpsAgent: https.Agent;

  constructor(options: HTTPClientOptions) {
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      rejectUnauthorized: options.rejectUnauthorized ?? false
    });
  }

  async forward(url: URL, options: ForwardRequestOptions): Promise<http.IncomingMessage> {
    // Return stream directly (no buffering)
    return new Promise((resolve, reject) => {
      const req = https.request({ ...requestOptions, agent: this.httpsAgent }, resolve);
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }
}
```

**Key Features**:
- Connection pooling (keep-alive)
- Streaming responses (memory-efficient)
- Configurable TLS validation
- Timeout support (0 = unlimited for long AI requests)

---

## npm Integration

### Package Management

```typescript
// Source: src/utils/processes.ts (pattern)
export async function installGlobal(
  packageName: string,
  options?: NpmInstallOptions
): Promise<void> {
  await exec('npm', ['install', '-g', packageName], options);
}

export async function uninstallGlobal(
  packageName: string,
  options?: NpmOptions
): Promise<void> {
  await exec('npm', ['uninstall', '-g', packageName], options);
}

export async function listGlobal(
  packageName: string,
  options?: NpmOptions
): Promise<boolean> {
  const result = await exec('npm', ['list', '-g', packageName, '--depth=0'], {
    ...options,
    throwOnError: false
  });
  return result.code === 0;
}
```

**Use Cases**:
- Install agent packages (`@claude/code`, `@google/gemini-cli`)
- Check if agent installed
- Uninstall agents
- Get package version info

**Error Handling**: Parse npm stderr for specific error codes (404, EACCES, timeout)

**Source**: src/utils/processes.ts:npm functions

---

## git Integration

### Repository Detection

```typescript
// Source: src/utils/processes.ts (pattern)
export async function detectGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const result = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      throwOnError: false
    });
    return result.code === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

// Usage in workflows
const branch = await detectGitBranch(process.cwd());
if (branch) {
  logger.info(`Detected git branch: ${branch}`);
}
```

**Use Cases**:
- Detect current branch for workflow configuration
- Check if directory is git repository
- Validate git availability

---

## CI/CD Workflow Integration

### Workflow Template Generation

```typescript
// Source: src/workflows/ (pattern)
export interface WorkflowTemplate {
  platform: 'github' | 'gitlab';
  name: string;
  template: string;  // YAML content
}

// Generate GitHub Actions workflow
export function generateGitHubWorkflow(config: WorkflowConfig): string {
  return `
name: ${config.name}

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ '**' ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm run lint
      - run: npm test
  `;
}
```

**Templates Location**: `src/workflows/templates/*.yml`

**CLI Command**: `codemie workflow install --platform github`

**Source**: src/workflows/installer.ts, src/cli/commands/workflow.ts

---

## Agent Installation Integration

**Pattern**: Check (listGlobal) → Install (installGlobal) → Verify (getCommandPath)

**Source**: src/agents/plugins/*/installer.ts

---

## Command Detection

**Functions**: `getCommandPath()`, `commandExists()` - use `which` command

**Use Cases**: Verify agent binaries, check dependencies, health checks

---

## Provider-Specific Integrations

| Provider | Special Integration | Features |
|----------|-------------------|----------|
| **AWS Bedrock** | AWS credentials, custom env vars | `exportEnvVars` hook |
| **SSO** | OAuth 2.0 flow, encrypted storage | Browser redirect, local callback server |
| **Ollama** | Local model management | List/pull/remove models |

**Sources**: src/providers/plugins/{bedrock,sso,ollama}/

---

## Integration Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Use parameterized process execution | String concat commands (injection risk) |
| Stream large responses (memory efficiency) | Buffer entire responses |
| Set timeouts on external calls | Infinite timeouts |
| Validate certificate in production | Disable SSL validation in prod |
| Handle provider-specific errors | Generic error handling |
| Use connection pooling (keep-alive) | Create new connection each request |
| Implement retries with backoff | Retry immediately forever |
| Log requests (sanitized) | Log with secrets |

---

## Error Handling Patterns

**Network Errors**: ECONNREFUSED → NetworkError with helpful message

**Provider Errors**: 401 → AuthenticationError, 429 → RateLimitError, 5xx → ProviderError

**Source**: src/providers/plugins/sso/proxy/proxy-errors.ts

---

## Testing External Integrations

**Unit Tests**: Mock fetch/HTTP responses (vi.fn().mockResolvedValue)

**Integration Tests**: Use real commands (npm, git) with known-good inputs

**Source**: tests/integration/processes.test.ts

---

## Performance Considerations

| Integration | Performance Impact | Mitigation |
|-------------|-------------------|------------|
| **npm install** | Slow (30s - 5min) | Show spinner, timeout=300s |
| **Streaming responses** | Memory-efficient | Don't buffer, pipe directly |
| **Connection pooling** | Reduces latency | keep-alive=true, maxSockets=50 |
| **Parallel requests** | Faster | Use Promise.all() for independent calls |

---

## References

- **Provider Templates**: `src/providers/core/types.ts`
- **Provider Plugins**: `src/providers/plugins/`
- **Process Utilities**: `src/utils/processes.ts`
- **HTTP Proxy**: `src/providers/plugins/sso/proxy/`
- **Workflows**: `src/workflows/`
- **Agent Installers**: `src/agents/plugins/*/installer.ts`
- **Session Sync**: `src/providers/plugins/sso/session/`

---

## Related Guides

- API Patterns: .codemie/guides/api/api-patterns.md
- Security Practices: .codemie/guides/security/security-practices.md
- Development Practices: .codemie/guides/development/development-practices.md
- Testing Patterns: .codemie/guides/testing/testing-patterns.md
