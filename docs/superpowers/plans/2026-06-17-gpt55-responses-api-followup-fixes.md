# GPT-5.5 Responses-API Follow-up Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three follow-up issues found after the gpt-5.5 routing PR: make the SSO proxy's request sanitizer endpoint-aware (F1), widen the encrypted-content sanitizer to codemie-code/codemie-opencode (F2), and correct the gpt-5.5 context limit from 400k to 1050k (F4).

**Architecture:** The SSO proxy pipeline runs interceptors in priority order. `RequestSanitizerPlugin` (priority 15) strips reasoning params — it needs a path check to preserve `reasoning.effort` on `/v1/responses`. `CodexEncryptedContentSanitizerPlugin` (priority 16) needs its agent allowlist widened from `codemie-codex` alone to all three OpenCode agents. The context limit is a static constant and a heuristic branch in the dynamic model resolver.

**Tech Stack:** TypeScript, Vitest, Node.js ≥ 20. No new dependencies.

---

## File Map

| File | Action | Reason |
|---|---|---|
| `src/providers/plugins/sso/proxy/plugins/request-sanitizer.plugin.ts` | Modify | F1: path-aware sanitizer logic |
| `src/providers/plugins/sso/proxy/plugins/__tests__/request-sanitizer.plugin.test.ts` | Modify | F1: add `/v1/responses` test cases, update `createProxyContext` helper |
| `src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts` | Modify | F2: widen ALLOWED_AGENTS, pass clientType to interceptor |
| `src/providers/plugins/sso/proxy/plugins/__tests__/codex-encrypted-content-sanitizer.plugin.test.ts` | Create | F2: new test file (none exists today) |
| `src/agents/plugins/opencode/opencode-model-configs.ts` | Modify | F4: gpt-5.5 context limit 400000 → 1050000 |
| `src/agents/plugins/opencode/opencode-dynamic-models.ts` | Modify | F4: gpt-5.5 branch before generic gpt-5 branch in `detectLimits()` |
| `src/agents/plugins/__tests__/opencode-gpt55-routing.test.ts` | Modify | F4: add context-limit assertions via `convertApiModelToOpenCodeConfig` |

---

