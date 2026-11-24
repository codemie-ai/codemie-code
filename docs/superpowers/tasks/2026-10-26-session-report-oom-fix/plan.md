# Session Report OOM Fix (EPMCDME-16400) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Node.js OOM crash that happens when `codemie-claude` (or any agent) generates its end-of-session analytics report against a large (multi-GB) transcript history, by making session-scoped report generation parse at most one transcript file regardless of total historical volume.

**Architecture:** `loadNativeSessions()` in `native-loader.ts` currently discovers every transcript file in an unbounded (`3650`-day) window and fully parses every one of them *before* checking whether it matches the requested `sessionId`. The fix narrows the discovered-file list down to the one matching descriptor immediately after discovery — before any of the per-family parse passes (Codex child-thread collection, Pi fork-family folding, or the main synthesis loop) touch file content — so a session-scoped request never parses an unrelated file. A secondary, independent fix corrects `windowDays()`, which currently forces an effectively-unbounded (3650-day) discovery window whenever no `fromDate` is given, overriding every per-agent adapter's own 30-day default.

**Tech Stack:** TypeScript, Vitest (`--project cli`), existing `NativeLoaderDeps` dependency-injection seam (`src/cli/commands/analytics/native-loader.ts`).

**Spec:** `docs/superpowers/tasks/2026-10-26-session-report-oom-fix/technical-analysis.md` (no separate spec.md — sdlc-light skips spec-writing; this technical-analysis.md is the grounding research document this plan argues from).

## Global Constraints

- No streaming-reader conversion of `jsonl-reader.ts` in this ticket — the sessionId short-circuit means the session-report path never parses more than one file, so the non-streaming reader is no longer the active bottleneck. Out of scope; left as a separable follow-up.
- No `process.on('uncaughtException'/'unhandledRejection')` or any OOM-catching handler — an actual OOM kill happens before any catch block or pending promise runs, so this cannot satisfy the ticket's "log and terminate gracefully" expectation. The ticket's expectation is satisfied in practice by preventing the OOM in the first place (memory reduction), not by catching it after the fact. No new exception-handling infrastructure is added.
- No `NODE_OPTIONS`/`--max-old-space-size` heap-bump infrastructure — none exists in the repo today; out of scope.
- No change to `docs/codemie/` directory-creation handling — already correct (`mkdirSync({ recursive: true })` runs before every write); the ticket's diagnostic about this was a red herring, since the process never reaches the write step today (it dies earlier, during discovery/parse).
- Behavior for non-session-scoped queries (e.g. aggregate "all sessions" reports that never set `sessionId`) must be preserved exactly — the short-circuit only activates when `filter.sessionId` is set.

## Review Focus

- A `filter.sessionId` that matches a Codex child-thread rollout file (not its parent) — must still resolve correctly via the narrowed `discovered` list, since the pre-pass no longer sees sibling/parent files to build `codexChildThreads` from. Verified by Task 1's test asserting `parse` is called exactly once for the matching descriptor regardless of agent family.
- A `filter.sessionId` that matches a Pi forked-continuation file — must still resolve to its own parsed data rather than being silently folded away, since `foldPiForkFamilies` no longer has sibling files to fold against. Covered by Task 1's single-match assertion (the narrowed list contains only the matching descriptor, so there is nothing left to fold it into).
- A `filter.sessionId` that matches **no** discovered descriptor — must return an empty array, not throw, and must not call `parse` at all. Covered by Task 1.
- `filter` entirely absent (`undefined`) — the sessionId short-circuit must not activate, and all discovered descriptors must still be parsed exactly as before (no regression to the aggregate/non-session-scoped path). Covered by Task 1.
- `windowDays()` called with a filter that explicitly sets `fromDate` — must keep its existing day-count-from-date behavior unchanged; only the "no `fromDate`" branch changes. Covered by Task 2.

---

### Task 1: Short-circuit `loadNativeSessions` to the requested session before any parse

**Files:**
- Modify: `src/cli/commands/analytics/native-loader.ts:717-785` (`loadNativeSessions`)
- Test: `src/cli/commands/analytics/__tests__/native-loader.test.ts`

**Interfaces:**
- Consumes: existing `NativeLoaderDeps` (`discover`, `parse`, `trackedLogPaths`, `realPath`, `hasOwnershipMarker`) — unchanged interface, no signature changes in this task.
- Produces: `loadNativeSessions(filter?, deps?)` behavior change only — when `filter?.sessionId` is set, discovery output is narrowed to at most one descriptor before any parsing happens. No new exports.

Test-first: yes — failing test asserting `deps.parse` is called exactly once (for the matching descriptor only) when `filter.sessionId` is set and multiple descriptors (including a Codex-family one and a Pi-family one) are discovered.

