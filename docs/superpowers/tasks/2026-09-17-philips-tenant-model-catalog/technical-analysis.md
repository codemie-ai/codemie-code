# Technical Analysis — non-EPAM tenant model catalog & proxy connector failures

**Date**: 2026-09-17
**Feature area**: proxy connectors, model catalog, VS Code BYOK, Claude Desktop, VS Code Claude Code extension
**Evidence**: a local, uncommitted sample of a customer tenant's `/v1/llm_models` response (20 models), two screenshots from a customer support session, repository source.

---

## 1. The reported tenant catalog

Parsed from the supplied sample. 20 models, 12 `aws_bedrock` + 8 `azure_openai`.

| Provider | `base_name` / `deployment_name` |
|---|---|
| aws_bedrock | `claude-4-5-sonnet`, `claude-5-sonnet`, `claude-4-6-sonnet`, `claude-4-5-haiku`, `claude-4-6-opus`, `claude-4-7-opus`, `claude-5-opus`, `claude-sonnet-4-6`, `qwen3-coder-next`, `deepseek-v3-2`, `nemotron-3-super-120b`, `glm-5` |
| azure_openai | `openai.gpt-5.6-luna`, `openai.gpt-5.6-terra`, `openai.gpt-5.6-sol`, `github-copilot-gpt-5-mini`, `github-copilot-gpt-5-3-codex`, `github-copilot-claude-haiku-4-5`, `github-copilot-claude-sonnet-4-5`, `github-copilot-claude-opus-4-5` |

Three properties of this catalog differ from the EPAM tenant the CLI was built against:

1. **No dates.** Every deployment name in this tenant's catalog is undated. The CLI's own hardcoded lists are dated (`gpt-5.6-luna-2026-07-09`, `claude-opus-4-5-20251101`, `claude-sonnet-4-5-20250929`). The reported "dates in models" symptom is the reverse of the user's initial reading: the dates come from the CLI, not from the tenant.
2. **Inverted Claude naming.** This tenant writes `claude-<version>-<family>` (`claude-5-opus`, `claude-4-7-opus`, `claude-4-6-sonnet`). The CLI assumes `claude-<family>-<version>` (`claude-opus-5`). `claude-sonnet-4-6` is the single entry that happens to match both conventions.
3. **Vendor-prefixed OpenAI names.** `openai.gpt-5.6-luna` carries an `openai.` prefix and a dotted minor version; the CLI expects the bare `gpt-5.6-luna-<date>` form.

Secondary observations: five models carry `default: true` (`claude-4-6-sonnet`, `claude-sonnet-4-6`, and all three `openai.gpt-5.6-*`), so any `find(m => m.default)` resolves arbitrarily; and `claude-4-6-sonnet` / `claude-sonnet-4-6` are a duplicate pair under both naming conventions.

---

## 2. Bug A — VS Code Copilot BYOK models (`codemie proxy connect --vscode`)

**Root cause: the model list is a static compile-time constant; the tenant catalog is never consulted.**

- `src/cli/commands/proxy/connectors/vscode-models.ts:43` declares `VS_CODE_SUPPORTED_MODELS` — 25 hardcoded `VsCodeModelDefinition` entries with EPAM-tenant IDs.
- `src/cli/commands/proxy/connectors/vscode.ts:107` `buildManagedModels()` maps **the entire constant** into the written config. There is no filter, no intersection, and no network call.
- `src/cli/commands/proxy/connectors/vscode.ts:236` `writeVsCodeLanguageModelsConfigAtPath()` writes that list to `chatLanguageModels.json` under the `CodeMie` / `customendpoint` provider.

Consequence on this tenant: VS Code is told about `gpt-5.6-luna-2026-07-09`, which the tenant's gateway has never heard of. Selecting it produces the observed failure verbatim — `400 {"error":{"message":"/responses: Invalid model name passed in model=gpt-5.6-luna-2026-07-09. Call /v1/models to view available models for your key."}}`.

The inverse also holds: of this tenant's 20 models only `claude-4-5-sonnet` and `claude-sonnet-4-6` appear in the static list. The other 18 — including every `openai.gpt-5.6-*`, every `github-copilot-*`, and `qwen3-coder-next` / `deepseek-v3-2` / `nemotron-3-super-120b` / `glm-5` — are unreachable from VS Code entirely.

**Contrast — the Desktop connector already does this correctly.** `src/cli/commands/proxy/connectors/desktop.ts:84` `fetchClaudeModels()` calls `GET /v1/llm_models?include_all=true` through the local proxy with the gateway key and reads `id || base_name || deployment_name`. The VS Code connector has no equivalent. The per-model metadata VS Code needs (`apiType`, `maxInputTokens`, `maxOutputTokens`, `supportsReasoningEffort`, `requestHeaders`) is not present in the `/v1/llm_models` payload, so discovery alone does not replace the static table — the table has to become a *capability* table keyed by model family, intersected with what the tenant actually serves.

---

## 3. Bug B — Claude Desktop models on a non-EPAM tenant

**Root cause: the curated preferred list is written in a naming convention this tenant does not use.**

