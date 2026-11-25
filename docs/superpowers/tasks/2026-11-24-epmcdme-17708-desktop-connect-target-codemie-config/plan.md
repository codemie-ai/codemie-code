# EPMCDME-17708 Desktop connect targets the CodeMie config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `codemie proxy connect|disconnect --claude-desktop` find, update/clean and (on connect) activate the CodeMie entry in Claude Desktop's `configLibrary`, instead of whatever `_meta.json.appliedId` points at.

**Architecture:** One read-only resolver in `src/cli/commands/proxy/connectors/desktop.ts` picks the CodeMie config id: rule (a) entry named `CodeMie Proxy`, then (b) the applied entry when it already points at the local proxy, then (c) a new UUID. `writeDesktopConfig` uses (a/b/c) and activates the result. `removeDesktopConfig` uses (a/b) only. The connect orchestrator reports the switch. Readers that describe what Desktop is using now still read the applied entry.

**Tech Stack:** TypeScript ESM, Vitest with real temp dirs (`desktop.test.ts` pattern), `writeFileAtomic` (`src/utils/atomic-write.ts`).

## Acceptance criteria

- AC1: With several entries in `_meta.json`, connect finds the CodeMie entry (named `CodeMie Proxy`) through `_meta.json`.
- AC2: The CodeMie entry's `<UUID>.json` gets the full field set `writeDesktopConfig` writes today: gateway URL, key, authScheme and inferenceCredentialKind, `modelDiscoveryEnabled`, `coworkEgressAllowedHosts`, `managedMcpServers`, with stale inference, sign-in and bedrock keys removed.
- AC3: MCP servers the user added in that entry are kept, and so are managed MCP servers the user edited since CodeMie last wrote them (detected by a per-name fingerprint in the managed-MCP marker, which is tied to the config it was written for).
- AC4: If the CodeMie entry is not active, connect sets `appliedId` to it and says so in its output.
- AC5: If it is already active and its entry exists, `_meta.json` is not rewritten.
- AC6: When another config is active, that config's file is not modified.
- Disconnect cleans the CodeMie entry even when another config is active. It never creates an entry or touches other configs, and it drops `appliedId` only when `appliedId` pointed at the deleted entry.
- Unknown top-level `_meta.json` fields survive connect and disconnect.

## Global Constraints

- ES modules, `.js` import extensions, `@/` alias, explicit return types, no `any`, `logger` + `sanitizeLogArgs` (never `console` in connectors), `ConfigurationError` for unreadable files.
- Config and `_meta.json` writes go through `writeFileAtomic`, which writes through symlinks. Never use plain `writeFile` for these files in the touched functions.
- `_meta.json` updates spread the existing meta, so unknown top-level fields and every existing entry survive.
- Never modify a config file other than the resolved CodeMie one (AC6). Do not repair configs that earlier versions overwrote (D6). The managed-MCP marker stays global.
- `getDesktopConfigPath`, `readDesktopGateway*`, `moveDesktopToNamedKey`, `decideDesktopRoute`, telemetry and `client-targets` keep their applied-entry semantics (D2).
- Follow `.ai-run/guides/testing/testing-patterns.md`. Commit per task using the repository's existing convention.

---

### Task 1: CodeMie config resolver

