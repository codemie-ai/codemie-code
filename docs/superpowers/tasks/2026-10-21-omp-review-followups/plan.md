# omp connector review follow-ups — Implementation Plan

## Acceptance criteria

- [ ] The two providers stay: `codemie` (OpenAI wire, `<daemon>/v1`) and `codemie-claude` (Anthropic Messages, `<daemon>` root, `authHeader`). Why there are two is documented in code comments and in `docs/COMMANDS.md`.
- [ ] A model goes to `codemie-claude` when its id contains `claude` or `anthropic` (`sy-signal-claude-v1`, `anthropic.claude-*`, `us.anthropic.claude-*`), or when it is a router whose tier targets are all Claude. Every other model goes to `codemie`.
- [ ] Image-generation, `/embedding/i` and disabled deployments never appear in either roster.
- [ ] `reasoning` is true only for Claude, GPT-5 and later, o1/o3/o4 and Gemini, and false for everything else. A router counts as reasoning only if all of its tier targets do.
- [ ] A router with no `max_output_tokens` gets `maxTokens` = the minimum known cap among its tier targets (128,000 on the live catalog). 32,000 applies only when no tier cap is known. The docs state that 128,000 comes from metadata and is not a proven hard limit.
- [ ] `connect --omp --vscode` exits 1 with a `ConfigurationError`, before any profile resolution, daemon action or file write. `--omp` alone uses `codemie-daemon`. The other `--omp` combinations keep working.
- [ ] `codemie-daemon` daemons (`proxy start` and `--omp`) load the Codex encrypted-content sanitizer.
- [ ] Vitest covers the roster builder, extension runtime, installer, omp identity and conflict handling, and sanitizer scope.

**Goal:** close the adversarial-review findings and the user's four comments on the omp connector.
**Architecture:** the pure roster logic lives in `omp-models.ts` (bundled into the omp extension). The target policy is in `connect-orchestrator.ts`. Sanitizer scope is an allowlist.
**Tech Stack:** TypeScript ESM, Vitest, esbuild (`scripts/bundle-omp-extension.mjs`).
**Spec:** none. Requirements were given inline, and the research is in `technical-analysis.md` in this directory.

## Global Constraints

- Use `.js` import suffixes and the `@/` alias, no `any`, and `ConfigurationError` from `@/utils/errors.js`.
- `omp-models.ts` is inlined into the extension bundle, so it may import only **types** from `sso.http-client.js`. A runtime `isRouterModel` import would pull the HTTP client into the bundle.
- `LlmModel` already has `tiers` / `litellm_router.tiers` (`RouterTier`, `sso.http-client.ts:38-55,232,252`). Do not redeclare them.
- Commit per task using the repository's existing convention. Never stage `package.json`. Do not edit `openwiki/` or `docs/superpowers/**` outside this task dir.
- Tests assert what a consumer observes (rows, registered configs, files, exit codes, messages, request bodies), not internal wiring.

## Review Focus

1. A router where only some tiers have a known cap uses the minimum of the known caps (Task 1).
2. A router with no tier map is classified by its name (`sy-signal-claude-v2` → anthropic) (Task 1).
3. A router whose tiers mix Claude and GPT goes to `codemie` and never to Anthropic (Task 1).
4. A vendor-prefixed GPT id counts as reasoning (`openai.gpt-6-luna` → true) (Task 1).
5. `--omp --vscode --profile x` fails before profile resolution and has no side effects (Task 4).

---

### Task 1: Roster routing, filtering, reasoning, router caps

**Files:** modify `src/cli/commands/proxy/connectors/omp/omp-models.ts:25-83`. Create `src/cli/commands/proxy/connectors/omp/__tests__/omp-models.test.ts`. Modify `docs/COMMANDS.md:329-336`.
**Interfaces:** the signature `buildOmpModelRoster(models: readonly LlmModel[]): OmpModelRoster` stays the same.

Test-first: yes — `sy-signal-claude-v1`, a router whose tiers are all Claude, must land in `roster.anthropic`, but today it lands in `openai`.

