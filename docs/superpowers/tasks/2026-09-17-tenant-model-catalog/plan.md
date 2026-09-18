# Tenant-Aware Model Catalogs For Proxy Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make VS Code Copilot BYOK, Claude Desktop, and the VS Code Claude Code extension configure
themselves from the tenant's live `/v1/llm_models` catalog and a comment-safe settings write, instead
of EPAM-shaped hardcoded constants and strict JSON parsing, so a non-EPAM-shaped tenant (or any other)
connects correctly.

**Architecture:** A new shared resolver (`model-name-resolver.ts`) generalizes
`codex-model-resolver.ts`'s date-stripping identity-parse shape to also strip known vendor prefixes
(GPT) and match both token orders (Claude), and is consumed by both `vscode.ts` and `desktop.ts` —
`codex-model-resolver.ts` itself is untouched. VS Code's static model table becomes a capability
table keyed by family and is intersected against a freshly fetched tenant catalog at connect time.
Claude Desktop's preferred-list resolution swaps its suffix-only strategies for the shared resolver.
VS Code Claude Code's settings write becomes comment-preserving via `jsonc-parser`.

**Tech Stack:** TypeScript, Vitest, `jsonc-parser` (new dependency).

**Spec:** `docs/superpowers/tasks/2026-09-17-tenant-model-catalog/spec.md`

**Commit per task using the repository's existing convention.**

## Global Constraints

- A local, untracked sample-data file (repo root, real customer tenant data) must never be committed,
  staged, or referenced as a fixture path by any test. Every non-EPAM-tenant-shaped fixture below is
  a small inline literal, authored fresh in the test file that needs it.
- No change to `src/providers/plugins/sso/proxy/plugins/codex-model-resolver.ts` or Codex connector
  behavior.
- No change to `vscode.ts:189`'s strict `JSON.parse` of `chatLanguageModels.json` (machine-written,
  different failure profile).
- `github-copilot-*` deployments never appear in the VS Code Copilot BYOK picker or the Claude
  Desktop picker.
- No surfacing of tenant models absent from the capability table (e.g. `glm-5`, `deepseek-v3-2`).

---

## File Structure

- `src/cli/commands/proxy/connectors/model-name-resolver.ts` (new) — shared resolver. Lives beside
  its two callers rather than under `src/providers/plugins/sso/proxy/plugins/` because it is a
  CLI-side config-writer concern, not proxy-runtime request handling; co-locating avoids a CLI→proxy
  layer crossing for logic neither `codex-model-resolver.ts` nor the proxy runtime needs.
- `src/cli/commands/proxy/connectors/tenant-catalog.ts` (new) — `fetchTenantModelCatalog()`, modeled
  on `desktop.ts:84`'s `fetchClaudeModels()` but returning every deployment id unfiltered. A new
  function rather than an extraction from `fetchClaudeModels()`: extracting shared code would touch
  `fetchClaudeModels()`'s proven error/fallback behavior, which the spec's non-goals do not ask to
  change and `desktop.test.ts` pins precisely — duplicating ~40 lines of fetch/parse logic is cheaper
  than that regression risk.
- `src/cli/commands/proxy/connectors/vscode-models.ts` (modify) — reshape to a capability table.
- `src/cli/commands/proxy/connectors/vscode.ts` (modify) — tenant-aware `buildManagedModels`.
- `src/cli/commands/proxy/connect-orchestrator.ts` (modify) — thread `gatewayKey`, log real count.
- `src/cli/commands/proxy/connectors/desktop.ts` (modify) — resolver-based preferred-model matching.
- `src/cli/commands/proxy/connectors/vscode-claude-code.ts` (modify) — JSONC-safe read/write.
- `package.json` (modify) — add `jsonc-parser`.

---

### Task 1: Shared model-name resolver

**Files:**
- Create: `src/cli/commands/proxy/connectors/model-name-resolver.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/model-name-resolver.test.ts`

**Interfaces:**
- Produces: `export function resolveTenantModelId(family: string, available: readonly string[]): string | undefined`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { resolveTenantModelId } from '../model-name-resolver.js';