- `src/cli/commands/proxy/connectors/desktop.ts:62` `PREFERRED_CLAUDE_MODELS` = `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`.
- `src/cli/commands/proxy/connectors/desktop.ts:186` `selectPreferredClaudeModels()` resolves each preferred name by: exact match → dated variant `<preferred>-<6–10 digits>` → `<preferred>-vertex`. Non-matches are dropped silently.
- `src/cli/commands/proxy/connectors/desktop.ts:~236` `selectDesktopClaudeModels()` then collapses the opus and sonnet families to one entry each.

Applied to this tenant's catalog, only `claude-sonnet-4-6` resolves. `claude-5-opus`, `claude-4-7-opus`, `claude-4-6-opus`, `claude-5-sonnet`, `claude-4-6-sonnet`, `claude-4-5-sonnet` and `claude-4-5-haiku` all fail every branch, because the resolver's three strategies only ever *append* a suffix — none of them reorder family and version tokens. Desktop users on this tenant get a one-model picker with no Opus and no Haiku.

The `/^claude-/i` filter at `desktop.ts:~143` additionally excludes the `github-copilot-claude-*` deployments; that is likely correct for Desktop but should be a stated decision rather than an accident.

---

## 4. Bug C — VS Code Claude Code extension (`--vscode-claude-code`)

**Root cause: VS Code's `settings.json` is JSONC; the connector parses it with strict `JSON.parse`.**

- `src/cli/commands/proxy/connectors/vscode-claude-code.ts:60` `readSettings()` calls `JSON.parse(raw)` and, on any failure, throws `VS Code settings at <path> are not valid JSON and were not changed.`
- That is the exact string in the screenshot: `C:\Users\<user>\AppData\Roaming\Code - Insiders\User\settings.json are not valid JSON and were not changed.`
- VS Code documents `settings.json` as JSON **with comments** and tolerates trailing commas. The reported file is a real working settings file (MCP server blocks, `${input:...}` variables are visible in the screenshot), so comments and/or trailing commas are the expected state, not corruption.

Consequence: the write is skipped entirely, so `claudeCode.environmentVariables` never receives `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (`vscode-claude-code.ts:119-125`) and `claudeCode.disableLoginPrompt` is never set. The extension keeps whatever it had — which is what the user is describing as "still aws connected models are in list… it's not reoverride it". The orchestrator reports the target as failed but does not abort the run (`connect-orchestrator.ts:684`), which is why the Copilot target shows ✓ next to the Claude Code ✗.

**Constraint on the fix:** lenient parsing alone is not enough. The writer at `vscode-claude-code.ts:155` re-serializes the whole object with `JSON.stringify`, which would silently delete every comment in the user's settings file. A correct fix needs a comment-preserving edit (surgical modification of the two managed keys), not parse-then-restringify. The repository currently has **no** JSONC dependency — `jsonc-parser`, `json5`, `strip-json-comments` and `comment-json` are all absent from `package.json`.

The same strict-`JSON.parse` shape exists at `vscode.ts:189` for `chatLanguageModels.json`. That file is machine-written by VS Code so it is lower risk, but it shares the failure mode.

---

## 5. Existing pattern worth reusing

`src/providers/plugins/sso/proxy/plugins/codex-model-resolver.ts` already solves this exact class of problem for Codex: the app's picker sends an undated name (`gpt-5.6-luna`) and the gateway only accepts the dated deployment (`gpt-5.6-luna-2026-07-09`), so the resolver parses a model into `{major, minor, variant}`, strips the date before reading the version, and normalizes dotted vs dashed minors. It is deliberately self-contained and deliberately GPT-only (`/^gpt-(\d+)(?:-(\d+))?/` at `codex-model-resolver.ts:~57`) — it has no Claude branch and no family/version reordering, so it does not cover this tenant's `claude-5-opus` form today. It is the right shape to generalize from, and it establishes that "resolve the client's name against the tenant's real catalog" is already an accepted approach in this codebase rather than a new architectural direction.

---

## 6. Affected files

| File | Role |
|---|---|
| `src/cli/commands/proxy/connectors/vscode-models.ts` | Static 25-entry model table (Bug A) |
| `src/cli/commands/proxy/connectors/vscode.ts` | Writes `chatLanguageModels.json`; `buildManagedModels` (Bug A); strict parse at :189 |
| `src/cli/commands/proxy/connectors/desktop.ts` | `PREFERRED_CLAUDE_MODELS`, `fetchClaudeModels`, `selectPreferredClaudeModels`, `selectDesktopClaudeModels` (Bug B) |
| `src/cli/commands/proxy/connectors/vscode-claude-code.ts` | `readSettings` strict parse + `JSON.stringify` write (Bug C) |
| `src/cli/commands/proxy/connect-orchestrator.ts` | Target wiring, per-target success/failure reporting |
| `src/providers/plugins/sso/proxy/plugins/codex-model-resolver.ts` | Existing resolution pattern to generalize |

## 7. Unknowns / verification gaps

- Whether `/v1/llm_models` is reachable from the VS Code connect path at the time config is written (Desktop proves it is reachable at that stage, with the gateway key).
- Whether this tenant's gateway accepts the `openai.` prefix verbatim on `/v1/responses`, or expects it stripped.
- Whether this tenant's `github-copilot-*` deployments should surface in the VS Code picker at all, or be excluded as duplicates of Copilot's own models.
- Whether other tenants use further naming conventions beyond the two now observed — i.e. whether the fix should be a general resolver or a two-convention one.
