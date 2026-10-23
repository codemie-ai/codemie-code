# OpenCode v2 Support Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the OpenCode agent plugin work end-to-end on OpenCode 2.x: read the session database that v2
actually writes, emit a config each supported provider can actually use, and decide endpoint routing in the
one place where it is decided — per `docs/superpowers/specs/2026-10-07-opencode-v2-support-design.md`.

**Architecture:** Extend in place with version branching. `opencode.plugin.ts` probes `opencode --version`
once per process (`resolveOpenCodeConfigVersion()`, `:48`) and emits the matching shape via
`injectV2Config()` (`:96`); the v1 config block (`:517-566`) stays byte-identical. `opencode.sqlite-reader.ts`
detects the database layout at runtime and reads both the 1.x and the 2.x layouts through one typed mapping,
because the metrics pipeline is DB-backed and the v2 database was renamed and rebuilt.

**Tech Stack:** TypeScript, ES modules, Node.js ≥ 20. Verification against a live OpenCode 2.0.27 binary and
its live database; v2 sources at `/home/nk/opencode-v2.0.27/` are reference only (never edited).

> **On `file:line` references below:** they were accurate when each step was planned and executed, and are
> kept as the historical record. Several have since drifted because the same steps moved code around — the v2
> branches, the routing decision and the reader all changed shape. For current locations read the design spec
> (`docs/superpowers/specs/2026-10-07-opencode-v2-support-design.md` §5 and §12), which is re-verified against
> the tree.

## Global Constraints

- Node.js >= 20.0.0. On Node 20 `node:sqlite` is unavailable, so every reader query must keep working
  through the `sqlite3` CLI fallback.
- ES modules only; imports use `.js` extensions; `@/` alias for deep imports.
- No `console.log`; use `logger.debug()` / `logger.warn()`.
- Explicit return types on exports; no `any` (use `unknown` + narrowing).
- Plugin code must never be imported from `src/cli`; do not extract the Responses-pattern list into `src/utils/`.
- Read the database **read-only** — it is the user's live database, possibly being written concurrently.
- Tests are written and run **only on explicit user request** (`AGENTS.md` testing policy). Task 6 is gated
  on that request; Task 7 runs the existing suites only to prove nothing regressed.
- No `openwiki/` edits (generated). Local-only notes (`OV2_MEMORY.md`, `opencodev2_support_impl.md`,
  `ov2_report.md`) are never committed.
- Git operations (commit) only on explicit user request.
- Verification one-liners work without a build on Node 24 (native type stripping):
  `node -e "import('./src/agents/plugins/opencode/opencode.sqlite-reader.ts').then(...)"`.

---

## Task 0: Config-side delivery (already landed — record only)

**State:** shipped on `feat/opencode-v2-config`. Version probe with `getCommandPath()` + Windows `shell` +
3s timeout + warn-and-fallback; `injectV2Config()`; `share: 'disabled'` on both v2 branches; per-model
`/responses` package override; v2 hooks plugin directory; `opencode-config-version.test.ts`. Verified
against live 2.0.27: probe resolves `v2`, the config loads, Responses models reach `/responses`, hooks fire.

- [x] **No action.** Do not re-commit; the audit in `ov2_report.md` is the acceptance record for this task.

---

## Task 1: Session storage — read the v2 database layout (blocking)

**Files:**
- Modify: `src/agents/plugins/opencode/opencode.sqlite-reader.ts`
- Read-only reference: `src/agents/plugins/opencode/opencode.session.ts` (callers at `:202,212,215,485`)

**Interfaces:**
- Unchanged exports: `readSessionsFromDb`, `readMessagesFromDb`, `readAllPartsForSessionFromDb`,
  `isSqliteAvailable`, `getDbPathFromStorage`. All layout branching stays internal — the only caller is
  `opencode.session.ts`.
- New internal: a cached layout probe returning the session / message / part table names to use.

**Why this is first:** the v2 database has `session_v2` / `session_message` and no `part` table
(migration `ALTER TABLE session RENAME TO session_v2`). The reader queries `session` (`:212`), `message`
(`:257`) and `part` (`:327`), every failure is swallowed at `debug` level (`:89-91`, `:130-145`), so
discovery returns "no sessions" and every metric consumer stays empty while looking healthy.

