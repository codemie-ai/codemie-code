# EPMCDME-13136: Fix Bedrock Qwen3 Compaction Failure (Option B)

**Date:** 2026-06-24
**Ticket:** [EPMCDME-13136](https://jiraeu.epam.com/browse/EPMCDME-13136)
**Branch:** `fix/EPMCDME-13136-bedrock-qwen3-compaction`

---

## Problem

When `codemie-opencode` reaches compaction with **Bedrock Qwen3 Coder 480B A35B** as the active model (via SSO/LiteLLM route), the compaction flow fails with:

```
litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without `tools=` param specified.
Pass `tools=` param OR set `litellm.modify_params = True` // `litellm_settings::modify_params: True`
to add dummy tool to the request.
Received Model Group=qwen.qwen3-coder-480b-a35b-v1
```

The user session stops. No recovery is possible without restarting.

---

## Root Cause

Compaction (`packages/opencode/src/session/compaction.ts:414`) sends `tools: {}` (empty) to the LiteLLM proxy. LiteLLM's Bedrock Converse transformation (`converse_transformation.py:1452–1466`) raises `UnsupportedParamsError` when:

1. `tools` is absent from `optional_params`, AND
2. the message history contains prior tool-call blocks (accumulated during the Qwen3 session).

The guard at line 1457 checks `litellm.modify_params`. If `True`, it injects a dummy tool and continues. If `False` (the default), it raises.

The LiteLLM proxy config (`codemie/litellm_config.yaml`) has `drop_params: true` but **does not have `modify_params: true`**, so `litellm.modify_params` remains `False` at runtime.

---

## Solution (Option B)

Two changes in two repos. The primary fix prevents the error. The secondary adds diagnostic context for future admin troubleshooting.

### Change 1 — `codemie` repo: `litellm_config.yaml`

**File:** `litellm_config.yaml`
**Location in file:** `litellm_settings` block (currently lines 419–425)

Add `modify_params: true` after `drop_params: true`:

```yaml
litellm_settings:
  request_timeout: 600
  set_verbose: False
  json_logs: true
  drop_params: true
  modify_params: true       # prevents UnsupportedParamsError on Bedrock Converse
  vertex_project: os.environ/VERTEX_PROJECT
  vertex_location: "us-central1"
```

**Why this works:** At proxy startup, `proxy_server.py:3775–4054` iterates every `litellm_settings` key and calls `setattr(litellm, key, value)`. This sets `litellm.modify_params = True`. When the compaction request arrives, `converse_transformation.py:1457` reads `litellm.modify_params`, finds it `True`, and injects `add_dummy_tool(custom_llm_provider="bedrock_converse")` instead of raising.

**Scope:** Global — applies to all Bedrock Converse calls through this proxy. Safe: `modify_params` only activates when a request has tool-call history blocks but no `tools` parameter, which only occurs in the compaction path.

**Deployment:** LiteLLM proxy restart/redeploy required.

---

### Change 2 — `codemie-code` repo: `sso.proxy.ts`

**File:** `src/providers/plugins/sso/proxy/sso.proxy.ts`
**Location:** `handleRequest` method, between step 5 (stream response) and step 6 (onResponseComplete hooks)

After `streamResponse` completes, if the upstream returned a 4xx status and the request targeted a Bedrock model, emit a structured `logger.warn` with the model name and admin action.

```typescript
// Step 5: stream response (existing)
const metadata = await this.streamResponse(context, upstreamResponse, res, startTime);

// NEW: diagnostic warn for Bedrock 4xx responses
if (metadata.statusCode >= 400) {
  this.logBedrockUpstreamError(context, metadata.statusCode);
}

// Step 6: onResponseComplete hooks (existing)
await this.runHook('onResponseComplete', interceptor =>
  interceptor.onResponseComplete?.(context, metadata)
);
```

New private method added to `SSOProxy`:

```typescript
private logBedrockUpstreamError(context: ProxyContext, statusCode: number): void {
  try {
    const body = JSON.parse(context.requestBody?.toString() ?? '{}');
    const model = typeof body.model === 'string' ? body.model : undefined;
    if (model && (model.startsWith('bedrock/') || model.includes('amazon') || model.includes('qwen'))) {
      logger.warn(
        `[proxy] Upstream returned ${statusCode} for Bedrock model "${model}". ` +
        `If cause is UnsupportedParamsError, ensure litellm_settings.modify_params: true ` +
        `is configured and the LiteLLM proxy has been restarted.`,
        { requestId: context.requestId, model, statusCode }
      );
    }
  } catch {
    // diagnostic only — never throws
  }
}
```

**Why here:** `context.requestBody` (the raw request buffer) and `metadata.statusCode` are both available at this point. No response body buffering is needed — the check is on the request side only. The method is defensive: any parse failure is silently swallowed.

**Pattern rationale:** The model check (`startsWith('bedrock/')`, `includes('amazon')`, `includes('qwen')`) is intentionally broad. This is a `warn`-level log; a false positive for a non-Qwen Bedrock model is acceptable, while a false negative (missed log) defeats the purpose. The check exists to guide admins, not to gate traffic.

**Scope:** Fires for any 4xx response to a Bedrock-patterned model string. Writes to the codemie-code log file. Satisfies the AC: "Logs contain enough diagnostic context to identify the model group, provider, and applied LiteLLM settings."

---

## Data Flow (after fix)

```
compaction.ts → processor.process({ tools: {}, messages: [...tool-call-history...] })
  → LLMRequestPrep.prepare() → streamText(ai) → codemie-code SSO proxy
  → LiteLLM proxy POST /chat/completions
  → converse_transformation.py:1457: litellm.modify_params is True
  → add_dummy_tool() injected into optional_params
  → Bedrock Converse API call succeeds
  → compaction completes ✓
```

---

## Acceptance Criteria Coverage

| AC | Addressed by |
|---|---|
| Compaction works for Bedrock Qwen3 480B | Change 1 |
| Requests include valid tools= or handled via modify_params | Change 1 |
| Fix in correct layer — no manual user patching | Change 1 (proxy config layer) |
| Clear actionable error if model can't support compaction | Change 2 (admin-facing log) |
| Regression: compaction still works for other SSO models | Manual verification required |
| Logs show model group, provider, LiteLLM settings context | Change 2 |

---

## Out of Scope

- Changes to `opencode` repo (read-only).
- Per-model `litellm_params` annotation (global setting is sufficient).
- User-facing UI error surfacing (admin log is the appropriate channel for infra config issues).
- Automated integration tests for the compaction → LiteLLM → Bedrock path (no test infrastructure exists; manual verification required).
