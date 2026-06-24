# EPMCDME-13136: Fix Bedrock Qwen3 Compaction Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `codemie-opencode` compaction failure for Bedrock Qwen3 Coder 480B by adding `modify_params: true` to the LiteLLM proxy config and adding a diagnostic warn to the SSO proxy for Bedrock 4xx responses.

**Architecture:** Two-repo change. Primary fix in `codemie` repo: one YAML line that sets `litellm.modify_params = True` at proxy startup, causing LiteLLM to inject a dummy tool instead of raising `UnsupportedParamsError` when a compaction request has tool-call history but no `tools` param. Secondary fix in `codemie-code` repo: a defensive private method in `SSOProxy` that emits a structured `logger.warn` when any upstream Bedrock request returns 4xx, logging the model name and an admin hint.

**Tech Stack:** YAML (LiteLLM proxy config), TypeScript + Node.js (codemie-code SSO proxy), LiteLLM Python proxy (`litellm_config.yaml` → `proxy_server.py:setattr(litellm, key, value)`)

---

### Task 1: Add `modify_params: true` to LiteLLM proxy config

**Test-first: no — YAML config change; verified by reading back the file after edit.**

**Files:**
- Modify: `/home/taras_spashchenko/EPAM/cm/codemie/litellm_config.yaml` (lines 419–425, `litellm_settings` block)

**Context:** At proxy startup, `proxy_server.py:3775–4054` iterates every key in `litellm_settings` and calls `setattr(litellm, key, value)`. Adding `modify_params: true` sets `litellm.modify_params = True`. The check at `converse_transformation.py:1457` reads this flag and injects a dummy tool instead of raising when a compaction request carries tool-call history but no `tools` parameter.

- [ ] **Step 1: Read the current litellm_settings block to confirm the target location**

  Read lines 419–430 of `/home/taras_spashchenko/EPAM/cm/codemie/litellm_config.yaml`.

  Expected current content:
  ```yaml
  litellm_settings:
    request_timeout: 600
    set_verbose: False
    json_logs: true
    drop_params: true
    vertex_project: os.environ/VERTEX_PROJECT
    vertex_location: "us-central1"
  ```

  Confirm `modify_params` is absent. If it is already present, skip Steps 2–3.

- [ ] **Step 2: Add `modify_params: true` after `drop_params: true`**

  Edit `/home/taras_spashchenko/EPAM/cm/codemie/litellm_config.yaml`.

  Replace:
  ```yaml
    drop_params: true
    vertex_project: os.environ/VERTEX_PROJECT
  ```

  With:
  ```yaml
    drop_params: true
    modify_params: true
    vertex_project: os.environ/VERTEX_PROJECT
  ```

- [ ] **Step 3: Verify the edit**

  Read lines 419–428 of `/home/taras_spashchenko/EPAM/cm/codemie/litellm_config.yaml`.

  Expected after edit:
  ```yaml
  litellm_settings:
    request_timeout: 600
    set_verbose: False
    json_logs: true
    drop_params: true
    modify_params: true
    vertex_project: os.environ/VERTEX_PROJECT
    vertex_location: "us-central1"
  ```

- [ ] **Step 4: Commit**

  ```bash
  cd /home/taras_spashchenko/EPAM/cm/codemie
  git add litellm_config.yaml
  git commit -m "fix(litellm): add modify_params: true to litellm_settings

  Prevents UnsupportedParamsError when compaction sends an empty tools
  list to Bedrock Converse but the session history contains tool-call
  blocks. LiteLLM now injects a dummy tool instead of raising.

  Refs: EPMCDME-13136"
  ```

---

### Task 2: Add `logBedrockUpstreamError` diagnostic warn to `sso.proxy.ts`

**Test-first: no — diagnostic logging method; verified by TypeScript compilation (`npm run typecheck`).**

**Files:**
- Modify: `src/providers/plugins/sso/proxy/sso.proxy.ts`
  - Wire call after line 344 (after `streamResponse` debug log, before step 6 comment)
  - Add private method near `sendErrorResponse` (after line 644)

