# Design: OpenCode v2 Support

**Status:** Implemented; automated unit/CLI checks pass locally and on Ubuntu/Windows CI.
A manual live smoke check also confirms OpenCode v2 startup through CodeMie with generated v2 config.
Full provider and end-to-end session acceptance remain unverified.
**Scope:** supplementary OpenCode 2.x support — provider configuration, supported launch isolation,
telemetry hooks, database selection and session-data translation, model routing and pricing metadata.

## 1. Goal

Adapt the existing CodeMie launch and analytics contracts to both OpenCode 1.x and 2.x: emit the matching
provider configuration, load the matching hooks plugin, select the database used by the launched binary,
and translate its session data into the existing metrics/conversation interfaces.

`codemie install opencode` continues to install **OpenCode v1** through `opencode-ai`. Making v2 the
default installed version is **out of scope**: the task is to support v2, not to replace the primary v1
installation path. Additional v2 support does not change that package choice or require a v2-only CLI
for v1 users. The v1 configuration shape and automatic argument policy are retained. Shared corrections to model-ID
qualification, hooks, MCP parsing and plugin URLs can change generated values. Compatibility means the
preserved v1 schema, flags and documented policies, not unconditional byte identity of every value.

## 2. Background

- CodeMie launches the `opencode` binary and injects its configuration at startup: inline JSON via
  `OPENCODE_CONFIG_CONTENT` primary, temp-file via `OPENCODE_CONFIG` fallback above the env size limit.
- OpenCode 1.x reads `provider` (singular) + `npm` + `options`. OpenCode 2.x reads `providers` (plural) +
  `package` + `settings`. The plugin probes `opencode --version` and caches the result with a TTL
  (`resolveOpenCodeConfigVersion()` in `src/agents/plugins/opencode/opencode.plugin.ts` — `PATH`
  resolution, shell execution on Windows for `.cmd` shims, 3s timeout, warn-and-fallback to `v1`;
  a successful probe is trusted for 5 minutes, a failed probe's v1 fallback for 30 seconds, so a
  short-lived CLI normally reuses the result throughout its launch while a long-lived process can pick up
  an installed/upgraded binary; `CODEMIE_OPENCODE_CONFIG_VERSION=1|2` overrides).
  Success requires exit `0` and a complete version response, with optional OpenCode label / `v` prefix
  and prerelease/build suffixes. Empty, malformed, partial or unrelated stdout and nonzero exits use the
  warning + 30-second v1 fallback. This avoids treating failed detection as a five-minute successful
  probe. Validation warnings do not echo response stdout/stderr. Windows executable quoting follows the
  launcher for resolved and raw metadata paths; POSIX stays shell-free.
- `modelID` does not need to be emitted: v2 defaults it to the `models` map key
  (`modelID: model.modelID ?? modelID` in the provider configuration mapping), and the field is optional.
  Our emission uses deployment IDs as map keys verbatim, so omitting it sends the correct ID by construction.
- Each v2 model entry carries either the default chat package or a per-model `/responses` package override,
  which decides whether the model is sent to `POST /v1/chat/completions` or `POST /v1/responses`. The
  decision is taken in `isResponsesApiModel()` when the fetched catalogue is converted; the v2 emission
  then splits the converted configs and sets the per-model package override for the Responses group.
- Responses-API-only families (gpt-5.2, gpt-5.1/5.3 Codex, gpt-5.4/5.5/5.6, gpt-6) are recognised by name
  patterns in `opencode-dynamic-models.ts`, with the bounded future-major heuristic described in §6.
  Without correct classification a Responses-only deployment is emitted for the wrong request route.
- **Session analytics are DB-backed, and the DB layout is version-specific.** OpenCode 1.x uses
  `session` / `message` / `part` tables; 2.x uses `session_v2` / `session_message` with message parts
  nested inside the message row.
  The reader must handle both layouts (§7). Hooks supply a `transcript_path`; a correct plugin event is
  insufficient if that path selects another binary's database or its source session cannot be found.
- **Per-provider v2 behaviour differs and is not uniform.** The proxy provider is fully expressible in v2.
  Ollama in v2 has no built-in AI provider package; its inventory comes from a bundled discovery plugin
  (§4). Bedrock has a native v2 provider package and must be declared in the matching shape (§4).

## 3. High-level approach

**Extend in place with separate decisions at their authoritative boundaries:**

1. Probe the CLI major for configuration and version-gated arguments (§2, §4).
2. Declare native v2 providers and the matching directory hooks plugin (§4, §8).
3. Resolve the database using the actual binary/environment, then detect its layout from the file (§7).
4. Carry source session identity separately from CodeMie lifecycle identity (§7).
5. Decide endpoint routing during catalogue conversion and preserve existing model metadata (§4, §6).

These decisions are intentionally independent. Config delivery size does not decide the schema; the
installed CLI major does not decide the layout of an existing database; and a CodeMie UUID does not name
an OpenCode source row. Keeping those boundaries separate retains the existing v1 paths and avoids
duplicating the analytics pipeline for v2.