- [x] **Step 1: Reproduce the empty read**

  ```bash
  node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.HOME+'/.local/share/opencode/opencode.db',{readOnly:true});console.log(db.prepare(\"select name from sqlite_master where type='table'\").all().map(r=>r.name).join(' '))"
  ```
  Expected: `session_v2 session_message event …` and no `session` / `message` / `part`.

  ```bash
  node -e "import('./src/agents/plugins/opencode/opencode.sqlite-reader.ts').then(async m=>console.log((await m.readSessionsFromDb(process.env.HOME+'/.local/share/opencode/opencode.db',{maxAgeDays:365,limit:3})).length))"
  ```
  Expected before the fix: `0` (with rows present in `session_v2`).

- [x] **Step 2: Add a cached layout probe**

  One query against `sqlite_master`, cached per database path (module-level `Map<string, …>`). Resolve the
  three table names in one shot:

  ```typescript
  interface DbLayout {
    readonly sessions: string;
    readonly messages: string;
    readonly parts: string | null; // v2 nests parts inside the message row
  }

  // v2 is identified by the renamed tables; 1.x by the originals.
  // 'session'/'message'/'part' → { sessions: 'session', messages: 'message', parts: 'part' }
  // 'session_v2'/'session_message' → { sessions: 'session_v2', messages: 'session_message', parts: null }
  ```

  Detection must run through the existing `queryDb()` helper so the `sqlite3` CLI fallback still applies on
  Node 20. On an unrecognized layout: `logger.warn` naming the detected table list, and let the caller fall
  back — never a silent empty array.

- [x] **Step 3: Read sessions for both layouts**

  The selected columns are a subset of `session_v2` (`id`, `project_id`, `slug`, `directory`, `title`,
  `version`, `time_created`, `time_updated`), so substitute the table name into the existing query
  unchanged. Keep age / directory / limit predicates in SQL — this runs on every incremental-sync tick.

- [x] **Step 4: Read messages for both layouts**

  v1 reads `data.role`. v2 carries role in the `type` column, and the same column also holds `idle`,
  `system`, `shell`, `synthetic`, `agent-switched` and `model-switched` rows — keep only `user` and
  `assistant`, order by `seq`. Field mapping for v2 (verified against a live database):

  | Target field | v1 source | v2 source |
  |---|---|---|
  | `role` | `data.role` | the `type` column |
  | `time.created` / `time.completed` | `data.time.created` / `data.time.completed` | `data.time.created` / `data.time.completed` |
  | assistant `providerID` / `modelID` | `data.providerID` / `data.modelID` | `data.model.providerID` / `data.model.id` |
  | assistant `agent` | `data.agent` | `data.agent` (present) |
  | user `agent` | `data.agent` | **verify** — `data.agents[]` was empty in the observed sample; leave unset unless the entry is a plain string, never fabricate |

  Assistant `error` has no v2 counterpart in the observed rows — leave unset rather than inventing one.

- [x] **Step 5: Derive parts from `data.content[]` on v2**

  v2 has no parts table. Query the session's message rows once and derive the part map:

  - each entry becomes `OpenCodePartBase` with `messageID` = row id, `sessionID` = requested session id,
    and a **synthetic id** `${row.id}:${index}` (v2 stores no per-part id).
  - `{type:'text', text}` maps directly.
  - `{type:'tool', id, name, executed, state:{status, input, content[], metadata}}` needs translation onto
    `OpenCodeToolPart`: `callID` ← `id`, `tool` ← `name`, `state.input` ← `state.input`,
    `state.metadata` ← `state.metadata`, and `state.output` ← the texts of `state.content[]` joined by a
    newline (v2 returns a content list, not a single output string). `state.status` falls back to
    `executed ? 'completed' : 'pending'` when absent.
  - entries of unknown `type` are kept as-is (the union already carries `step-start`, `step-finish`,
    `patch`, `file`, `reasoning`), so a future v2 part type degrades instead of vanishing.
  - Part order follows `content[]` order, which is the turn order.

  Keep the v1 query untouched for v1 databases.