- [ ] **Step 1: Write the failing tests.** Use a `model(overrides: Partial<LlmModel>)` fixture.
  - Routing (check both the roster and `api`):
    - `claude-sonnet-5`, `anthropic.claude-opus-4-7`, `us.anthropic.claude-haiku-4-5` → anthropic, `anthropic-messages`.
    - `gpt-5.6-sol-2026-07-09` → `openai-responses`.
    - `gpt-4.1` → `openai-completions`.
  - Routers:
    - Claude tiers, set either top-level or under `litellm_router.tiers` → anthropic.
    - `gpt-6-luna`/`gpt-6-sol` tiers → openai.
    - Mixed Claude and GPT tiers → openai.
    - `sy-signal-claude-v2` with no tiers → anthropic.
  - Exclusion: image-generation, `text-embedding-3-large`, `enabled: false`, a duplicate id (the first one is kept), and a row with neither an id nor a base name.
  - Cost: `1e-7` → `0.1`, `3e-6` → `3`, missing → `0`.
  - Limits:
    - `max_input_tokens` is passed through. When it is missing, use `128000`.
    - `max_output_tokens` is passed through.
    - A router with tier caps 128000 and 64000 → `64000`.
    - A router whose tiers are not in the catalog → `32000`.
    - A router with one known tier cap (100000) and one unknown tier → `100000`.
  - Reasoning true for: `claude-sonnet-5`, `gpt-5-2025-08-07`, `gpt-6-luna`, `openai.gpt-6-luna`, `o1`, `o3-mini`, `o4-mini-2025-04-16`, `gemini-3.1-pro`, and a GPT-tier router.
  - Reasoning false for: `gpt-4.1`, `qwen.qwen3-coder-30b-a3b-v1`, `grok-4.6`, `deepseek-v4-pro`, and a router with a `gpt-4.1` tier.
- [ ] **Step 2: Run** `npx vitest run src/cli/commands/proxy/connectors/omp/__tests__/omp-models.test.ts`. Expect FAIL on the router, vendor-prefix, embedding, reasoning and cap cases.
- [ ] **Step 3: Implement.**
  - Add the helpers below, with `RouterTier` as a type-only import.
  - Make `buildOmpModelRoster` two passes:
    - **Pass 1** builds `caps: Map<id, max_output_tokens>` over **all** rows (deployment_name and base_name), including disabled rows.
    - **Pass 2** keeps the existing filter and adds `NON_CHAT.test(id)`. Then:
      - `targets = tierTargets(model)`
      - `anthropic = targets.length ? targets.every(isClaudeFamily) : isClaudeFamily(id)`
      - `reasoning` uses the same `every`/fallback with `isReasoningFamily`
      - `maxTokens = model.max_output_tokens || routerOutputCap(targets, caps) || DEFAULT_MAX_OUTPUT_TOKENS`
  - `api` selection stays as it is.
  - Rewrite the `OmpModelRoster` doc to explain the two providers. An omp provider binds one `baseUrl`, one `api` and one auth mode. The OpenAI wire needs `<daemon>/v1` with a Bearer key, and the Anthropic wire needs the `<daemon>` root with `authHeader`. A per-model `api` override under one provider is unverified, because omp v18.12.3 types are not available locally.
  - Update the `DEFAULT_MAX_OUTPUT_TOKENS` comment to say that routers take their tier minimum first.