**V2 isolation classification.** A shared OpenCode service has its own configuration context; the
wrapper's per-run environment cannot configure a service that it did not start. A private server loads
the launch environment without terminating unrelated sessions. Add `--standalone` only where v2 accepts
it, preserving the existing isolation of `run`, `mini`, `api`, `models`, `stats`, `reload` and the
supported leaves under `auth`/`session` (not the bare groups). Pass `debug`, `mcp`, `plugin`, `upgrade/update`,
`uninstall`, `serve`, `service`, `acp` and `pair` through without that automatic flag. Root TUI isolation
requires no positional command or an
existing directory argument; unknown words are not guessed as TUI. Skip leading root option values
when identifying commands, respect explicit server/standalone flags before `--`, and insert automatic
isolation before that separator. A directory named like a command can be passed explicitly after `--`.
Keep the v1 gate, legacy `ownedSubcommands`, task/effort/model mappings and native argument validation
unchanged. Private capability lists are not a new CLI ownership/feature integration.

Set the resolved-version marker before provider early returns, because isolation is needed independently
of whether this launch emits a provider block. V1 and version-probe fallback never receive automatic
`--standalone`. Preserve an explicit `--server` selection instead of combining incompatible server modes.

## 4. Config emission

`injectV2Config()` delivers every v2 config through the unified strategy
(inline primary, temp-file fallback). Branches:

- **SSO/proxy:** native `providers.codemie-proxy` block with the emitted model
  catalogue, `share: 'disabled'`, `model` as `provider/model`.
- **Ollama:** endpoint-only native block, `package` = the chat package, no `models`
  map. Inventory is *not* served by that package: v2 ships no `ollama` provider in
  `packages/ai/src/providers/`, and the openai-compatible package exposes only `configure` / `model` /
  `routes`. Inventory comes from the bundled discovery plugin `packages/core/src/plugin/provider/ollama.ts`,
  which reads the declared `providers.ollama.settings.baseURL`, strips a `/v1` or `/api` suffix,
  enumerates `/api/tags`, enriches each entry with `/api/show`, and keeps only models whose capabilities
  include `completion`. Requests are bounded to 1s in the reference discovery implementation. Its
  transform contributes no models when none load, so an unavailable endpoint leaves the provider
  model-less; the allowlist prevents substitution with an unrelated provider.
- **Bedrock:** a native v2 block. v2 registers
  `@opencode/ai/providers/amazon-bedrock` as a built-in provider whose settings accept
  `apiKey`, `auth`, `baseURL`, `credentials`, `profile`, `region`
  in `packages/ai/src/providers/amazon-bedrock.ts`. Region falls back through the AWS environment
  (`AWS_REGION`, `AWS_DEFAULT_REGION`, then `us-east-1`) and credentials fall back to the AWS default chain
  when omitted, so the env the Bedrock provider plugin already sets keeps
  working and the wrapper can declare `region` without embedding credentials. The selected model is emitted as an explicit
  `models` entry so the `model:` reference resolves without depending on which models a particular
  bundled catalogue includes.

**Reasoning effort on v2.** The v2 `run` command does not accept `--variant`, so the central cli-flag
injection must not use it. Effort is defined in config variants and selected through a model reference:
- **SSO/proxy:** the branch declares per-model `variants` entries (body overlays only) on
  reasoning-capable models — `reasoning_effort` for chat-completions, `reasoning.effort` for
  Responses. Both openai-compatible packages forward `body` into the request payload
  (`http.body`), and v2 deep-merges variant overlays. Variants are emitted whenever the converted model
  metadata marks it reasoning-capable, independently of startup effort, so interactive selection is
  available without first requesting a level. Large catalogues use the file fallback instead of dropping
  variants or capabilities to fit the 32 KiB inline budget. When startup effort is requested, the selected
  reference gains `#<level>` and `enrichArgs` supplies `-m <ref>` on the `run` path. A config default alone
  is not sufficient proof that a session or run selects the variant.
  The `shouldApply` gate in `BaseAgentAdapter` delegates version-specific flag policy to the plugin.
  It skips automatic `--variant` on v2 and reports success only when the final `run` argv selects the
  prepared reference. Explicit model flags take precedence; a different final selection produces a
  warning rather than a false "effort applied" result. Handoff markers are cleared before each launch.
  The v1 flag path is retained, and a manually supplied unsupported v2 `--variant` is warned about, not
  silently removed. Automatic startup effort for bare TUI/resume is not guaranteed by catalogue emission.
