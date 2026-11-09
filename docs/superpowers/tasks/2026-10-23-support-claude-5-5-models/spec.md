# Specification: Support Claude 5.5 Models

**Task:** Support Claude 5.5 generation models in codemie-code  
**Status:** Approved  
**Author:** SDLC Factory  
**Created:** 2026-10-23  

---

## 1. Summary

Add complete support for Anthropic's Claude 5.5 model family (`claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5`) across the codemie-code local proxy ecosystem. This includes client configuration connectors (Claude Desktop and VS Code), proxy middleware request normalization (adaptive thinking transformation with reasoning effort parameter for Bedrock / Vertex AI compatibility), official Anthropic pricing configuration, and Pi agent capabilities.

---

## 2. Goals & Acceptance Criteria

### Acceptance Criteria
1. **Claude Desktop Connector**:
   - `PREFERRED_CLAUDE_MODELS` includes `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5` as the highest priority candidates within their respective model families.
   - `selectDesktopClaudeModels()` collapses candidate models such that at most one model per family (Opus, Sonnet, Haiku) is selected, favoring the highest priority available version.
   - Fallback models for 4.x / 5.0 are preserved when 5.5 models are absent from upstream endpoints.
2. **VS Code Capability Registry**:
   - Capability entries are registered for `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5`.
   - Capabilities declare `apiType: 'messages'`, `adaptiveThinking: true`, and support for `reasoningEffort`.
3. **Claude Request Normalizer Plugin**:
   - `MODEL_CAPABILITY_TABLE` regex patterns match Opus 5/5.5, Sonnet 5/5.5, and Haiku 5/5.5 models.
   - Legacy `thinking: { type: 'enabled' }` blocks in incoming requests are converted to `{ type: 'adaptive' }` with `output_config.effort` forwarded or defaulted to prevent upstream Bedrock 400 errors.
4. **Pricing Configuration**:
   - Official Anthropic rates for `claude-haiku-5-5` ($0.10 input, $0.50 output per MTok, $0.01 cache read, $0.125 / $0.20 cache write) are registered in `pricing.json` with Bedrock 1.1x multiplier.
5. **Agent Compatibility**:
   - `pi.models.ts` flags `claude-haiku-5` models for forced adaptive thinking.
6. **Test Coverage**:
   - Unit tests verify connector selection, capability lookup, dated snapshot matching, thinking normalization, and pricing calculations.

### Non-Goals
- Modifying proxy transport protocols or authentication layers.
- Changing model routing logic for non-Claude providers (OpenAI, Gemini, DeepSeek).

---

## 3. Detailed Component Design

### 3.1 Claude Desktop Connector (`src/cli/commands/proxy/connectors/desktop.ts`)
- Prepend 5.5 models to `PREFERRED_CLAUDE_MODELS`:
  - `claude-opus-5-5`
  - `claude-sonnet-5-5`
  - `claude-haiku-5-5`
- In `selectDesktopClaudeModels(available, preferred)`:
  - Add family collapsing for Haiku (`haikuKept`) alongside existing `opusKept` and `sonnetKept` flags.
  - Return the filtered and deduplicated model array.

### 3.2 VS Code Models (`src/cli/commands/proxy/connectors/vscode-models.ts`)
- Register entries in `VS_CODE_CAPABILITY_TABLE`:
  - `claude-sonnet-5-5` (family: `claude-sonnet`, apiType: `messages`, adaptiveThinking: true)
  - `claude-opus-5-5` (family: `claude-opus`, apiType: `messages`, adaptiveThinking: true)
  - `claude-haiku-5-5` (family: `claude-haiku`, apiType: `messages`, adaptiveThinking: true)

### 3.3 Claude Request Normalizer (`src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts`)
- Separate `MODEL_CAPABILITY_TABLE` rows per model family and version:
  - `claude-haiku-5 / 5-5`: adaptive thinking, effort: true, sampling: false, preserveDisabledThinking: true.
  - `claude-opus-5-5`: adaptive thinking, effort: true, sampling: false, preserveDisabledThinking: false (removes disabled thinking to avoid upstream 400).
  - `claude-opus-5`: adaptive thinking, effort: true, sampling: false, preserveDisabledThinking: true.
  - `claude-sonnet-5-5`: adaptive thinking, effort: true, sampling: false, preserveDisabledThinking: false (removes disabled thinking to avoid upstream 400).
  - `claude-sonnet-5`: adaptive thinking, effort: true, sampling: false, preserveDisabledThinking: true.
- Transform payload:
  - `body.thinking = { type: 'adaptive' }`
  - `body.output_config = { effort: body.thinking.effort ?? 'medium' }`
  - Strip deprecated sampling parameters (`temperature`, `top_p`, `top_k`) for models with `sampling: false`.

### 3.4 Pricing Table (`src/utils/pricing.json`)
- Add `claude-haiku-5-5` entry matching official Anthropic documentation.

### 3.5 Pi Models (`src/agents/plugins/pi/pi.models.ts`)
- Include `id.startsWith('claude-haiku-5')` in adaptive thinking guard.

---

## 4. Verification Plan

1. Vitest suite covering desktop connector, vscode-models, normalizer, and pi models.
2. Full project lint and typecheck (`npm run lint`, `npm run typecheck`).
3. Snapshot resolution and fallback resilience tests.
