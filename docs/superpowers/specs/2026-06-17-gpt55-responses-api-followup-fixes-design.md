# Design: GPT-5.5 Responses-API Follow-up Fixes

**Branch:** `fix/gpt55-responses-api-routing`  
**Date:** 2026-06-17  
**Status:** Approved

## Background

Issue A (already merged) moved `gpt-5.5` and `gpt-5.4` models onto the Responses API path
(`/v1/responses`) instead of the Chat Completions path (`/v1/chat/completions`). This stopped
the `400` errors. Three follow-up findings remain:

- **F1 (HIGH):** The SSO proxy's request sanitizer strips `reasoning` unconditionally —
  correct on Chat Completions, wrong on Responses (where `reasoning.effort` is required).
  After Issue A this converts a hard failure into a silent quality regression.
- **F2 (MEDIUM):** The encrypted-content sanitizer is gated to `codemie-codex` only;
  `codemie-code` and `codemie-opencode` sessions on the Responses API path are exposed to
  `invalid_encrypted_content` failures on load-balanced follow-ups.
- **F4 (NIT):** The static `gpt-5.5-2026-04-24` entry and the dynamic `detectLimits()`
  heuristic both report 400,000 context tokens; Azure publishes 1,050,000.

---

## Architecture context

The proxy chain is:

```
OpenCode (AI SDK)
  → local CodeMie SSO proxy  (clientType = codemie-code | codemie-opencode)
  → codemie-backend → LiteLLM → Azure OpenAI
```

Two provider paths share the same proxy base URL; only the endpoint segment differs:

| Provider | SDK | Endpoint |
|---|---|---|
| `codemie-proxy` | `@ai-sdk/openai-compatible` | `…/chat/completions` |
| `openai` | `@ai-sdk/openai` (built-in) | `…/responses` |

`context.url` in `ProxyContext` is the raw incoming `req.url` — whatever the AI SDK appends
to `proxyBaseUrl`. The endpoint segment is what the AI SDK controls; the base prefix (`/v1`)
is what the deployment controls and is not guaranteed stable.

---

## F1 — Path-aware request sanitizer

### Problem

`UNSUPPORTED_PARAMS = ['reasoningSummary', 'reasoning_summary', 'reasoning']` is applied to
every JSON POST. On `/v1/responses` the `reasoning: { effort, summary }` object is valid and
required — deleting it silently removes the configured reasoning effort, falling back to the
model default.

### URL discriminator

```ts
const path = context.url.split('?')[0].replace(/\/+$/, '');
const isResponsesApi = path.endsWith('/responses');
```

`endsWith('/responses')` is prefix-agnostic (handles `/v1/responses`, `/responses`,
`/proxy/v1/responses`) and precise (does not match `/responses-something` or
`/chat/completions`). It keys on what the AI SDK controls — the endpoint segment — not the
deployment-controlled base prefix.

### Sanitizer logic

```ts
const stripped: string[] = [];

if (isResponsesApi) {
  // Responses API: reasoning: { effort, summary } is valid.
  // Strip only the camelCase top-level leakage and the nested summary field.
  // Preserve reasoning.effort — it controls the model's reasoning depth.
  for (const k of ['reasoningSummary', 'reasoning_summary']) {
    if (k in body) { delete body[k]; stripped.push(k); }
  }
  if (body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)) {
    // NOTE: stripping reasoning.summary is the safe-conservative choice.
    // Azure accepts reasoning.summary (auto/detailed) on /v1/responses; the original
    // "Unknown parameter: 'reasoningSummary'" rejection was the camelCase TOP-LEVEL
    // form on the chat path. This can be relaxed (keep summary) once summaries are
    // confirmed desired and accepted by the upstream deployment.
    if ('summary' in body.reasoning) {
      delete (body.reasoning as Record<string, unknown>).summary;
      stripped.push('reasoning.summary');
      // Note: if 'summary' was the only key (reasoning: { summary }), reasoning becomes {}.
      // This is non-occurring in practice — the openai provider always sets effort alongside
      // summary (transform.ts:1152+). The empty object is harmless; we skip an extra delete
      // because the re-serialize tail already fires via 'reasoning.summary' in stripped.
    }
    // body.reasoning.effort is intentionally preserved
  } else if ('reasoning' in body) {
    // Non-object reasoning on /v1/responses — not produced by any known code path.
    // Pass through unchanged; let the upstream surface the anomaly rather than
    // silently swallowing it into a default-effort run.
    logger.debug(`[${this.name}] non-object 'reasoning' on responses path, leaving untouched: ${typeof body.reasoning}`);
  }
} else {
  // Chat Completions and all other paths: strip all reasoning-related params.
  for (const param of ['reasoningSummary', 'reasoning_summary', 'reasoning']) {
    if (param in body) { delete body[param]; stripped.push(param); }
  }
}

// Re-serialize only if something was stripped (shared tail)
if (stripped.length > 0) {
  const newBodyStr = JSON.stringify(body);
  context.requestBody = Buffer.from(newBodyStr, 'utf-8');
  context.headers['content-length'] = String(context.requestBody.length);
  logger.debug(`[${this.name}] Stripped unsupported params: ${stripped.join(', ')}`);
}
```

### Constants

`UNSUPPORTED_PARAMS` is retired. The header comment and inline comments document the split
behavior.

### Test coverage

- Existing chat-path test (`/v1/chat/completions`) continues to verify `reasoning`,
  `reasoningSummary`, `reasoning_summary` are stripped. No change to the test.
- New test case (`/v1/responses`): body `{ reasoning: { effort: 'medium', summary: 'auto' }, reasoningSummary: 'auto' }` → after sanitizer: `reasoning.effort` present, `reasoning.summary` absent, `reasoningSummary` absent.

