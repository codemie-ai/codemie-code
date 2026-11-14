# Technical Research

**Task**: omp analytics codemie-omp pi
**Generated**: 2026-11-10
**Research path**: filesystem

---

## 1. Original Context

Full task text lives in `/tmp/omp-web-analytics/sdlc-task.md` (EPMCDME-17104). Verbatim essentials:

> EPMCDME-17104 — CLI Insights: report Oh My Pi (omp) sessions to web analytics as their own coding agent (codemie-omp)
>
> **Problem**: EPMCDME-16258 (CLI 0.16.7) made oh-my-pi (omp) sessions visible only in the local `codemie analytics --include-external` report. The web Analytics → CLI Insights tab never showed omp: native omp transcripts are never uploaded (only ledger-tracked transcripts of a managed run reach `POST /v1/metrics` and `/v1/conversations`), and omp model traffic through `codemie proxy connect --omp` was tagged `X-CodeMie-Client: codemie-daemon`, which the backend folds into the generic "CLI" client.
>
> **Scope (three repos)**: 1. codemie-code: managed `omp` agent (`codemie-omp`) modelled on the Pi plugin (run-ledger extension loaded with `-e`, incremental + end-of-session sync, ownership markers), uploading metrics and conversations with agent `omp` / client `codemie-omp`; `~/.omp` untouched; models routed through the run proxy via an extension-registered provider. 2. codemie-code: `codemie proxy connect --omp` daemon identity uses client type `codemie-omp` (CRITICAL attribution-header change). 3. backend: map `codemie-omp` → import source `omp`. 4. codemie-ui: `omp` import source labelled "Oh My Pi". 5. Docs in all three repos.
>
> **Acceptance**: `codemie-omp` run produces session/tool metrics with `codemie_client=codemie-omp`, `agent=omp`; omp subagent transcripts not uploaded as separate sessions; user's `~/.omp` not modified; `proxy connect --omp` traffic attributed to `codemie-omp`; synced omp conversations show "Oh My Pi"; `codemie-pi` behaviour unchanged.
>
> **State of THIS repository**: ALREADY IMPLEMENTED and committed on this branch; verified end to end. Run sdlc-light over existing work; research/plan describe this repo's slice as delivered; stage 4 verifies, does not re-implement; NEVER push, NEVER create MR/PR. Only this repo's slice is in scope.

Caller note: delivered changes = commits on the branch. NOTE: local `main` is stale, so `git log main..HEAD` lists ~20 unrelated upstream commits (and a 159-file diff incl. older task artifacts). The EPMCDME-17104 slice is exactly two commits: `f2382a07` and `74cb3acd`.

---

## 2. Codebase Findings

### Existing Implementations (delivered, per change area)

**A. Managed `omp` agent plugin** (`74cb3acd`) — `src/agents/plugins/omp/`
- `omp.plugin.ts` — `OmpPluginMetadata` (`name: 'omp'`, `displayName: 'Oh My Pi'`, npm `@oh-my-pi/pi-coding-agent`, supported 18.18.6, `ssoConfig.clientType: 'codemie-omp'`, `dataPaths.home: .omp`, `--task` → `-p`), `OmpPlugin extends BaseAgentAdapter` (session adapter = `PiSessionAdapter(OmpPluginMetadata)`, `getVersion()` parses `omp/<semver>`, `run()` applies `prepareOmpInvocation` translating `--resume <id>` → `--resume=<id>`). Lifecycle: `beforeRun` installs ledger + providers extensions, sets env; `enrichArgs` prepends `-e <ledger> -e <providers> --model <provider>/<model>` (no `--session-id`; ollama → `ollama` provider, else `classifyPiModel`); `onSessionStart/End` delegate to `startPiFamilySession`/`endPiFamilySession` (providers config removed in `finally`).
- `omp.extension.ts` — materializes extensions under `~/.codemie/omp/extensions/{codemie-metrics,codemie-providers}` (via `getCodemiePath`), writes per-run `~/.codemie/omp/providers/<sessionId>.json` with mode 0600 (+chmod), removes it at end. Env vars `CODEMIE_OMP_LEDGER_EXTENSION`, `CODEMIE_OMP_PROVIDERS_EXTENSION`, `CODEMIE_OMP_PROVIDERS`. `~/.omp` is never written.
- `extension/index.js` (+`package.json`, `README.md`) — plain-ESM omp extension; reads providers JSON defensively (node builtins only, whole body try/catch, per-provider try/catch, field whitelist, nothing logged) and calls `pi.registerProvider`.
- `index.ts` re-export; `bin/codemie-omp.js` entry; `package.json` bin `codemie-omp` + lint globs for `omp/extension/*.js`; `eslint.config.mjs` explicit block + un-ignore; `scripts/copy-plugins.js` copies the asset to `dist/` byte-identical; `install/windows/clidiag.ps1`.
- Registration: `src/agents/registry.ts` (`registerPlugin(new OmpPlugin())`), `src/agents/core/AgentCLI.ts` (`'omp': OmpPluginMetadata` in the metadata map).

