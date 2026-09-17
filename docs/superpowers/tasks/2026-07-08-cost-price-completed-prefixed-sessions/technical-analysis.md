# Technical Research

**Task**: analytics cost-enricher session data-loader correlation
**Generated**: 2026-07-09
**Research path**: codegraph

---

## 1. Original Context

Fix: the analytics cost enricher fails to price sessions whose CodeMie session-metadata file has the `completed_` filename prefix (renamed by hook.ts on SessionEnd). Root cause: `realDeps.loadAgentSessionFile` in src/cli/commands/analytics/cost/cost-enricher.ts constructs the correlation-metadata path as `~/.codemie/sessions/${raw.sessionId}.json` (bare UUID only) and throws ENOENT when only `completed_<id>.json` exists, returning null → hadLog=false → priced=false, even though the native agent transcript and correlation.agentSessionFile both exist. Chosen fix (Option B): populate `RawSessionData.agentSessionFile` inside `MetricsDataLoader.loadSession` (src/cli/commands/analytics/data-loader.ts) from the `sessionMetadata.correlation.agentSessionFile` it ALREADY parses, so the enricher's existing first branch (`if (raw.agentSessionFile) return raw.agentSessionFile`) handles tracked sessions and never does the second hardcoded read.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/analytics/data-loader.ts:254` — **the fix site**. `loadSession` returns the `RawSessionData` literal with no `agentSessionFile`:
  - `return { sessionId, startEvent, endEvent, deltas };`
- `src/cli/commands/analytics/data-loader.ts:193` — `sessionMetadata` is parsed as the whole metadata JSON, so `sessionMetadata.correlation.agentSessionFile` is already in scope but never extracted (only `startTime`, `endTime`, `status`, `agentName`, `provider`, `workingDirectory` are read at lines 200-223):
  - `const sessionMetadata = JSON.parse(readFileSync(sessionFile, 'utf-8'));`
- `src/cli/commands/analytics/data-loader.ts:264-270` — `resolveSessionPath` already implements the `completed_` fallback for both suffixes (called at lines 188-189 for `.json` and `_metrics.jsonl`), so `loadSession` DOES read the `completed_`-prefixed metadata correctly. The bug is purely that it drops `agentSessionFile`:
  ```ts
  private resolveSessionPath(sessionId: string, suffix: string): string {
    const active = join(this.sessionsDir, `${sessionId}${suffix}`);
    if (existsSync(active)) {
      return active;
    }
    return join(this.sessionsDir, `completed_${sessionId}${suffix}`);
  }
  ```