- **Bedrock:** the `amazon-bedrock` package's Converse route is driven through
  `additionalModelRequestFields`. The variant shape follows the `bedrockConverse` protocol:
  Claude 4.6+ gets `output_config.effort` next to adaptive thinking, Claude
  3.7 / 4.0–4.5 get `settings.thinking.budgetTokens` (the one typed setting the package
  accepts). Canonical variant IDs use the same `#<level>` suffix plus `-m <ref>` handoff as the proxy.
  Reasoning cannot be gated on `modelConfig.reasoning` (a Bedrock id starts with `us.anthropic.`, so `getModelConfig()`
  misses the `claude` family prefix and reports `reasoning: false`). The generic
  `{ context: 128000, output: 4096 }` fallback would also clamp the thinking budget to 2048 through
  `fitThinkingBudget`, so recognized Claude models receive model-generation limits from the
  AWS Bedrock model cards (not the Claude API pages, which differ for Sonnet 4.6):
  200k / 64k for Sonnet 4, Sonnet 4.5, Opus 4.5, Haiku 4.5; 200k / 32k for
  Opus 4.1; 1M / 64k for Sonnet 4.6; 1M / 128k for Opus 4.6+ and Sonnet 5 / Opus 5. Sonnet 4
  gets budget-based thinking like the other 4.0–4.5 models. `xhigh` is not supported by
  Sonnet 4.6 on Bedrock (AWS adaptive-thinking table), so it is downgraded to `high` with a
  warning.
  Non-Claude Bedrock models stay out of scope for effort: `toBedrockModelId()` preserves
  their IDs, but OpenCode's generic `reasoningConfig` overlay
  is unverified for them, so effort warns and skips.

  Manual-thinking variants use budgets of 1024/4096/8192/16000/24000/32000 tokens for
  minimal/low/medium/high/xhigh/max. Adaptive variants use low/low/medium/high/xhigh/max; the explicit
  Sonnet 4.6 `xhigh` clamp is applied before emission. Bedrock variants are currently emitted only when
  startup effort is requested for a recognized, supported Claude model. The generic treatment of other
  adaptive generations/levels is not an independently certified per-model capability table.
- **Ollama: known limitation, do not implement.** The branch is endpoint-only by construction:
  inventory belongs to the bundled discovery plugin (which recreates model entries at runtime)
  and a successful discovery overwrites `provider.settings`, so neither pre-declared `variants`
  nor provider-level body overlays survive. Effort on ollama-v2 warns and skips by design.

**Provider allowlist.** Each v2 branch enables exactly its declared provider. Otherwise an unavailable
model can resolve to an unrelated provider's default, hiding a configuration/routing failure. This
restriction also keeps unrelated catalogue providers out of the picker. It does not forbid fallback to
another model within the selected provider. A provider with no available models produces a model-resolution
error; a missing root default alone does not. V1 retains its existing multi-provider allowlist.

**Missing proxy model policy.** In the v2 proxy branch, a selected model absent
from the emitted catalogue aborts before OpenCode is spawned, with `ConfigurationError` and guidance to
select an available model. This applies equally to explicit CLI/env choices and persisted profile defaults:
no automatic replacement is allowed. The wrapper does not declare a synthetic model from
`getModelConfig()` just to make the reference resolve. On rejection it stops the launch's incremental
sync timer, and the adapter stops its already-started proxy while preserving the configuration error.
It does not discover a transcript for a child that never started. Existing catalogue-fetch fallback to
static configs is retained; membership there does not certify backend availability. This correction leaves
v1 emission, full-selector/resume semantics, and the direct Ollama/Bedrock branches unchanged.

The error includes the profile name when available and source-specific recovery using the existing
`CODEMIE_MODEL_SOURCE` marker. CLI users must correct `--model`; env users must update or unset
`CODEMIE_MODEL`, which overrides the profile. A saved default is changed through `codemie setup` →
**Update an existing profile** → the named profile → select and save an available model. The message
distinguishes that persistent change from a one-run `--profile <profile-name> --model <model-id>` override,
requires bare catalogue IDs because the wrapper does not implement full-selector parsing, and states
that `codemie models list` uses only the active profile. Missing provenance is reported as unknown
instead of guessed as a profile default.

Proxy v2 model entries include `{name, capabilities, limit?, package?}` alongside existing cost/variants
metadata — no `modelID`, correct by construction per §2. In both chat-completions and Responses loops,
`capabilities.tools` preserves `tool_call` (including `false`), and `capabilities.input`/`output` preserve
`modalities.input`/`output`. Explicit metadata overrides OpenCode's custom-model tools/image defaults;
it does not add a capability inference policy or change the catalogue, v1 model shape, reasoning,
limits, pricing or direct-provider branches.

**Pricing metadata.** Both proxy loops preserve converted input/output prices and optional cache-read
prices in the v2 `cost` shape. API rates are converted from $/token to $/million once in
`convertApiModelToOpenCodeConfig()`; emission must not scale them again. Without these rates, a custom
model's cost estimate can appear as zero even when usage is charged. Cache-write price conversion is not
implemented. Catalogue prices are estimates, not proof of actual billing; existing session costs are not
recalculated and historical records are not backfilled.