**Files:** Modify `src/cli/commands/proxy/connectors/desktop.ts` (types at `:657-665`, add the resolver after `getDesktopConfigPath` `:711-723`). Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` (new `describe('resolveCodeMieDesktopConfig')`).

**Interfaces — Produces:**
```ts
export const CODEMIE_DESKTOP_CONFIG_NAME = 'CodeMie Proxy';
export interface ConfigMeta { appliedId?: string; entries?: ConfigMetaEntry[] } // now exported
export interface CodeMieDesktopConfigTarget {
  configId: string;
  isNew: boolean;                       // rule (c): no file, no meta entry yet
  appliedId: string | undefined;        // appliedConfigId(meta)
  previousAppliedName: string | undefined; // name of the applied entry when appliedId !== configId and that entry exists
}
export async function resolveCodeMieDesktopConfig(
  libDir: string, meta: ConfigMeta, localKey: string
): Promise<CodeMieDesktopConfigTarget>;
export async function getCodeMieDesktopConfigPath(
  baseDir?: string, stateFile?: string
): Promise<string>; // reads meta (corrupt → {}), localKey = readState(stateFile)?.gatewayKey ?? DEFAULT_GATEWAY_KEY
```

- [ ] **Test-first: yes — with entries `[{id:A,name:'QA Other'},{id:C,name:'CodeMie Proxy'}]` and `appliedId:A`, the resolver returns `{configId:C,isNew:false,appliedId:A,previousAppliedName:'QA Other'}`; it currently fails because the symbol does not exist.** Add cases for: (a) with two `CodeMie Proxy` entries, the applied one is preferred, otherwise the first; (a) with the entry's file missing it still returns that id; an unsafe-id `CodeMie Proxy` entry (`../x`) is skipped; (b) an applied entry renamed `My CodeMie`, whose file has a loopback gateway with key `<localKey>.claude-desktop`, is chosen; (b) is rejected for a loopback gateway with another key (EPMCDME-17531), a non-gateway file, a missing file or unparsable JSON. Those fall to (c): a new UUID with `isNew:true`. `getCodeMieDesktopConfigPath` returns `<libDir>/<C>.json` for the first fixture.
- [ ] Implement. Ids pass `isSafeSessionId` (`@/agents/core/session-id.js`). Rule (b) uses `desktopGatewayOfEntry` + `isDesktopPointedAtLocalProxy` from `claude-desktop.gateway.ts`. Replace the literal at `:898` with `CODEMIE_DESKTOP_CONFIG_NAME`. Leave `getDesktopConfigPath` unchanged. Run `npx vitest run src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`.

### Task 2: writeDesktopConfig targets and activates the CodeMie entry

**Files:** Modify `desktop.ts:725-907` and the caller at `src/cli/commands/proxy/connect-orchestrator.ts:789-805`. Test: `desktop.test.ts` writeDesktopConfig block (`:594-1412`); update the `writeDesktopConfig` mocks in `connect-orchestrator.test.ts` (`:69`, `:818-833`, `:1146`), `connect-orchestrator.bedrock-gate.test.ts` (`:43`, `:151-438`) and any other mock that grep finds.

**Interfaces — Consumes:** Task 1 resolver. **Produces:**
```ts
export interface WriteDesktopConfigResult {
  configPath: string;
  /** Name of the entry that was active before connect switched Desktop to CodeMie's; absent when nothing was switched or no named entry was active. */
  switchedFrom?: string;
  activated: boolean; // appliedId changed
}
```

- [ ] **Test-first: yes — the QA scenario: meta `{appliedId:OTHER, entries:[CodeMie(C), 'QA Other Gateway'(OTHER)], extra:'keep'}`, file C has a stale port `61111` and no `inferenceCredentialKind`, file OTHER has its own gateway. After `writeDesktopConfig`: file C holds the full field set (AC2); file OTHER is byte-identical (AC6); `appliedId === C` (AC4); `extra` and both entries are preserved; the result is `{configPath:C, activated:true, switchedFrom:'QA Other Gateway'}`. It currently fails because OTHER gets overwritten.** Also add: a user MCP server kept in C while OTHER is active (AC3). AC5: C is already applied and its entry exists, and meta is seeded as compact one-line JSON, so after the write `_meta.json` text is unchanged and `activated:false`. Rule (c) appends a `CodeMie Proxy` entry and keeps the existing entries.
- [ ] Update the existing cases that encode "write the applied entry" (D7). Do not delete them. `:691` (`Default` applied, no file) and `:734` (`X` stale non-gateway) now expect a new `CodeMie Proxy` entry to be appended and activated, with the applied entry's file and meta entry left alone. Rework the "name preserved" assertion as rule (b): an applied entry already pointing at the local proxy keeps its name. Cases that only read `result` as a path switch to `result.configPath`.
- [ ] Implement. Replace `:758` with `resolveCodeMieDesktopConfig(libDir, meta, gatewayKey)`. Write the config via `writeFileAtomic` (`:877`). Write meta with `writeFileAtomic` as `{...meta, appliedId: configId, entries}` only when the entry was appended or `appliedId !== configId` (`:896-904`). Return the result object. In `runClaudeDesktop` destructure `configPath` (Task 3 adds the output line). Run the desktop and orchestrator test files.

### Task 3: Connect output and the Bedrock-gate target

**Files:** Modify `connect-orchestrator.ts:504` and `:789-822`, plus `docs/COMMANDS.md` (connect `:240-262`, disconnect `:95`). Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`, `connect-orchestrator.bedrock-gate.test.ts`, `index.test.ts:86` (mock).