```ts
const CLAUDE_FAMILY = /claude|anthropic/i;
// Non-chat deployments (same convention as codex-model-resolver.ts INCOMPATIBLE_NAME_PATTERN).
const NON_CHAT = /embedding/i;
// The catalog has no reasoning flag; families known to accept reasoning effort. Unknown → false.
const REASONING_FAMILIES = [CLAUDE_FAMILY, /(?:^|[./])gpt-(?:[5-9]|[1-9]\d)/i, /(?:^|[./])o[134](?:-|$)/i, /gemini/i];
const isClaudeFamily = (id: string): boolean => CLAUDE_FAMILY.test(id);
const isReasoningFamily = (id: string): boolean => REASONING_FAMILIES.some((p) => p.test(id));

/** Distinct tier target ids of a Switchyard or LiteLLM router; `[]` for a plain model. */
function tierTargets(model: LlmModel): string[] {
  const tiers = model.tiers ?? model.litellm_router?.tiers;
  if (!tiers) return [];
  const ids = (Object.values(tiers) as (RouterTier | undefined)[]).map((t) => t?.model).filter((m): m is string => Boolean(m));
  return [...new Set(ids)];
}

/** Lowest known output cap across a router's tier targets; `undefined` when none is known. */
function routerOutputCap(targets: readonly string[], caps: ReadonlyMap<string, number>): number | undefined {
  const known = targets.map((t) => caps.get(t)).filter((c): c is number => c !== undefined);
  return known.length ? Math.min(...known) : undefined;
}
```

- [ ] **Step 4: Run** the same command and expect PASS.
- [ ] **Step 5: Update the docs.**
  - Table rows:
    - `codemie-claude` → "Claude deployments (id contains `claude` or `anthropic`) and routers whose tiers are all Claude".
    - `codemie` → "everything else".
  - After the table, add one sentence explaining why there are two providers.
  - Paragraph at :336:
    - Mention that embedding deployments are also excluded.
    - Add: "A router's `maxTokens` is the lowest `max_output_tokens` among its tier targets (128,000 on the current catalog). This value comes from metadata, and a `max_tokens: 128001` request was accepted, so it is not a proven hard limit. When no tier cap is known, 32,000 is used."

### Task 2: Extension runtime tests + two-provider header

**Files:** create `src/cli/commands/proxy/connectors/omp/__tests__/codemie-models.extension.test.ts`. Modify `codemie-models.extension.ts:1-15`, header comment only.
**Interfaces:** consumes the default export `codemieModels(pi)` without changes.

Test-first: no — these are characterization tests of existing behavior, and the only production change is a comment.

- [ ] **Step 1: Write the tests and the header paragraph.** The paragraph gives the same two-provider reasoning as Task 1. Then run `npx vitest run src/cli/commands/proxy/connectors/omp/__tests__/codemie-models.extension.test.ts` and expect PASS.
  - Setup:
    - Set `CODEMIE_HOME` to an `mkdtemp` dir containing `proxy-daemon.json` `{url:'http://127.0.0.1:4555', gatewayKey:'gk-test'}`.
    - `vi.stubGlobal('fetch', vi.fn())`.
    - Use a fake `pi.registerProvider` that records configs.
    - Restore env, globals and the `Date.now` spy in `afterEach`.
  - Cases:
    - **Registered configs:** `codemie` → `http://127.0.0.1:4555/v1`, `openai-completions`, `gk-test`. `codemie-claude` → root URL, `anthropic-messages`, `authHeader: true`.
    - **No state file:** falls back to `http://127.0.0.1:4001` with `codemie-proxy`.
    - **`CODEMIE_OMP_BASE_URL=http://127.0.0.1:9999/`:**
      - Both baseUrls use `:9999` with no trailing slash.
      - The catalog is still fetched from `:4555/v1/llm_models?include_all=true` with `Authorization: Bearer gk-test`.
    - **Family split:** each provider's `fetchDynamicModels` returns only its own family.
    - **Fetch reuse:** two back-to-back provider fetches make one `fetch`. Once `Date.now` is past 5 s, the next one fetches again.
    - **Errors:** each of these rejects with `ConfigurationError`:
      - 401 and 403 → `/codemie profile login/`
      - 500 → `/HTTP 500/`
      - 200 `text/html` → `/non-JSON/`
      - an object payload → `/unexpected payload/`
      - `fetch` rejecting → `/not reachable at http:\/\/127\.0\.0\.1:4555/`

### Task 3: Extension installer tests

**Files:** create `src/cli/commands/proxy/connectors/__tests__/omp.test.ts`.
**Interfaces:** consumes `getOmpExtensionPath`, `writeOmpExtension({ force? })` and `removeOmpExtension()` without changes.