## Task 1: F1 — Add failing tests for Responses API path behavior

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/__tests__/request-sanitizer.plugin.test.ts`

The existing `createProxyContext` helper hard-codes `url: '/v1/chat/completions'`. Add an optional third parameter so Responses-API tests can use `/v1/responses`.

- [ ] **Step 1: Update `createProxyContext` to accept optional URL**

In `request-sanitizer.plugin.test.ts`, change the helper signature at line 30:

```ts
function createProxyContext(
  body: Record<string, unknown> | null,
  contentType = 'application/json',
  url = '/v1/chat/completions',
): ProxyContext {
  const requestBody = body ? Buffer.from(JSON.stringify(body), 'utf-8') : null;
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method: 'POST',
    url,
    headers: {
      'content-type': contentType,
      ...(requestBody && { 'content-length': String(requestBody.length) }),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}
```

- [ ] **Step 2: Add a new `describe` block for Responses API behavior**

Append this block at the end of the outer `describe('RequestSanitizerPlugin', ...)` block (after the `Edge Cases` describe, before the closing `}`):

```ts
describe('Responses API path — preserve effort, strip summary', () => {
  let interceptor: ProxyInterceptor;

  beforeEach(async () => {
    interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
  });

  it('preserves reasoning.effort on /v1/responses', async () => {
    const context = createProxyContext(
      { model: 'gpt-5.5-2026-04-24', reasoning: { effort: 'medium', summary: 'auto' } },
      'application/json',
      '/v1/responses',
    );

    await interceptor.onRequest!(context);

    const body = JSON.parse(context.requestBody!.toString('utf-8'));
    expect(body.reasoning).toBeDefined();
    expect(body.reasoning.effort).toBe('medium');
  });

  it('strips reasoning.summary on /v1/responses', async () => {
    const context = createProxyContext(
      { model: 'gpt-5.5-2026-04-24', reasoning: { effort: 'medium', summary: 'auto' } },
      'application/json',
      '/v1/responses',
    );

    await interceptor.onRequest!(context);

    const body = JSON.parse(context.requestBody!.toString('utf-8'));
    expect(body.reasoning.summary).toBeUndefined();
  });

  it('strips top-level reasoningSummary on /v1/responses', async () => {
    const context = createProxyContext(
      { model: 'gpt-5.5-2026-04-24', reasoning: { effort: 'medium' }, reasoningSummary: 'auto' },
      'application/json',
      '/v1/responses',
    );

    await interceptor.onRequest!(context);

    const body = JSON.parse(context.requestBody!.toString('utf-8'));
    expect(body.reasoningSummary).toBeUndefined();
    expect(body.reasoning.effort).toBe('medium');
  });

  it('strips top-level reasoning_summary on /v1/responses', async () => {
    const context = createProxyContext(
      { model: 'gpt-5.5-2026-04-24', reasoning: { effort: 'high' }, reasoning_summary: 'detailed' },
      'application/json',
      '/v1/responses',
    );

    await interceptor.onRequest!(context);

    const body = JSON.parse(context.requestBody!.toString('utf-8'));
    expect(body.reasoning_summary).toBeUndefined();
    expect(body.reasoning.effort).toBe('high');
  });

  it('passes through non-object reasoning on /v1/responses without deleting it', async () => {
    const context = createProxyContext(
      { model: 'gpt-5.5-2026-04-24', reasoning: 'auto' },
      'application/json',
      '/v1/responses',
    );

    await interceptor.onRequest!(context);

    const body = JSON.parse(context.requestBody!.toString('utf-8'));
    // Non-object reasoning is anomalous on /v1/responses; pass through unchanged
    expect(body.reasoning).toBe('auto');
  });

  it('updates content-length after stripping on /v1/responses', async () => {
    const context = createProxyContext(
      { model: 'gpt-5.5-2026-04-24', reasoning: { effort: 'medium', summary: 'auto' }, reasoningSummary: 'auto' },
      'application/json',
      '/v1/responses',
    );
    const originalLength = Number(context.headers['content-length']);

    await interceptor.onRequest!(context);

    expect(Number(context.headers['content-length'])).toBeLessThan(originalLength);
    expect(Number(context.headers['content-length'])).toBe(context.requestBody!.length);
  });
});
```

- [ ] **Step 3: Run the new tests — verify they FAIL**

```bash
npm run test:unit -- --run src/providers/plugins/sso/proxy/plugins/__tests__/request-sanitizer.plugin.test.ts
```

Expected: the new "Responses API path" tests fail (currently `UNSUPPORTED_PARAMS` deletes `reasoning` entirely, so `body.reasoning` will be `undefined` instead of `{ effort: 'medium' }`). Existing tests still pass.

---

## Task 2: F1 — Implement path-aware sanitizer

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/request-sanitizer.plugin.ts`

- [ ] **Step 1: Replace the `UNSUPPORTED_PARAMS` constant and `onRequest` method**

Replace the entire file with:

```ts
/**
 * Request Sanitizer Plugin
 * Priority: 15 (runs after auth, before header injection)
 *
 * Strips request body parameters that upstream LLM proxies (LiteLLM/Azure)
 * may not support. Specifically targets reasoning-related params that AI SDKs
 * inject for GPT-5 and o-series "reasoning models".
 *
 * Problem: @ai-sdk/openai-compatible and @langchain/openai detect GPT-5/o-series
 * as reasoning models and inject `reasoningSummary`, `reasoning` (object), etc.
 * LiteLLM/Azure rejects these with: "Unknown parameter: 'reasoningSummary'"
 *
 * Endpoint-aware behavior:
 * - /v1/chat/completions (and all other paths): strip `reasoning`, `reasoningSummary`,
 *   `reasoning_summary` entirely — these are invalid on Chat Completions.
 * - /v1/responses: `reasoning: { effort, summary }` is a valid field. Preserve
 *   `reasoning.effort`; strip only `reasoning.summary` (conservative — Azure
 *   supports it but it's unused today) and the camelCase top-level leakage.
 *   NOTE: stripping `reasoning.summary` can be relaxed to keep summaries once
 *   confirmed desired and accepted by the upstream deployment.
 *
 * URL discriminator: path.endsWith('/responses') — prefix-agnostic, keys on the
 * AI SDK endpoint segment not the deployment-controlled base path.
 *
 * Scope: Only enabled for codemie-code and codemie-opencode agents (which use
 * AI SDKs that inject these params). Other agents (claude, gemini) handle their
 * own request formatting and don't need this sanitization.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

/** Agents that use AI SDKs which inject unsupported reasoning params */
const ALLOWED_AGENTS = ['codemie-code', 'codemie-opencode'];

export class RequestSanitizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-request-sanitizer';
  name = 'Request Sanitizer';
  version = '1.0.0';
  priority = 15; // After auth (10), before header injection (20)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
    return new RequestSanitizerInterceptor();
  }
}

class RequestSanitizerInterceptor implements ProxyInterceptor {
  name = 'request-sanitizer';

  async onRequest(context: ProxyContext): Promise<void> {
    // Only process JSON request bodies (POST/PUT/PATCH with content)
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const bodyStr = context.requestBody.toString('utf-8');
      const body = JSON.parse(bodyStr) as Record<string, unknown>;

      const stripped: string[] = [];

      // Determine endpoint: key on the trailing segment the AI SDK controls,
      // not the deployment-controlled base prefix (avoids /v1 coupling).
      const path = context.url.split('?')[0].replace(/\/+$/, '');
      const isResponsesApi = path.endsWith('/responses');

      if (isResponsesApi) {
        // /v1/responses: reasoning: { effort, summary } is valid.
        // Strip only the camelCase top-level leakage and the nested summary field.
        for (const k of ['reasoningSummary', 'reasoning_summary'] as const) {
          if (k in body) {
            delete body[k];
            stripped.push(k);
          }
        }
        if (body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)) {
          const reasoningObj = body.reasoning as Record<string, unknown>;
          if ('summary' in reasoningObj) {
            delete reasoningObj.summary;
            stripped.push('reasoning.summary');
            // body.reasoning.effort is intentionally preserved.
            // If stripping summary leaves reasoning: {}, the object is harmless;
            // the re-serialize tail fires via 'reasoning.summary' in stripped.
          }
        } else if ('reasoning' in body) {
          // Non-object reasoning on /v1/responses — not produced by any known code path.
          // Pass through unchanged; let the upstream surface the anomaly.
          logger.debug(`[${this.name}] non-object 'reasoning' on responses path, leaving untouched: ${typeof body.reasoning}`);
        }
      } else {
        // Chat Completions and all other paths: strip all reasoning-related params.
        for (const param of ['reasoningSummary', 'reasoning_summary', 'reasoning'] as const) {
          if (param in body) {
            delete body[param];
            stripped.push(param);
          }
        }
      }

      if (stripped.length > 0) {
        // Re-serialize and update the request body buffer
        const newBodyStr = JSON.stringify(body);
        context.requestBody = Buffer.from(newBodyStr, 'utf-8');

        // Update Content-Length header to match new body size
        context.headers['content-length'] = String(context.requestBody.length);

        logger.debug(`[${this.name}] Stripped unsupported params: ${stripped.join(', ')}`);
      }
    } catch {
      // Not valid JSON or parse error — pass through unchanged
    }
  }
}
```

- [ ] **Step 2: Run all request-sanitizer tests — verify they pass**

