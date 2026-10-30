# Technical Research

**Task**: omp proxy connector model-catalog
**Generated**: 2026-10-21
**Research path**: filesystem

---

## 1. Original Context

"lets try implementing the adversarial review comments and my comments.
I stopped the local proxy recheck the first point by running the the code from this worktree.
   1. why there are 2 lists for models? Why codemie and codemie/claude if possible. Document the reasoning if update is not required.
   2. how can we verify the cap? Verify with a sub agent and implement.
   3. we dont have to use vscode and omp together. remove relevant implementation without breaking anything. This is an edge case and this prioritizes omp terminal usage only.
   4. add tests for relevant parts."

Prior adversarial review evidence:
A. `omp-models.ts:57` routes to Anthropic only when id starts `claude`; `sy-signal-claude-v1` (is_router) goes to OpenAI. Same prefix convention occurs in `src/agents/plugins/pi/pi.models.ts:33` and `opencode-dynamic-models.ts:27`.
B. Filtering excludes only disabled and image-generation models; embeddings may leak. `reasoning: !id.startsWith('gpt-4')` marks unrelated families as reasoning.
C. Routers omit `max_output_tokens`, so omp uses `DEFAULT_MAX_OUTPUT_TOKENS=32_000`.
D. `--omp` alone gets `codemie-daemon`; `--omp --vscode` gets `vscode-byok`. Sanitizer `ALLOWED_AGENTS` omits `codemie-daemon`, so omp-alone misses invalid encrypted-content recovery.
E. No tests for `omp-models.ts`, `connectors/omp.ts`, or `omp/codemie-models.extension.ts`.

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/proxy/connectors/omp/omp-models.ts`: catalog-to-OMP mapping, split rosters, Claude-prefix routing, image/disabled filtering, fallback window/cap.
- `src/cli/commands/proxy/connectors/omp/codemie-models.extension.ts`: fetches daemon catalog and registers `codemie` and `codemie-claude` providers; provider config has `api`/`baseUrl`, model rows also have `api` but no model URL.
- `src/cli/commands/proxy/connectors/omp.ts`: installs/removes owned extension; honors omp agent-dir overrides.
- `src/cli/commands/proxy/index.ts`: parses `--omp`/`--vscode` independently, maps flags to targets; disconnect has `--omp` only.
- `src/cli/commands/proxy/connect-orchestrator.ts`: one daemon identity for all targets; omp alone → `codemie-daemon`, omp+VS Code BYOK → `vscode-byok`; runs both target writers independently.
- `src/cli/commands/proxy/disconnect-orchestrator.ts`: removes omp extension independently.
- `src/providers/plugins/sso/proxy/sso.proxy.ts`: generic HTTP proxy preserves incoming URL path and forwards request; `/v1/messages`, `/v1/chat/completions`, `/v1/responses` are separate routes selected by path.
- `src/providers/plugins/sso/sso.http-client.ts`: `LlmModel.max_input_tokens` is documented as minimum across router tiers; `max_output_tokens` comes from LiteLLM model info and is absent on virtual routers; router tiers are exposed.
- `src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts`: explicit agent allowlist lacks `codemie-daemon`; plain `codemie proxy start` uses that same identity.
- Installed OMP is v18.12.3. `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-agent`, and `oh-my-pi` are not resolvable in this worktree; upstream ExtensionAPI types are unavailable locally.

### Live Catalog Recheck
Exact commands from worktree root:
1. `node bin/codemie.js proxy status --json` → stopped.
2. `npm run build` → success (`tsc`, aliasing, plugin copy, statusline and OMP bundles); OMP bundle emitted `dist/cli/commands/proxy/connectors/omp/codemie-models.bundle.js`.
3. `node bin/codemie.js proxy start` → `http://127.0.0.1:4001`, profile `epm-cdme`.
4. Node `fetch` GET `/v1/llm_models?include_all=true`, with bearer key read from `$CODEMIE_HOME/proxy-daemon.json` or `~/.codemie/proxy-daemon.json`; projection emitted only catalog fields, not credentials.
5. `node bin/codemie.js proxy stop`. Restarted and stopped once more for cap probe.