- [x] **Step 6: Make failures visible**

  - the native-query helper's bare `catch { return null }` (`:89-91`) must log the reason at `warn` when the
    database was detected as a known layout, so a genuine fault is not mistaken for "unavailable";
  - `queryDb`'s `logger.debug` on CLI failure / exception (`:131,143`) becomes `warn` under the same
    condition;
  - ensure a failed read cannot be reported as "no sessions": `discoverSessions` already warns and falls back
    to file-based discovery when discovery throws (`opencode.session.ts:506-510`) — that path must become
    reachable instead of receiving an empty array.

- [x] **Step 7: Verify against the live database**

  ```bash
  node -e "import('./src/agents/plugins/opencode/opencode.sqlite-reader.ts').then(async m=>{const p=process.env.HOME+'/.local/share/opencode/opencode.db';const s=await m.readSessionsFromDb(p,{maxAgeDays:365,limit:3});console.log('sessions',s.length,s[0]?.id);const msgs=await m.readMessagesFromDb(p,s[0].id);console.log('messages',msgs.length,msgs.map(x=>x.role).join(','));const parts=await m.readAllPartsForSessionFromDb(p,s[0].id);console.log('partKeys',Object.keys(parts).length,JSON.stringify(Object.values(parts)[0]?.[0]).slice(0,200));})"
  ```
  Expected: non-zero sessions; both `user` and `assistant` roles; parts with `type`, synthetic `id`,
  `callID` / `tool` populated for tool entries.

- [x] **Step 8: Gates**

  Run: `npm run typecheck` → no errors. Run: `npm run lint` → zero warnings.

---

## Task 2: Config emission — native Bedrock block and provider allowlist

**Files:**
- Modify: `src/agents/plugins/opencode/opencode.plugin.ts` (v2 proxy branch `:433-467`, v2 ollama branch
  `:473-491`, Bedrock warn `:493-506`, v1 allowlist `:518` for reference)
- Never modify: the v1 block (`:517-566`) — it must stay byte-identical to `origin/main`.

**Interfaces:**
- Consumes: `toBedrockModelId()` (already imported), `env.AWS_REGION || env.CODEMIE_AWS_REGION`,
  `modelConfig.limit`.
- Produces: one `injectV2Config()` call per provider, each with `enabled_providers` naming exactly the
  provider that branch declares.

- [x] **Step 1: Allowlist the two existing v2 branches**

  Add `enabled_providers: ['codemie-proxy']` to the proxy branch and `enabled_providers: ['ollama']` to the
  ollama branch, mirroring the v1 intent (`:518`). v2 honours the key
  (`packages/core/src/config/normalize.ts:388`). Without it an unresolvable `ollama/<id>` is silently
  replaced by another provider's default model instead of failing, and unrelated catalogue models pollute
  the picker.

- [x] **Step 2: Replace the Bedrock fall-through with a native v2 block**

  v2 registers `@opencode/ai/providers/amazon-bedrock` as a built-in provider whose settings accept
  `region`, `credentials`, `profile`, `apiKey`, `auth`, `baseURL` plus the shared `timeout`
  (`packages/ai/src/providers/amazon-bedrock.ts:8-35`). Region resolves through the AWS environment when
  omitted (`:16-22,46`), and credentials fall back to the AWS default chain when omitted — so only the
  region needs declaring; the AWS environment the Bedrock provider plugin already sets keeps working.

  ```typescript
  if (provider === 'bedrock' && configVersion === 'v2') {
    const bedrockId = toBedrockModelId(modelConfig.id, env.AWS_REGION || env.CODEMIE_AWS_REGION);
    return injectV2Config(env, {
      $schema: 'https://opencode.ai/config.json',
      share: 'disabled',
      enabled_providers: ['amazon-bedrock'],
      model: `amazon-bedrock/${bedrockId}`,
      providers: {
        'amazon-bedrock': {
          name: 'Amazon Bedrock',
          package: '@opencode/ai/providers/amazon-bedrock',
          settings: { ...(region && { region }), timeout },
          models: {
            [bedrockId]: { name: modelConfig.name ?? bedrockId, ...(modelConfig.limit && { limit: modelConfig.limit }) },
          },
        },
      },
      plugins: [pluginV2Url],
    }, 'opencode-v2-bedrock');
  }
  ```

  Then delete the old warn block (`:493-506`) — its claim that the emitted v1 shape is "normalized by
  OpenCode" is what hid the real failure (the v1 block declares only the `ollama` provider while
  `model:` references `amazon-bedrock/…`, so the reference has no provider behind it, and the v1 single-file
  plugin URL is dropped by the v2 scanner).