```bash
npm run test:unit -- --run src/providers/plugins/sso/proxy/plugins/__tests__/request-sanitizer.plugin.test.ts
```

Expected output (all tests pass, no failures):
```
✓ src/providers/plugins/sso/proxy/plugins/__tests__/request-sanitizer.plugin.test.ts
  RequestSanitizerPlugin
    Plugin Metadata ...         ✓
    createInterceptor ...       ✓
    Parameter Stripping ...     ✓
    Content-Length Update ...   ✓
    Edge Cases ...              ✓
    Responses API path ...      ✓ (6 new tests)
```

- [ ] **Step 3: Commit**

```bash
git add src/providers/plugins/sso/proxy/plugins/request-sanitizer.plugin.ts \
        src/providers/plugins/sso/proxy/plugins/__tests__/request-sanitizer.plugin.test.ts
git commit -m "fix(proxy): make request-sanitizer endpoint-aware for Responses API path

On /v1/responses, preserve reasoning.effort; strip only reasoning.summary
and camelCase top-level variants (reasoningSummary, reasoning_summary).
On all other paths, existing behavior is unchanged.

URL discriminator uses path.endsWith('/responses') — prefix-agnostic,
keys on the AI SDK endpoint segment rather than the deployment base path."
```

---

## Task 3: F2 — Add failing tests for widened encrypted-content sanitizer

**Files:**
- Create: `src/providers/plugins/sso/proxy/plugins/__tests__/codex-encrypted-content-sanitizer.plugin.test.ts`

No test file exists for this plugin today. Create one following the same patterns as `request-sanitizer.plugin.test.ts`.

- [ ] **Step 1: Create the test file**