The catalog contained 54 rows, all `enabled=true`. Table: `id | image | is_router/type | max_input/max_output`; `—` means field absent. Non-router rows had `image=false`, `is_router`/`router_type` absent. The two image-generation entries are `true`; router rows omit image flag.

| ID | Image | Router/type | Input/output |
|---|---|---|---:|
| `gpt-4.1` | F | — | 1,047,576/32,768 |
| `gpt-4.1-mini` | F | — | 1,047,576/32,768 |
| `gpt-5-2025-08-07` | F | — | 272,000/128,000 |
| `gpt-5-mini-2025-08-07` | F | — | 272,000/128,000 |
| `gpt-5-nano-2025-08-07` | F | — | 272,000/128,000 |
| `gpt-5-1-codex-2025-11-13` | F | — | 272,000/128,000 |
| `gpt-5-2-2025-12-11` | F | — | 272,000/128,000 |
| `gpt-5.4-2026-03-05` | F | — | 1,050,000/128,000 |
| `gpt-5.5-2026-04-24` | F | — | 1,050,000/128,000 |
| `gpt-5.6-luna-2026-07-09` | F | — | 1,050,000/128,000 |
| `gpt-5.6-sol-2026-07-09` | F | — | 1,050,000/128,000 |
| `gpt-5.6-terra-2026-07-09` | F | — | 1,050,000/128,000 |
| `gpt-6-luna` | F | — | 922,000/128,000 |
| `gpt-6-sol` | F | — | 922,000/128,000 |
| `gpt-6.1-sol` | F | — | 922,000/128,000 |
| `o3-mini` | F | — | 200,000/100,000 |
| `o1` | F | — | 200,000/100,000 |
| `o3-2025-04-16` | F | — | 200,000/100,000 |
| `o4-mini-2025-04-16` | F | — | 200,000/100,000 |
| `deepseek-v4-pro` | F | — | 1,000,000/384,000 |
| `gemini-3-flash` | F | — | 1,048,576/65,535 |
| `gemini-3.1-flash-image` | T | — | 65,536/32,768 |
| `gemini-3.1-pro` | F | — | 1,048,576/65,536 |
| `gemini-3.5-flash` | F | — | 1,048,576/65,535 |
| `gemini-3.6-flash` | F | — | 1,048,576/65,536 |
| `gemini-3.7-flash` | F | — | 1,048,576/65,536 |
| `gemini-3.8-flash` | F | — | 1,048,576/65,536 |
| `gemini-4-argon` | F | — | 1,048,576/1,048,576 |
| `gemini-nano-banana-2.1` | T | — | 131,072/32,768 |
| `claude-4-5-sonnet-vertex` | F | — | 200,000/64,000 |
| `claude-sonnet-4-6-vertex` | F | — | 1,000,000/64,000 |
| `claude-opus-4-6-vertex` | F | — | 1,000,000/128,000 |
| `claude-4-5-sonnet` | F | — | 200,000/64,000 |
| `claude-sonnet-4-6` | F | — | 1,000,000/64,000 |
| `claude-sonnet-5` | F | — | 1,000,000/128,000 |
| `claude-sonnet-5-5` | F | — | 1,000,000/128,000 |
| `claude-opus-4-5-20251101` | F | — | 200,000/64,000 |
| `claude-opus-4-6-20260205` | F | — | 1,000,000/128,000 |
| `claude-opus-4-7` | F | — | 1,000,000/128,000 |
| `claude-opus-4-8` | F | — | 1,000,000/128,000 |
| `claude-opus-5` | F | — | 1,000,000/128,000 |
| `claude-opus-5-5` | F | — | 1,000,000/128,000 |
| `claude-haiku-4-5-20251001` | F | — | 200,000/64,000 |
| `claude-haiku-5-5` | F | — | 1,000,000/128,000 |
| `qwen.qwen3-coder-30b-a3b-v1` | F | — | 262,144/16,384 |
| `qwen.qwen3-coder-480b-a35b-v1` | F | — | 262,144/16,384 |
| `moonshotai.kimi-k2.5` | F | — | 262,144/16,000 |
| `grok-4.6` | F | — | 500,000/500,000 |
| `claude-sonnet-4-5-20250929` | F | — | 200,000/64,000 |
| `sy-signal-gpt-v1` | — | true/switchyard | 922,000/— |
| `sy-signal-claude-v1` | — | true/switchyard | 1,000,000/— |
| `claude-router-standard` | — | true/litellm_auto | 1,000,000/— |
| `claude-router-premium` | — | true/litellm_auto | 1,000,000/— |
| `gpt-router-standard` | — | true/litellm_auto | 922,000/— |