describe('resolveTenantModelId', () => {
  it.each([
    // [description, family, available, expected]
    ['exact match', 'claude-sonnet-4-6', ['claude-sonnet-4-6'], 'claude-sonnet-4-6'],
    ['GPT vendor-prefixed, undated (non-EPAM tenant)', 'gpt-5.6-luna', ['openai.gpt-5.6-luna'], 'openai.gpt-5.6-luna'],
    ['GPT dated, dashed minor (EPAM)', 'gpt-5.6-luna', ['gpt-5.6-luna-2026-07-09'], 'gpt-5.6-luna-2026-07-09'],
    ['GPT picks most recent dated duplicate', 'gpt-5.6-luna',
      ['gpt-5.6-luna-2025-01-01', 'gpt-5.6-luna-2026-07-09'], 'gpt-5.6-luna-2026-07-09'],
    ['Claude family-first request, version-first tenant (non-EPAM tenant)', 'claude-opus-5', ['claude-5-opus'], 'claude-5-opus'],
    ['Claude version-first request, family-first tenant', 'claude-haiku-4-5', ['claude-4-5-haiku'], 'claude-4-5-haiku'],
    ['Claude dated family-first tenant (EPAM)', 'claude-opus-4-5', ['claude-opus-4-5-20251101'], 'claude-opus-4-5-20251101'],
    ['no match at all', 'glm-5', ['claude-sonnet-4-6'], undefined],
    ['Gemini exact-match only — no fuzzy normalization invented', 'gemini-3.1-pro', ['gemini-3-1-pro'], undefined],
    ['github-copilot-claude-* never matches a Claude family (AC4/AC8 defense-in-depth)',
      'claude-sonnet-4-6', ['github-copilot-claude-sonnet-4-5'], undefined],
    ['github-copilot-gpt-* never matches a GPT family (AC4 defense-in-depth)',
      'gpt-5-mini', ['github-copilot-gpt-5-mini'], undefined],
  ])('%s', (_desc, family, available, expected) => {
    expect(resolveTenantModelId(family, available)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test file and confirm every case fails** (module does not exist yet)

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/model-name-resolver.test.ts`

- [ ] **Step 3: Implement the resolver**

Generalizes `codex-model-resolver.ts`'s `DEPLOYMENT_DATE_PATTERN` date-stripping shape. Token order for
Claude is handled by collecting every numeric token regardless of position, so `claude-opus-4-5` and
`claude-4-5-opus` parse to the same identity without two separate branches:

```ts
const RELEASE_DATE_PATTERN = /[-._](20\d{2})[-._](\d{2})[-._](\d{2})/;
const GPT_VENDOR_PREFIXES = ['openai.'];
const CLAUDE_SEGMENT_PATTERN = /opus|sonnet|haiku/i;

interface ModelIdentity { vendor: 'gpt' | 'claude'; segment: string; major: number; minor: number }

function stripReleaseDate(name: string): string {
  const match = name.match(RELEASE_DATE_PATTERN);
  return match ? name.slice(0, match.index) : name;
}

function parseGptIdentity(rawName: string): ModelIdentity | null {
  let name = stripReleaseDate(rawName.toLowerCase());
  for (const prefix of GPT_VENDOR_PREFIXES) {
    if (name.startsWith(prefix)) { name = name.slice(prefix.length); break; }
  }
  const canonical = name.replace(/\./g, '-').replace(/-+$/, '');
  const versionMatch = canonical.match(/^gpt-(\d+)(?:-(\d+))?/);
  if (!versionMatch) return null;
  const rest = canonical.slice(versionMatch[0].length).replace(/^-/, '');
  return { vendor: 'gpt', segment: rest, major: Number(versionMatch[1]), minor: Number(versionMatch[2] ?? 0) };
}

function parseClaudeIdentity(rawName: string): ModelIdentity | null {
  const name = stripReleaseDate(rawName.toLowerCase()).replace(/-vertex$/, '');
  if (!name.startsWith('claude-')) return null;
  const tokens = name.slice('claude-'.length).split('-').filter(Boolean);
  const segmentToken = tokens.find((t) => CLAUDE_SEGMENT_PATTERN.test(t));
  if (!segmentToken) return null;
  const numbers = tokens.filter((t) => /^\d+$/.test(t)).map(Number);
  return { vendor: 'claude', segment: segmentToken, major: numbers[0] ?? 0, minor: numbers[1] ?? 0 };
}

function sameIdentity(a: ModelIdentity | null, b: ModelIdentity): boolean {
  return a !== null && a.vendor === b.vendor && a.segment === b.segment
    && a.major === b.major && a.minor === b.minor;
}

// Lexicographic descending is sufficient: embedded dates are fixed-width YYYY-MM-DD.
function pickMostRecent(ids: string[]): string {
  return [...ids].sort((a, b) => b.localeCompare(a))[0];
}

export function resolveTenantModelId(family: string, available: readonly string[]): string | undefined {
  if (available.includes(family)) return family;

  const gptWanted = parseGptIdentity(family);
  if (gptWanted) {
    const matches = available.filter((id) => sameIdentity(parseGptIdentity(id), gptWanted));
    if (matches.length > 0) return pickMostRecent(matches);
  }

  const claudeWanted = parseClaudeIdentity(family);
  if (claudeWanted) {
    const matches = available.filter((id) => sameIdentity(parseClaudeIdentity(id), claudeWanted));
    if (matches.length > 0) return pickMostRecent(matches);
  }

  return undefined;
}
```

- [ ] **Step 4: Run the test file and confirm every case passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/model-name-resolver.test.ts`

**Test-first: yes — `resolveTenantModelId('gpt-5.6-luna', ['openai.gpt-5.6-luna'])` must return `'openai.gpt-5.6-luna'` (fails: module doesn't exist).**

---

### Task 2: VS Code capability table

**Files:**
- Modify: `src/cli/commands/proxy/connectors/vscode-models.ts:1-315`
- Test: `src/cli/commands/proxy/connectors/__tests__/vscode-models.test.ts` (new)

**Interfaces:**
- Produces: `export interface VsCodeCapabilityEntry` (per spec.md), `export const VS_CODE_CAPABILITY_TABLE: readonly VsCodeCapabilityEntry[]`, replacing `VsCodeModelDefinition`/`VS_CODE_SUPPORTED_MODELS`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { VS_CODE_CAPABILITY_TABLE } from '../vscode-models.js';

describe('VS_CODE_CAPABILITY_TABLE', () => {
  it('has a unique, date-free family key per entry', () => {
    const families = VS_CODE_CAPABILITY_TABLE.map((e) => e.family);
    expect(new Set(families).size).toBe(families.length);
    for (const family of families) {
      expect(family).not.toMatch(/[-._]20\d{2}[-._]\d{2}[-._]\d{2}/);
    }
  });
});
```

- [ ] **Step 2: Run and confirm it fails** (`VS_CODE_CAPABILITY_TABLE` doesn't exist yet)

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/vscode-models.test.ts`

- [ ] **Step 3: Reshape the table**

Rename the `id` field to `family` and strip any trailing release-date suffix from its value (the
resolver's `RELEASE_DATE_PATTERN` shape: `[-._]YYYY[-._]MM[-._]DD`); every other field is unchanged.
Examples:

```ts
export interface VsCodeCapabilityEntry {
  family: string;
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

export const VS_CODE_CAPABILITY_TABLE: readonly VsCodeCapabilityEntry[] = [
  // vscode-models.ts:45 id 'claude-sonnet-4-5-20250929' -> family 'claude-sonnet-4-5'
  // vscode-models.ts:135 id 'gpt-5.6-luna-2026-07-09' -> family 'gpt-5.6-luna'
  // vscode-models.ts:229 id 'claude-opus-4-5-20251101' -> family 'claude-opus-4-5'
  // vscode-models.ts:54 id 'gpt-4.1' has no date suffix -> family 'gpt-4.1' unchanged
  // ...apply the same date-strip rule to the remaining 21 entries; every other field
  // (apiType, vision, thinking, maxInputTokens, maxOutputTokens, modelOptions,
  // requestHeaders, supportsReasoningEffort, reasoningEffortFormat, adaptiveThinking,
  // zeroDataRetentionEnabled) is copied verbatim.
];
```

Rename the exported type/constant everywhere they are declared; do not yet update importers
(`vscode.ts`, `connect-orchestrator.ts`) — that happens in Tasks 3 and 4.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/vscode-models.test.ts`

**Test-first: yes — the uniqueness/date-free structural test above fails until the table is reshaped.**

---

### Task 3: Tenant-aware VS Code Copilot BYOK (`vscode.ts` + `tenant-catalog.ts`)

**Files:**
- Create: `src/cli/commands/proxy/connectors/tenant-catalog.ts`
- Create: `src/cli/commands/proxy/connectors/__tests__/tenant-catalog.test.ts`
- Modify: `src/cli/commands/proxy/connectors/vscode.ts:46-49` (`WriteVsCodeConfigResult`), `:107-137`
  (`buildManagedModels`), `:139-171` (`mergeManagedProviders`), `:226-268`
  (`writeVsCodeLanguageModelsConfig[AtPath]`)
- Modify: `src/cli/commands/proxy/connectors/__tests__/vscode.test.ts`

**Interfaces:**
- Consumes: `resolveTenantModelId` (Task 1), `VS_CODE_CAPABILITY_TABLE` (Task 2)
- Produces:
  - `export async function fetchTenantModelCatalog(proxyUrl: string, gatewayKey: string): Promise<string[]>`
  - `export interface WriteVsCodeConfigResult { configPath: string; requiresSecretConfiguration: boolean; modelCount: number }`
  - `export async function writeVsCodeLanguageModelsConfig(proxyUrl: string, gatewayKey: string, insiders = false): Promise<WriteVsCodeConfigResult>`
  - `export async function writeVsCodeLanguageModelsConfigAtPath(configPath: string, proxyUrl: string, gatewayKey: string): Promise<WriteVsCodeConfigResult>`

- [ ] **Step 1: Write the failing `tenant-catalog.ts` tests**

Mirror `desktop.test.ts`'s `fetchClaudeModels` suite (`globalThis.fetch` saved/restored in
`beforeEach`/`afterEach`). Cases: returns every id unfiltered (mixed `openai.*`, `github-copilot-*`,
`claude-*`, `qwen.*`); throws `ConfigurationError` on non-2xx; throws on non-JSON content-type; throws
on network rejection. No Claude filter, no vertex dedup, no curated-list fallback — those stay
`fetchClaudeModels`-only.

- [ ] **Step 2: Confirm the tests fail, then implement `fetchTenantModelCatalog`**

Same endpoint/headers/error-message shape as `desktop.ts:84-175`'s `fetchClaudeModels`, minus the
`/^claude-/i` filter and vertex/curated-list fallback logic — return `ids` unfiltered.

- [ ] **Step 3: Write the failing `vscode.ts` integration tests**

Add to `vscode.test.ts`, mocking `globalThis.fetch` the same way. Use small inline fixtures — never
the root sample file:

```ts
const NON_EPAM_TENANT_FIXTURE = [
  'openai.gpt-5.6-luna',
  'claude-4-6-sonnet',
  'github-copilot-gpt-5-mini',
  'github-copilot-claude-sonnet-4-5',
];
```

- AC1: fixture with no match for a given family → written config has no entry for it.
- AC2: family matched under a different tenant id → written `id`/`name` equals the tenant id
  byte-for-byte, paired with that family's capability metadata.
- AC3: `NON_EPAM_TENANT_FIXTURE` resolves `gpt-5.6-luna` to `openai.gpt-5.6-luna` verbatim (not the
  dated canonical form).
- AC4: `github-copilot-gpt-5-mini` / `github-copilot-claude-sonnet-4-5` never appear in the written
  config even though same-family non-prefixed entries exist in the same fixture.
- AC5: catalog fetch resolves to `['totally-unknown-model']` (zero matches against the whole table) →
  `writeVsCodeLanguageModelsConfigAtPath` rejects; no file is written.
- Update every pre-existing test in this file to also mock `globalThis.fetch` resolving to a catalog
  containing every id in the file's existing `EXPECTED_MODEL_IDS` list unchanged, and pass a
  `gatewayKey` argument to the call site — this keeps every pre-existing EPAM-shaped assertion valid
  under the new fetch-then-resolve path.

- [ ] **Step 4: Confirm the new tests fail, then implement**

- `WriteVsCodeConfigResult` gains `modelCount: number`.
- Extract `buildManagedModels`'s per-item body (`vscode.ts:109-135`) into
  `buildManagedModel(entry: VsCodeCapabilityEntry, tenantId: string, proxyUrl: string): VsCodeManagedModel`,
  substituting `tenantId` for both `id` and `name` and `entry.<field>` everywhere `definition.<field>`
  was read — otherwise identical.
- Add `resolveManagedModels(proxyUrl, gatewayKey)`: calls `fetchTenantModelCatalog`, maps
  `VS_CODE_CAPABILITY_TABLE` through `resolveTenantModelId` + `buildManagedModel`, drops unmatched
  families, and throws `ConfigurationError` when the result is empty (mirrors `desktop.ts:823-826`'s
  zero-match throw).
- `mergeManagedProviders` takes a precomputed `models: VsCodeManagedModel[]` parameter instead of
  calling `buildManagedModels(proxyUrl)` internally.
- `writeVsCodeLanguageModelsConfigAtPath` becomes `(configPath, proxyUrl, gatewayKey)`: awaits
  `resolveManagedModels`, passes the result into `mergeManagedProviders`, and returns
  `{ configPath, requiresSecretConfiguration, modelCount: models.length }`.
- `writeVsCodeLanguageModelsConfig` gains the `gatewayKey` parameter and forwards it.

- [ ] **Step 5: Run the full file and confirm all tests pass**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/tenant-catalog.test.ts src/cli/commands/proxy/connectors/__tests__/vscode.test.ts`

**Test-first: yes — the AC3 test (`openai.gpt-5.6-luna` written verbatim from `NON_EPAM_TENANT_FIXTURE`) fails against the current static-table `buildManagedModels`, which never calls the network.**

---

### Task 4: Thread `gatewayKey` through `connect-orchestrator.ts`

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:39` (import), `:460` (call site), `:468,477` (logging)
- Modify: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts:40,49,378-459` (mocks/assertions)

**Interfaces:**
- Consumes: `writeVsCodeLanguageModelsConfig(proxyUrl, gatewayKey, insiders)` (Task 3)

- [ ] **Step 1: Write the failing test**

In `connect-orchestrator.test.ts`, remove the `VS_CODE_SUPPORTED_MODELS: ['model-a', 'model-b', 'model-c']`
mock (line 49, no longer imported), change every `mockResolvedValue({ configPath, requiresSecretConfiguration })`
for `writeVsCodeLanguageModelsConfig` to also include `modelCount: 5`, and add:

```ts
expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalledWith(state.url, state.gatewayKey, insiders);
```

to the existing "configures VS Code" test (around line 404).

- [ ] **Step 2: Run and confirm the new assertion fails**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`

- [ ] **Step 3: Implement**

Remove the `VS_CODE_SUPPORTED_MODELS` import (`:39`). At `:460`, call
`writeVsCodeLanguageModelsConfig(state.url, state.gatewayKey, insiders)`. At `:468` and `:477`,
replace `VS_CODE_SUPPORTED_MODELS.length` with `result.modelCount`.

- [ ] **Step 4: Run and confirm all pass**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`

**Test-first: yes — `toHaveBeenCalledWith(state.url, state.gatewayKey, insiders)` fails against the current two-argument call site.**

---

### Task 5: Tenant-aware Claude Desktop resolution (`desktop.ts`)

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts:1-15` (import), `:186-226` (`selectPreferredClaudeModels`)
- Modify: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` (`selectPreferredClaudeModels` describe block, from line 345)

**Interfaces:**
- Consumes: `resolveTenantModelId` (Task 1)
- Produces: `selectPreferredClaudeModels(available, preferred?)` — signature unchanged

- [ ] **Step 1: Write the failing tests**

Add to the existing `selectPreferredClaudeModels` describe block, using a small inline fixture (not
the root file):

```ts
const VERSION_FIRST_CLAUDE_FIXTURE = ['claude-5-opus', 'claude-4-5-haiku', 'claude-4-6-sonnet'];

it('resolves version-first (non-EPAM tenant) Claude names for every preferred family', () => {
  const resolved = selectPreferredClaudeModels(VERSION_FIRST_CLAUDE_FIXTURE);
  expect(resolved).toContain('claude-5-opus');
  expect(resolved).toContain('claude-4-5-haiku');
  expect(resolved).toContain('claude-4-6-sonnet');
});

it('omits a preferred family with no match and still resolves the rest', () => {
  const resolved = selectPreferredClaudeModels(['claude-4-6-sonnet']);
  expect(resolved).toEqual(['claude-4-6-sonnet']);
});

it('never resolves a github-copilot-claude-* deployment', () => {
  const resolved = selectPreferredClaudeModels(['github-copilot-claude-sonnet-4-5']);
  expect(resolved).toEqual([]);
});
```

- [ ] **Step 2: Run and confirm the first case fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

Expected: FAIL — the current suffix-only strategies never reorder `family`/`version` tokens, so none
of `VERSION_FIRST_CLAUDE_FIXTURE` resolve.

- [ ] **Step 3: Implement**

Import `resolveTenantModelId` from `./model-name-resolver.js`. Replace the exact-match and dated-suffix
block (`desktop.ts:190-206`) with a single call per preferred name; keep the existing `-vertex` fallback
(`:207-210`) and the logging block (`:211-225`) unchanged:

```ts
const resolved: string[] = [];
for (const name of preferred) {
  const match = resolveTenantModelId(name, available);
  if (match) { resolved.push(match); continue; }
  const vertexId = `${name}-vertex`;
  if (availableSet.has(vertexId)) resolved.push(vertexId);
}
```

`selectDesktopClaudeModels` (`:240-260`) and the `/^claude-/i` filter in `fetchClaudeModels` (`:144`)
are unchanged — the third new test above is a regression check on already-correct behavior.

- [ ] **Step 4: Run and confirm all pass**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

**Test-first: yes — `selectPreferredClaudeModels(VERSION_FIRST_CLAUDE_FIXTURE)` returning `claude-5-opus` etc. fails against the current suffix-only strategies.**

---

### Task 6: Comment-preserving VS Code Claude Code settings edit

**Files:**
- Modify: `package.json` (add `jsonc-parser` dependency)
- Modify: `src/cli/commands/proxy/connectors/vscode-claude-code.ts:44-73` (`readSettings`), `:137-174`
  (`writeVsCodeClaudeCodeConfigAtPath`)
- Modify: `src/cli/commands/proxy/connectors/__tests__/vscode-claude-code.test.ts`

**Interfaces:**
- Produces: `writeVsCodeClaudeCodeConfigAtPath` — signature and `WriteVsCodeClaudeCodeConfigResult` unchanged

- [ ] **Step 1: Add the dependency**

Run: `npm install jsonc-parser`

- [ ] **Step 2: Write the failing tests**

Add to `vscode-claude-code.test.ts`, following its existing real-temp-directory style (`mkdtemp` +
`writeFile` + call the real function, no fs mocking):

```ts
const SETTINGS_WITH_COMMENTS = `{
  // keep this comment
  "editor.fontSize": 14,
  "claudeCode.environmentVariables": [
    { "name": "OTHER", "value": "1" },
  ],
}
`;

it('writes managed keys into a settings.json with comments and trailing commas', async () => {
  await mkdir(join(productDir, 'User'), { recursive: true });
  await writeFile(configPath, SETTINGS_WITH_COMMENTS);

  const result = await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');
  expect(result).toEqual({ written: true, path: configPath });

  const rawAfter = await readFile(configPath, 'utf-8');
  expect(rawAfter).toContain('// keep this comment');
  expect(rawAfter).toContain('"editor.fontSize": 14');
  expect(rawAfter).toContain('"OTHER"');
  expect(rawAfter).toContain('ANTHROPIC_BASE_URL');
  expect(rawAfter).toContain('ANTHROPIC_AUTH_TOKEN');
});

it('rejects a genuinely unparseable settings.json with a specific reason and leaves it untouched', async () => {
  await mkdir(join(productDir, 'User'), { recursive: true });
  const unbalanced = '{ "claudeCode.disableLoginPrompt": true';
  await writeFile(configPath, unbalanced);

  await expect(
    writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key')
  ).rejects.toThrow(ConfigurationError);

  const rawAfter = await readFile(configPath, 'utf-8');
  expect(rawAfter).toBe(unbalanced);
});
```

- [ ] **Step 3: Run and confirm the first case fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/vscode-claude-code.test.ts`

Expected: FAIL — current `readSettings` throws the generic "not valid JSON" message on the comment
line before any managed key is written.

- [ ] **Step 4: Implement**

`readSettings` returns `{ settings, raw }` (`raw` is `''` when the file is absent/empty) and uses
`jsonc-parser`'s `parse(raw, errors, { allowTrailingComma: true })`; a non-empty `errors` array throws
`ConfigurationError` naming the path and `printParseErrorCode(errors[0].error)`, file untouched:

```ts
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

interface SettingsReadResult { settings: Record<string, unknown>; raw: string }

async function readSettings(configPath: string): Promise<SettingsReadResult> {
  if (!existsSync(configPath)) return { settings: {}, raw: '' };
  const raw = await readFile(configPath, 'utf-8');
  if (raw.trim().length === 0) return { settings: {}, raw: '' };

  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new ConfigurationError(
      `VS Code settings at ${configPath} could not be read: ` +
      `${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}. The file was not changed.`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError(`VS Code settings must contain a JSON object: ${configPath}`);
  }
  return { settings: parsed as Record<string, unknown>, raw };
}
```

`writeVsCodeClaudeCodeConfigAtPath` (`:137-174`): when `raw` is empty, keep the existing
`JSON.stringify` path (nothing to preserve). Otherwise apply two `modify()` + `applyEdits()` passes
against the original `raw` text — one per managed key — instead of re-serializing the whole object:

```ts
const { settings, raw } = await readSettings(configPath);
const envVars = upsertManagedEnvVars(settings['claudeCode.environmentVariables'], gatewayUrl, gatewayKey);

let nextText: string;
if (raw.trim().length === 0) {
  nextText = `${JSON.stringify(
    { ...settings, 'claudeCode.disableLoginPrompt': true, 'claudeCode.environmentVariables': envVars },
    null, '\t'
  )}\n`;
} else {
  const afterFirst = applyEdits(raw, modify(raw, ['claudeCode.disableLoginPrompt'], true, {}));
  nextText = applyEdits(afterFirst, modify(afterFirst, ['claudeCode.environmentVariables'], envVars, {}));
}
```

The rest of the function (the `writeAtomically` call and its `catch`, the closing `logger.info` and
return) is unchanged.

- [ ] **Step 5: Run the full file and confirm all pass, including the pre-existing invalid-JSON test**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/vscode-claude-code.test.ts`

**Test-first: yes — the comments/trailing-comma test fails against the current strict `JSON.parse`, which throws on the first `//` comment.**

---

## Negative-constraint pass

| Constraint (spec Non-goals / task instructions) | Honored by | Check |
|---|---|---|
| Local sample-data file never committed/staged/used as a fixture path | Tasks 3, 5 | All non-EPAM-tenant-shaped fixtures (`NON_EPAM_TENANT_FIXTURE`, `VERSION_FIRST_CLAUDE_FIXTURE`) are inline literals in the test files; no task reads or paths into the root file |
| No change to `codex-model-resolver.ts` / no Codex regression | Task 1 | New resolver is a separate file; Codex connector code and its tests are untouched by every task |
| No comment-tolerant parsing added to `vscode.ts:189` | Task 6 (scope boundary) | Only `vscode-claude-code.ts` gains `jsonc-parser`; `vscode.ts:189`'s `readProviders` is not in any task's Files list |
| `github-copilot-*` excluded from VS Code Copilot BYOK and Claude Desktop | Tasks 1, 3, 5 | Resolver's `parseGptIdentity`/`parseClaudeIdentity` require the un-prefixed `gpt-`/`claude-` start, so a `github-copilot-*` id parses to `null` and never matches (Task 1 tests this directly); Task 3's AC4 test and Task 5's third test assert it end-to-end; `desktop.ts:144`'s existing filter is untouched |
| No surfacing of tenant models absent from the capability table (`glm-5`, `deepseek-v3-2`, `qwen3-coder-next`, `nemotron-3-super-120b`) | Task 3 | `resolveManagedModels` only iterates `VS_CODE_CAPABILITY_TABLE` families; an unmapped tenant id simply never gets looked up |
| No fix for the reported tenant's duplicate/multi-`default` catalog entries | none needed | No task touches catalog deduplication or `default` handling; `resolveTenantModelId`'s `pickMostRecent` only disambiguates same-identity dated duplicates, a different mechanism |
| No skipped-model reporting | Tasks 3, 5 | Unmatched families are silently dropped (`.filter`), not logged as a report to the user |
| No fully generic resolver — scoped to the two evidenced conventions | Task 1 | `parseClaudeIdentity` hardcodes the three known segments (`opus`/`sonnet`/`haiku`); Gemini/Qwen/Kimi get no parser and fall through to exact-match only |