---

## F2 — Widen encrypted-content sanitizer

### Problem

`ALLOWED_AGENT = 'codemie-codex'` means `codemie-code` / `codemie-opencode` sessions on the
Responses API do not have encrypted reasoning state stripped. Multi-turn sessions accumulate
`encrypted_content` from prior reasoning turns; if LiteLLM load-balances a follow-up to a
different deployment/key, Azure returns `invalid_encrypted_content`.

### Change

```ts
// Before
const ALLOWED_AGENT = 'codemie-codex';
// ...
if (clientType !== ALLOWED_AGENT) throw new Error(`Plugin disabled for agent: ${clientType}`);

// After
const ALLOWED_AGENTS = ['codemie-codex', 'codemie-code', 'codemie-opencode'];
// ...
if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
  throw new Error(`Plugin disabled for agent: ${clientType}`);
}
```

Pass `clientType` into the interceptor constructor so the debug log can identify the agent:
```
Removed encrypted reasoning content from codemie-code request: 2 item(s)
```

### What does NOT change

- Plugin `id`, `name`, class name, and file name are unchanged — these are registry and
  telemetry surfaces.
- Sanitization logic (`sanitizeValue`, `isEncryptedReasoningItem`) is unchanged.
- The header comment is updated to note it now also covers the OpenCode agents.

### Behavior change note (for PR description)

Widening the guard affects **all Responses-API sessions** for `codemie-code` and
`codemie-opencode`, not just `gpt-5.5`. Models `gpt-5.2`, `gpt-5.3-codex`, and any other
Responses-path models gain the same encrypted-state stripping that `codemie-codex` already
has. This trades cross-turn reasoning continuity for avoiding hard `invalid_encrypted_content`
failures — the same tradeoff already accepted for Codex. If server-side
`encrypted_content_affinity` becomes available, this client-side strip becomes redundant.

---

## F4 — Correct gpt-5.5 context limits

### opencode-model-configs.ts

`gpt-5.5-2026-04-24` static entry: `limit.context` changes from `400000` to `1050000`.

### opencode-dynamic-models.ts — detectLimits()

Insert a `gpt-5.5` / `gpt-5-5` branch before the generic `gpt-5*` branch:

```ts
// Before
if (id.startsWith('gpt-5')) return { context: 400000, output: 128000 };

// After
if (id.startsWith('gpt-5.5') || id.startsWith('gpt-5-5')) return { context: 1050000, output: 128000 };
if (id.startsWith('gpt-5')) return { context: 400000, output: 128000 };
```

Branch ordering matters: `'gpt-5.5'.startsWith('gpt-5')` is true, so the specific branch
must precede the generic one.

### Known gap (out of scope for this fix)

`gpt-5.4` base model also has a 1,050,000 context window, but `gpt-5.4-mini` and
`gpt-5.4-nano` do not. Fixing `gpt-5.4` accurately requires a mini/nano exclusion. That
complexity is out of scope for this NIT — left for a follow-up if full accuracy is needed.

---

## Files changed

| File | Change |
|---|---|
| `src/providers/plugins/sso/proxy/plugins/request-sanitizer.plugin.ts` | F1: path-aware sanitizer |
| `src/providers/plugins/sso/proxy/plugins/__tests__/request-sanitizer.plugin.test.ts` | F1: add /responses test case |
| `src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts` | F2: widen ALLOWED_AGENTS |
| `src/agents/plugins/opencode/opencode-model-configs.ts` | F4: gpt-5.5 context limit |
| `src/agents/plugins/opencode/opencode-dynamic-models.ts` | F4: detectLimits gpt-5.5 branch |

## Plugin composition note

`RequestSanitizerPlugin` (priority 15) runs before `CodexEncryptedContentSanitizerPlugin`
(priority 16). They touch disjoint fields (`reasoning.*` vs `encrypted_content` / `include`),
so execution order has no effect on correctness here.

---

## Acceptance criteria

1. POST to `/v1/responses` with `{ reasoning: { effort: 'medium', summary: 'auto' }, reasoningSummary: 'auto' }`:  
   → `reasoning.effort` preserved, `reasoning.summary` absent, `reasoningSummary` absent.
2. POST to `/v1/chat/completions` with `{ reasoning: 'auto', reasoningSummary: 'x', reasoning_summary: 'y' }`:  
   → all three keys absent (existing behavior unchanged).
3. For `codemie-code`: a body containing an encrypted reasoning item (e.g. `{ type: 'reasoning', encrypted_content: 'abc' }` in the `input` array, or `include: ['reasoning.encrypted_content']`) → the item is removed and `removedCount > 0`. `codemie-codex` behavior unchanged. `codemie-opencode` receives the same functional treatment as `codemie-code`.
4. `gpt-5.5-2026-04-24` static config: `limit.context === 1050000`.
5. `convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.5-2026-04-24')).limit.context === 1050000`  
   (`detectLimits` is module-private; assert via the public `convertApiModelToOpenCodeConfig` API, following the pattern in `opencode-gpt55-routing.test.ts`).
6. `convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.2-latest')).limit.context === 400000` (regression — generic gpt-5* branch still applies).

## Scope boundary

- **F3 intentionally excluded.** Finding F3 from the review doc ("codemie bypasses OpenCode's `@ai-sdk/azure` `gpt-5.5` guard") is informational only — no action required.
- **Issue C (picker propagation) is out of scope for unit tests.** AC #1 above proves that `reasoning.effort` present in the request body survives the proxy unchanged. It does not prove that the OpenCode picker value (low/high/medium) reaches the body — that path is OpenCode-internal (`transform.ts:1154` hardcodes `"medium"` as default; model variants override it). Confirming the picker works end-to-end requires a manual/e2e capture after F1 lands.