**Shared Bedrock model-ID policy.** Keep `us.` when no region is supplied,
preserving the existing v1 and built-in agent geography policy. Explicit regions and already-qualified
IDs/ARNs remain authoritative, including an explicitly selected `global.` profile. The necessary ID and
suffix corrections do not imply switching the shared default to global routing. Explicit regions select
their mapped geography; no version suffix is invented, and bare non-Claude IDs are not assigned an
inferred provider. AWS model IDs have model-specific suffixes, so an unconditional `-v1:0` would corrupt
valid identifiers. Callers must supply any suffix their selected model actually requires.

## 5. File layout

```
src/agents/plugins/opencode/
├── opencode.plugin.ts                 # schema probe, provider emission, effort handoff, isolation
├── opencode-model-configs.ts          # static catalogue and getModelConfig() fallback
├── opencode-dynamic-models.ts         # catalogue conversion, routing and pricing units
├── opencode.paths.ts                  # binary/env-aware database resolution and fallback
├── opencode.sqlite-reader.ts          # layout detection and source-data translation
├── opencode.session.ts                # discovery, exact source selection and parsing
├── opencode.storage-utils.ts          # part ownership filtering and backend ordering
├── session/processors/                # existing metrics/conversation contracts
└── __tests__/
    ├── opencode-config-version.test.ts
    ├── opencode-config-size-fallback.test.ts
    ├── opencode-v2-emission.test.ts
    ├── opencode-v2-effort.test.ts
    ├── opencode-v2-bedrock-effort.test.ts
    ├── opencode-paths.test.ts
    ├── opencode-session-source.test.ts
    ├── opencode-sqlite-reader.test.ts
    ├── opencode-sqlite-cli-fallback.test.ts
    ├── opencode-sqlite-windows-paths.test.ts
    └── opencode-standalone-classification.test.ts
src/agents/plugins/codemie-code-hooks/  # shared runtime and v1/v2 host adapters
src/agents/plugins/codemie-code.plugin.ts             # built-in binary/storage/source-ID context
src/agents/core/plugin-injector.ts                    # file and directory plugin URLs
src/agents/core/BaseAgentAdapter.ts                   # effort veto and early proxy cleanup
src/providers/plugins/bedrock/bedrock.utils.ts        # shared model-ID qualification
src/cli/commands/hook.ts                             # extraction-only source-ID override
src/cli/commands/opencode-metrics.ts                  # SQLite-aware manual processing
src/utils/mcp-config.ts                              # JSONC and ordered schema alternatives
```

## 6. Model classification

| Model ID shape | Endpoint | Decided by | Notes |
|---|---|---|---|
| Listed GPT-5.2, GPT-5.1/5.3 Codex, GPT-5.4/5.5/5.6 and GPT-6 deployment-name patterns | `POST /v1/responses` (per-model `package` override) | `RESPONSES_API_MODEL_PATTERNS` | Dotted/hyphenated naming and supported provider-prefixed forms; excludes accidental two-digit-major matches |
| Unknown future Responses-only ID (misses the patterns) | `POST /v1/responses` | Family heuristic in `isResponsesApiModel()`: a `gpt-<major>` ID whose single-digit major is at or beyond the lowest explicitly listed major (6) is treated as Responses-only | Closes the silent misroute: such an ID is otherwise emitted without the `/responses` override and fails at request time |
| Everything else (`gpt-4*`, `o1/o3/o4*`, `claude-*`, `gemini-*`, …) | `POST /v1/chat/completions` | Default (no override) | Unchanged |

The heuristic belongs in `isResponsesApiModel()`, not in `getModelConfig()`: only converted catalogue
entries feed the chat/Responses split. Setting a routing flag on a fallback used for provider options and
the selected reference cannot change those groups. Keeping the decision at conversion avoids an inert
flag that would imply a routing guarantee without influencing the emitted configuration.

One implementation constraint: `opencode-dynamic-models.ts` already imports
`opencode-model-configs.ts`, so the check must not import it back. Placing the heuristic inside
`opencode-dynamic-models.ts` is naturally cycle-free. The VS Code connector keeps its own classifier rather
than importing this agent-specific implementation. Name-based routing is a compatibility heuristic, not
backend capability discovery.

## 7. Session storage schema

### Database selection and runtime context

`resolveOpenCodeDbPath()` resolves the database before checking whether it exists. A first launch may
not have written the file yet, and a SQLite-only installation may have no legacy `storage/` directory.
Gating resolution on those files would leave hooks without a usable transcript path.

`OpenCodePathContext` carries the metadata command, child environment and optional legacy data directory:

- Run the actual command with `debug paths db`, a 3s timeout and the launch's environment. The CLI reports
  its compiled release-channel path; directory recency cannot identify the correct channel. This command
  does not start a server or open the database.
- Respect absolute `OPENCODE_DB` and `:memory:` without a binary probe. Let the actual binary resolve a
  relative override under its data root instead of applying a platform guess first.
- Do not replace the child's `XDG_DATA_HOME` with a legacy fallback. V2 uses `XDG_DATA_HOME/opencode`,
  or `~/.local/share/opencode`, across platforms; legacy/file fallbacks retain their existing macOS and
  Windows locations. An optional `dataDir` selects fallback only, not the probe environment.
