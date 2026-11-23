# Technical Research

> Sliced from the parent `../../technical-analysis.md` for `codemie-code`. Findings in `codemie` are kept only where they are a contract this repository produces or consumes (reference only, no write scope).

**Task**: analytics prompt obfuscation redaction sensitive-data PII secrets claude-otlp otlp collector github collector ticket attribution customer-config feature-flag codemie-cli backend
**Generated**: 2026-11-20
**Research path**: filesystem
**Workspace root**: /Users/Nikita_Levyankov/repos/codemie-ai — `codemie-code` @ 23335dea3 (main), `codemie` @ 76162abee (main)

---

## 1. Original Context

there is a need to introduce ability to have obfuscation of sensitive data in prompt when analytics is being generated in codemie analytics and --claude-otlp and other collectors as github. it should be in codemie cli and same logic applied on codemie backend via customer config flag (disabled by default), but can be enabled via customer config. exact same obfuscation rules should be applied. it's crucial to make sure that ticket description is still in place to have correct attribution, but other data can be obfuscated

---

## 2. Codebase Findings

### Repository impact

| Repo | Status | Evidence |
|---|---|---|
| codemie-code | affected | Owns every prompt capture site and the existing masking rules (below) |

### Existing Implementations

**Purpose A — keep secrets out of prompt text sent as analytics (CLI).** Already done, always on, secrets-only (no PII):
- `codemie-code:src/utils/security.ts:176` `EMBEDDED_SECRET_PATTERNS` + `applySecretPatterns` (:223), `maskSecretsInText` (:235, 64 KB cap), `maskSecretsDeep` (:244, key-name redaction via `SENSITIVE_KEY_PATTERNS` :29). Rules: PEM blocks, URL userinfo, `authorization:`, JWT `eyJ…`, Bearer, `sk-`/`sk-ant-`, Stripe, Google `AIza`/`ya29.`, npm, HF, AWS `AKIA/ASIA`, GitHub `gh[pousr]_`/`github_pat_`, GitLab `glpat-`, Slack `xox*`, curl `-u`, mysql `-p`. Replacement literal `[REDACTED]` (:135). No email, phone, IP, name, path rules.
- `codemie-code:src/utils/long-text-masking.ts:72` `maskSecretsInLongText` — same rules, no 64 KB cut.
- `codemie-code:src/agents/core/otlp-field-limits.ts:49` `maskAndBoundFields` — mask every field except `UNMASKED_FIELD_KEYS` (:23), then cut `prompt` to `MAX_PROMPT_CHARS=200` (:9) and tool/error fields to 300. Consumers: `OtlpAgentAdapter.ts:341` (base for all hook collectors: claude-code-otlp, copilot-cli-otlp, copilot-chat-otlp, codemie-code-hooks…), `copilot-cli-otlp.unhooked-tools.ts:91,100`, `telemetry/runtime/cowork/cowork-events.ts:323` (Claude Desktop cowork).
- `codemie-code:src/agents/core/OtlpAgentAdapter.ts:305` emits `prompt_body = boundedText(limited.prompt, 200)` — the field the backend stores.
- `codemie-code:src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts:342` `boundedFreeText` — `maskSecretsInText` then slice for extra free-text fields.
- `codemie-code:src/providers/plugins/sso/proxy/plugins/otlp-json-masking.ts:43` `maskOtlpJson` — masks native OTLP/JSON from `--claude-otlp` (attribute names via `isSensitiveKey`, then all strings). Consumer: `otlp.plugin.ts:383` (JSON path). Protobuf path `otlp.plugin.ts` `handleOtlpBinary` is "byte-blind, unmasked, unchanged".
- `--claude-otlp` connector sets `OTEL_LOG_TOOL_DETAILS=1` but not `OTEL_LOG_USER_PROMPTS` (`codemie-code:src/cli/commands/proxy/connectors/claude-code-otlp.ts:116-123`).

**Purpose B — strip prompt text from local `codemie analytics` reports.**
- `codemie-code:src/cli/commands/analytics/report/redact.ts:39` `redactPayload` (`--redact`, opt-in) — blanks session `title` (= full first user prompt), basenames `project`, drops `agentSessionFile`. Keeps `userEmail`, `branch`. Consumer: `cli/commands/analytics/index.ts:330,370`. Removal, not obfuscation.
- `codemie-code:src/cli/commands/analytics/sync/redact.ts:19` `redactSecrets` — only URL `sig=`/userinfo in sync logs (git/webhook targets, `sync/targets/*`). Not prompt content.

