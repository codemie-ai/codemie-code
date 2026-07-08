# Cost Enricher: Price completed_-prefixed sessions Implementation Plan

> **For agentic workers:** implemented inline via sdlc-light Stage 4 (TDD). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the analytics cost enricher price CodeMie-tracked sessions whose metadata file has the `completed_` prefix, by populating `RawSessionData.agentSessionFile` from the correlation record the loader already parses.

**Architecture:** Option B — fix in the analytics data-access layer only. `MetricsDataLoader.loadSession` already reads the `completed_`-prefixed metadata (via `resolveSessionPath`) and parses it into `sessionMetadata`; it just drops `correlation.agentSessionFile`. Populate that field on the returned `RawSessionData` so the cost enricher's existing first branch (`if (raw.agentSessionFile) return raw.agentSessionFile`, cost-enricher.ts:62) resolves the native log directly and never runs the broken hardcoded `${sessionId}.json` read.

**Tech Stack:** TypeScript (ESM), Vitest, node fs.

## Global Constraints

- ES modules, `.js` import extensions, `async`/`await`, no `any`, explicit types on exports.
- Tests: Vitest, real-fs temp dirs (`mkdtempSync`), matching existing `data-loader.test.ts` style.
- Surgical change: only lines tracing to this fix. No refactor of adjacent code.

---

### Task 1: Populate `agentSessionFile` from `correlation` in `loadSession`

**Test-first: yes** — a data-loader test asserting `loadSessions` sets `agentSessionFile` from a completed session's `correlation.agentSessionFile`; fails today because `loadSession` never reads `correlation`.

**Files:**
- Modify: `src/cli/commands/analytics/data-loader.ts` (return literal at line 254; doc comment at lines 111-116)
- Test: `src/cli/commands/analytics/__tests__/data-loader.test.ts` (inside `describe('MetricsDataLoader.loadSessions — completed_ prefixed sessions', ...)`, before its closing `});` at line 164)

**Interfaces:**
- Consumes: existing `MetricsDataLoader.loadSessions(filter?)` → `RawSessionData[]`; `RawSessionData.agentSessionFile?: string` (already declared, optional).
- Produces: `RawSessionData.agentSessionFile` populated for tracked sessions whose metadata has `correlation.agentSessionFile`; left `undefined` otherwise. Consumer `cost-enricher.ts:62` unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/commands/analytics/__tests__/data-loader.test.ts`, inside the `completed_ prefixed sessions` describe block (after the last `it(...)`, before the closing `});`):

```typescript
  it('populates agentSessionFile from correlation.agentSessionFile for a completed_ session', () => {
    const sessionId = 'eddd66b2-0e73-4167-841c-9263207870ae';
    const agentSessionFile = '/home/user/.claude/projects/proj/native-log.jsonl';
    writeFileSync(
      join(dir, `completed_${sessionId}.json`),
      JSON.stringify({
        startTime: 1000,
        endTime: 2000,
        status: 'completed',
        agentName: 'claude',
        provider: 'anthropic',
        workingDirectory: '/tmp/project',
        correlation: { status: 'matched', agentSessionId: 'native-1', agentSessionFile, retryCount: 0 },
      })
    );

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ sessionId });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentSessionFile).toBe(agentSessionFile);
  });

  it('leaves agentSessionFile undefined when the session has no correlation', () => {
    const sessionId = 'eddd66b2-0e73-4167-841c-9263207870ae';
    writeCompletedSession(sessionId); // helper writes no correlation key

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ sessionId });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentSessionFile).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify the first fails (RED)**

Run: `npx vitest run src/cli/commands/analytics/__tests__/data-loader.test.ts`
Expected: `populates agentSessionFile from correlation.agentSessionFile...` FAILS (`sessions[0].agentSessionFile` is `undefined`, expected the path). The `leaves agentSessionFile undefined...` test PASSES already (guard baseline).

- [ ] **Step 3: Implement the fix**

In `src/cli/commands/analytics/data-loader.ts`, change the `loadSession` return literal (line 254) from:

```typescript
      return { sessionId, startEvent, endEvent, deltas };
```

to:

```typescript
      return { sessionId, startEvent, endEvent, deltas, agentSessionFile: sessionMetadata.correlation?.agentSessionFile };
```

Then reword the now-stale `agentSessionFile` doc comment on `RawSessionData` (lines 111-116) from:

```typescript
  /**
   * Native agent log path, set for sessions discovered directly from agent logs
   * (not tracked by CodeMie). When present, the cost enricher prices from this path
   * instead of the ~/.codemie/sessions correlation file.
   */
  agentSessionFile?: string;
```

to:

```typescript
  /**
   * Native agent log path used for cost pricing. Resolved either from a
   * native-discovered session (which carries its log path directly) or from a
   * CodeMie-tracked session's `correlation.agentSessionFile`. When present, the
   * cost enricher prices from this path directly instead of re-reading the
   * ~/.codemie/sessions correlation file (which its bare-UUID lookup misses for
   * `completed_`-prefixed metadata).
   */
  agentSessionFile?: string;
```

- [ ] **Step 4: Run tests to verify they pass (GREEN)**

Run: `npx vitest run src/cli/commands/analytics/__tests__/data-loader.test.ts`
Expected: all tests in the file PASS, including both new ones.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/analytics/data-loader.ts src/cli/commands/analytics/__tests__/data-loader.test.ts
git commit -m "fix(analytics): loadSession populates agentSessionFile from correlation so completed_ sessions are priced"
```

---

## Self-Review

- **Coverage:** Task 1 implements the sole requirement (populate `agentSessionFile` from `correlation` for `completed_` sessions) and guards the uncorrelated case (optional chaining — the highest risk from research).
- **Placeholders:** none — full test and production code shown.
- **Type consistency:** `agentSessionFile?: string` already declared on `RawSessionData`; `sessionMetadata.correlation?.agentSessionFile` is `string | undefined`, assignable. Matches `CorrelationResult` shape (`src/agents/core/session/types.ts`).