- Cache successful path probes for five minutes and unverified fallbacks for 30 seconds. Keys include
  command, cwd and path-affecting environment values, not credentials/config content. Different binaries
  or roots must not reuse each other's cached result. A failed probe does not certify channel selection.
- `getOpenCodeDbPath()` checks existence for discovery; `beforeRun` also retains the resolved path for
  first-write hooks. An in-memory database is not presented as a file transcript.

The built-in agent uses its own resolved binary and deliberate
`XDG_DATA_HOME=<codemie-home>/opencode-storage` redirect. SessionEnd passes that same context into the
adapter instead of temporarily changing/deleting the parent's `OPENCODE_STORAGE_PATH`. This avoids
reading standalone OpenCode storage and avoids modifying another caller's environment.

### Source identity and session lookup

An OpenCode database holds many sessions; its path does not identify a conversation. A CodeMie lifecycle
UUID and an OpenCode source `ses_*` ID have different purposes and must not be interchanged:

- OpenCode and the built-in agent discover a cwd-filtered descriptor and retain both its path and source
  ID. `HookProcessingConfig.sourceSessionId` overrides only the extraction identity.
- Lifecycle `event.session_id`, output/spool identity and API start/end correlation remain unchanged.
  No attribution header or authoritative API identity is rewritten by the source lookup.
- The adapter uses an exact SQL predicate when a source ID is known, without a creation-age cutoff.
  Missing explicit IDs fail rather than selecting another conversation. Native hooks retain their event
  source ID when no programmatic override is supplied.
- `codemie opencode-metrics` accepts database-only storage. `--session` checks the exact requested ID;
  legacy files are searched only after a successful database query finds no match, not after a read
  failure. `--discover` passes each descriptor's source ID to parsing.

Newest-within-cwd discovery remains a heuristic when no exact ID is available. This design does not
guarantee correlation for every concurrent/resumed session or redesign that discovery policy.

### Layout and message translation

The reader opens the user's live database read-only, so layout detection must be cheap and cached. Detect
from `sqlite_master` once per database path, and key the cache on that path.

| Concern | OpenCode 1.x | OpenCode 2.x |
|---|---|---|
| Sessions | `session` | `session_v2` |
| Messages | `message` (`data.role`) | `session_message` (`type` column) |
| Parts | `part` table, one row per part | no table; nested in the message row |
| Ordering | implicit, sorted in JS | `seq` column available |

- `session_v2` is a superset of the columns the reader selects (`id`, `project_id`, `slug`, `directory`,
   `title`, `version`, `time_created`, `time_updated`), so the session query is a table-name substitution;
   it additionally carries per-session `cost` / `tokens_*` / `time_idle` columns that a later change may use.