- [ ] **Step 1: Write the failing tests** in `src/cli/commands/analytics/__tests__/native-loader.test.ts`, in a new `describe('loadNativeSessions — sessionId short-circuit')` block:

```ts
describe('loadNativeSessions — sessionId short-circuit', () => {
  it('parses only the descriptor matching filter.sessionId, skipping all others', async () => {
    const parse = vi.fn(async (_agent: string, _filePath: string, sessionId: string) =>
      ({ messages: [], metadata: {}, sessionId } as unknown as ParsedSession)
    );
    const deps: NativeLoaderDeps = {
      trackedLogPaths: () => new Set<string>(),
      discover: async () => [
        { agentName: 'claude', descriptor: { sessionId: 'target', filePath: '/logs/target.jsonl', createdAt: 1, agentName: 'claude' } },
        { agentName: 'codex', descriptor: { sessionId: 'other-codex', filePath: '/logs/other.jsonl', createdAt: 1, agentName: 'codex' } },
        { agentName: 'pi', descriptor: { sessionId: 'other-pi', filePath: '/logs/other-pi.jsonl', createdAt: 1, agentName: 'pi' } },
      ],
      parse,
      realPath: (p) => p,
      hasOwnershipMarker: () => true,
    };

    const results = await loadNativeSessions({ sessionId: 'target' }, deps);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith('claude', '/logs/target.jsonl', 'target');
    expect(results).toHaveLength(1);
  });

  it('returns an empty array and calls parse zero times when no descriptor matches filter.sessionId', async () => {
    const parse = vi.fn(async () => null);
    const deps: NativeLoaderDeps = {
      trackedLogPaths: () => new Set<string>(),
      discover: async () => [
        { agentName: 'claude', descriptor: { sessionId: 'unrelated', filePath: '/logs/unrelated.jsonl', createdAt: 1, agentName: 'claude' } },
      ],
      parse,
      realPath: (p) => p,
      hasOwnershipMarker: () => true,
    };

    const results = await loadNativeSessions({ sessionId: 'nonexistent' }, deps);

    expect(parse).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('parses every discovered descriptor when filter.sessionId is absent (no regression)', async () => {
    const parse = vi.fn(async (_agent: string, _filePath: string, sessionId: string) =>
      ({ messages: [], metadata: {}, sessionId } as unknown as ParsedSession)
    );
    const deps: NativeLoaderDeps = {
      trackedLogPaths: () => new Set<string>(),
      discover: async () => [
        { agentName: 'claude', descriptor: { sessionId: 'a', filePath: '/logs/a.jsonl', createdAt: 1, agentName: 'claude' } },
        { agentName: 'claude', descriptor: { sessionId: 'b', filePath: '/logs/b.jsonl', createdAt: 1, agentName: 'claude' } },
      ],
      parse,
      realPath: (p) => p,
      hasOwnershipMarker: () => true,
    };

    await loadNativeSessions(undefined, deps);

    expect(parse).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- --project cli -t "sessionId short-circuit"`
