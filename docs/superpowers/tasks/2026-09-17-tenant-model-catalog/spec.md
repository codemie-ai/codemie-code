# Spec: Tenant-aware model catalogs for CodeMie CLI proxy connectors

**Ticket**: EPMCDME-15073
**Date**: 2026-09-17

## Problem

`codemie proxy connect` configures three editor targets — VS Code Copilot BYOK, Claude Desktop,
and the VS Code Claude Code extension — using constants and parsing assumptions tuned to EPAM's
tenant. On any tenant with a different model catalog or a real hand-edited `settings.json`
(observed on a customer tenant), each fails independently:

- **Bug A** — `buildManagedModels()` (`vscode.ts:107`) writes the entire hardcoded
  `VS_CODE_SUPPORTED_MODELS` table (`vscode-models.ts:43`) into `chatLanguageModels.json` without
  ever consulting the tenant's `GET /v1/llm_models` catalog. Models the tenant doesn't serve get
  offered and 400 on use; models the tenant does serve under a different identifier are never
  offered.
- **Bug B** — `PREFERRED_CLAUDE_MODELS` (`desktop.ts:63`) and `selectPreferredClaudeModels()`
  (`desktop.ts:186`) assume EPAM's `claude-<family>-<version>` order. The reported tenant names
  Claude models `claude-<version>-<family>`; the resolver's three strategies only ever append
  suffixes, so 7 of 8 of that tenant's Claude models never resolve.
- **Bug C** — `readSettings()` (`vscode-claude-code.ts:44`) strict-parses VS Code's JSONC
  `settings.json` with `JSON.parse`. A real settings file with a comment fails to parse; the write
  is silently skipped and the extension keeps its prior routing (e.g. AWS Bedrock).

## Fix approach

### Bug A — tenant-aware VS Code Copilot BYOK

Reshape `vscode-models.ts`'s flat `VS_CODE_SUPPORTED_MODELS` array into a capability table keyed
by canonical model family/identity. Each entry keeps the metadata VS Code needs but that
`/v1/llm_models` doesn't carry (apiType, vision, thinking, token limits, reasoning-effort support,
request headers) — this data cannot come from the catalog and must stay curated.

At connect time, `buildManagedModels()` fetches the tenant's live catalog the same way
`desktop.ts:84`'s `fetchClaudeModels()` already does (`GET /v1/llm_models?include_all=true`,
`Authorization: Bearer <gatewayKey>`, reading `id || base_name || deployment_name`), generalized
to return every deployment rather than only Claude-prefixed ones. It intersects that catalog
against the capability table via the shared resolver (below): for each capability-table family
with a live match, it writes the config entry with the **tenant's own identifier string
verbatim** and that family's capability metadata. Families with no match are simply absent — no
error. Threading `state.gatewayKey` into `writeVsCodeLanguageModelsConfig`'s signature
(`connect-orchestrator.ts:460`) is the only plumbing change needed; `state.url` and
`state.gatewayKey` already reach this call site the same way `runClaudeDesktop` and
`runCodexDesktop` use them.

`github-copilot-*` deployments are excluded from this picker (see Decisions).

```ts
interface VsCodeCapabilityEntry {
  family: string; // resolver match key, e.g. "claude-opus-5", "gpt-5.6-luna"
  apiType: VsCodeApiType;
  vision: boolean;
  thinking: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  zeroDataRetentionEnabled?: boolean;
  adaptiveThinking?: true;
  modelOptions?: Readonly<{ temperature?: number | null; top_p?: number | null }>;
  requestHeaders?: Readonly<Record<string, string>>;
  supportsReasoningEffort?: readonly VsCodeReasoningEffort[];
  reasoningEffortFormat?: 'chat-completions' | 'responses';
}
```