- **Windows paths:** for detected v2 layout on Windows, normalize cwd separators to `/` before
  binding the SQL predicate, matching upstream `database/path.ts` storage representation. Returned v2
  drive/UNC directory paths convert back to native `\`, matching upstream `fromDriver`, so existing
  filesystem consumers such as the timer's `safeRealpath` receive comparable paths. Leave v1/file
  representations, POSIX paths and empty legacy directories unchanged; no case folding, broader
  discovery, source-ID fallback or database write is introduced. The gate uses layout, not binary version.
- `session_message` rows are `(id, session_id, type, seq, time_created, time_updated, data)`. Role comes from
  `type`, not from `data.role`, and only `user` and `assistant` rows are messages — the type column also
  carries `idle`, `system`, `shell`, `synthetic`, `agent-switched` and `model-switched` rows, which must be
  skipped.
- Message field mapping:
  - `type='user'` → `data` carries `{time:{created}, text, files, agents[]}`; there is no per-message
    model, so `model` stays unset rather than fabricated; an agent name is read from available mentions.
  - `type='assistant'` → `data` carries `{time:{created, streamed, completed}, agent, model:{id, providerID,
    variant}, content[], finish, rawFinish, cost, tokens}`; the v1 flat `providerID` / `modelID` map from
    `model.providerID` / `model.id`, and `completed` maps onto the existing `time.completed`.
- Parts are read from `data.content[]` of the same rows rather than a second query: entries are
  `{type:'text', text}` or `{type:'tool', id, name, executed, state:{status, input, content[], metadata}}`.
  A tool entry therefore needs translation onto `OpenCodeToolPart` — `callID` from `id`, `tool` from `name`,
  and the rendered output assembled from `state.content[].text` into `state.output` (v2 returns a content
  list, not a single output string). v2 stores no per-part id, so parts get a stable synthetic id derived
  from message id and content index; `messageID` / `sessionID` / `type` are filled in as before.
- **User prompts:** normalize user `data.text` into a real text part with stable `<messageId>:0` identity.
  A generated ID must not mark the prompt `synthetic`, because downstream processors would exclude it.
- **Part order:** preloaded parts preserve backend/content order after ownership filtering. Sorting v2
  synthetic IDs as strings would put index 10 before index 2 and reorder the conversation. Legacy files
  retain their ID ordering; the shared message contract retains creation-time ordering.
- **Errors:** translate assistant `{type, message}` into `{name, data: {message}}`; retain tool-error
  strings and structured messages. Existing error metrics should not lose data because nesting changed.
- **File operations:** the existing metrics processor also accepts v2 `metadata.files[]`
  (`file`, `patch`, `additions`, `deletions`, `status`) for `edit` and `patch/apply_patch`. Map file statuses
  `added/deleted/modified` to the existing `write/delete/edit` operations and `file` to `path`. Prefer
  supplied nonnegative integer counts, preserving zero; use the existing diff counter only as the
  fallback for absent/invalid counts. Legacy patch paths/types and edit `filediff/diff` retain precedence.
  Keep raw reader metadata, the delta/API shape, record IDs, dedup and all other tool behavior unchanged;
  do not backfill historical deltas as part of this correction.
- **Read failures:** native `node:sqlite` on supported runtimes and the `sqlite3` CLI fallback use readonly
  access. Missing/unrecognized schemas and failed queries raise `AnalyticsSourceError`; an empty successful
  query is distinct from an unreadable source. Discovery logs a warning and can try legacy files, while
  exact manual lookup surfaces read failures. Malformed individual JSON rows are skipped with debug logs.
- Layout branching stays within `opencode.sqlite-reader.ts`; the session adapter and manual metrics
  command consume its common contracts. Aggregate token/cost columns are not added to the metrics payload.

## 8. Telemetry hooks

### Host-specific registration and shared execution

V1 loads a single `.ts` plugin URL and a dotted-key handler map. V2 requires a plugin directory and
`Plugin.define` with domain hooks and an event subscription. Only the packaging registered by the selected
config schema is materialized. `OPENCODE_HOOKS` remains the configuration channel read by the CodeMie
payload itself; it is not a native v2 hook-registration mechanism.

`shell-hooks-common-source.ts` supplies both payloads with one matcher, config loader, command resolver,
sync/async executor, response parser and idle deduplication implementation. Each host adapter supplies its
own registration, session-ID extraction and runner. Keeping shared behavior in one embedded body avoids
version-specific escaping drift: a matcher such as `Edit|Write` must behave identically in both payloads.
The host import remains host-specific, so the v1 payload does not require the v2 plugin API.

### Event mapping

| OpenCode operation/event | CodeMie hook | Reason |
|---|---|---|
| Prompt admission | `UserPromptSubmit` | Real user input is a turn boundary, not every model continuation |
| Tool before/after/error hooks | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | Preserve the existing tool hooks and response handling |
| Compaction hook | `PreCompact` | Preserve the existing compaction hook contract |
| `session.execution.succeeded/failed/interrupted` | `Stop` | Durable execution lifecycle supplies v2 turn boundaries; repeated idle boundaries are collapsed |
| `session.execution.failed` | `Notification` with `data.error.message` | Error notification must not depend on the legacy `session.error` event or be collapsed with repeated Stop events |
| Wrapper process start/exit | `SessionStart`, `SessionEnd` | Native session creation/deletion is not the same as CLI process lifecycle |

The v2 bus mapping retains legacy idle/status/error alternatives as compatibility fallbacks. A failed
execution can emit both Stop and Notification; subsequent execution-start events reset idle state.
The event subscription is cancelled when the plugin unloads.

### Shell portability and delivery boundaries

Async delivery does not assume `sh` exists. POSIX uses `shell: true`; Windows prefers a POSIX `sh` found
on PATH for bash-syntax commands and otherwise uses the platform shell. Without this fallback a stock
Windows installation would fail to spawn the hook. Detachment is POSIX-only because detached shell
execution can leave `cmd.exe` hanging; `unref()` and ignored stdout/stderr keep async hooks from holding
the host open. Child/stdin error guards make spawn or broken-pipe failures non-blocking for the session.

Turn hooks parse the resolved transcript path from §7 and write existing JSONL deltas; incremental sync
and process-exit finalization use the same session adapter. Correct event delivery and correct source
selection are both necessary for analytics. Neither hook registration nor a generated config alone
proves a complete live delivery/upload cycle.

Both plugin cleanup functions run in SessionEnd's `finally`. File and directory URLs use
`pathToFileURL(...).href` rather than concatenating `file://`, preserving Windows drives and encoding
spaces, `#` and `%`. Fixed temporary-directory ownership and signal-specific cleanup guarantees are not
redesigned by these packaging/URL corrections.

### MCP metadata compatibility

MCP analytics accepts ordered `mcp.servers` and `mcp` alternatives for native v2 and legacy documents.
The first object wins, including an empty map, so empty native configuration is not reinterpreted as
wrapper metadata. JSONC parsing uses `jsonc-parser` and rejects parse errors instead of stripping comments
with text substitution. These shared helpers preserve metadata across schema variants without changing
the launched MCP servers.