Live router tiers: GPT routers `simple/medium → gpt-6-luna`, `complex/reasoning → gpt-6-sol`; standard Claude routers `simple/medium → claude-haiku-5-5`, `complex/reasoning → claude-sonnet-5`; premium Claude `simple → claude-haiku-5-5`, `medium → claude-sonnet-5`, `complex/reasoning → claude-opus-5-5`. Each target has catalog output cap 128,000; minimum tier cap for all five routers is 128,000. No strategy/classifier fields were in the emitted projection.

### Architecture and Layers Affected
- CLI target parsing/orchestration/disconnect; OMP installer, extension and model mapping; SSO proxy plugins/client identity; unit/integration tests and command/architecture docs.

### Integration Points
- `codemie` uses `<daemon>/v1` with OpenAI Chat Completions/Responses; `codemie-claude` uses `<daemon>` with Anthropic Messages and `authHeader`. The SSO proxy forwards paths transparently. Thus two providers capture distinct URL roots, wire APIs and auth behavior.
- The extension model row has `api`, but upstream OMP API types are not locally present; per-model API override with one provider/base URL is unverified. Pi's `pi.models.ts` also uses separate `codemie-proxy`/`codemie-anthropic` provider families and routes by Claude prefix.

### Patterns and Conventions
- Testing guide: co-located Vitest `__tests__`, Arrange/Act/Assert, mocked external dependencies, teardown of spies. `connect-orchestrator.test.ts` covers identity tables; `connect-wiring.test.ts` tests Commander flags; `codex-desktop.test.ts` covers connector file lifecycle.
- For a self-contained deployed extension, testing guide recommends injected fakes for filesystem/network rather than mocking its direct dependencies.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/testing/testing-patterns.md`; `docs/COMMANDS.md` (OMP providers and combined identity); `docs/ARCHITECTURE-PROXY.md` (§6.13 shared daemon and normalizers).

### Architectural Decisions
- SSO proxy is generic/path-transparent. `LlmModel` documents router input cap minimum across tiers and absent router output cap. Encrypted-content sanitizer uses explicit client allowlist.

### Derived Conventions
- Retain protocol-specific provider registrations unless real OMP runtime/type evidence proves mixed per-model protocol and URL support. Derive router output limits as minimum catalog cap across known tier targets; handle unknown caps explicitly.

---

## 4. Testing Landscape

### Existing Coverage
- `connect-orchestrator.test.ts`: identity and lifecycle; no omp/vscode pair asserted. `connect-wiring.test.ts`: CLI target mapping. `connectors/__tests__/codex-desktop.test.ts`: connector test patterns. `transparent-vscode-proxy.integration.test.ts`: all three API paths. Prior review found no OMP-specific tests.

### Testing Framework and Patterns
- Vitest (`npm test` runs unit, CLI, agent projects), co-located tests, module mocks and temporary workspaces. For extension, use injected filesystem/network fakes.

### Coverage Gaps
- Add `connectors/omp/__tests__/omp-models.test.ts` (family/router selection, non-chat filtering, reasoning, tier caps); `connectors/omp/__tests__/codemie-models.extension.test.ts` (registrations, fetch/cache, failures); `connectors/__tests__/omp.test.ts` (install/refresh/ownership/disconnect); extend `connect-orchestrator.test.ts` and `connect-wiring.test.ts` for omp+VS Code policy; add sanitizer coverage for `codemie-daemon` including ordinary proxy start.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_HOME` selects daemon state directory; `CODEMIE_OMP_BASE_URL` selects an alternate inference hop; `PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR` select omp extension location.

