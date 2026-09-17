# Analytics Sessions: "Source" Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Source" column to the analytics report's Sessions table (right after "Branch") that classifies each session by which SDLC tooling/framework it used — CodeMie AI Factory, Superpowers, OpenSpec, SpecKit, BMAD, or "Pure chat" when no signal is found.

**Architecture:** A new pure, ordered Strategy-pattern module (`session-source-detector.ts`) inspects the skill/agent/command invocation names already flowing through the report pipeline (`skillInvocations`/`agentInvocations`/`commandInvocations` on each session) and returns the first matching bundle's label, first-match-wins. It is wired in once, at `payload-builder.ts` (the single place `ReportSessionRecord` objects are constructed), adding one new `sessionSource: string` field. The client (`app.js`) renders that field as a new table column. No new telemetry/capture is needed — the raw invocation-name data already reaches this layer.

**Tech Stack:** TypeScript (ES modules), Vitest, vanilla JS client (`report/client/app.js`).

---

## Clarification assumptions

- Per user decision: SpecKit/BMAD detection uses invocation-name matching only (same mechanism as the other bundles) — no filesystem/workingDirectory marker inspection, even though those two frameworks are elsewhere implemented in this repo via `.specify/`/`_bmad/` init markers. This is a known, accepted under-detection risk for sessions where SpecKit/BMAD are used purely via filesystem workflow with no named skill/agent/command invocation captured.
- Priority order (first-match-wins) follows the user's stated precedence: CodeMie AI Factory (sdlc-factory) > Superpowers > OpenSpec > SpecKit > BMAD > Pure chat.
- CSV export (`report/exporter.ts`) is explicitly out of scope — the request is about the dashboard table only.
- `SessionAnalytics`/`aggregator.ts` are NOT touched — `ReportSessionRecord` already carries `skillInvocations`/`agentInvocations`/`commandInvocations`, so classification happens once, at payload-build time, keeping the change surface minimal.

---

### Task 1: Session-source detector module (Strategy pattern)

**Files:**
- Create: `src/cli/commands/analytics/report/session-source-detector.ts`
- Test: `src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts`

**Test-first: yes — detector returns the correct label per bundle and falls back to "Pure chat" with no signal.**

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts
import { describe, it, expect } from 'vitest';
import { detectSessionSource, SESSION_SOURCE_DETECTORS } from '../session-source-detector.js';
import type { NamedInvocationStats } from '../../types.js';

function names(list: string[]): NamedInvocationStats[] {
  return list.map((name) => ({ name, totalCalls: 1, successCount: 1, failureCount: 0 }));
}

function session(over: { skill?: string[]; agent?: string[]; command?: string[] }) {
  return {
    skillInvocations: names(over.skill ?? []),
    agentInvocations: names(over.agent ?? []),
    commandInvocations: names(over.command ?? []),
  };
}