## 9. Error handling

| Scenario | Behavior |
|---|---|
| Version probe fails (missing binary, hung `--version`, nonzero exit, empty/malformed version response) | Warn and fall back to v1 rather than blocking startup; cache failure for 30 seconds, not as a five-minute successful probe. Response-validation warnings do not echo stdout/stderr |
| Selected v2 proxy model is absent from the emitted catalogue (CLI/env or profile default) | Throw `ConfigurationError` before spawning OpenCode; stop the launch timer and proxy, do not substitute a model or discover another session's transcript |
| `CODEMIE_OPENCODE_CONFIG_VERSION=1\|2` is set | Explicit override wins over probe result and cache |
| Ollama endpoint unreachable, or no model reports the `completion` capability | The v2 discovery plugin contributes zero models, the provider stays model-less, and the allowlist turns that into an explicit "no model is available for session" error instead of a silent switch to another provider |
| Bedrock on a v2 binary | Native v2 block with `region` from the AWS environment; credentials resolve through the AWS default chain. If the provider package rejects the emitted settings, the failure surfaces from OpenCode, not as a misconfiguration CodeMie hid |
| A deployment misses explicit Responses patterns | Apply the bounded single-digit GPT-major heuristic; other unmatched models retain the chat-completions default |
| Database path probe is unavailable or invalid | Use a 30-second unverified fallback without rewriting the child's XDG environment; do not claim that the release channel was detected |
| Database layout is neither the 1.x nor the 2.x shape | Reader throws `AnalyticsSourceError` naming the tables; discovery warns and may try files, while exact manual lookup surfaces the failure |
| A query fails on a detected layout | Try the supported readonly backends, then throw `AnalyticsSourceError`; never report a failed query as an empty successful result |
| An explicit source session ID has no database row | Fail the lookup; do not select another conversation or apply the discovery age window |
| Emitted config exceeds the env size limit | Temp-file fallback via `OPENCODE_CONFIG` (same rule for v1 and v2) |
| `--reasoning-effort` on v2 proxy with a reasoning-capable model | Configure variants and the prepared model reference; skip automatic `--variant`, and report application only when final `run` argv selects that reference |
| `--reasoning-effort` on v2 Bedrock with supported Claude thinking | Emit the model-specific budget/adaptive variant and use the same final model-reference handoff |
| Effort is unsupported or a different explicit model wins | Warn and continue without claiming effort delivery; never automatically inject the unsupported v2 `--variant` |
| Hook subprocess cannot spawn or stdin breaks | Async guards keep the failure non-blocking; turn telemetry may be missing |
| v2 plugin cannot load | Loading/error behavior belongs to OpenCode; the wrapper does not substitute a v1 plugin or guarantee complete telemetry |

## 10. Out of scope

- Changing `codemie install opencode` to install OpenCode v2 by default. The command continues to install
  v1 via `opencode-ai`; v2 runtime support and default-version installation policy are separate concerns.
- Global `minimumSupportedVersion` enforcement and process-scanning doctor diagnostics are independent
  concerns, not required runtime configuration/session adaptation. They are not part of this design.
- Full `provider/model#variant` parsing in the wrapper, explicit model changes on resume and broader v2
  CLI ownership/feature integration are not implemented by the narrow isolation/effort changes.
- General external inline/file precedence is unchanged. Large-file fallback is not a redesign of
  inherited configuration ownership and cannot guarantee which external override will take precedence.
- Reasoning effort on Ollama and non-Claude Bedrock models remains unsupported. Proxy reasoning metadata
  and generic adaptive Bedrock levels are not certified capability declarations for every deployment.
- Cache-write pricing, authoritative proxy limit discovery, aggregate `session_v2` token/cost payloads,
  actual billing verification and historical metric/cost backfill are not implemented here.
- File/SQLite discovery policy, concurrent session correlation and mutable-history conversation
  checkpoint behavior are not redesigned. Exact source-ID handling does not solve every discovery case.
- A SQLite-only database still requires a working native or CLI reader backend. Availability diagnostics
  for a runtime with neither backend are outside this adaptation; file fallback does not prove SQLite access.
- Temporary plugin ownership across concurrent launches and guaranteed SIGINT cleanup remain separate
  concerns. Ordinary finally/exit cleanup and portable URLs do not establish those guarantees.
- The Responses heuristic remains in `opencode-dynamic-models.ts`; reverse imports into static model
  configs or agent-specific imports into the VS Code classifier would create unnecessary coupling.

## 11. Verification

### Automated evidence

| Environment/check | Result |
|---|---|
| Local Linux, Node 24.22.0: full unit project | 5586 passed, 367 files, no skipped tests |
| Local Linux, Node 24.22.0: full CLI project | 278 passed, 10 skipped, 38 files |
| Commitlint, license-check, lint, typecheck, build | Passed; lint has zero warnings |
| CI Ubuntu and Windows, Node 20: unit and CLI projects | Passed |
| CI commit messages/PR title, build and Gitleaks | Passed |