### Configuration Files
- `$CODEMIE_HOME/proxy-daemon.json` or `~/.codemie/proxy-daemon.json`: daemon URL/key. If unreadable, extension defaults to localhost:4001 and `codemie-proxy`.
- `<omp-agent-dir>/extensions/codemie-models.js`: managed extension removed only with CodeMie ownership marker.

### Feature Flags and Deployment Concerns
- `--omp` + `--vscode` today shares one daemon identity (`vscode-byok`), activating that request-normalizer path for omp. Sanitizer allowlist omits `codemie-daemon`; adding it also affects plain `proxy start`.

---

## 6. Risk Indicators

- Claude-prefix classification misroutes `sy-signal-claude-v1`; router tier metadata can identify family more reliably.
- Current filtering can include embedding/non-chat entries; reasoning heuristic is not catalog-derived.
- Metadata supports 128,000 as a router cap (minimum tier output cap); live request does not prove hard enforcement.
- Cap probe: one `sy-signal-gpt-v1` Chat Completions request with `max_tokens:128001`, prompt “Reply only OK.” returned HTTP 200 and `gpt-6-luna` with `OK`. This only proves acceptance, not maximum.
- `--omp --vscode` picks `vscode-byok` and exposes OMP to its normalizer; payload impact untested. Simplest scoped remedy: reject only `targets.omp && targets.vscode` before side effects with guidance to connect separately; leave `vscodeClaudeCode` and unrelated target combinations unchanged.
- Adding `codemie-daemon` to encrypted-content allowlist enables ordinary `proxy start` too; test/document this shared effect.
- Separate providers encode path/wire/auth differences; no local upstream OMP type proves single-provider override semantics.
- OMP catalog, extension, installer, mixed target and sanitizer paths lack dedicated tests per prior review and reviewed test files.

---

## 7. Summary for Complexity Assessment

The change surface spans CLI target parsing/orchestration and disconnect, the OMP installer/extension/model mapper, SSO proxy plugins gated by daemon identity, tests, and proxy docs. The worktree build succeeded and the live daemon returned 54 models. Five routers omit output caps but expose complete tier maps; each listed tier target has a 128,000 catalog output cap, so the minimum-across-tiers metadata rule yields 128,000 for all five. A single minimal `max_tokens: 128001` request to the GPT router returned HTTP 200, which does not establish a hard limit; 128,000 is metadata-derived rather than experimentally enforced.

Two registrations currently express OpenAI `/v1` versus Anthropic root URL/API differences, with path-transparent proxy routing. OMP's upstream API type source was unavailable, leaving single-provider per-model override support unresolved. OMP+VS Code BYOK uses the shared daemon's `vscode-byok` identity and consequently enters its gated normalizer path; omp-alone gets `codemie-daemon`, which the encrypted-content sanitizer does not allow. Existing Vitest coverage covers generic connect wiring and identity patterns, not OMP. Principal risks: router-family classification, non-chat filtering, hard-cap assumptions, ambiguous mixed identity, sanitizer scope, and missing OMP tests.

---

## 8. External References

None named outside the repository. All task-named source paths and guides are within this worktree.