```ts
/**
 * Codex Encrypted Content Sanitizer Plugin Tests
 *
 * Tests agent-scoping and functional encrypted-content removal for
 * codemie-codex, codemie-code, and codemie-opencode agents.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CodexEncryptedContentSanitizerPlugin } from '../codex-encrypted-content-sanitizer.plugin.js';
import { PluginContext, ProxyInterceptor } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

function createPluginContext(clientType?: string): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://api.example.com',
      provider: 'test',
      sessionId: 'test-session',
      clientType,
    },
    logger,
  };
}

function createProxyContext(body: unknown): ProxyContext {
  const requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method: 'POST',
    url: '/v1/responses',
    headers: {
      'content-type': 'application/json',
      'content-length': String(requestBody.length),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

describe('CodexEncryptedContentSanitizerPlugin', () => {
  let plugin: CodexEncryptedContentSanitizerPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new CodexEncryptedContentSanitizerPlugin();
  });

  describe('Plugin Metadata', () => {
    it('has correct id', () => {
      expect(plugin.id).toBe('@codemie/proxy-codex-encrypted-content-sanitizer');
    });

    it('has priority 16 (after request-sanitizer)', () => {
      expect(plugin.priority).toBe(16);
    });
  });

  describe('createInterceptor — Agent Scoping', () => {
    it('creates interceptor for codemie-codex', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-codex'));
      expect(interceptor).toBeDefined();
    });

    it('creates interceptor for codemie-code', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
      expect(interceptor).toBeDefined();
    });

    it('creates interceptor for codemie-opencode', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-opencode'));
      expect(interceptor).toBeDefined();
    });

    it('throws for claude agent', async () => {
      await expect(plugin.createInterceptor(createPluginContext('claude')))
        .rejects.toThrow('Plugin disabled for agent: claude');
    });

    it('throws for undefined clientType', async () => {
      await expect(plugin.createInterceptor(createPluginContext(undefined)))
        .rejects.toThrow('Plugin disabled');
    });
  });

  describe('Encrypted content removal — codemie-code', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('codemie-code'));
    });

    it('removes encrypted reasoning items from input array', async () => {
      const body = {
        model: 'gpt-5.5-2026-04-24',
        input: [
          { type: 'message', role: 'user', content: 'hello' },
          { type: 'reasoning', encrypted_content: 'abc123==' },
        ],
      };
      const context = createProxyContext(body);

      await interceptor.onRequest!(context);

      const result = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(result.input).toHaveLength(1);
      expect(result.input[0].type).toBe('message');
    });

    it('removes reasoning.encrypted_content from include array', async () => {
      const body = {
        model: 'gpt-5.5-2026-04-24',
        include: ['reasoning.encrypted_content', 'usage'],
      };
      const context = createProxyContext(body);

      await interceptor.onRequest!(context);

      const result = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(result.include).not.toContain('reasoning.encrypted_content');
      expect(result.include).toContain('usage');
    });

    it('updates content-length after stripping', async () => {
      const body = {
        model: 'gpt-5.5-2026-04-24',
        input: [{ type: 'reasoning', encrypted_content: 'abc123==' }],
      };
      const context = createProxyContext(body);
      const originalLength = Number(context.headers['content-length']);

      await interceptor.onRequest!(context);

      expect(Number(context.headers['content-length'])).toBeLessThan(originalLength);
      expect(Number(context.headers['content-length'])).toBe(context.requestBody!.length);
    });

    it('passes through body with no encrypted content unchanged', async () => {
      const body = { model: 'gpt-5.5-2026-04-24', input: [{ type: 'message', content: 'hi' }] };
      const context = createProxyContext(body);
      const originalStr = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(originalStr);
    });
  });

  describe('Encrypted content removal — codemie-codex (regression)', () => {
    it('still removes encrypted items for codemie-codex', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('codemie-codex'));
      const body = {
        model: 'gpt-5.3-codex',
        input: [{ type: 'reasoning', encrypted_content: 'xyz==' }],
      };
      const context = createProxyContext(body);

      await interceptor.onRequest!(context);

      const result = JSON.parse(context.requestBody!.toString('utf-8'));
      expect(result.input).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run the new test file — verify `codemie-code` tests FAIL**

```bash
npm run test:unit -- --run src/providers/plugins/sso/proxy/plugins/__tests__/codex-encrypted-content-sanitizer.plugin.test.ts
```

Expected: tests for `codemie-code` and `codemie-opencode` in the "Agent Scoping" block fail with `"Plugin disabled for agent: codemie-code"` (the current guard only allows `codemie-codex`). `codemie-codex` tests pass.

---

## Task 4: F2 — Widen encrypted-content sanitizer to OpenCode agents

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts`

- [ ] **Step 1: Update the agent allowlist, guard, and log message**

Replace the top of the file (lines 1–69) with:

```ts
/**
 * Encrypted Content Sanitizer
 * Priority: 16 (after generic request sanitizer, before header injection)
 *
 * LiteLLM/Azure can reject Responses API follow-up requests when encrypted
 * reasoning content is load-balanced to a different deployment/API key than
 * the one that created it. Server-side encrypted_content_affinity is the
 * correct fix. This client-side sanitizer is a defensive fallback:
 * it removes encrypted reasoning state so the session can continue instead of
 * failing with invalid_encrypted_content.
 *
 * Scope: codemie-codex, codemie-code, codemie-opencode. Widened from codex-only
 * to cover all Responses-API sessions — affects gpt-5.2, gpt-5.3-codex, gpt-5.5,
 * and any other Responses-path models. Tradeoff: drops cross-turn reasoning
 * continuity (encrypted state stripped) to avoid hard invalid_encrypted_content
 * failures — the same tradeoff already accepted for Codex. If server-side
 * encrypted_content_affinity becomes available, this client strip becomes redundant.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const ALLOWED_AGENTS = ['codemie-codex', 'codemie-code', 'codemie-opencode'];
const ENCRYPTED_CONTENT_INCLUDE = 'reasoning.encrypted_content';

interface SanitizeResult {
  value: unknown;
  modified: boolean;
  removedCount: number;
}

export class CodexEncryptedContentSanitizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-codex-encrypted-content-sanitizer';
  name = 'Codex Encrypted Content Sanitizer';
  version = '1.0.0';
  priority = 16;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }

    return new CodexEncryptedContentSanitizerInterceptor(clientType);
  }
}

class CodexEncryptedContentSanitizerInterceptor implements ProxyInterceptor {
  name = 'codex-encrypted-content-sanitizer';

  constructor(private readonly clientType: string) {}

  async onRequest(context: ProxyContext): Promise<void> {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const body = JSON.parse(context.requestBody.toString('utf-8')) as unknown;
      const sanitized = sanitizeValue(body);

      if (!sanitized.modified) {
        return;
      }

      const newBodyStr = JSON.stringify(sanitized.value);
      context.requestBody = Buffer.from(newBodyStr, 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);

      logger.debug(
        `[${this.name}] Removed encrypted reasoning content from ${this.clientType} request: ${sanitized.removedCount} item(s)`
      );
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged.
    }
  }
}
```

