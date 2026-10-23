# Technical Research

**Task**: proxy claude connectors normalizer
**Generated**: 2026-10-23T11:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Add support for Claude 5.5 generation models (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`) across codemie-code:
1. Desktop connector (`src/cli/commands/proxy/connectors/desktop.ts`): Add models to `PREFERRED_CLAUDE_MODELS` and support priority selection collapsing.
2. VS Code capability table (`src/cli/commands/proxy/connectors/vscode-models.ts`): Register capability entries for `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5`.
3. Claude request normalizer (`src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts`): Update `MODEL_CAPABILITY_TABLE` regex to adapt thinking for 5.5 models (adaptive thinking with effort parameter).
4. Pricing table (`src/utils/pricing.json`): Add official Anthropic pricing entries for `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`.
5. Agents Pi models (`src/agents/plugins/pi/pi.models.ts`): Enable `forceAdaptiveThinking` for Haiku 5 models.
6. Unit and connector tests: Ensure full test coverage and snapshot resolution for Claude 5.5 models.

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/proxy/connectors/desktop.ts`: Governs model selection, priority lists, and fallback models configured for Claude Desktop. Defines `PREFERRED_CLAUDE_MODELS` and `selectDesktopClaudeModels()`, which filters and deduplicates candidate models available to the local Claude Desktop client.
- `src/cli/commands/proxy/connectors/vscode-models.ts`: Defines `VS_CODE_CAPABILITY_TABLE`, mapping model ID patterns to capabilities (`apiType`, `adaptiveThinking`, `effort`, `maxTokens`, `outputTokens`).
- `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts`: Intercepts upstream Claude Messages requests, normalizing legacy or unsupported parameters (such as converting `thinking: { type: 'enabled' }` to `{ type: 'adaptive' }` with `output_config.effort`) to avoid Bedrock / Vertex upstream provider failures.
- `src/agents/plugins/pi/pi.models.ts`: Contains Pi agent provider model resolution, determining whether adaptive thinking is forced for specific models via `forceAdaptiveThinking`.
- `src/utils/pricing.json`: Static pricing lookup table mapping model identifiers to per-million token costs (input, output, cache read, cache write) and Bedrock adjustment factors.

### Architecture and Layers Affected
- **CLI / Proxy Connectors Layer**: `desktop.ts` and `vscode-models.ts` manage proxy connector profiles and client-side model negotiation.
- **Provider / Proxy Plugin Layer**: `claude-request-normalizer.plugin.ts` operates as a Fastify / proxy middleware pipeline hook transforming Anthropic request bodies before routing upstream.
- **Agent Plugin Layer**: `pi.models.ts` configures model parameters for internal agent workflows.
- **Utility / Billing Layer**: `pricing.json` calculates estimated and recorded session costs.

### Integration Points
- Claude Desktop JSON config generator (`claude_desktop_config.json`).
- VS Code extension Copilot / BYOK model discovery interface.
- Upstream cloud provider model endpoints (Anthropic direct, AWS Bedrock, GCP Vertex AI).
- Cost calculator in session telemetry.

### Patterns and Conventions
- Priority resolution with family collapsing: When multiple versions of Opus, Sonnet, or Haiku exist, only the highest priority model from each family is selected for Claude Desktop to avoid confusing model duplicates.
- Regular expression matching in capability tables: Models are matched against regex patterns in `MODEL_CAPABILITY_TABLE` and `VS_CODE_CAPABILITY_TABLE`.
- Snapshot-based dated suffix resolution: Model prefixes map to snapshots (e.g. `-2025...` or `-latest`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/standards/git-workflow.md`: Conventional commits standard (`feat(proxy): ...`).
- Inline comments and test cases document the Claude proxy normalization behavior and Bedrock adaptive thinking requirement.

### Architectural Decisions
- Claude 5.x and 5.5 models require `type: 'adaptive'` thinking instead of legacy `type: 'enabled'` thinking when routed through Bedrock to prevent 400 Bad Request errors.
- Haiku family in Desktop connector must collapse to a single preferred candidate, just like Opus and Sonnet families.

### Derived Conventions
- Standard pricing unit: USD per 1M tokens with multiplier for Bedrock routing (1.1x default).
- ESM modules with `.js` extensions in imports.
- TypeScript strict mode compliance.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`: Verifies `selectDesktopClaudeModels` and `PREFERRED_CLAUDE_MODELS` ordering.
- `src/cli/commands/proxy/connectors/__tests__/vscode-models.test.ts`: Tests `findVsCodeCapabilityEntry` for registered models.
- `src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts`: Validates request normalization for adaptive thinking.
- `src/agents/plugins/pi/__tests__/pi.models.test.ts`: Tests Pi model capability flags.
- `tests/proxy-normalizer-body-contract.test.ts`: Verifies body contract transformations.

### Testing Framework and Patterns
- Vitest with `describe`, `it`, `expect`.
- Fixture-based test requests simulating Claude Messages API payloads.

### Coverage Gaps
- Previously no test verified `claude-haiku-5-5` or `claude-opus-5-5` adaptive thinking normalization, or dated snapshot variants.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_PROXY_PORT` (defaults to 4001).
- `CODEMIE_PROFILE` (defaults to active profile).

### Configuration Files
- `src/utils/pricing.json`: Model pricing configuration.

### Feature Flags and Deployment Concerns
- No feature flags; model capabilities are static tables loaded at process start.

---

## 6. Risk Indicators

- **Upstream Model Availability**: If a user's cloud credential or Bedrock region does not have 5.5 model ARNs enabled, fallback to 4.x / 5.0 must continue working transparently.
- **Thinking Configuration Normalization**: Misconfiguring adaptive thinking on models that require it causes upstream 400 HTTP errors from AWS Bedrock / GCP Vertex AI.
- **Pricing Calculation Accuracy**: Inaccurate token rates in `pricing.json` would lead to misleading cost attribution.

---

## 7. Summary for Complexity Assessment

The task extends existing Claude model support in `codemie-code` to include the Claude 5.5 family (`claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5`). The change spans three distinct subsystems within the codebase: proxy client connectors (Desktop and VS Code), the proxy request normalizer plugin, and auxiliary modules (Pi agent model configuration and pricing table).

All changes follow established, well-tested patterns. No new dependencies or architectural abstractions are required. The file surface touches 5 source files and 5 test files with clear unit test coverage and high confidence.

The technical risk is low. Existing fallback mechanisms protect against missing upstream model deployments, and the request normalizer ensures requests conform to Anthropic and Bedrock specifications.

---

## 8. External References

- Anthropic Pricing Documentation: `https://platform.claude.com/docs/en/about-claude/pricing` verified for `claude-haiku-5-5` ($0.10 / $0.50 per MTok base, $0.01 cache read, $0.125 / $0.20 cache write).