**Interfaces — Consumes:** `getCodeMieDesktopConfigPath` (Task 1), `WriteDesktopConfigResult` (Task 2).

- [ ] **Test-first: yes — when the mocked `writeDesktopConfig` resolves `{configPath, activated:true, switchedFrom:'QA Other Gateway'}`, connect prints `  Switched Claude Desktop's active configuration from "QA Other Gateway" to "CodeMie Proxy".` before the existing restart line, and prints no such line when `activated:false`. The bedrock-gate test expects `desktopApplied` to come from the mocked `getCodeMieDesktopConfigPath`. Both currently fail.** Add a `getCodeMieDesktopConfigPath` mock wherever `getDesktopConfigPath` is mocked.
- [ ] Implement. `claudeConnectTargets` calls `getCodeMieDesktopConfigPath()`: the gate inspects the file connect is about to write and activate. Print the yellow line only when `switchedFrom` is set; the existing `:821` restart line covers the restart. In `docs/COMMANDS.md`, add one sentence each: connect updates the `CodeMie Proxy` configuration and makes it active even when another configuration is active, leaving the others untouched; disconnect cleans only that configuration.

### Task 4: removeDesktopConfig targets the CodeMie entry

**Files:** Modify `desktop.ts:977-1089`. Test: `desktop.test.ts` removeDesktopConfig block (`:1414-1595`).

**Interfaces — Consumes:** Task 1 resolver (local key: `readState()?.gatewayKey ?? DEFAULT_GATEWAY_KEY`, which is already computed at `:1030`. Move it before resolution).

- [ ] **Test-first: yes — with `appliedId:OTHER` and a CodeMie-only entry C, disconnect deletes file C, removes only C's meta entry, leaves `appliedId === OTHER` and unknown meta fields, and leaves file OTHER byte-identical. It currently fails with "no applied Claude Desktop config".** Add: C applied, so it is deleted and `appliedId` dropped (existing behaviour); C keeps user servers, so only C is rewritten; no CodeMie entry and a non-CodeMie applied entry (`'Local'` `:1449`, unsafe id `:1584`) give `removed:false`, nothing written, never a new id; a `CodeMie Proxy` entry whose file is missing gives `removed:false`.
- [ ] Implement. Resolve after reading meta. A result with `isNew` means not found: reason `'no CodeMie Claude Desktop config'`, changed from `'no applied …'`. Update the existing assertions. Keep the `isCodeMieGatewayConfig` / `isDesktopPointedAtLocalProxy` guards unchanged. On delete, drop the entry and delete `appliedId` only when it equals `configId`. Write config and meta with `writeFileAtomic` (`:1078`, `:1080`); keep the symlink branch at `:1062-1072`. `disconnect-orchestrator.ts` output needs no change. Run the desktop and disconnect-orchestrator tests.