describe('detectSessionSource', () => {
  it('labels a session with a namespaced sdlc-factory agent invocation as CodeMie AI Factory', () => {
    expect(detectSessionSource(session({ agent: ['sdlc-factory:tech-analyst'] }))).toBe('CodeMie AI Factory');
  });

  it('labels a session with an unnamespaced sdlc-light/-task/-autonomous slash command as CodeMie AI Factory', () => {
    expect(detectSessionSource(session({ command: ['sdlc-light'] }))).toBe('CodeMie AI Factory');
    expect(detectSessionSource(session({ command: ['sdlc-task'] }))).toBe('CodeMie AI Factory');
    expect(detectSessionSource(session({ command: ['sdlc-autonomous'] }))).toBe('CodeMie AI Factory');
  });

  it('labels a session with a superpowers skill as Superpowers when no sdlc-factory signal is present', () => {
    expect(detectSessionSource(session({ skill: ['superpowers:test-driven-development'] }))).toBe('Superpowers');
  });

  it('prioritizes CodeMie AI Factory over Superpowers when both are present in one session', () => {
    expect(detectSessionSource(session({ skill: ['superpowers:brainstorming'], command: ['sdlc-light'] }))).toBe('CodeMie AI Factory');
  });

  it('labels a session with an openspec-named invocation as OpenSpec', () => {
    expect(detectSessionSource(session({ skill: ['openspec:apply'] }))).toBe('OpenSpec');
    expect(detectSessionSource(session({ command: ['open-spec-init'] }))).toBe('OpenSpec');
  });

  it('labels a session with a speckit-named invocation as SpecKit', () => {
    expect(detectSessionSource(session({ agent: ['speckit-planner'] }))).toBe('SpecKit');
  });

  it('labels a session with a bmad-named invocation as BMAD', () => {
    expect(detectSessionSource(session({ skill: ['bmad:architect'] }))).toBe('BMAD');
  });

  it('falls back to Pure chat when no known signal is found', () => {
    expect(detectSessionSource(session({ skill: ['some-other-skill'], command: ['analytics'] }))).toBe('Pure chat');
    expect(detectSessionSource(session({}))).toBe('Pure chat');
  });

  it('matches case-insensitively', () => {
    expect(detectSessionSource(session({ agent: ['SDLC-Factory:Foo'] }))).toBe('CodeMie AI Factory');
  });

  it('exposes the ordered detector list for callers that need custom ordering/extension', () => {
    expect(SESSION_SOURCE_DETECTORS.map((d) => d.name)).toEqual(['sdlc-factory', 'superpowers', 'openspec', 'speckit', 'bmad']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts`
Expected: FAIL — `Cannot find module '../session-source-detector.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/cli/commands/analytics/report/session-source-detector.ts
/**
 * Session-source classification: labels each session by the SDLC tooling/framework
 * signal found in its skill/agent/command invocation names. Ordered, first-match-wins
 * strategy list — new bundles register by adding an entry here, not by editing a
 * branching if/else chain. Detection is name-based only (skill/agent/command names
 * already captured by the report pipeline); it does not inspect the filesystem.
 */

import type { NamedInvocationStats } from '../types.js';

export interface SessionInvocationNames {
  skillInvocations: NamedInvocationStats[];
  agentInvocations: NamedInvocationStats[];
  commandInvocations: NamedInvocationStats[];
}

export interface SessionSourceDetector {
  /** Stable id, e.g. 'sdlc-factory'. */
  name: string;
  /** Display label shown in the report's Source column when this detector matches. */
  label: string;
  /** True if any invocation name (already lowercased) signals this bundle. */
  matches(names: string[]): boolean;
}

export const PURE_CHAT_LABEL = 'Pure chat';

function collectNames(session: SessionInvocationNames): string[] {
  return [...session.skillInvocations, ...session.agentInvocations, ...session.commandInvocations].map((n) =>
    n.name.toLowerCase()
  );
}

function hasPrefix(names: string[], prefix: string): boolean {
  return names.some((n) => n.startsWith(prefix));
}

function hasExact(names: string[], candidates: string[]): boolean {
  return names.some((n) => candidates.includes(n));
}

function hasSubstring(names: string[], substrings: string[]): boolean {
  return names.some((n) => substrings.some((s) => n.includes(s)));
}

// Unnamespaced slash commands from the external sdlc-factory skill bundle — distinct
// from the namespaced `sdlc-factory:` prefix seen on skill/agent invocations.
const SDLC_FACTORY_COMMANDS = ['sdlc-light', 'sdlc-task', 'sdlc-autonomous'];

export const SESSION_SOURCE_DETECTORS: SessionSourceDetector[] = [
  {
    name: 'sdlc-factory',
    label: 'CodeMie AI Factory',
    matches: (names) => hasPrefix(names, 'sdlc-factory:') || hasExact(names, SDLC_FACTORY_COMMANDS),
  },
  {
    name: 'superpowers',
    label: 'Superpowers',
    matches: (names) => hasPrefix(names, 'superpowers:'),
  },
  {
    name: 'openspec',
    label: 'OpenSpec',
    matches: (names) => hasSubstring(names, ['openspec', 'open-spec']),
  },
  {
    name: 'speckit',
    label: 'SpecKit',
    matches: (names) => hasSubstring(names, ['speckit', 'spec-kit']),
  },
  {
    name: 'bmad',
    label: 'BMAD',
    matches: (names) => hasSubstring(names, ['bmad']),
  },
];

/**
 * Classify a session's tooling/framework source. Detectors are tried in order;
 * the first match wins. Falls back to {@link PURE_CHAT_LABEL} when none match.
 */
export function detectSessionSource(
  session: SessionInvocationNames,
  detectors: SessionSourceDetector[] = SESSION_SOURCE_DETECTORS
): string {
  const names = collectNames(session);
  for (const detector of detectors) {
    if (detector.matches(names)) {
      return detector.label;
    }
  }
  return PURE_CHAT_LABEL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/analytics/report/session-source-detector.ts src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts
git commit -m "feat(analytics): add session-source detector with strategy-pattern registry"
```

---

### Task 2: Add `sessionSource` field to `ReportSessionRecord`

**Files:**
- Modify: `src/cli/commands/analytics/report/types.ts:34-36`

**Test-first: no — type-only change; covered by Task 3's payload-builder test (a TS compile error surfaces immediately if the field is missing/misspelled).**

- [ ] **Step 1: Add the field**

In `src/cli/commands/analytics/report/types.ts`, change:

```typescript
  skillInvocations: NamedInvocationStats[];
  agentInvocations: NamedInvocationStats[];
  commandInvocations: NamedInvocationStats[];
```

to:

```typescript
  skillInvocations: NamedInvocationStats[];
  agentInvocations: NamedInvocationStats[];
  commandInvocations: NamedInvocationStats[];
  /** Tooling/framework classified from the invocation names above — see session-source-detector.ts. */
  sessionSource: string;
```

- [ ] **Step 2: Confirm the type-checker flags the now-incomplete object literal**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: FAIL — `Property 'sessionSource' is missing in type ... ReportSessionRecord` at `payload-builder.ts` (fixed in Task 3).

- [ ] **Step 3: Commit is deferred to Task 3** (keeping the type change and its only call site in one commit avoids a broken intermediate state).

---

### Task 3: Wire the detector into `payload-builder.ts`

**Files:**
- Modify: `src/cli/commands/analytics/report/payload-builder.ts:10, 84-86`
- Test: `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts`

**Test-first: yes — payload builder must compute and attach `sessionSource` per record.**

- [ ] **Step 1: Write the failing test**

Add to `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts` (after the existing "passes skillInvocations..." test, around line 233):

```typescript
  it('classifies sessionSource from invocation names, defaulting to Pure chat', () => {
    const withCommand = {
      ...root,
      projects: [{
        projectPath: '/repo/app',
        branches: [{ branchName: 'main', sessions: [session({ commandInvocations: [{ name: 'sdlc-light', totalCalls: 1, successCount: 1, failureCount: 0 }] })] }],
      }],
    } as unknown as RootAnalytics;
    const payload = buildPayload(withCommand, costIndex, summary, {
      rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z',
    });
    expect(payload.sessions[0].sessionSource).toBe('CodeMie AI Factory');

    const bare = buildPayload(root, costIndex, summary, {
      rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z',
    });
    expect(bare.sessions[0].sessionSource).toBe('Pure chat');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts`
Expected: FAIL — `expect(received).toBe(expected)` — `sessionSource` is `undefined`.

- [ ] **Step 3: Wire the detector in the implementation**

In `src/cli/commands/analytics/report/payload-builder.ts`, add the import (line 10 area):

```typescript
import type { ReportPayload, ReportSessionRecord, ReportMeta } from './types.js';
import { detectSessionSource } from './session-source-detector.js';
```

Then change the invocation block (currently lines 84-86) plus the object literal that pushes into `sessions`. Replace:

```typescript
        agents.add(s.agentName);
```

through:

```typescript
          skillInvocations: s.skillInvocations ?? [],
          agentInvocations: s.agentInvocations ?? [],
          commandInvocations: s.commandInvocations ?? [],
        });
```

with:

```typescript
        agents.add(s.agentName);
        const skillInvocations = s.skillInvocations ?? [];
        const agentInvocations = s.agentInvocations ?? [];
        const commandInvocations = s.commandInvocations ?? [];
```

(keep the rest of the existing block — `cov`, etc. — unchanged), and change the tail of the `sessions.push({...})` object literal from:

```typescript
          skillInvocations: s.skillInvocations ?? [],
          agentInvocations: s.agentInvocations ?? [],
          commandInvocations: s.commandInvocations ?? [],
        });
```

to:

```typescript
          skillInvocations,
          agentInvocations,
          commandInvocations,
          sessionSource: detectSessionSource({ skillInvocations, agentInvocations, commandInvocations }),
        });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts`
Expected: PASS (all cases, including the new one)

- [ ] **Step 5: Type-check the whole change**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS (no errors — Task 2's field is now populated)

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/analytics/report/types.ts src/cli/commands/analytics/report/payload-builder.ts src/cli/commands/analytics/report/__tests__/payload-builder.test.ts
git commit -m "feat(analytics): compute sessionSource in the report payload builder"
```

---

### Task 4: Render the "Source" column in the Sessions table (client)

**Files:**
- Modify: `src/cli/commands/analytics/report/client/app.js:805, 809, 811-819`

**Test-first: no — this is a vanilla-JS client view with no existing unit-test harness for rendered markup (confirmed in research: `report-generator.test.ts` only exercises HTML-shell injection/escaping, not `VIEWS.sessions` output). Verify manually per Step 3 below.**

- [ ] **Step 1: Update the three coordinated arrays plus the search filter in `VIEWS.sessions`**

In `src/cli/commands/analytics/report/client/app.js`, inside `VIEWS.sessions`'s `draw` function, change:

```javascript
    function draw(q) {
      var list = fs.slice().sort(function (a, b) { return b.startTime - a.startTime; });
      if (q) {
        var ql = q.toLowerCase();
        list = list.filter(function (s) { return (s.sessionId + ' ' + s.agentName + ' ' + s.project + ' ' + s.branch + ' ' + (s.title || '')).toLowerCase().indexOf(ql) >= 0; });
      }
      var shown = list.slice(0, 300);
      holder.innerHTML = tableHTML(
        ['Date', 'Prompt', 'Agent', 'Project', 'Branch', 'Turns', 'Net lines', 'Input', 'Output', 'Cached', 'Cost'],
        shown.map(function (s) {
          var branchCell = s.branch ? '<span title="' + esc(s.branch) + '" style="max-width:90px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle">' + esc(s.branch) + '</span>' : '—';
          var promptCell = '<span title="' + esc(s.title || '') + '" style="max-width:280px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;color:var(--color-text-muted);font-size:12px">' + esc(truncStr(s.title || '—', 80)) + '</span>';
          return [new Date(s.startTime).toISOString().slice(0, 16).replace('T', ' '),
            promptCell,
            '<span class="tag tag-sm" style="text-transform:capitalize">' + esc(s.agentName) + '</span>',
            '<span title="' + esc(s.project) + '">' + esc(shortPath(s.project)) + '</span>', branchCell,
            fmtNum(s.turns), fmtNum(s.netLines), fmtTokens(tkIn(s)), fmtTokens(tkOut(s)), fmtTokens(tkCached(s)), fmtUSD(s.costUSD)];
        }),
        [false, false, false, false, false, true, true, true, true, true, true],
        shown.map(function (s) { return 'class="clickable" data-session="' + esc(s.sessionId) + '"'; }));
      if (list.length > 300) holder.appendChild(el('p', 'text-muted', '<span style="font-size:12px">Showing first 300 of ' + list.length + '.</span>'));
    }
```

to:

```javascript
    function draw(q) {
      var list = fs.slice().sort(function (a, b) { return b.startTime - a.startTime; });
      if (q) {
        var ql = q.toLowerCase();
        list = list.filter(function (s) { return (s.sessionId + ' ' + s.agentName + ' ' + s.project + ' ' + s.branch + ' ' + (s.title || '') + ' ' + (s.sessionSource || '')).toLowerCase().indexOf(ql) >= 0; });
      }
      var shown = list.slice(0, 300);
      holder.innerHTML = tableHTML(
        ['Date', 'Prompt', 'Agent', 'Project', 'Branch', 'Source', 'Turns', 'Net lines', 'Input', 'Output', 'Cached', 'Cost'],
        shown.map(function (s) {
          var branchCell = s.branch ? '<span title="' + esc(s.branch) + '" style="max-width:90px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle">' + esc(s.branch) + '</span>' : '—';
          var promptCell = '<span title="' + esc(s.title || '') + '" style="max-width:280px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;color:var(--color-text-muted);font-size:12px">' + esc(truncStr(s.title || '—', 80)) + '</span>';
          var sourceCell = '<span class="tag tag-sm">' + esc(s.sessionSource || 'Pure chat') + '</span>';
          return [new Date(s.startTime).toISOString().slice(0, 16).replace('T', ' '),
            promptCell,
            '<span class="tag tag-sm" style="text-transform:capitalize">' + esc(s.agentName) + '</span>',
            '<span title="' + esc(s.project) + '">' + esc(shortPath(s.project)) + '</span>', branchCell, sourceCell,
            fmtNum(s.turns), fmtNum(s.netLines), fmtTokens(tkIn(s)), fmtTokens(tkOut(s)), fmtTokens(tkCached(s)), fmtUSD(s.costUSD)];
        }),
        [false, false, false, false, false, false, true, true, true, true, true, true],
        shown.map(function (s) { return 'class="clickable" data-session="' + esc(s.sessionId) + '"'; }));
      if (list.length > 300) holder.appendChild(el('p', 'text-muted', '<span style="font-size:12px">Showing first 300 of ' + list.length + '.</span>'));
    }
```

Note the three coordinated edits: header array gained `'Source'` at index 5; row-cell array gained `sourceCell` at index 5; alignment-mask array gained one more `false` at index 5 (Turns/Net lines/etc. shift right by one, their `true` entries unchanged in relative order).

- [ ] **Step 2: Run the existing report-generator test to confirm the HTML shell still builds correctly**

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/report-generator.test.ts`
Expected: PASS (this test does not snapshot `VIEWS.sessions` output, so it validates the app.js bundle still embeds/parses without syntax errors)

- [ ] **Step 3: Manual verification**

Run: `codemie analytics --report --open` (or `node bin/codemie.js analytics --report --open` from repo root) against a local `~/.codemie/sessions/` directory that has at least one session with a captured `sdlc-light`/`sdlc-task`/`sdlc-autonomous` command and one plain-chat session. Confirm in the browser:
- The Sessions tab shows a "Source" column immediately after "Branch".
- A session that used `sdlc-light` shows "CodeMie AI Factory".
- A session with no matching signal shows "Pure chat".
- Typing "pure chat" or "factory" in the search box filters accordingly.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/analytics/report/client/app.js
git commit -m "feat(analytics): render Source column in the Sessions table"
```

---

## Self-review notes

- **Spec coverage:** (1) CodeMie AI Factory detection via `sdlc-factory:` prefix + `sdlc-light`/`sdlc-task`/`sdlc-autonomous` exact-match — Task 1. (2) Superpowers/OpenSpec/SpecKit/BMAD as additional ordered detectors — Task 1. (3) "Pure chat" fallback — Task 1. (4) Extensible via Strategy pattern (ordered array of `{name, label, matches}`, not if/else) — Task 1. (5) New column after Branch — Task 4.
- **Placeholder scan:** none — every step has complete, runnable code.
- **Type consistency:** `SessionInvocationNames` (Task 1) matches the shape passed from `payload-builder.ts` (Task 3): `{ skillInvocations, agentInvocations, commandInvocations }`, all `NamedInvocationStats[]`. `sessionSource: string` (Task 2) is the exact property name read by `app.js` (Task 4) and asserted in the Task 3 test.