Test-first: no — these are characterization tests of the existing installer, and there is no production change.

- [ ] **Step 1: Write the tests, then run** `npx vitest run src/cli/commands/proxy/connectors/__tests__/omp.test.ts` and expect PASS.
  - Setup:
    - `vi.mock('@/utils/paths.js', …importOriginal, getDirname: () => bundleRoot)`.
    - `bundleRoot` is an `mkdtemp` dir holding `omp/codemie-models.bundle.js` with the content `// codemie-managed: test\nexport default () => {};\n`.
    - Point `PI_CODING_AGENT_DIR` at a temp dir. Save and restore it and `PI_CONFIG_DIR`.
  - Cases:
    - **Path resolution:** `PI_CODING_AGENT_DIR` wins. Otherwise `PI_CONFIG_DIR=.omp-test` → `join(homedir(), '.omp-test', 'agent', 'extensions', 'codemie-models.js')`. With neither set, the default is `.omp`.
    - **Install:**
      - Fresh install → `changed: true` and the file content equals the bundle.
      - Identical file → `changed: false`.
      - Older CodeMie-owned copy (marker present) → replaced, `changed: true`.
    - **Foreign file:** rejects with `ConfigurationError` matching `/--force/` and the file is byte-identical afterwards. `{ force: true }` replaces it.
    - **Remove:**
      - File absent → `removed: false`.
      - CodeMie-owned file → deleted.
      - Foreign file → rejects with `ConfigurationError` and the file is kept.

### Task 4: Reject `--omp` + `--vscode`; simplify omp identity

**Files:**
- `src/cli/commands/proxy/connect-orchestrator.ts`: `:109-131` (JSDoc and `deriveDaemonIdentity`) and `:719-726` (after the `hasAnyTarget` block).
- `__tests__/connect-orchestrator.test.ts`: add `vi.mock('../connectors/omp.js', () => ({ writeOmpExtension: vi.fn() }))` and new describes.
- `docs/COMMANDS.md:340`.
- `CHANGELOG.md:14`.

**Interfaces:** `deriveDaemonIdentity` keeps its signature. `connectTargets` exits 1 when both `omp` and `vscode` are set.

Test-first: yes — `connectTargets({ targets: { omp: true, vscode: true }, profile: 'x' })` must reject `process.exit:1` without calling `ConfigLoader.load`. Today it spawns `vscode-byok`.

- [ ] **Step 1: Write the failing tests.** Reuse `spyConsole`, `setupHappyMocks` and `daemonState`.
  - **`omp` + `vscode`:**
    - Rejects with `process.exit:1`.
    - None of `ConfigLoader.load`, `checkStatus`, `spawnDaemon`, `writeVsCodeLanguageModelsConfig` or `writeOmpExtension` is called.
    - `console.error` contains `--omp cannot be combined with --vscode`.
  - **`omp` + `vscodeClaudeCode`:** with `spawnDaemon` returning `daemonState({ telemetryMode: 'claude-desktop' })` and `writeOmpExtension` returning `{ path: '/x', changed: true }`, both writers are called and `exitCode` is 0.
  - **New `describe('deriveDaemonIdentity — omp')`.** Keep this out of the existing `cases` table, so that table's "two identities" test stays valid.
    - `{omp}` → `codemie-daemon` (both `clientType` and `spawnOptions`).
    - `+claudeDesktop` or `+vscodeClaudeCode` → `claude-desktop`.
    - `+claudeCodeOtlp` → `claude-code-otlp`.
    - `+codexDesktop` → `codex-desktop`.
- [ ] **Step 2: Run** `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` and expect the conflict case to FAIL.
- [ ] **Step 3: Implement.** Insert this directly after the `hasAnyTarget` early return:

```ts
  // omp and VS Code BYOK need different daemon identities, and one daemon carries one.
  if (targets.omp && targets.vscode) {
    printProxyError(new ConfigurationError(
      '--omp cannot be combined with --vscode: they need different proxy identities and share one daemon.\n' +
      'Run `codemie proxy connect --omp` for oh-my-pi, or `codemie proxy connect --vscode` for VS Code.'
    ), 'Failed to connect proxy');
  }
```

  In `deriveDaemonIdentity`, change `targets.omp && !targets.vscode` to `targets.omp`. Update the JSDoc order to `` `codemie-daemon` (`omp`) > `vscode-byok` `` and note that `connectTargets` rejects `omp`+`vscode`. Leave disconnect alone: it has no `--vscode` flag and no identity.
- [ ] **Step 4: Run** the same command and expect PASS, with the existing suites still green.
- [ ] **Step 5: Update the docs.**
  - Replace `COMMANDS.md:340` with this paragraph:
    - `--omp` uses the generic `codemie-daemon` identity, the same as `proxy start`.
    - It cannot be combined with `--vscode`, because the two need different identities.
    - A later `connect --vscode` restarts the shared daemon as `vscode-byok`, and omp traffic carries that identity until `--omp` is re-run.
    - When `--omp` is combined with `--claude-desktop`/`--vscode-claude-code`, `--claude-code-otlp` or `--codex-desktop`, the daemon takes that target's identity (in this priority order).
  - In `CHANGELOG.md:14`, append "; it cannot be combined with `--vscode`".

### Task 5: Encrypted-content recovery for `codemie-daemon`

**Files:**
- `src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts:27-28,35-50`.
- Its `__tests__/codex-encrypted-content-sanitizer.plugin.test.ts:83-92`, plus a new describe near `:295`.
- `docs/ARCHITECTURE-PROXY.md:602`.
- `CHANGELOG.md` (Unreleased `### Fixed`).

**Interfaces:** none.

Test-first: yes — `createInterceptor(createPluginContext('codemie-daemon'))` currently rejects with `Plugin disabled for agent: codemie-daemon`.

- [ ] **Step 1: Write the failing tests.**
  - Add `'codemie-daemon'` to the Agent Scoping `it.each`.
  - Add `describe('Reasoning state removal once latched — codemie-daemon')`, mirroring the codemie-codex block. After `latchFallback`, `onRequest` on `{ model: 'gpt-6-luna', input: [{ type: 'reasoning', encrypted_content: 'xyz==' }] }` leaves `input` at length 0.
- [ ] **Step 2: Run** `npx vitest run src/providers/plugins/sso/proxy/plugins/__tests__/codex-encrypted-content-sanitizer.plugin.test.ts` and expect FAIL.
- [ ] **Step 3: Implement.** Add `'codemie-daemon'` to `ALLOWED_AGENTS` with a comment: it is the generic identity of `proxy start` and `connect --omp`, and omp replays Responses reasoning state for GPT-5.x/6. The plugin passes requests through until it sees a failure signature, so this change only adds recovery. Append `codemie-daemon` to the header `Scope:` line.
- [ ] **Step 4: Run** the same command and expect PASS.
- [ ] **Step 5: Update the docs.**
  - In ARCHITECTURE-PROXY §6.8 `:602`, add `codemie-daemon` (`proxy start` and `--omp`) to the self-healing identity list.
  - Under CHANGELOG `### Fixed`, add: "Encrypted reasoning-content recovery now also covers `codemie proxy start` and `codemie proxy connect --omp` daemons".

---

## Negative-constraint pass

- "remove … without breaking anything": Task 4 rejects only the `omp`+`vscode` pair. Its tests pin `omp` combined with `vscodeClaudeCode`, claude-desktop, otlp and codex.
- "Document the reasoning if update is not required" / "No merge": Tasks 1–2 add only comments and docs. Both providers stay.
- "avoid duplicate declarations": no task touches `LlmModel`.
- Bundle purity: Task 1 uses only type imports and local regexes.
- "do not edit openwiki/ or docs/superpowers/**": no task touches them.
- "never include package.json": stated in Global Constraints.
- "consumer-visible behavior, not wiring": every case asserts outputs, files, exit codes, messages or request bodies.
- Out of scope, unchanged: the same Claude-prefix rule in `src/agents/plugins/pi/pi.models.ts:33` and `opencode-dynamic-models.ts:27`.