- [x] **Step 3: Correct the ollama comment**

  The branch comment claims the endpoint "serves its own model inventory". It does not: the declared package
  exposes only `configure` / `model` / `routes`, and inventory comes from the bundled discovery plugin
  `packages/core/src/plugin/provider/ollama.ts`, which reads `providers.ollama.settings.baseURL`, strips a
  `/v1` or `/api` suffix, enumerates `/api/tags`, enriches with `/api/show`, and keeps only models whose
  capabilities include `completion` — each call bounded to 1s. Its transform no-ops at zero models
  (`local.ts:61-62`), which is exactly why step 1's allowlist matters here. Rewrite the comment to name that
  plugin and the empty-inventory degradation.

- [x] **Step 4: Verify against the live binary, per branch**

  Run the three branches with `CODEMIE_OPENCODE_CONFIG_VERSION=2` against a live 2.0.27 binary:
  - proxy + stubbed upstream → catalogue listed; `gpt-6*` hits `/responses`, `claude-*` hits `/chat/completions`;
  - ollama with a running Ollama → models discovered and selectable;
  - ollama with the endpoint down → **explicit** "no model is available for session", not another provider's model;
  - bedrock → the session starts and the model resolves.

- [x] **Step 5: Gates**

  Run: `npm run typecheck`, `npm run lint`, `npm run build` → clean.
  Run: `git diff origin/main..HEAD -- src/agents/plugins/opencode/opencode.plugin.ts` and confirm the v1
  block region is untouched.

---

## Task 3: Routing — decide the endpoint where routing is decided

**Files:**
- Modify: `src/agents/plugins/opencode/opencode-model-configs.ts` (inert flag at `:863`, pattern copy at `:805-818`)
- Modify: `src/agents/plugins/opencode/opencode-dynamic-models.ts` (`isResponsesApiModel`, `:52`)

**Interfaces:**
- `getModelConfig(modelId)` signature unchanged; its fallback simply stops claiming an endpoint it cannot decide.

- [x] **Step 1: Remove the inert flag**

  Delete the `RESPONSES_FALLBACK_PATTERNS` list and the conditional `use_responses_api` spread in the
  `getModelConfig()` fallback. Nothing reads it: the chat / Responses split is built only from the fetched
  catalogue (`opencode.plugin.ts:398-399`), the fallback result feeds only `providerOptions` and the `model:`
  reference (`:393-395,451,477,562`), and the per-model `package` override comes from the converted
  catalogue. A flag no routing code reads advertises a guarantee that does not exist.

- [x] **Step 2: Add the family heuristic to `isResponsesApiModel()`**

  Keep the existing name patterns, then add: an ID matching `/^gpt-(\d+)(?:[.\-]|$)/` whose major is at or
  beyond the largest major the patterns cover explicitly (currently 6) is Responses-only. This is where the
  decision is actually taken (`isResponsesApiModel()` is called at `:111` during catalogue conversion, and
  its flag is what `:133` writes), and it is naturally cycle-free — `opencode-dynamic-models.ts` already
  imports `opencode-model-configs.ts`, so nothing imports back.

- [x] **Step 3: Verify**

  ```bash
  node -e "import('./src/agents/plugins/opencode/opencode-dynamic-models.ts').then(m=>{for(const id of ['gpt-6.9-unknown-luna','gpt-7-preview','gpt-60','gpt-4o-mini','claude-4-5-sonnet','gpt-5.2-2025-12-11'])console.log(id,m.isResponsesApiModel(id))})"
  ```
  Expected: `true` for the unknown GPT-6/7-shaped IDs and `gpt-5.2-*`; `false` for `gpt-60`, `gpt-4o-mini`,
  `claude-4-5-sonnet`.