**Context:** `context.requestBody` is typed `Buffer | null` (see `proxy-types.ts:58`). The model field in compaction requests from OpenCode follows LiteLLM model-group naming (e.g. `qwen.qwen3-coder-480b-a35b-v1`). The pattern check is intentionally broad (warn-level; false positives are acceptable to avoid missing the target case).

- [ ] **Step 1: Wire the diagnostic call into `handleRequest`**

  In `src/providers/plugins/sso/proxy/sso.proxy.ts`, find the block after the `streamResponse` debug log (currently lines 341–345):

  ```typescript
      logger.debug(`[proxy] Response streaming completed for ${context.requestId}`, {
        statusCode: metadata.statusCode,
        bytesSent: metadata.bytesSent
      });

      // 6. Run onResponseComplete hooks (AFTER streaming)
  ```

  Replace with:

  ```typescript
      logger.debug(`[proxy] Response streaming completed for ${context.requestId}`, {
        statusCode: metadata.statusCode,
        bytesSent: metadata.bytesSent
      });

      // Diagnostic: warn on Bedrock 4xx to surface modify_params misconfiguration
      if (metadata.statusCode >= 400) {
        this.logBedrockUpstreamError(context, metadata.statusCode);
      }

      // 6. Run onResponseComplete hooks (AFTER streaming)
  ```

- [ ] **Step 2: Add the `logBedrockUpstreamError` private method**

  In `src/providers/plugins/sso/proxy/sso.proxy.ts`, find the closing brace of `sendErrorResponse` (currently ends around line 644):

  ```typescript
      if (proxyError instanceof NetworkError || proxyError instanceof TimeoutError) {
        logger.debug(`[proxy] Operational error: ${proxyError.message}`);
      } else {
        logger.error('[proxy] Error:', proxyError);
      }
    }
  ```

  Add the new private method immediately after the closing brace of `sendErrorResponse`:

  ```typescript
    /**
     * Emit a structured warn when a Bedrock request returns 4xx.
     * Helps admins diagnose UnsupportedParamsError caused by missing
     * litellm_settings.modify_params: true in the LiteLLM proxy config.
     */
    private logBedrockUpstreamError(context: ProxyContext, statusCode: number): void {
      try {
        const body = JSON.parse(context.requestBody?.toString() ?? '{}');
        const model = typeof body.model === 'string' ? body.model : undefined;
        if (
          model &&
          (model.startsWith('bedrock/') || model.includes('amazon') || model.includes('qwen'))
        ) {
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

- [ ] **Step 3: Run TypeScript type-check to confirm no compile errors**

  ```bash
  cd /home/taras_spashchenko/EPAM/codemie-ai/codemie-code
  npm run typecheck
  ```

  Expected: exits 0 with no errors. If errors appear, fix them before committing.

- [ ] **Step 4: Run lint to confirm no lint warnings**

  ```bash
  cd /home/taras_spashchenko/EPAM/codemie-ai/codemie-code
  npm run lint
  ```

  Expected: exits 0. Fix any lint errors before committing.

- [ ] **Step 5: Commit**

  ```bash
  cd /home/taras_spashchenko/EPAM/codemie-ai/codemie-code
  git add src/providers/plugins/sso/proxy/sso.proxy.ts
  git commit -m "fix(proxy): log diagnostic warn on Bedrock 4xx upstream responses

  Adds logBedrockUpstreamError to SSOProxy. Fires when any upstream
  Bedrock request returns 4xx and logs the model name, requestId, and
  an actionable hint about litellm_settings.modify_params: true.

  Addresses EPMCDME-13136 acceptance criterion: logs must contain
  enough diagnostic context to identify the model group, provider,
  and applied LiteLLM settings.

  Refs: EPMCDME-13136"
  ```

---

## Verification

After both tasks are committed:

1. **Proxy config:** Confirm `modify_params: true` is present in `litellm_config.yaml` under `litellm_settings`.
2. **TypeScript:** `npm run typecheck` exits 0 in `codemie-code`.
3. **Lint:** `npm run lint` exits 0 in `codemie-code`.
4. **End-to-end (manual):** Restart the LiteLLM proxy with the updated config, start `codemie-opencode` with Bedrock Qwen3 Coder 480B A35B, work until compaction triggers, confirm no `UnsupportedParamsError` and compaction completes.
