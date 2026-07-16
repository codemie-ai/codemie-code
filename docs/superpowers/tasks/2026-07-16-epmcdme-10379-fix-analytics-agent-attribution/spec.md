# Spec: Fix codemie analytics agent attribution

**Ticket**: EPMCDME-10379  
**Branch**: EPMCDME-10379_fix-analytics-agent-attribution  
**Date**: 2026-07-16

---

## Problem

`codemie analytics` does not show usage data for new CLI agents (`codemie-claude`,
`codemie-codex`, `codemie-gemini`, `codemie-kimi`, `codemie-opencode`). Their sessions
merge silently into rows named `claude`, `codex`, etc. and are invisible as distinct
entities.

**Root cause**: `BaseAgentAdapter.run()` sets `CODEMIE_AGENT: this.metadata.name`, which
is the short plugin name (`claude`, `codex`, …). This env var is inherited by lifecycle
hooks that write `~/.codemie/sessions/<uuid>.json`, so `agentName` in every session file
is the short name instead of the wrapper name (`codemie-claude`, …).

---

## Approach

**Approach A — derive wrapper name at session write time only.**

`CODEMIE_AGENT` stays as the short name throughout the process. Three call sites in
`hook.ts` pass it to `AgentRegistry.getAgent()`, and the backend API receives it via
`sendSessionStartMetrics`/`sendSessionEndMetrics` — both are left untouched. Only the
session file's `agentName` field is changed to the wrapper name.

---

## Changes

### 1. `src/cli/commands/hook.ts`

Add a module-level helper:

```ts
function toWrapperAgentName(name: string): string {
  return name.startsWith('codemie') ? name : `codemie-${name}`;
}
```

In `createSessionRecord()`, after reading `agentName` from `CODEMIE_AGENT`, use
`toWrapperAgentName(agentName)` for the Session object's `agentName` field only:

```ts
const session = {
  sessionId,
  agentName: toWrapperAgentName(agentName),  // was: agentName
  provider,
  ...
};
```

The re-entry branch (lines 708–734) loads an existing live session from disk — its
`agentName` was already set at creation and is not updated. The transcript marker call
(`appendTranscriptMarker(path, sessionId, agentName)`) keeps the short name since it is
used only for log markers, not for analytics.

Registry lookups, logger init, `sendSessionStartMetrics`, and `sendSessionEndMetrics`
all continue to use the short `agentName` from `CODEMIE_AGENT` unchanged.

### 2. `src/cli/commands/analytics/cost/codex-agent.ts`

Refactor `agentMatchesAnalyticsFilter` using an internal normaliser:

```ts
/** Internal: normalise legacy codemie_xxx to codemie-xxx. */
function normalizeAgentId(name: string): string {
  return name.toLowerCase().replace(/^codemie_/, 'codemie-');
}

export function agentMatchesAnalyticsFilter(sessionAgent: string, filterAgent: string): boolean {
  const filter = normalizeAgentId(filterAgent);
  const session = normalizeAgentId(sessionAgent);

  // Legacy broad match: --agent codex matches all codex family variants
  if (filter === 'codex') {
    return isCodexFamilyAgent(session);
  }

  // Exact wrapper match: --agent codemie-xxx matches only codemie-xxx sessions.
  // native-loader synthesises sessions with agentName 'claude'/'codex' for bare
  // non-wrapper runs; keeping wrapper filters narrow prevents those from leaking in.
  if (filter.startsWith('codemie-')) {
    return session === filter;
  }

  // Short-name broad match: --agent claude matches 'claude' AND 'codemie-claude'.
  // Ensures backward compat after sessions switch to wrapper name storage.
  return session === filter || session === `codemie-${filter}`;
}
```

`isCodexFamilyAgent` is unchanged.

**Filter matching table**:

| Session `agentName` | Filter | Matches | Reason |
|---|---|---|---|
| `claude` (pre-fix) | `claude` | ✓ | short broad |
| `codemie-claude` (new) | `claude` | ✓ | short broad |
| `claude` (pre-fix) | `codemie-claude` | ✗ | exact wrapper, narrow |
| `codemie-claude` (new) | `codemie-claude` | ✓ | exact wrapper |
| `codemie-codex` | `codex` | ✓ | codex family path |
| `codex` | `codemie-codex` | ✗ | exact wrapper, narrow (existing) |
| `codemie-gemini` | `gemini` | ✓ | short broad |
| `codemie-kimi` | `kimi` | ✓ | short broad |
| `codemie-opencode` | `opencode` | ✓ | short broad |
| `codemie-cli` | `codemie-cli` | ✓ | exact wrapper |
| `codemie_cli` | `codemie-cli` | ✓ | underscore normalised |
| `codemie_cli` | `codemie_cli` | ✓ | underscore normalised |
| `codemie-claude` | `codemie-gemini` | ✗ | different agent |

### 3. `src/agents/core/session/types.ts`

Update the `Session.agentName` comment from `// 'claude', 'gemini'` to
`// 'codemie-claude', 'codemie-gemini', etc.`

---

## Tests

### `src/cli/commands/analytics/cost/__tests__/codex-agent.test.ts`

Extend with:

- `agentMatchesAnalyticsFilter` parametrised tests covering: short-name broad matches
  for all new agents, exact wrapper matches, legacy underscore normalisation, existing
  codex narrow behaviour preserved, cross-agent non-match assertions.

### `src/cli/commands/analytics/__tests__/data-loader.test.ts`

Add one fixture test: write a session file with `agentName: 'codemie-claude'`, call
`matchesFilter` with `agentName: 'claude'` — assert the session is included. Add the
inverse (session `claude`, filter `codemie-claude`).

---

## Acceptance Criteria

- `codemie analytics` displays rows for all 7 CLI agent types: `codemie-cli`,
  `codemie-claude`, `codemie-codex`, `codemie-gemini`, `codemie-kimi`,
  `codemie-opencode`, `codemie_cli` (legacy underscore via bidirectional filter).
- New sessions written by wrapper agents carry the wrapper name in
  `~/.codemie/sessions/<uuid>.json`.
- `--agent claude` and `--agent codemie-claude` both match new and pre-fix sessions.
- Existing `codemie-cli` behaviour is unchanged.
- No changes to `CODEMIE_AGENT`, `AgentRegistry`, or the backend API payload.
- All new tests pass; existing tests remain green.

---

## Out of Scope

- Retroactive migration of existing session files on disk (not needed; the filter
  handles both old and new names bidirectionally).
- Backend (`codemie` repo) changes — tracked separately in MR !3762.
- `NATIVE_AGENTS` extension in `native-loader.ts` — pre-existing limitation, separate
  ticket.