- [x] **Step 4: Gates**

  Run: `npm run typecheck`, `npm run lint`.

---

## Task 4: Hooks plumbing hygiene

**Files:**
- Modify: `src/agents/plugins/opencode/opencode.plugin.ts` (`:362-366` comment, `:422-423` payload creation,
  `onSessionEnd` cleanup around `:681`)
- Modify: `src/agents/plugins/codemie-code-hooks/inject-hooks.ts` only if a cleanup signature must change
  (it already exports the v2 cleanup at `:15`)

- [x] **Step 1: Call both payload cleanups**

  `onSessionEnd`'s `finally` calls only the v1 cleanup. Call the v2 cleanup alongside it, so the injected v2
  directory is removed on session end instead of relying solely on the process-exit cleanup.

- [x] **Step 2: Create the v1 payload only when the v1 shape is emitted**

  `getHooksPluginFileUrl()` (`:422`) writes the v1 single-file payload on every run past the base-URL check,
  including v2 runs that register only the directory URL — v2 rejects single-file targets
  (`packages/core/src/config/plugin/source.ts:151-153`), so that file is always unused on v2. Move its
  creation next to the v1 config block that consumes it. No permanent leak exists today (the process-exit
  cleanup covers it); this removes the asymmetry.

- [x] **Step 3: Make the early-registration comment precise**

  The comment at `:362-366` says telemetry registration was moved before the base-URL early returns. What is
  registered before them is `OPENCODE_HOOKS` (`:366`); plugin injection stays after the check because it
  genuinely needs the proxy config. Reword to say exactly that — the behaviour is intentional and pinned by
  `opencode-session-lifecycle.test.ts:139-149`, only the wording invites misreading.

- [x] **Step 4: Gates**

  Run: `npm run typecheck`, `npm run lint`. Run the existing lifecycle spec to confirm the
  "no proxy config" case is unchanged.

---

## Task 5: Documentation — state the real v2 limitations

**Files:**
- Modify: `.ai-run/guides/integration/external-integrations.md` (v2 schema section)
- Modify: `docs/COMMANDS.md` (user-facing v2 behaviour)
- Never edit: `openwiki/` (generated).

- [x] **Step 1: Update the guide**

  Document the v2 config schema (`providers` + `package` + `settings`), the unified delivery (inline
  `OPENCODE_CONFIG_CONTENT` primary, `OPENCODE_CONFIG` temp-file fallback above the env size limit — the same
  rule for both versions), the `CODEMIE_OPENCODE_CONFIG_VERSION=1|2` override, the per-provider allowlist, and
  the session-database layout difference (1.x `session`/`message`/`part` vs 2.x `session_v2`/`session_message`
  with nested `data.content[]`), plus the Ollama inventory dependency on the v2 discovery plugin and the
  native Bedrock block.

- [x] **Step 2: Update the user documentation**

  Where v2 behaviour is described, state that: an undetectable version falls back to the v1 schema with a
  warning and never blocks startup; the v2 provider allowlist makes an unresolvable model an explicit error
  rather than a silent switch to another provider; Ollama on v2 needs a reachable endpoint whose models report
  the `completion` capability.

- [x] **Step 3: Read both through**

  Confirm no stale claim remains that v2 always uses the temp-file channel, and no claim that a provider
  "works on v2" without naming its requirement.

---

## Task 6: Coverage for the v2 shapes (requires explicit user request)

**Files:**
- Add: v2-shape assertions for `beforeRun` (proxy / ollama / bedrock branches, allowlist, `plugins` directory URL)
- Add: reader coverage against a v2-shaped database fixture built in a temp directory with `node:sqlite`
  (layout detection, `type`-column role mapping, `content[]` parts, tool-part translation)

**Gate:** do not start this task unless the user explicitly asks for tests (`AGENTS.md`).

> **Done 2026-10-12 (explicit request).** `opencode-v2-emission.test.ts` (12 cases, three v2 branches),
> `opencode-sqlite-reader.test.ts` (12 cases, both database layouts + failure visibility), and five
> unknown-future-major routing cases in `opencode-gpt55-routing.test.ts`. Both new suites were mutation-checked:
> forcing the v1 layout onto a v2 database fails 7 reader cases, and emptying the Bedrock allowlist fails the
> allowlist assertion. The reader suite skips itself on Node < 22.5, where `node:sqlite` cannot build a fixture.