**Purpose C — keep ticket attribution.** Derived from the full, unmasked prompt before masking/truncation:
- `codemie-code:src/agents/core/ticket-parser.ts:14` `TICKET_RE` (`[A-Z][A-Z0-9]+-\d+`), `NON_TICKET_PREFIXES` (:22), `extractTicketMarker` (:310, `story: X`/`ticket #X`), `parsePromptFields` (:328 → `story_marker`, `ticket_mentions`, `prompt_length`; "Only derived values leave this function").
- `codemie-code:src/agents/core/story-resolver.ts:133` `resolveStoryFor` priority explicit (`SDLC_ANALYTICS_STORY_ID` / `.claude/analytics.local.json`) → marker → branch → mention. Consumer `event-fields/repo-fields.ts:34` → `story_id`, `story_source` on every event.
- `codemie-code:src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:707-721` calls `parsePromptFields(typed)` on the untruncated prompt.


**Other touched code**
- `codemie-code:src/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.ts:19` fetches `GET /v1/analytics/cli-analytics/classification-policy` (served at `cli_analytics.py:183`, returns `organizations`, `version`, `organization_encodings`, `publication_contracts`), cached 24 h (`POLICY_USABLE_MS`). Consumers: `evidence-send.ts`, `publication-mode.ts`, `forwarder.ts`, `tick-processor.ts`, `session-project.ts`.

### Decisions Already in the Code
- CLI masking is unconditional, secrets-only, no config toggle (`otlp-field-limits.ts`, `otlp.plugin.ts:383`). Alternative (configurable) — reason none found.
- Mask first, then truncate, so a secret straddling a cut is never half-shown (`otlp-field-limits.ts:47`). Prompt stored at ≤200 chars.
- Ticket fields are computed from the raw prompt before masking; ticket IDs never pass through masking (`claude-code-otlp.plugin.ts:707-712`).
- Mask failure drops the record rather than forwarding unmasked (`otlp.plugin.ts:385-392`); protobuf is forwarded unmasked by design.
- The CLI masking rules are TypeScript regexes; the backend is Python. No shared rule artifact (JSON/YAML) exists between the repos.

### Task Statements Checked Against the Code
- "obfuscation … in codemie cli" — partly holds: secret masking already exists in CLI for all hook collectors and `--claude-otlp` JSON; keeps `security.ts` rules in place (consumers listed under A). No PII rules.
- "codemie analytics" — holds as a gap: local report carries full first prompt in `title`; only opt-in `--redact` blanks it (`report/redact.ts`).
- "--claude-otlp" — holds: masked on JSON path; protobuf path unmasked (`otlp.plugin.ts`).
- "other collectors as github" — unverified which: no "GitHub collector" module found; candidates are GitHub Copilot collectors (`agents/plugins/copilot-cli-otlp`, `copilot-chat-otlp`) or `analytics sync` git target (`sync/targets/git-target.ts`, pushes report payload to a git repo).
- "same logic applied on codemie backend via customer config flag (disabled by default)" — no backend analytics obfuscation exists; `features:cliAnalytics` itself is `enabled: false` in YAML.
- "exact same obfuscation rules" — no shared rule source exists across TS/Python (see Decisions).
- "ticket description is still in place" — contradicted in part: attribution uses ticket IDs (`story_id`, `ticket_mentions`, `story_marker`), not descriptions; these are separate fields derived pre-mask. Prompt text itself carries any ticket description, truncated to 200 chars.

### Consumers of Changed Contracts
- `prompt_body` (hook field): stored `hook_events.prompt_body` (`alembic …0001:63`, `vocabulary.py:146`); read by `rollups.py:225` `_clean_prompt`, :236 sentinel-prefix filters (`SENTINEL_PREFIX_RAW`), :1798 `_IS_AUTO_PROMPT` (`CLAUDE_CODE_AUTO_PROMPT_PREFIXES`), :2136 → `session_dims.first_prompt`; `reader.py:688` search columns (`first_prompt`), :1378, :2394 (worst-sessions listing). Obfuscated text changes prefix-match and search results.
- `prompt` field in `maskAndBoundFields` — consumers `OtlpAgentAdapter.ts:305,341`, `cowork-events.ts:323,337`, `copilot-cli-otlp.unhooked-tools.ts`.
- `ReportSessionRecord.title` — `report/redact.ts:34`, local HTML report client (`report/client/app.js`).
- Classification-policy response shape — `policy-cache.ts` (`Policy` type), backend tests `test_cli_analytics_policy.py`.
- `features:cliAnalytics` settings — `cli_analytics_ingest_route.py:48`, `usage_attribution/handler.py:161`, `postgres_sources.py:39`, `analytics/cli_analytics_jobs.py:149`, `analytics/delivery_framework.py:45`, `cli_analytics.py:174`.

### Architecture and Layers Affected
- CLI: hook-adapter layer (`agents/core`), proxy OTLP ingest plugin (`providers/plugins/sso/proxy/plugins`), local analytics report/sync (`cli/commands/analytics`), shared utils (`utils/security.ts`).

### Integration Points
- CLI hook process → proxy daemon spool → backend `/v1/analytics/cli-analytics/event-hooks` (NDJSON) and `/logs|/metrics|/traces` (OTLP).