**B. Pi machinery parameterized, Pi behaviour unchanged** (`74cb3acd`) — `src/agents/plugins/pi/`
- `pi.plugin.ts`: new exports `PiFamilyIdentity {agentName, clientType}`, `startPiFamilySession`, `endPiFamilySession`; `buildPiHookConfig(env, sessionId, identity = PI_IDENTITY)`; `correlateRunToSession(..., agentName)`. Pi's own hooks call the same functions with `PI_IDENTITY {pi, codemie-pi}`.
- `pi.extension.ts`: `DISABLE_ENV` exported, `getLedgerExtensionSourceDir()`, generic `installCodeMieExtension(targetDir, sourceDir, disabled)` (self-test load, removes on failure); `ensurePiCodeMieExtension` now delegates.
- `extension/index.js` (ledger): omp subagent skip — `isSubagent(ctx)` (`ctx.agent.kind === 'sub'`) guards `session_start`/`session_shutdown`, so subagent transcripts are never recorded or uploaded (acceptance criterion). Pi has no `ctx.agent`, so unaffected.
- `pi.models.ts`: `buildPiModelsConfig(env)` extracted + `PiModelsConfig` exported; `fetchAndBuildPiModels` writes it for Pi.
- `pi.session.ts`: `PiSessionAdapter.agentName = metadata.name`; conversations processor constructed with `{folder: 'omp', authorName: 'Oh My Pi'}` for non-pi.
- `session/processors/pi.conversations-processor.ts`: `PiConversationIdentity` (folder, author; thoughts authored `Oh My Pi` / `Oh My Pi Reasoning`), default `pi`/`Pi`.
- `pi.incremental-sync.ts`: upload `clientType` taken from `metadata.ssoConfig?.clientType` (default `codemie-pi`) instead of hard-coded.
- `src/agents/core/session/next-record-start.ts`: `omp` handled alongside `pi` for ledger-based same-transcript keys (`${agentName}:${path}`), uncached for both.

**C. Conversation folder** — `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts` `resolveConversationFolder`: `codemie-omp`/`omp` → folder `omp` (backend maps to import source "Oh My Pi" in the other repos).

**D. `proxy connect --omp` identity** (`f2382a07`, CRITICAL attribution change) — `src/cli/commands/proxy/connect-orchestrator.ts`: `'codemie-omp'` added to the client-type union and `DaemonIdentity`; `deriveDaemonIdentity` returns `{clientType:'codemie-omp', spawnOptions:{clientType:'codemie-omp'}}` for omp alone (priority order otherwise unchanged; `omp`+VS Code BYOK still rejected). A daemon recorded as `codemie-daemon` no longer matches in `daemonMatchesRequest`, so the existing mismatch path restarts it. `src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts`: `ALLOWED_AGENTS` gains `codemie-omp` (keeps Responses reasoning recovery for omp; `codemie-daemon` retained for `proxy start`).

**E. Analytics omp/pi mapping** — pre-existing from EPMCDME-16258, not modified by these commits: `src/cli/commands/analytics/cost/pi-agent.ts` (`OMP_AGENT='omp'`, maps `omp` back to the Pi adapter/readers), `native-loader.ts`. Reused as-is; the new managed agent reports under the same `omp` agent name.

**F. Docs/housekeeping** — `README.md` (omp section), `AGENTS.md` (plugin table: `omp` row, Pi row note), `CHANGELOG.md` (Added: managed launcher; Changed: attribution header), `docs/COMMANDS.md`, `docs/ARCHITECTURE-PROXY.md`, `docs/ANALYTICS-REPORT.md`.