If the live catalog fetch yields zero matches against the entire table (total failure, not
partial), the target throws (mirrors `desktop.ts:823`'s existing zero-match throw) and is reported
as failed for that target only — `connect-orchestrator.ts`'s existing per-target try/catch
isolation is untouched.

### Bug B — tenant-aware Claude Desktop resolution

Replace `selectPreferredClaudeModels()`'s three suffix-only strategies with the shared resolver
(below), which recognizes both `claude-<family>-<version>` and `claude-<version>-<family>` token
order — the two conventions actually observed. `selectDesktopClaudeModels()`'s family-collapse
behavior (one Opus, one Sonnet) is unchanged. The existing `/^claude-/i` filter
(`desktop.ts:~143`), which already excludes `github-copilot-claude-*`, is unchanged.

### Bug C — comment-preserving VS Code Claude Code settings edit

Add `jsonc-parser` as a new dependency (the library VS Code's own settings UI uses internally).
`readSettings()` uses its `parse()` with error collection: comments and trailing commas parse
cleanly; a genuine syntax error (e.g. an unbalanced brace) is reported with a specific reason and
the file is left untouched. The write path replaces
`JSON.stringify(updatedSettings, ...)` (`vscode-claude-code.ts:155`) with `modify()` +
`applyEdits()` against the original file text, applying only the two managed keys
(`claudeCode.disableLoginPrompt`, `claudeCode.environmentVariables`) as textual edits — every
other key, comment, and formatting byte is untouched by construction, not by best effort.

`vscode.ts:189`'s strict parse of the machine-written `chatLanguageModels.json` is left unchanged
(see Non-goals).

### Shared resolver module

A new module (used by `vscode.ts` and `desktop.ts` only — `codex-model-resolver.ts` is not
modified) generalizes `codex-model-resolver.ts`'s identity-parsing shape: strip the release date
before reading version tokens, normalize dotted vs. dashed minor versions. It adds two things the
Codex resolver doesn't need: stripping a small known set of vendor prefixes (e.g. `openai.`)
before matching GPT-family entries — never blind dot-segment stripping, which would corrupt
dotted versions like `gpt-5.6` — and, for the Claude family only, matching both token orders.
Gemini/Qwen/Kimi capability entries use exact match only; no naming variation has been observed
for them and none is invented speculatively.

## Non-goals

- No change to CodeMie's backend or to how tenants name their deployments — the CLI adapts to the
  tenant, not the reverse.
- No surfacing of tenant models absent from the capability table (e.g. the reported tenant's
  `glm-5`, `deepseek-v3-2`, `qwen3-coder-next`, `nemotron-3-super-120b`).
- No fix for the reported tenant's catalog's duplicate/multi-`default` entries (`claude-4-6-sonnet`
  / `claude-sonnet-4-6`, five `default: true` models) — a backend data question.
- No changes to `codex-model-resolver.ts` or Codex connector behavior; it must not regress.
- No comment-tolerant parsing added to `vscode.ts:189`'s `chatLanguageModels.json` read — that
  file is VS Code machine-written, not hand-edited, and doesn't share Bug C's failure mode.
- No reporting of which tenant models were skipped and why (deferred per story.md's existing
  decision — revisit if support tickets follow).
- `github-copilot-*` deployments do not appear in the VS Code Copilot BYOK picker (this story) or
  the Claude Desktop picker (already the case).
- No connectors other than VS Code Copilot BYOK, the VS Code Claude Code extension, and Claude
  Desktop are touched.
- No fully generic model-name resolver — scoped to the two evidenced naming conventions
  (EPAM-style family-first, and the reported tenant's version-first style).
- A local, untracked sample-data file (repo root) is a local reference only; it must never be
  committed, staged, or used as a fixture path. Any non-EPAM-tenant-shaped test fixture is a small
  inline literal defined fresh for its test.

## Acceptance criteria

**VS Code Copilot BYOK**
1. Given a tenant catalog with no deployment matching any capability-table family, the written VS
   Code config contains no entry for that family.
2. Given a tenant catalog with a deployment for a known family under a different identifier than
   CodeMie's canonical form, the written entry's `id`/`name` is byte-identical to the tenant's own
   identifier, paired with that family's capability metadata (apiType, token limits, reasoning
   efforts, etc.).
3. Given a synthetic non-EPAM-tenant-shaped catalog fixture (inline, not the root sample file)
   containing `openai.gpt-5.6-luna` with no dated suffix, the resolver matches it to the `gpt-5.6-luna`
   capability family after stripping the `openai.` prefix, and writes `openai.gpt-5.6-luna`
   verbatim — not the CLI's own dated canonical form.
4. Given a tenant catalog containing `github-copilot-*` deployments, none of them appear in the
   written VS Code config, regardless of whether a same-named non-prefixed deployment also exists.
5. Given a live catalog fetch that matches zero capability-table families, the VS Code target
   fails (reported as failed; other targets unaffected) rather than writing an empty or partial
   config.

**Claude Desktop**
6. Given a tenant catalog naming Claude models version-first (`claude-5-opus`, `claude-4-5-haiku`,
   `claude-4-6-sonnet`), Claude Desktop is offered the highest available Opus, the highest
   available Sonnet, and the available Haiku, each under the tenant's own identifier.
7. Given a tenant catalog with no model for one preferred family, that family is omitted and the
   connect still completes for the families that did resolve.
8. Given a tenant catalog containing `github-copilot-claude-*` deployments, none of them are
   offered by Claude Desktop (unchanged from current behavior).

**VS Code Claude Code extension**
9. Given a `settings.json` containing comments and/or trailing commas, the CodeMie-managed keys
   are written and the command reports the target as configured.
10. Given that same `settings.json` after a successful write, every pre-existing comment,
    unrelated key, and the file's formatting are unchanged — only `claudeCode.disableLoginPrompt`
    and `claudeCode.environmentVariables` differ.
11. Given a `settings.json` that is genuinely unparseable (e.g. an unbalanced brace), the file is
    left byte-for-byte unchanged and the reported error names both the file and the specific
    reason it could not be read.
12. Given a VS Code Claude Code extension previously routing to AWS Bedrock, after
    `--vscode-claude-code` completes successfully, `claudeCode.environmentVariables` carries
    `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` pointing at the local gateway, and
    `claudeCode.disableLoginPrompt` is `true`.

## Decisions

- New shared resolver module (not modifying `codex-model-resolver.ts`) generalizing its shape,
  scoped to the two evidenced Claude conventions plus known vendor-prefix stripping for GPT — over
  a fully generic resolver, per YAGNI and existing codebase precedent.
- Gemini/Qwen/Kimi capability families use exact match only.
- `github-copilot-*` deployments excluded from both the VS Code Copilot BYOK picker and Claude
  Desktop — smallest-scope option, consistent with the existing Desktop precedent, resolved by the
  product owner.
- `jsonc-parser` (`parse` + `modify` + `applyEdits`) chosen for Bug C over `json5`/`comment-json`,
  which fully re-serialize and risk reformatting untouched regions.
- `vscode.ts:189`'s strict parse is left unchanged — different failure profile (machine-written
  file, not hand-edited).
- Story.md's "report skipped tenant models" question stays deferred, per story.md's own prior
  decision.

## Open risks

- Whether a tenant's gateway accepts its own advertised identifier verbatim on the relevant
  endpoint (e.g. the reported tenant's `/v1/responses` with an `openai.`-prefixed id) cannot be
  verified from this repository; the CLI's contract is to pass it through unchanged, not to
  guarantee gateway acceptance.
- Verification against a real non-EPAM tenant before release depends on a customer-side retest or
  synthetic-fixture-only coverage — no live non-EPAM tenant is available in this environment.
- If a third tenant naming convention surfaces later, the two-convention-scoped resolver will need
  a follow-up change rather than already covering it.