Leave the `sanitizeValue`, `isEncryptedReasoningItem`, and `isPlainObject` functions at the bottom of the file unchanged.

- [ ] **Step 2: Run encrypted-content sanitizer tests — verify they pass**

```bash
npm run test:unit -- --run src/providers/plugins/sso/proxy/plugins/__tests__/codex-encrypted-content-sanitizer.plugin.test.ts
```

Expected: all tests pass, including the new `codemie-code` and `codemie-opencode` scoping and functional tests.

- [ ] **Step 3: Commit**

```bash
git add src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts \
        src/providers/plugins/sso/proxy/plugins/__tests__/codex-encrypted-content-sanitizer.plugin.test.ts
git commit -m "fix(proxy): widen encrypted-content sanitizer to codemie-code/codemie-opencode

Extends defensive encrypted_content stripping from codex-only to all
Responses-API agents. Prevents invalid_encrypted_content failures on
load-balanced multi-turn sessions for gpt-5.2, gpt-5.3-codex, gpt-5.5,
and any future Responses-path models.

Tradeoff: drops cross-turn reasoning continuity (same as codex already).
If server-side encrypted_content_affinity is available, this is redundant."
```

---

## Task 5: F4 — Add failing tests for context limit corrections

**Files:**
- Modify: `src/agents/plugins/__tests__/opencode-gpt55-routing.test.ts`

- [ ] **Step 1: Add context-limit test cases to the existing describe block**

Append these `it` blocks inside `describe('GPT-5.5 / GPT-5.4 → Responses API routing', ...)`, after the existing "Static fallback path" block:

```ts
// ── Context limits ──────────────────────────────────────────────────────────

it('dynamic gpt-5.5-2026-04-24 reports context limit of 1050000', () => {
  const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.5-2026-04-24'));
  expect(config.limit.context).toBe(1050000);
});

it('dynamic gpt-5-5-2026-04-24 (hyphenated) reports context limit of 1050000', () => {
  const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5-5-2026-04-24'));
  expect(config.limit.context).toBe(1050000);
});

it('dynamic gpt-5.2-latest still reports context limit of 400000 (regression)', () => {
  const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.2-latest'));
  expect(config.limit.context).toBe(400000);
});

it('static config gpt-5.5-2026-04-24 reports context limit of 1050000', () => {
  expect(OPENCODE_MODEL_CONFIGS['gpt-5.5-2026-04-24']!.limit.context).toBe(1050000);
});
```

- [ ] **Step 2: Run the updated test file — verify context-limit tests FAIL**

```bash
npm run test:unit -- --run src/agents/plugins/__tests__/opencode-gpt55-routing.test.ts
```

Expected: the four new context-limit tests fail — dynamic models return 400000 (current generic branch), static config also has 400000. Existing routing tests still pass.