### Architecture and Layers Affected
Agent plugin layer (`src/agents/plugins/omp`, `pi`), agent core/session (`next-record-start.ts`, `AgentCLI`, registry), session sync / SSO provider (conversation folder, incremental upload clientType), proxy layer (daemon identity, sanitizer plugin) via CLI command `proxy/connect-orchestrator`, build/packaging (`package.json`, `copy-plugins.js`, eslint), docs.

### Integration Points
- omp CLI (external binary `omp`, `CODEMIE_OMP_BIN` override) loaded with `-e` extensions; omp `registerProvider` API.
- CodeMie analytics endpoints (`/v1/metrics`, `/v1/conversations`) with `codemie_client=codemie-omp`; local SSO proxy / daemon header `X-CodeMie-Client`.
- Shared run ledger (`CODEMIE_PI_LEDGER`, `getPiRunLedgerPath`) between Pi and omp.
- Backend (`codemie`) and `codemie-ui` — out of scope here.

### Patterns and Conventions
Mirrors Pi: ledger-driven transcript ownership, incremental sync + end flush, CLI -> Registry -> Plugin, `getCodemiePath()` for paths, `.js` import extensions, `@/` alias, `logger`. Extension assets are plain ESM JS, copied not compiled, linted via explicit eslint block. `OtlpAgentAdapter` pattern is not used (managed launcher, not hooks-only).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, project-config, quality-gates; testing guides modified earlier on the branch). AGENTS.md notes no guide covers Pi/omp; design reference is `docs/superpowers/specs/2026-08-07-codemie-pi-design.md`. `docs/COMMANDS.md`, `docs/ARCHITECTURE-PROXY.md`, `docs/ANALYTICS-REPORT.md`, README and CHANGELOG are updated by the commits (see F).

### Architectural Decisions
Inline: omp extension header documents invariants (node builtins only, try/catch everywhere, untrusted JSON, no logging). `deriveDaemonIdentity` comment records why omp gets its own client type. Ledger header item 7 records subagent skip.

### Derived Conventions
Pi-family parameterization via `PiFamilyIdentity` / `PiConversationIdentity` / `metadata.ssoConfig.clientType` rather than forked code.

---

## 4. Testing Landscape

### Existing Coverage (Vitest)
- `src/agents/plugins/omp/__tests__/omp.identity.test.ts` — metadata, registry, hook config (omp, `CODEMIE_AGENT` override), mid-run upload as `codemie-omp`, Pi stays `pi`/`codemie-pi`, session adapter files conversations under `omp` / `Oh My Pi`.
- `omp.args.test.ts` — `-e` ordering, `--model provider/id`, ollama routing, no `--session-id`, `--task`→`-p`, `--resume` translation, missing-model error.
- `omp.extension.test.ts` — install under CodeMie home, kill switch, providers file 0600 + removal, `beforeRun` leaves omp dir untouched.
- `omp.providers-extension.test.ts` — registration, field whitelist, malformed/hostile input resilience.
- `pi/__tests__/pi.extension-asset.test.ts` — ledger subagent skip (`kind: 'sub'`) and main session still recorded.
- `pi/__tests__/pi.conversations-processor.test.ts` — default Pi vs omp identity (folder/author).
- `connect-orchestrator.test.ts` (modified in `f2382a07`) — `codemie-omp` identity derivation, spawn options, restart of a `codemie-daemon` daemon (`daemonMatchesRequest`), priority preserved.
- `agents/__tests__/registry.test.ts` — omp registered.
- Pre-existing, adjacent: `native-loader-pi.test.ts`, `agent-labels.test.ts`, `usage-readers.test.ts`, `pi.discovery.test.ts`, proxy `connectors/omp/*` tests.

### Testing Framework and Patterns
Vitest; dynamic imports after mocks, temp HOME fixtures, fake omp API objects for extension tests.

