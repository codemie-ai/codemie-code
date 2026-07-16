# EPMCDME-10379: Fix analytics agent attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `codemie analytics` attribute sessions to their wrapper agent name (`codemie-claude`, etc.) instead of the short plugin name (`claude`).

**Architecture:** Two independent changes applied in order. Task 1 refactors the analytics filter to handle all seven canonical agent names (short and wrapper form). Task 2 patches the single line in `hook.ts` that stores the session's `agentName` field, and exports a helper to make that change unit-testable. Task 3 adds integration-level fixtures confirming the full read path works end-to-end.

**Tech Stack:** TypeScript, Node.js ≥ 20, Vitest

## Global Constraints

- ES modules only; all imports must include `.js` extension.
- `@/` alias maps to `/src`; use it for cross-package imports.
- Conventional Commits with allowed scope list (`analytics`, `cli`). Subject ≤ 100 chars.
- Ticket reference `EPMCDME-10379` goes in the commit body footer, not the subject.
- Run `npm run typecheck` and `npx vitest run --project unit <test-file>` after every task.
- Never use `--no-verify`.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/cli/commands/analytics/cost/codex-agent.ts` | Modify | Add internal `normalizeAgentId`; refactor `agentMatchesAnalyticsFilter` |
| `src/cli/commands/analytics/cost/__tests__/codex-agent.test.ts` | Modify | Extend with all-agent parametrised tests |
| `src/cli/commands/hook.ts` | Modify | Export `toWrapperAgentName`; use it in `createSessionRecord` |
| `src/cli/commands/__tests__/hook-agent-name.test.ts` | Create | Unit tests for `toWrapperAgentName` |
| `src/agents/core/session/types.ts` | Modify | Update `Session.agentName` comment |
| `src/cli/commands/analytics/__tests__/data-loader.test.ts` | Modify | Add wrapper-name filter fixture tests |

---

## Task 1: Extend analytics filter for all wrapper agent names

**Files:**
- Modify: `src/cli/commands/analytics/cost/codex-agent.ts`
- Modify: `src/cli/commands/analytics/cost/__tests__/codex-agent.test.ts`

**Interfaces:**
- Produces: `agentMatchesAnalyticsFilter(sessionAgent, filterAgent)` with updated semantics
  (short filter is broad, exact `codemie-` filter is narrow, legacy underscore normalised).
  `isCodexFamilyAgent` signature and behaviour unchanged.

- [ ] **Step 1: Write the failing tests**

Open `src/cli/commands/analytics/cost/__tests__/codex-agent.test.ts` and append below the existing `describe` blocks:

```ts
describe('agentMatchesAnalyticsFilter — new agents', () => {
  it.each([
    // Short-name filter: broad — matches both short and codemie- prefixed sessions
    ['claude',          'claude'],
    ['codemie-claude',  'claude'],
    ['gemini',          'gemini'],
    ['codemie-gemini',  'gemini'],
    ['kimi',            'kimi'],
    ['codemie-kimi',    'kimi'],
    ['opencode',        'opencode'],
    ['codemie-opencode','opencode'],
  ] as [string, string][])('"%s" session + "%s" filter → match (short broad)', (session, filter) => {
    expect(agentMatchesAnalyticsFilter(session, filter)).toBe(true);
  });

  it.each([
    // Exact wrapper filter: narrow — only the exact codemie- name
    ['codemie-claude',   'codemie-claude'],
    ['codemie-gemini',   'codemie-gemini'],
    ['codemie-kimi',     'codemie-kimi'],
    ['codemie-opencode', 'codemie-opencode'],
    ['codemie-cli',      'codemie-cli'],
    // Legacy underscore normalised to hyphen form
    ['codemie-cli',      'codemie_cli'],
    ['codemie_cli',      'codemie-cli'],
    ['codemie_cli',      'codemie_cli'],
  ] as [string, string][])('"%s" session + "%s" filter → match (exact wrapper)', (session, filter) => {
    expect(agentMatchesAnalyticsFilter(session, filter)).toBe(true);
  });

  it('exact codemie-claude filter does NOT match short-name claude session', () => {
    expect(agentMatchesAnalyticsFilter('claude', 'codemie-claude')).toBe(false);
  });

  it('does not cross-match different agents', () => {
    expect(agentMatchesAnalyticsFilter('codemie-claude', 'codemie-gemini')).toBe(false);
    expect(agentMatchesAnalyticsFilter('claude', 'gemini')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run --project unit src/cli/commands/analytics/cost/__tests__/codex-agent.test.ts
```

Expected: Several FAIL lines. The new `it.each` groups fail because the current
implementation uses exact-match for non-codex agents and doesn't handle `codemie_cli`.

- [ ] **Step 3: Implement the changes in `codex-agent.ts`**

Replace the entire file content:

```ts
/**
 * Agent-name helpers for analytics — family matching and CLI filter resolution.
 */

/** True when analytics should use Codex rollout parsers/readers for this agent name. */
export function isCodexFamilyAgent(agentName: string | undefined): boolean {
  const a = (agentName ?? '').toLowerCase();
  if (!a) {
    return false;
  }
  return a === 'codex' || a === 'codemie-codex' || a.includes('codex');
}

/** Internal: normalise legacy codemie_xxx → codemie-xxx (underscore form). */
function normalizeAgentId(name: string): string {
  return name.toLowerCase().replace(/^codemie_/, 'codemie-');
}

/**
 * Match session agent against a CLI --agent filter.
 *
 * Rules:
 * - `codex` filter: broad family match (legacy behaviour via isCodexFamilyAgent).
 * - `codemie-xxx` filter: exact wrapper match only (narrow).
 * - short-name filter (no prefix): matches both the short name AND `codemie-<short>`.
 * - Legacy `codemie_xxx` (underscore) in either position is normalised to `codemie-xxx`.
 */
export function agentMatchesAnalyticsFilter(sessionAgent: string, filterAgent: string): boolean {
  const filter = normalizeAgentId(filterAgent);
  const session = normalizeAgentId(sessionAgent);

  // Legacy broad match: --agent codex matches all codex family variants
  if (filter === 'codex') {
    return isCodexFamilyAgent(session);
  }

  // Exact wrapper match: --agent codemie-xxx matches only codemie-xxx sessions.
  // Keeps wrapper filters narrow so native-loader synthesised sessions (agentName
  // 'claude'/'codex') don't leak into codemie-wrapper-specific reports.
  if (filter.startsWith('codemie-')) {
    return session === filter;
  }

  // Short-name broad match: --agent claude matches 'claude' AND 'codemie-claude'.
  // Backward compat: scripts using --agent claude still see post-fix sessions stored
  // under the new wrapper name.
  return session === filter || session === `codemie-${filter}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run --project unit src/cli/commands/analytics/cost/__tests__/codex-agent.test.ts
```

Expected: All tests PASS, including the pre-existing `isCodexFamilyAgent` and
`agentMatchesAnalyticsFilter` describe blocks and all new parametrised cases.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/analytics/cost/codex-agent.ts \
        src/cli/commands/analytics/cost/__tests__/codex-agent.test.ts
git commit -m "$(cat <<'EOF'
fix(analytics): extend agentMatchesAnalyticsFilter for all wrapper agent names

Short-name filters (e.g. --agent claude) now match both the short form and the
codemie- prefixed wrapper form. Legacy codemie_xxx underscore names are normalised
to codemie-xxx. Exact wrapper filters (--agent codemie-claude) remain narrow so
native-loader synthesised sessions do not leak in.

EPMCDME-10379
EOF
)"
```

---

## Task 2: Store wrapper name in session file + export helper for testing

**Files:**
- Modify: `src/cli/commands/hook.ts`
- Create: `src/cli/commands/__tests__/hook-agent-name.test.ts`
- Modify: `src/agents/core/session/types.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export function toWrapperAgentName(name: string): string` from `hook.ts`.
  Sessions written by `createSessionRecord` will have `agentName: 'codemie-claude'` etc.

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/__tests__/hook-agent-name.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toWrapperAgentName } from '../hook.js';

describe('toWrapperAgentName', () => {
  it('prefixes short plugin names with codemie-', () => {
    expect(toWrapperAgentName('claude')).toBe('codemie-claude');
    expect(toWrapperAgentName('codex')).toBe('codemie-codex');
    expect(toWrapperAgentName('gemini')).toBe('codemie-gemini');
    expect(toWrapperAgentName('kimi')).toBe('codemie-kimi');
    expect(toWrapperAgentName('opencode')).toBe('codemie-opencode');
  });

  it('passes through names that already start with codemie', () => {
    expect(toWrapperAgentName('codemie-code')).toBe('codemie-code');
    expect(toWrapperAgentName('codemie-claude')).toBe('codemie-claude');
    expect(toWrapperAgentName('codemie-cli')).toBe('codemie-cli');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project unit src/cli/commands/__tests__/hook-agent-name.test.ts
```

Expected: FAIL — `toWrapperAgentName` is not exported from `hook.ts`.

- [ ] **Step 3: Add `toWrapperAgentName` to `hook.ts` and apply it**

Find the block that reads `CODEMIE_AGENT` in `createSessionRecord` (around line 660).
Add the helper immediately before the `createSessionRecord` function definition, and
update the session object literal inside the function.

Add after the existing imports/constants near the top of `hook.ts` (before
`createSessionRecord`), around line 650:

```ts
/**
 * Derive the wrapper agent name for session file storage.
 * CODEMIE_AGENT carries the short plugin name (e.g. 'claude') so that
 * AgentRegistry.getAgent() lookups and the backend API payload are unaffected.
 * Only the persisted session JSON uses the wrapper name.
 */
export function toWrapperAgentName(name: string): string {
  return name.startsWith('codemie') ? name : `codemie-${name}`;
}
```

Then inside `createSessionRecord`, locate the session object literal (around line 738):

```ts
    // Create session record with correlation already matched
    const session = {
      sessionId,
      agentName,
```

Change `agentName` to `agentName: toWrapperAgentName(agentName)`:

```ts
    // Create session record with correlation already matched
    const session = {
      sessionId,
      agentName: toWrapperAgentName(agentName),
```

Do NOT change any other use of `agentName` in this file — registry lookups, logger
calls, and metric senders must keep the short name.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run --project unit src/cli/commands/__tests__/hook-agent-name.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Update `Session.agentName` comment in `types.ts`**

Open `src/agents/core/session/types.ts` and find line 115:

```ts
  agentName: string; // 'claude', 'gemini'
```

Change to:

```ts
  agentName: string; // 'codemie-claude', 'codemie-gemini', etc. (wrapper name, not short plugin name)
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/hook.ts \
        src/cli/commands/__tests__/hook-agent-name.test.ts \
        src/agents/core/session/types.ts
git commit -m "$(cat <<'EOF'
fix(cli): store wrapper agent name in session file

createSessionRecord now writes agentName as 'codemie-claude' etc. instead of
the short plugin name 'claude'. CODEMIE_AGENT env var is unchanged so
AgentRegistry lookups and the backend metrics API payload are unaffected.

EPMCDME-10379
EOF
)"
```

---

## Task 3: Data-loader integration tests for wrapper-name filter

**Files:**
- Modify: `src/cli/commands/analytics/__tests__/data-loader.test.ts`

**Interfaces:**
- Consumes: `agentMatchesAnalyticsFilter` changes from Task 1 (already in place).
- Produces: regression coverage confirming the full path from session file read through
  `matchesFilter` works for wrapper-named sessions.

- [ ] **Step 1: Write the failing tests**

Open `src/cli/commands/analytics/__tests__/data-loader.test.ts`.

At the top, confirm the imports include `writeFileSync`, `mkdtempSync`, `rmSync`,
`join`, `tmpdir`, and `MetricsDataLoader`. They are already present in the existing
test file.

Append a new `describe` block at the end of the file:

```ts
describe('MetricsDataLoader.loadSessions — wrapper agent name filter', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'data-loader-wrapper-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSession(id: string, agentName: string): void {
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        startTime: 1000,
        status: 'active',
        agentName,
        provider: 'anthropic',
        workingDirectory: '/tmp/project',
      })
    );
  }

  it('includes codemie-claude session when filtering by short name claude', () => {
    writeSession('s1', 'codemie-claude');
    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ agentName: 'claude' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].startEvent?.agentName).toBe('codemie-claude');
  });

  it('includes pre-fix claude session when filtering by short name claude', () => {
    writeSession('s2', 'claude');
    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ agentName: 'claude' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].startEvent?.agentName).toBe('claude');
  });

  it('returns codemie-claude session when filtering by exact wrapper codemie-claude', () => {
    writeSession('s3', 'codemie-claude');
    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ agentName: 'codemie-claude' });
    expect(sessions).toHaveLength(1);
  });

  it('excludes pre-fix claude session when filtering by exact wrapper codemie-claude', () => {
    writeSession('s4', 'claude');
    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ agentName: 'codemie-claude' });
    expect(sessions).toHaveLength(0);
  });

  it('includes codemie-gemini session when filtering by short name gemini', () => {
    writeSession('s5', 'codemie-gemini');
    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ agentName: 'gemini' });
    expect(sessions).toHaveLength(1);
  });

  it('matches codemie_cli (underscore) session when filtering by codemie-cli (hyphen)', () => {
    writeSession('s6', 'codemie_cli');
    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ agentName: 'codemie-cli' });
    expect(sessions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
npx vitest run --project unit src/cli/commands/analytics/__tests__/data-loader.test.ts
```

Expected: All tests PASS. The new tests pass immediately because Task 1 already
implemented the filter logic they exercise. No production code change is needed here.

- [ ] **Step 3: Run the full unit suite to confirm no regressions**

```bash
npm run test:unit
```

Expected: All tests PASS.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/analytics/__tests__/data-loader.test.ts
git commit -m "$(cat <<'EOF'
test(analytics): add wrapper-name filter fixture tests for data-loader

Verifies that codemie-claude sessions are included by --agent claude (short broad),
excluded by --agent codemie-claude if stored as the pre-fix short name, and that
legacy codemie_cli (underscore) sessions are matched by codemie-cli (hyphen) filter.

EPMCDME-10379
EOF
)"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by |
|---|---|
| Session file stores `codemie-claude` etc. | Task 2: `toWrapperAgentName` in `createSessionRecord` |
| Analytics filter handles all 7 agent types | Task 1: `normalizeAgentId` + `agentMatchesAnalyticsFilter` |
| Legacy `codemie_cli` underscore handled | Task 1: `normalizeAgentId` strips underscore form |
| `codemie-cli` exact match works | Task 1: exact wrapper path |
| Backward compat: `--agent claude` still works | Task 1: short-name broad path |
| Existing codex narrow behaviour preserved | Task 1: codex family path unchanged |
| `Session.agentName` comment updated | Task 2 Step 5 |
| Tests for each new agent type | Tasks 1 + 3 |
| No changes to `CODEMIE_AGENT`, registry, or backend API | Task 2: only session object field changed |

**Placeholder scan:** No TBDs or incomplete steps found.

**Type consistency:** `toWrapperAgentName` defined and exported in Task 2 Step 3; consumed in the same step; tested in Step 1. No cross-task type mismatches.