The ten local CLI skips are nine authenticated skills cases without SSO and one opt-in VS Code live
certification case. Skipped cases are not passed executions. The live agent suite was not run.
CI evidence: [automated validation](https://github.com/codemie-ai/codemie-code/actions/runs/38715615203).
Local stages were executed separately; a fresh local dependency installation and repository-wide
coverage measurement are not claimed.

Behavioral regression coverage includes:

- Schema overrides, version validation/quoting, success/failure TTLs and size fallback.
- Native provider emission, capabilities/pricing fields, missing-model rejection and final effort selection.
- Actual binary/env path selection, exact source identity and early proxy/timer cleanup.
- Real SQLite fixtures for both layouts, user text, structured errors, part order and v2 file operations;
  forced CLI-fallback behavior and simulated Windows path conversion.
- v1 flag/config behavior, v2 standalone command classification, shared matcher behavior and embedded
  v1/v2 hook payload delivery with a stubbed host plugin API.
- MCP JSONC/schema alternatives and portable file/directory plugin URLs.

Native SQLite fixture tests are runtime-gated: success of the Node 20 suite is not evidence that native
`node:sqlite` exists there. Likewise, passing shell/Windows-path fixtures is not a live OpenCode launch.

### Manual live smoke check

- [x] OpenCode v2 successfully launched through CodeMie with the generated v2 configuration.

This is a user-confirmed manual check of the v2 config/launch integration, not only a config-shape
assertion. The local invocation currently uses a manually created `~/.local/bin/codemie-opencode` shim.
That launch path does not establish a default v2 installation through `codemie install opencode` and
does not change its v1 installation policy.

The smoke check confirms working startup for the exercised invocation. It is not a complete live
agent-suite run or proof of every provider, effort level, analytics upload and billing scenario.

### Remaining acceptance boundaries

The manual startup check and automated results do not establish the complete end-to-end provider/session
pipeline. Broader live acceptance must independently confirm that turn hooks reach the selected source
database, final
metrics/conversations upload correctly, and requested variants reach the provider. Bedrock model IDs,
caps and effort acceptance, Ollama discovery, bare-TUI/resume selection and actual sidebar cost behavior
are not certified by config emission tests. Retained v1 compatibility is covered by automated fixtures,
not a new live v1 launch. These are verification limits, not permission to expand the implementation scope.

## 12. References

- `src/agents/plugins/opencode/opencode.plugin.ts` — `resolveOpenCodeConfigVersion`, `injectV2Config`,
  `buildV2EffortVariants`, `buildV2BedrockEffortVariants`, provider lifecycle and argument enrichment.
- `src/agents/plugins/opencode/opencode.paths.ts` — `OpenCodePathContext`, `resolveOpenCodeDbPath`,
  `getOpenCodeDbPath`, fallback roots and cache keys.
- `src/agents/plugins/opencode/opencode.sqlite-reader.ts` — `detectDbLayout`, `queryDb`,
  `readSessionsFromDb`, `readMessagesFromDb`, `readAllPartsForSessionFromDb`, source-data normalization.
- `src/agents/plugins/opencode/opencode.session.ts` — `discoverSessions`, `parseSessionFromDb`,
  `selectSessionFromDb`; `src/agents/plugins/opencode/opencode.storage-utils.ts` — `loadPartsForMessage`.
- `src/agents/plugins/opencode/session/processors/` — metrics and conversation consumers.
- `src/agents/plugins/opencode/opencode-dynamic-models.ts` — `isResponsesApiModel`,
  `convertApiModelToOpenCodeConfig`; `src/agents/plugins/opencode/opencode-model-configs.ts` — static catalogue and fallback.
- `src/agents/plugins/codemie-code-hooks/` — shared embedded runtime, host adapters and injectors.
- `src/agents/plugins/codemie-code.plugin.ts` — built-in binary/storage/source identity context.
- `src/agents/core/types.ts`, `src/agents/core/BaseAgentAdapter.ts` — effort veto and early launch cleanup.
- `src/agents/core/plugin-injector.ts`, `src/utils/mcp-config.ts` — portable URLs and MCP schema parsing.
- `src/cli/commands/hook.ts`, `src/cli/commands/opencode-metrics.ts` — extraction identity and manual processing.
- `src/providers/plugins/bedrock/bedrock.utils.ts` — `toBedrockModelId`.
- [OpenCode v2 CLI](https://opencode.ai/v2/docs/cli),
  [models and variants](https://opencode.ai/v2/docs/models),
  [plugin API](https://opencode.ai/v2/docs/build/plugins) — upstream contracts.
- [AWS extended thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html),
  [adaptive thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html)
  and model-specific Bedrock cards — provider capability/limit references, not live acceptance evidence.
- `.ai-run/guides/integration/external-integrations.md`, `docs/COMMANDS.md` — integration documentation.