### Coverage Gaps
- No direct assertion that `codex-encrypted-content-sanitizer` accepts `codemie-omp` (the existing sanitizer test has no omp case).
- No direct test of the `omp` branch of `resolveConversationFolder` in `syncProcessor.ts` (covered indirectly via the adapter folder test only).
- `next-record-start.ts` omp branch (ledger keys, uncached) has no omp-specific case in `stale-session-reconciliation.test.ts`.
- `pi.incremental-sync` clientType parameterization is covered through omp.identity (mid-run upload test), not a dedicated Pi-default test.
- No test of `OmpPlugin.getVersion()` output parsing or the `bin/codemie-omp.js` entry. Real run verified end to end manually per task text.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_OMP_BIN` (omp binary override), `CODEMIE_OMP_LEDGER_EXTENSION`, `CODEMIE_OMP_PROVIDERS_EXTENSION`, `CODEMIE_OMP_PROVIDERS` (run-scoped, set by `beforeRun`), `CODEMIE_PI_LEDGER` / `CODEMIE_PI_EXTENSION_DISABLED` (shared with Pi; the latter also disables the omp ledger), `CODEMIE_OMP_BASE_URL` (proxy connect, documented in COMMANDS.md), `CODEMIE_MODEL`, `CODEMIE_PROVIDER`, `CODEMIE_SESSION_ID`, `CODEMIE_AGENT`.

### Configuration Files
`package.json` (bin, lint scripts), `eslint.config.mjs`, `scripts/copy-plugins.js`; no new config schema; profiles use existing `supportedProviders: ai-run-sso, bearer-auth, litellm, ollama`.

### Feature Flags and Deployment Concerns
No flag for the agent; kill switch is the Pi ledger env. Providers JSON holds base URL/key (0600, deleted at end). Packaging: the asset must be copied to `dist/agents/plugins/omp/extension` (copy-plugins). The attribution change requires daemon restart for users with a running `codemie-daemon`; handled by mismatch path.

---

## 6. Risk Indicators

- CRITICAL attribution-header change: omp daemon traffic moves from `codemie-daemon` to `codemie-omp`; any backend/dashboard filter keyed on `codemie-daemon` for omp traffic changes. Backend/UI mapping lives in other repos; cross-repo ordering matters.
- The ledger extension and providers extension execute inside omp: a load failure can end the user session; mitigated by self-test, try/catch invariants, and the lint block.
- Pi functions were refactored (`pi.plugin.ts` ~270 changed lines, `pi.models.ts`, `pi.extension.ts`); "Pi unchanged" rests on existing Pi tests plus one `Pi stays Pi` test.
- omp has no `--session-id`; correlation relies wholly on the run ledger; a missing ledger yields lifecycle-only reporting.
- Subagent exclusion depends on omp exposing `ctx.agent.kind === 'sub'` (version-coupled to supported 18.18.6).
- Test gaps listed in Section 4 (sanitizer allow-list, conversation folder branch, next-record-start omp branch).
- Local `main` is stale; diffs vs `main` overstate the slice (159 files); scope by commits `f2382a07`, `74cb3acd`.
- Speculative: any additional work in this repo should be limited to filling the Section 4 gaps; no further implementation is indicated.

---

## 7. Summary for Complexity Assessment

The repo slice is delivered in two commits: `f2382a07` (proxy daemon identity -> `codemie-omp`, sanitizer allow-list, 4 files) and `74cb3acd` (managed omp plugin, 35 files, ~1250 insertions: new `src/agents/plugins/omp/` with plugin, extension materializer and a plain-JS omp extension, plus parameterization of the Pi modules, registry/CLI wiring, conversation folder mapping, packaging, docs). Layers touched: agent plugins, agent core/session, SSO session sync, proxy, CLI command, build tooling, docs.

Technical novelty is moderate: a second agent reuses Pi's ledger/sync machinery through identity parameters, and a new in-process omp extension loaded with `-e` must satisfy strict fail-safe invariants. The attribution change is behaviorally significant but a few lines of code.

Coverage is good: 4 new omp test files, 1 extended Pi asset test, extended Pi conversation test and connect-orchestrator tests, registry test. Small gaps: sanitizer allow-list, `syncProcessor` omp folder branch, `next-record-start` omp branch. Main risk is cross-repo attribution coordination, not in-repo complexity.

---

## 8. External References

None named by the task beyond the task file itself (`/tmp/omp-web-analytics/sdlc-task.md`, read; contents quoted in Section 1). Other repositories (backend, codemie-ui) were named only as out-of-scope.