- `src/cli/commands/analytics/data-loader.ts:142-147` — `loadSessions` strips the `completed_` prefix to derive the bare `sessionId`, then passes the bare id to `loadSession` (line 164). Confirms the queried/returned `sessionId` is always the bare UUID (which is exactly why the enricher's `${raw.sessionId}.json` read misses the `completed_` file).

### Architecture and Layers Affected

- **Analytics data-access layer** — `MetricsDataLoader` in `data-loader.ts` (the single fix). One object-literal field addition.
- **Analytics cost/enrichment layer** — `cost-enricher.ts` (no code change; its existing first branch consumes the newly-populated field).
- **Session/correlation domain** (read-only reference) — `src/agents/core/session/types.ts` defines the `CorrelationResult` shape being consumed; `hook.ts` writes and renames the metadata file.

The change is confined to the analytics read path. No API, workflow, or persistence-write code is touched.

### Integration Points

- `data-loader.ts` reads `~/.codemie/sessions/{completed_}<id>.json` metadata whose `correlation` field is produced by the session-correlation domain (`src/agents/core/session/`).
- The `completed_` rename is applied in `src/cli/commands/hook.ts:982` `renameSessionFiles(sessionId)` (invoked at line 227 in `handleSessionEnd`) via `addCompletedPrefix`, renaming `{id}.json → completed_{id}.json` (plus `_metrics.jsonl`, `_conversation.jsonl`). The `correlation` object is created earlier at SessionStart (`createSessionRecord`, hook.ts:171-172) and persisted by `SessionStore.saveSession` (`src/agents/core/session/SessionStore.ts:22-41`).
- Downstream, `cost-enricher.ts` consumes `RawSessionData.agentSessionFile` to locate the native transcript for pricing.

### Patterns and Conventions

- **RawSessionData interface** — `src/cli/commands/analytics/data-loader.ts:106-117`. Current `agentSessionFile` field + doc comment:
  ```ts
  /**
   * Native agent log path, set for sessions discovered directly from agent logs
   * (not tracked by CodeMie). When present, the cost enricher prices from this path
   * instead of the ~/.codemie/sessions correlation file.
   */
  agentSessionFile?: string;
  ```
  Field is optional (`?: string`), so populating it for tracked sessions is type-safe and changes no signature. Broadening the semantics (now also set for CodeMie-tracked sessions) makes the doc comment stale/contradictory ("not tracked by CodeMie" / "instead of the correlation file") — it should be reworded, e.g. "path resolved either from native discovery or from the CodeMie correlation record." No type usage depends on the native-only invariant.

- **CorrelationResult type** (shape of `sessionMetadata.correlation`) — `src/agents/core/session/types.ts:25-31`, type of `Session.correlation` (line 124):
  ```ts
  export interface CorrelationResult {
    status: CorrelationStatus;        // 'pending' | 'matched' | 'failed'  (line 20)
    agentSessionFile?: string; // Path to matched file
    agentSessionId?: string;   // Extracted session ID
    detectedAt?: number;       // Unix timestamp (ms)
    retryCount: number;
  }
  ```
  Both `correlation` (may be absent) and `agentSessionFile` (`?: string`) are optional. The fix MUST use optional chaining `sessionMetadata.correlation?.agentSessionFile` so uncorrelated / `status: 'pending'` sessions leave the field `undefined` and fall through to the enricher's existing null path (behavior unchanged for those).

- **Enricher branches** — `src/cli/commands/analytics/cost/cost-enricher.ts:58-74` (`realDeps.loadAgentSessionFile`):
  ```ts
  async loadAgentSessionFile(raw) {
    // Native-discovered sessions carry their log path directly (no CodeMie correlation file).
    if (raw.agentSessionFile) {
      return raw.agentSessionFile;          // first branch — the fix's target
    }
    try {
      const metaPath = getCodemiePath('sessions', `${raw.sessionId}.json`);   // bare UUID — misses completed_
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as {
        correlation?: { agentSessionFile?: string };
      };
      return meta.correlation?.agentSessionFile ?? null;
    } catch {
      return null;                          // ENOENT on completed_<id>.json swallowed here — root cause
    }
  }
  ```
  `hadLog`/`priced` derivation — `cost-enricher.ts:99-105` (`parseOne`) and `:137` (`priceUsage`):
  ```ts
  const filePath = await deps.loadAgentSessionFile(raw);
  const hadLog = filePath != null;
  const parsed = filePath ? await deps.parseNative(agentName, filePath, raw.sessionId) : null;
  // ...
  priced: perModel.length > 0
  ```
  `filePath === null` → `hadLog=false`, `parsed=null` → empty `usageByModel` → `priced=false`. Populating `raw.agentSessionFile` makes the first branch return the path, so both become true.

---

## 3. Documentation Findings

### Guides and Architecture Docs

Relevant P0/P1 guides for this task (per AGENTS.md Task Classifier — keywords `test`/`vitest` and `architecture`):
- `.ai-run/guides/testing/testing-patterns.md` — Vitest conventions (regression test goes here per project policy).
- `.ai-run/guides/architecture/architecture.md` — 5-layer analytics/plugin architecture (confirms the data-access vs. enrichment layer boundary respected by Option B).

Prior planning artifacts for the same analytics area exist under `docs/superpowers/` (recent commits `5dcd819`, `ad17d3b` added sdlc-light planning artifacts for a related session-filter bug), indicating an established run-directory convention.

### Architectural Decisions

- Inline decision comment at `cost-enricher.ts:61` ("Native-discovered sessions carry their log path directly (no CodeMie correlation file).") documents the original native-only intent of the first branch. Option B deliberately reuses this branch for tracked sessions — the comment context is why the RawSessionData doc comment must be updated in tandem.

### Derived Conventions

- Object construction in the loader is a plain literal; the fix follows the existing style — add one optional field, no helper/abstraction.
- `RawSessionData.sessionId` is always the bare UUID by convention (loadSessions strips `completed_`), so any bare-UUID path construction downstream (the enricher fallback) is inherently blind to the `completed_` file — the reason resolution must happen in the loader.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/analytics/__tests__/data-loader.test.ts` — Vitest. Real-fs temp dirs via `mkdtempSync(join(tmpdir(), 'data-loader-test-'))` (`beforeEach`, line 56), cleaned with `rmSync(dir, {recursive, force})` (`afterEach`, line 60); fixtures written with `writeFileSync`. Helper `writeCompletedSession(id)` (lines 63-75) writes `completed_${id}.json` with `{startTime, endTime, status:'completed', agentName, provider, workingDirectory}` — **it writes NO `correlation` key**. There is currently **zero coverage asserting `agentSessionFile` is populated by the loader**. Existing block: `describe('MetricsDataLoader.loadSessions — completed_ prefixed sessions', ...)` opens at line 52.
- `src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts` — Vitest. Fully dependency-injected `EnricherDeps` (no fs/registry): `baseDeps` (lines 13-23) stubs `loadAgentSessionFile: async () => '/fake/s1.jsonl'`; raw sessions are inline `as never[]` literals (line 11). The only `realDeps` exercise is the `acceptance:` block (line 498) which is `it.skip` in CI and uses `sessionEntry(...)` that sets `agentSessionFile` directly (lines 508-522) — proving the first branch works end-to-end but not run in CI.

### Testing Framework and Patterns

- **Vitest** (`vitest ^4.1.5`), `import { describe, it, expect, beforeEach, afterEach } from 'vitest'`.
- data-loader tests: real temp fs + JSON fixtures written to disk.
- cost-enricher tests: pure dependency injection, no fs.

### Coverage Gaps

- `loadSession` (`data-loader.ts:187`) has **no covering tests**.
- `parseOne` / `realDeps.loadAgentSessionFile` (`cost-enricher.ts:99` / `:60`) have **no covering tests** for the ENOENT-on-`completed_` path.
- **Where the regression test goes (load-bearing):** add an `it(...)` inside `describe('MetricsDataLoader.loadSessions — completed_ prefixed sessions', ...)` (after the last test, ~line 163, before the closing `});` at line 164). Write a `completed_<id>.json` variant that includes `correlation: { status: 'matched', agentSessionFile: '/some/log.jsonl', retryCount: 0 }` (the existing `writeCompletedSession` helper omits `correlation`, so a variant is needed), then assert `sessions[0].agentSessionFile === '/some/log.jsonl'`.
- Optional secondary guard: a `describe('realDeps.loadAgentSessionFile', ...)` in cost-enricher.test.ts asserting the first branch returns `raw.agentSessionFile` without touching fs (add after the `enrichCosts` block closes ~line 297, or after the acceptance block ~line 543).

---

## 5. Configuration and Environment

### Environment Variables

None relevant to this fix. Session metadata location is derived via `getCodemiePath('sessions', ...)` (see `src/utils/paths.ts`), not an env var read in this path.

### Configuration Files

- Metadata files live under `~/.codemie/sessions/` (`getCodemiePath`); tests substitute a `mkdtempSync` directory and inject it via the loader's `sessionsDir`. No config file governs this behavior.

### Feature Flags and Deployment Concerns

None. The fix is a pure in-process data-transformation change with no flag, deployment, or secrets implications.

---

## 6. Risk Indicators

- **Uncorrelated-session correctness (highest):** `correlation` may be absent or `status: 'pending'` with no `agentSessionFile`. The fix MUST use `sessionMetadata.correlation?.agentSessionFile` — plain access risks setting `agentSessionFile: undefined` on a missing `correlation` or throwing. Optional chaining keeps such sessions `undefined` → existing enricher null path → `priced=false` (no regression).
- **Stale doc comment:** after the fix, `RawSessionData.agentSessionFile` comment (`data-loader.ts:112-114`, "not tracked by CodeMie" / "instead of the correlation file") is factually wrong. Reword to cover tracked sessions, or the invariant becomes misleading for future readers.
- **Coverage gap on the exact bug path:** `loadSession`, `parseOne`, and `realDeps.loadAgentSessionFile` are untested for the `completed_` case. The data-loader regression test is the load-bearing addition; without it the fix is unverified.
- **Test fixture helper omits `correlation`:** `writeCompletedSession` (data-loader.test.ts:63-75) writes no `correlation` key, so the regression test can't reuse it directly — needs a correlation-carrying variant, or the helper must be extended.
- **CI blind spot:** the only end-to-end proof of the first branch (`acceptance:` block, cost-enricher.test.ts:498) is `it.skip` in CI — so the enricher-side behavior is not guarded by CI today.
- **Low blast radius (favorable):** `RawSessionData.agentSessionFile` is read functionally in exactly ONE place — `cost-enricher.ts:62`. `native-loader.ts:350,:440` are write-sites (native synthesis, own objects); `aggregator.ts`, `otel-loader.ts`, and `sources/` reference `RawSessionData` but do NOT read `agentSessionFile`. No collateral consumer impact.

---

## 7. Summary for Complexity Assessment

This is a **surgical, single-layer bug fix**. The production code change is one line: add `agentSessionFile: sessionMetadata.correlation?.agentSessionFile` (optional-chained) to the `RawSessionData` object literal returned at `data-loader.ts:254`, sourcing from metadata the same method already parses at line 193. No new abstraction, no signature change (the field is already optional `?: string`), and the consuming enricher branch (`cost-enricher.ts:62`) already exists and is unchanged. Layers touched: analytics data-access only (with the cost-enrichment layer benefiting passively). Expected production file change surface: **1 file, ~1-3 lines** (plus a doc-comment reword in the same file).

Technical novelty is **near zero** — the fix reuses an established, already-tested branch and follows the existing plain-object-literal construction convention; `resolveSessionPath` already handles the `completed_` fallback for metadata reads, so the domain pattern is proven. The one real correctness subtlety is optional chaining for uncorrelated/`pending` sessions, which is a well-understood guard, not a novel pattern.

Test coverage posture is **mixed-to-weak on the exact path**: the affected `loadSession`/`parseOne`/`loadAgentSessionFile` code has no direct coverage, and the only end-to-end enricher proof is `it.skip` in CI. However, the test harness is mature (Vitest, real-fs temp dirs with a clear insertion point in the existing `completed_ prefixed sessions` describe block), so adding a load-bearing regression test is straightforward and low-risk. Net: **low complexity, low blast radius, single-file change**; the primary risks are non-code (stale comment, missing regression test, uncorrelated-session guard) rather than architectural.