### Patterns and Conventions
- CLI: pure functions, input never mutated; `@/` path alias; leaf modules to keep proxy daemon graph small (`otlp-field-limits.ts:3-7`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `codemie-code/.ai-run/guides/security/security-practices.md`, `codemie/.ai-run/guides/security/`, `codemie/.ai-run/guides/data/`, `api/` exist (not read in depth).
- `codemie-docs/docs/admin/configuration/codemie/customer-feature-configuration.md` — customer feature config docs.

### Architectural Decisions
- Ingest gating decision referenced as EPMCDME-16440 (`cli_analytics_ingest_route.py` docstring).
- Masking rationale inline in `otlp-json-masking.ts`, `otlp-field-limits.ts`, `report/redact.ts` headers.

### Derived Conventions
- Masking utilities live in `src/utils/`, applied at the producer edge; backend trusts CLI masking.

---

## 4. Testing Landscape

### Existing Coverage
- CLI (vitest): `src/utils/__tests__/security.test.ts`, `long-text-masking.test.ts`, `agents/core/__tests__/otlp-field-limits.test.ts`, `ticket-parser.test.ts`, `story-resolver.test.ts`, `providers/plugins/sso/proxy/plugins/__tests__/otlp-json-masking.test.ts`, `otlp.plugin.otel-json.test.ts`, `cli/commands/analytics/__tests__/*`.

### Testing Framework and Patterns
- CLI vitest, co-located `__tests__`; backend pytest.

### Coverage Gaps
- No backend test of `prompt_body` content transformation (none exists). No test for a "redact report" test file located under `report/__tests__` (not found by name).
- No cross-language parity tests between TS and Python rule sets (none exist).

---

## 5. Configuration and Environment

### Environment Variables
- CLI `SDLC_ANALYTICS_STORY_ID` (explicit story tier); `--claude-otlp` writes `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.

### Configuration Files
- `codemie-code` `.claude/analytics.local.json` (`storyId`).

### Feature Flags and Deployment Concerns
- `features:cliAnalytics` disabled by default; extra settings ride on the component.

---

## 6. Risk Indicators

- No shared rule definition exists between `codemie-code` (TS regex in `security.ts:176`) and `codemie` (Python); "exact same rules" has no existing mechanism.
- Existing CLI secret masking (Purpose A) is always on; a new opt-in obfuscation sits alongside it (see Task Statements).
- `--claude-otlp` protobuf path is unmasked (`otlp.plugin.ts` `handleOtlpBinary`).
- "Ticket description" vs ticket ID: attribution depends on IDs derived pre-mask (`claude-code-otlp.plugin.ts:707`); other adapters' ordering of `resolveRepoFields` vs `limitPayload` not individually verified.
- "GitHub collector" ambiguous (Copilot collectors vs `analytics sync` git target).
- Speculative: backend-side obfuscation of already-stored rows would require a data path not present (no transform at ingest today).
- codemie-ui, codemie-test-harness, codemie-docs impact unknown.

---

## 7. Summary for Complexity Assessment

The change spans two repositories and languages. In `codemie-code`, prompt text reaches analytics through the hook-adapter base (`OtlpAgentAdapter` → `maskAndBoundFields`, ~5 collectors plus Claude Desktop cowork), the proxy OTLP/JSON path (`maskOtlpJson`), and the local `codemie analytics` report (`title` = full first prompt, opt-in `--redact`). A secrets-only masking layer already exists and is unconditional; there are no PII rules and no toggle. In `codemie`, CLI analytics ingest (`/event-hooks`, `/logs`) stores `prompt_body` verbatim into `hook_events`, feeding `session_dims.first_prompt`, rollup sentinel/auto-prompt detection and session search; no analytics redaction exists. Customer config has a clear convention (`features:cliAnalytics` component, `get_feature_setting`, declarations registry), and the only backend→CLI config channel is the cached classification-policy endpoint.

Novelty: keeping identical rules across TypeScript and Python has no precedent here; ticket attribution is already decoupled from prompt text (IDs computed pre-mask), but the task's "ticket description" wording does not match any existing field. Test posture is good on CLI masking and ticket parsing and on backend ingest/customer config, with no tests on prompt content transforms at the backend or cross-language parity. Key risks: rule parity, rollups depending on raw prompt prefixes, unmasked protobuf path, ambiguous "GitHub collector", and flag propagation to the CLI.

---

## 8. External References

None named by the task.

## Produced external contracts (reference only)

- The rule list, typed placeholder format, failure placeholder and canonical sample set defined here are mirrored by `codemie` (child `prompt-obfuscation-backend`), which stores obfuscated text from `prompt_body` and other free-text fields (`codemie:src/codemie/repository/cli_analytics/postgres/otlp.py:160`).
- New `story_source` values or ticket forms (Azure DevOps, GitHub/GitLab) reach the backend through the existing `story_id`/`story_source` attributes (`codemie:src/codemie/repository/cli_analytics/postgres/rollups.py:1596-1611`).