---

## Task 6: F4 — Implement context limit corrections

**Files:**
- Modify: `src/agents/plugins/opencode/opencode-model-configs.ts`
- Modify: `src/agents/plugins/opencode/opencode-dynamic-models.ts`

- [ ] **Step 1: Fix static config — gpt-5.5-2026-04-24 context limit**

In `opencode-model-configs.ts`, find the `gpt-5.5-2026-04-24` entry. Lines 255–258 currently read:

```ts
    limit: {
      context: 400000,
      output: 128000
    }
```

Change `context: 400000` to `context: 1050000`:

```ts
    limit: {
      context: 1050000,
      output: 128000
    }
```

- [ ] **Step 2: Fix `detectLimits()` — add gpt-5.5/gpt-5-5 branch**

In `opencode-dynamic-models.ts`, line 77 currently reads:

```ts
  if (id.startsWith('gpt-5')) return { context: 400000, output: 128000 };
```

Insert a `gpt-5.5` / `gpt-5-5` branch immediately before it. The two lines after the change:

```ts
  if (id.startsWith('gpt-5.5') || id.startsWith('gpt-5-5')) return { context: 1050000, output: 128000 };
  if (id.startsWith('gpt-5')) return { context: 400000, output: 128000 };
```

Branch ordering matters: `'gpt-5.5-2026-04-24'.startsWith('gpt-5')` is true, so the more-specific branch must come first.

- [ ] **Step 3: Run context-limit tests — verify they pass**

```bash
npm run test:unit -- --run src/agents/plugins/__tests__/opencode-gpt55-routing.test.ts
```

Expected: all tests pass, including the four new context-limit tests.

- [ ] **Step 4: Run the full unit test suite**

```bash
npm run test:unit
```

Expected: all tests pass. No regressions.

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/opencode/opencode-model-configs.ts \
        src/agents/plugins/opencode/opencode-dynamic-models.ts \
        src/agents/plugins/__tests__/opencode-gpt55-routing.test.ts
git commit -m "fix(agents): correct gpt-5.5 context limit to 1050000 tokens

Update static config and detectLimits() heuristic for gpt-5.5-2026-04-24.
Azure publishes ~1050000 input tokens for this model; previous value of
400000 was under-reported, affecting context-budget hints in OpenCode."
```

---

## Self-Review Checklist

Spec coverage:
- AC#1 (effort preserved on /responses) → Task 1 Step 2 test + Task 2 implementation ✅
- AC#2 (chat path unchanged) → existing tests still exercise this path; Task 2 preserves `else` branch ✅
- AC#3 (codemie-code strips encrypted content) → Task 3 Step 1 functional test + Task 4 implementation ✅
- AC#4 (static config limit.context 1050000) → Task 5 Step 1 + Task 6 Step 1 ✅
- AC#5 (dynamic convertApiModelToOpenCodeConfig 1050000) → Task 5 Step 1 + Task 6 Step 2 ✅
- AC#6 (gpt-5.2 regression 400000) → Task 5 Step 1 + Task 6 Step 2 (generic branch unchanged) ✅

Placeholder scan: no TBDs, no "handle edge cases" without code, no forward references to undefined types. ✅

Type consistency:
- `body.reasoning as Record<string, unknown>` — `body` is typed `Record<string, unknown>` after JSON.parse cast in Task 2. `body.reasoning` is `unknown`; cast to `Record<string, unknown>` before accessing `.summary`. ✅
- `CodexEncryptedContentSanitizerInterceptor(clientType)` constructor matches `new CodexEncryptedContentSanitizerInterceptor(clientType)` in `createInterceptor`. ✅
- `makeLlmModel` helper used in new F4 tests is already defined in `opencode-gpt55-routing.test.ts` at line 30. ✅
- `OPENCODE_MODEL_CONFIGS` is already imported in the test file at line 45. ✅