Expected: FAIL — all three assertions fail because `parse` is currently called for every discovered descriptor regardless of `filter.sessionId` (first test gets `parse` called 3 times, not 1; second test's `parse` mock still gets invoked once).

- [ ] **Step 3: Implement the short-circuit in `loadNativeSessions`** (`src/cli/commands/analytics/native-loader.ts`)

Immediately after the existing `const discovered = await deps.discover(windowDays(filter));` line (722), add:

```ts
const scoped = filter?.sessionId
  ? discovered.filter(({ descriptor }) => descriptor.sessionId === filter.sessionId)
  : discovered;
```

Replace every subsequent reference to `discovered` in the function body (the Codex pre-pass `for` loop at ~730, `readPiTranscripts(discovered, deps)` at ~745, and the main synthesis `for` loop at ~750) with `scoped`. Do not change anything else in the function — `tracked`-dedup, Codex child-thread collection, and Pi fork-folding logic all keep operating exactly as before, just over the narrowed list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- --project cli -t "sessionId short-circuit"`
Expected: PASS

- [ ] **Step 5: Run the full native-loader suite to confirm no regression**

Run: `npm run test -- --project cli src/cli/commands/analytics/__tests__/native-loader.test.ts src/cli/commands/analytics/__tests__/native-loader-pi.test.ts src/cli/commands/analytics/__tests__/native-family-bounds.test.ts`
Expected: PASS (all existing tests, which never set `filter.sessionId`, continue to parse every discovered descriptor)

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/analytics/native-loader.ts src/cli/commands/analytics/__tests__/native-loader.test.ts
git commit -m "fix(analytics): short-circuit native session discovery to the requested sessionId

EPMCDME-16400"
```

---

### Task 2: Stop `windowDays()` from forcing an unbounded (3650-day) discovery window

**Files:**
- Modify: `src/cli/commands/analytics/native-loader.ts:63-74` (`NativeLoaderDeps.discover` signature), `:163-175` (`realNativeDeps.discover`), `:604-611` (`windowDays`)
- Test: `src/cli/commands/analytics/__tests__/native-loader.test.ts`

**Interfaces:**
- Consumes: Task 1's `scoped` short-circuit (independent of this task — this task only changes what window value gets passed to `discover()`, not the post-discovery filtering).
- Produces: `NativeLoaderDeps.discover(maxAgeDays?: number)` — now optional. `windowDays(filter?)` now returns `number | undefined`, returning `undefined` (not `3650`) when `filter?.fromDate` is absent, so each per-agent adapter's own `options?.maxAgeDays ?? 30` default takes effect instead of being overridden.

Test-first: yes — failing test asserting `deps.discover` is called with `undefined` (not `3650`) when `loadNativeSessions` is called with a filter that has no `fromDate` (including a session-scoped filter, which never sets `fromDate`).

- [ ] **Step 1: Write the failing test** in `src/cli/commands/analytics/__tests__/native-loader.test.ts`, in a new `describe('loadNativeSessions — windowDays')` block:

```ts
describe('loadNativeSessions — windowDays', () => {
  it('passes undefined (not 3650) to discover when filter has no fromDate', async () => {
    const discover = vi.fn(async () => []);
    const deps: NativeLoaderDeps = {
      trackedLogPaths: () => new Set<string>(),
      discover,
      parse: async () => null,
      realPath: (p) => p,
      hasOwnershipMarker: () => true,
    };

    await loadNativeSessions({ sessionId: 'target' }, deps);

    expect(discover).toHaveBeenCalledWith(undefined);
  });

  it('still derives a day count from filter.fromDate when it is set', async () => {
    const discover = vi.fn(async () => []);
    const deps: NativeLoaderDeps = {
      trackedLogPaths: () => new Set<string>(),
      discover,
      parse: async () => null,
      realPath: (p) => p,
      hasOwnershipMarker: () => true,
    };
    const fromDate = new Date(Date.now() - 5 * 86_400_000);

    await loadNativeSessions({ fromDate }, deps);

    const calledWith = discover.mock.calls[0]?.[0] as number;
    expect(calledWith).toBeGreaterThanOrEqual(5);
    expect(calledWith).toBeLessThanOrEqual(7);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- --project cli -t "windowDays"`
Expected: FAIL — first assertion fails because `discover` is currently called with `3650`, not `undefined`.

- [ ] **Step 3: Implement the fix**

In `windowDays()` (~line 604-611), change the return type and the no-`fromDate` branch:

```ts
function windowDays(filter?: AnalyticsFilter): number | undefined {
  if (filter?.fromDate) {
    const days = Math.ceil((Date.now() - filter.fromDate.getTime()) / 86_400_000);
    return Math.max(days + 1, 1);
  }
  return undefined; // no lower bound requested → let each adapter apply its own default
}
```

Update the `NativeLoaderDeps.discover` signature (~line 67) from `discover(maxAgeDays: number): Promise<DiscoveredNative[]>;` to `discover(maxAgeDays?: number): Promise<DiscoveredNative[]>;`.

Update `realNativeDeps.discover` (~line 165) parameter type to match (`async discover(maxAgeDays?: number)`); its body already does `await adapter.discoverSessions({ maxAgeDays })`, which needs no further change — passing `{ maxAgeDays: undefined }` through to each adapter's `options?.maxAgeDays ?? 30` already produces the desired default.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- --project cli -t "windowDays"`
Expected: PASS

- [ ] **Step 5: Run the full native-loader suite plus the session-report suite to confirm no regression**

Run: `npm run test -- --project cli src/cli/commands/analytics/__tests__/native-loader.test.ts src/cli/commands/analytics/report/__tests__/session-report.test.ts src/cli/commands/analytics/sources/__tests__/sessions-source.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/analytics/native-loader.ts src/cli/commands/analytics/__tests__/native-loader.test.ts
git commit -m "fix(analytics): stop forcing a 3650-day discovery window when no fromDate is given

EPMCDME-16400"
```

---

### Task 3: Run the project's quality gates

**Files:** none (verification only)

**Interfaces:** none

Test-first: no — this task runs existing gates, it writes no new test.

- [ ] **Step 1: Run lint, typecheck, and the full cli test project**

Run: `npm run lint && npm run typecheck && npm run test -- --project cli`
Expected: PASS, zero lint warnings, zero type errors

- [ ] **Step 2: Commit any lint/format fixups, if the gate step produced auto-fixes**

```bash
git add -A
git commit -m "chore: lint fixups for EPMCDME-16400" --allow-empty
```

(Skip this commit entirely if Step 1 produced no changes — do not create an empty commit.)