- [x] **Step 1: Emission shape test**

  Force `CODEMIE_OPENCODE_CONFIG_VERSION=2`, then assert per branch: `providers` (plural) present,
  `package` present, `settings.baseURL` present, `share: 'disabled'`, `enabled_providers` naming the declared
  provider, and `plugins` containing the directory URL. This is the test that turns an Ollama or Bedrock
  regression into a failure instead of a silent reroute.

- [x] **Step 2: Reader fixture test**

  Build a temp database with `session_v2` / `session_message` rows (one user message, one assistant message
  carrying a text and a tool content entry), then assert the mapped session, both roles, the synthetic part
  id, and the tool part's `callID` / `tool` / `output`.

- [x] **Step 3: Run the opencode suites**

  Run: `npx vitest run src/agents/plugins/opencode src/agents/plugins/codemie-code-hooks src/agents/core`

---

## Task 7: Verification and CI

- [x] **Step 1: Prove the analytics gap is closed**

  Run a prompt through a live 2.0.27 binary so a real session exists in the database, then read that session
  through the reader and confirm non-empty metrics (tokens, turns). Hooks firing plus an empty reader result
  was the failure mode being fixed; a non-empty read of a hook-created session is the proof.

- [x] **Step 2: Prove the v1 path is untouched**

  Run: `git diff origin/main..HEAD -- src/agents/plugins/opencode/opencode.plugin.ts` — the v1 block must be
  byte-identical apart from the payload-creation move in Task 4. Force
  `CODEMIE_OPENCODE_CONFIG_VERSION=1` and repeat a prompt; turn metrics land as before.

- [x] **Step 3: Full CI**

  Run: `npm run ci` (per `.ai-run/guides/quality-gates.md`). Expected: green.

  Result 2026-10-12: license-check / lint / build clean; `unit` project 328 files / 4816 tests green.
  The `cli` project's 8 suites fail on `node-pty` (no `prebuilds/linux-x64` in this checkout) and the
  `agent` project aborts in global setup trying to download the Claude CLI from an unreachable host — both
  pre-existing environment limits that execute no project code.

- [ ] **Step 4: Commit only on explicit request**

  One Conventional Commits commit per task, or a single commit if the user prefers. Never stage the local-only
  notes.

---

## Self-review

**Spec coverage:**
- §4 config emission per provider + allowlist → Task 2 (steps 1-4).
- §6 routing decision → Task 3 (remove the inert flag, add the heuristic where routing is decided).
- §7 session storage schema → Task 1 (detection, both layouts, `content[]` parts, visibility).
- §8 hooks cleanup hygiene → Task 4 (both cleanups, v1 payload only when emitted, comment accuracy).
- §9 error handling → Task 1 step 6 (visible failures), Task 2 step 4 (allowlist turns silent reroute into an
  error), Task 3 step 3 (unknown Responses-only IDs routed correctly).
- §10 out of scope → Global Constraints (no `src/utils/` extraction, no cost/token columns, no `openwiki/`,
  tests gated, local notes uncommitted).
- §11 verification → Task 2 step 4 (per-branch live binary), Task 7 (analytics proof, v1 regression, CI).

**Ordering rationale:** Task 1 is first because it is the only blocker and it gates the value of everything
else; Task 2 next because it changes the config other tasks assert against; Task 3 is independent and small;
Task 4 is hygiene; docs after code; tests last so they assert the final shapes.

**Placeholder scan:** every table name, column, type value and provider setting was read from the v2 sources
or from a live 2.0.27 database. Two things are deliberately left as verification steps rather than asserted
facts: the shape of `data.agents[]` entries on user messages (observed empty, so the field stays unset) and
the live per-branch behaviour, which requires the binary.

**Type consistency:** reader exports keep their signatures; the layout probe is internal. `isResponsesApiModel`
keeps its signature and returns `boolean`. `injectV2Config(env, config, label)` is unchanged, so each new
branch is one call.