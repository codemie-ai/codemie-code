# Design: Add Gemini CLI to Analytics Report

**Date**: 2026-08-05
**Ticket**: EPMCDME-13909
**Status**: Approved

## Problem

`codemie analytics` ignores codemie-gemini session data. The Gemini plugin (`src/agents/plugins/gemini/`) is fully registered and has a session adapter that can parse session files, but `GeminiSessionAdapter` never implemented `discoverSessions()`. The native-loader therefore skips it silently — `NATIVE_AGENTS` does not include `'gemini'`, so discovery is never attempted.

## Solution

Implement `discoverSessions()` on `GeminiSessionAdapter` and add `'gemini'` to `NATIVE_AGENTS`. This slots gemini into the established three-layer analytics pattern used by every other agent (claude, codex, copilot-cli).

## Architecture

Five files change; no new abstractions beyond a small paths helper.

| File | Change |
|---|---|
| `src/agents/plugins/gemini/gemini.paths.ts` | **New** — path helpers for discovery, mirrors `copilot-cli.paths.ts` |
| `src/agents/plugins/gemini/gemini.session-adapter.ts` | Add `discoverSessions(options?)` method |
| `src/cli/commands/analytics/native-loader.ts` | Add `'gemini'` to `NATIVE_AGENTS` |
| `src/cli/commands/analytics/agent-labels.ts` | Add `'gemini': 'Gemini CLI'` |
| `src/cli/commands/analytics/report/client/app.js` | Add `gemini` entry to inline `AGENT_LABELS` and `AGENT_COLORS` |

The `synthesizeRawSession` path in `native-loader.ts` handles non-Codex agents without changes. `projectPath` will be `undefined` from the descriptor (no reverse-hash mapping exists in the Gemini CLI); the loader falls back to `'Unknown'`.

## Components

### `gemini.paths.ts` (new, ~15 lines)

```ts
export function getGeminiHome(): string {
  return process.env.GEMINI_HOME?.trim() || resolveHomeDir('.gemini');
}

export function getGeminiTmpRoot(): string {
  return join(getGeminiHome(), 'tmp');
}
```

Respects `GEMINI_HOME` environment override, consistent with how `copilot-cli.paths.ts` respects `COPILOT_HOME`.

### `discoverSessions()` on `GeminiSessionAdapter` (~60 lines)

Gemini session files live at `~/.gemini/tmp/{projectHash}/chats/{sessionId}.json`. Each file is a self-contained JSON object with `sessionId`, `projectHash`, `startTime`, `lastUpdated`, and `messages[]`.

Discovery algorithm:
1. Read `~/.gemini/tmp/` — each entry is a hash directory (one per project)
2. For each hash dir, read `chats/` — each `*.json` is a session file
3. Read only the header fields (`sessionId`, `startTime`, `lastUpdated`) — no full parse at discovery time
4. Apply `maxAgeDays` cutoff on `startTime`; skip files that fail JSON parse (never throw)
5. Return `SessionDescriptor[]` with:
   - `sessionId` — from file content
   - `filePath` — absolute path to the `.json` file
   - `createdAt` — `Date.parse(startTime)` in ms
   - `updatedAt` — `Date.parse(lastUpdated)` in ms
   - `projectPath` — `undefined` (no reverse hash mapping available)

### `NATIVE_AGENTS` in `native-loader.ts`

```ts
const NATIVE_AGENTS = ['claude', 'codex', 'copilot-cli', 'gemini'] as const;
```

### Labels

`agent-labels.ts`:
```ts
const AGENT_LABELS: Record<string, string> = {
  'copilot-cli': 'GitHub Copilot CLI',
  'gemini': 'Gemini CLI',
};
```

`src/cli/commands/analytics/report/client/app.js` — add matching entries to the inline `AGENT_LABELS` object and pick a color for `AGENT_COLORS` from the existing palette (the report handles unknown agents gracefully, so this is cosmetic).

## Data Flow

```
getGeminiTmpRoot()
  → readdirSync(tmp/)            [hash directories, one per project]
    → readdirSync(hash/chats/)   [*.json session files]
      → read header → SessionDescriptor
        → native-loader dedup    (skip if already tracked by CodeMie)
          → parseSessionFile()   (existing GeminiSessionAdapter method)
            → synthesizeRawSession()
              → aggregator → formatter / HTML report
```

## Error Handling

- Absent `~/.gemini/tmp` → return `[]` (same as copilot-cli when its directory is missing)
- Unreadable hash directory or `chats/` subdirectory → log at `debug`, skip, continue
- Malformed JSON in a session file → log at `debug`, skip that file, continue
- Empty `messages[]` → `parseSessionFile` already handles this gracefully (returns a valid `ParsedSession` with empty metrics)
- No `GEMINI_HOME` set → default to `resolveHomeDir('.gemini')`

No error ever propagates out of `discoverSessions()`.

## Testing

Three new test files, mirroring the copilot-cli test split:

### `src/agents/plugins/gemini/__tests__/gemini.discovery.test.ts`

Unit tests for `discoverSessions` using injected/mocked filesystem:
- Empty `tmp/` dir → returns `[]`
- `tmp/` does not exist → returns `[]`
- `chats/` missing from hash dir → skips that dir
- Malformed JSON in `chats/` → skips that file, returns others
- `maxAgeDays` cutoff → old sessions excluded, recent ones included
- `GEMINI_HOME` env override → uses custom path
- Valid session files → returns correct `SessionDescriptor` fields

### `src/cli/commands/analytics/__tests__/native-loader.test.ts`

Extend existing file with a gemini case:
- Gemini session discovered and synthesized into `RawSessionData`
- Already-tracked gemini session is deduped (not double-counted)

Uses existing fixture files from `tests/integration/metrics/fixtures/gemini/`.

### `src/cli/commands/analytics/__tests__/agent-labels.test.ts`

Verify `agentLabel('gemini')` returns `'Gemini CLI'`; `agentLabel('unknown-agent')` returns `'unknown-agent'` unchanged.

## Acceptance Criteria Mapping

| Criterion | How satisfied |
|---|---|
| `codemie analytics` includes gemini data | `'gemini'` in `NATIVE_AGENTS` + `discoverSessions` implemented |
| Aggregated consistently with other agents | Same `synthesizeRawSession` → aggregator path |
| Report reflects Gemini sessions/usage | Label + (optional) color in report client |
| No regression on existing agents | Only additive changes; existing `NATIVE_AGENTS` entries unchanged |
| Validated with codemie-gemini session dataset | Integration test uses fixture files; CI gate |
| Graceful empty-state when no Gemini data | `discoverSessions` returns `[]` when tmp dir absent |

## Out of Scope

- Resolving `projectHash` → project path (no reverse mapping exists in Gemini CLI)
- Cost enrichment for gemini sessions (no pricing data available yet; can be added separately)
- Changes to codemie-tracked (hook-driven) gemini session processing
