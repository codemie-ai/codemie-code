# Fix: Windows special-char profile path in codemie-code CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `codemie-code` from crashing on Windows when the user's profile path contains CMD.EXE metacharacters such as `(`.

**Architecture:** Insert a single quoting guard in `BaseAgentAdapter.ts` immediately before the `finalCommand` assembly block. The guard wraps `commandPath` in double-quotes when running on Windows and the path contains CMD.EXE metacharacters, provided it is not already quoted. The fix then adds three unit tests in the existing `BaseAgentAdapter.test.ts` file to cover the null-resolved-path branch (the crash path), the clean-path branch (no change), and the already-quoted branch (no double-quote).

**Tech Stack:** TypeScript 5, Node.js ≥ 20, Vitest 4

## Global Constraints

- No new dependencies — quoting is hand-rolled (no `execa`, `cross-spawn`, or `shell-quote`)
- Regex for Windows metacharacters: `/[ ()&|<>^%[\]{}]/` — identical to the existing regex at `BaseAgentAdapter.ts:713`
- Double-quote guard: only wrap if `!commandPath.startsWith('"')` — prevents double-quoting
- `exec.ts` is **out of scope** for this ticket — do not modify it
- Tests run via `npm run test:unit` (Vitest, `unit` project)
- Commit message format: `EPMCDME-12737: <description>`

---

### Task 1: Write failing tests for Windows command-path quoting

**Files:**
- Modify: `src/agents/core/__tests__/BaseAgentAdapter.test.ts`

**Interfaces:**
- Consumes: existing `RunPipelineAdapter` pattern, existing `spawn` and `getCommandPath` mocks
- Produces: three failing tests in `describe('run() — Windows command path quoting')`

- [ ] **Step 1: Add `spawn` import at the top of the test file**

Open `src/agents/core/__tests__/BaseAgentAdapter.test.ts`.

Add to the imports block (after the existing `import { describe, it, expect, vi, beforeEach } from 'vitest';` line):

```typescript
import { spawn } from 'child_process';
import { getCommandPath } from '../../../utils/processes.js';
```

- [ ] **Step 2: Append the new describe block at the end of the file (before the final `});`)**

Add the following block just before the last `});` that closes the outer `describe('BaseAgentAdapter', () => {`:

```typescript
  describe('run() — Windows command path quoting', () => {
    class RunPathAdapter extends BaseAgentAdapter {}

    const baseMetadata: AgentMetadata = {
      name: 'path-agent',
      displayName: 'Path Agent',
      description: 'Windows path quoting tests',
      npmPackage: null,
      cliCommand: null,
      envMapping: {},
      supportedProviders: ['anthropic-subscription'],
      silentMode: true,
    };

    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.clearAllMocks();
      // Force Windows detection regardless of host OS so tests are portable
      platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as NodeJS.Platform);
      delete process.env['CODEMIE_REASONING_EFFORT'];
    });

    afterEach(() => {
      platformSpy.mockRestore();
    });

    it('wraps commandPath in double-quotes when getCommandPath returns null and path contains (', async () => {
      const spawnMock = vi.mocked(spawn);

      const adapter = new RunPathAdapter({
        ...baseMetadata,
        cliCommand: 'C:\\Users\\Name(Org\\bin\\cmd.exe',
      });

      await adapter.run([], {});

      expect(spawnMock).toHaveBeenCalledWith(
        '"C:\\Users\\Name(Org\\bin\\cmd.exe"',
        [],
        expect.objectContaining({ shell: true }),
      );
    });

    it('leaves commandPath unchanged when path has no CMD.EXE metacharacters', async () => {
      const spawnMock = vi.mocked(spawn);

      const adapter = new RunPathAdapter({
        ...baseMetadata,
        cliCommand: 'C:\\Users\\Normal\\bin\\cmd.exe',
      });

      await adapter.run([], {});

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Users\\Normal\\bin\\cmd.exe',
        [],
        expect.objectContaining({ shell: true }),
      );
    });

    it('does not double-quote when getCommandPath returns a path that already contains ( (existing branch quotes it once)', async () => {
      const spawnMock = vi.mocked(spawn);
      vi.mocked(getCommandPath).mockResolvedValueOnce('C:\\Users\\Name(Org\\bin\\cmd.exe');

      const adapter = new RunPathAdapter({
        ...baseMetadata,
        cliCommand: 'C:\\Users\\Name(Org\\bin\\cmd.exe',
      });

      await adapter.run([], {});

      const firstArg = spawnMock.mock.calls[0]?.[0] as string;
      // Quoted exactly once — starts with " but not ""
      expect(firstArg).toBe('"C:\\Users\\Name(Org\\bin\\cmd.exe"');
      expect(firstArg.startsWith('""')).toBe(false);
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

```
cd C:\Projects\codemie-code
npm run test:unit -- --reporter=verbose src/agents/core/__tests__/BaseAgentAdapter.test.ts
```

Expected: the three new tests FAIL with something like `expected spawn to have been called with '"C:\\Users\\Name(Org\\bin\\cmd.exe"' but was called with 'C:\\Users\\Name(Org\\bin\\cmd.exe'`.

If the tests pass here, the guard was already in place — stop and investigate before continuing.

---

### Task 2: Implement the Windows quoting guard

**Files:**
- Modify: `src/agents/core/BaseAgentAdapter.ts:750–754`

**Interfaces:**
- Consumes: `commandPath` (string), `isWindows` (boolean) — both already in scope at this location
- Produces: `commandPath` is unconditionally safe for CMD.EXE before the `finalCommand` assembly block

- [ ] **Step 1: Open `src/agents/core/BaseAgentAdapter.ts` and locate the insertion point**

Find line 750 — the closing `}` of the `else if (!isWindows)` block:

```typescript
      }  // ← line 750: end of else if (!isWindows) block

      // When shell: true is needed (Windows), merge args into command to avoid DEP0190
      // Node.js deprecation warning: shell mode doesn't escape array arguments, only concatenates them
      let finalCommand = commandPath;
```

- [ ] **Step 2: Insert the quoting guard between line 750 and the `let finalCommand` comment**

The block after the insertion should read:

```typescript
      }

      // On Windows, ensure commandPath is quoted for cmd.exe regardless of how it was resolved.
      // getCommandPath() may return null (binary not in PATH) leaving commandPath as the raw
      // unquoted absolute path from plugin metadata. CMD.EXE treats bare '(' as a
      // compound-group delimiter, so paths like C:\Users\Name(Org\...\bin\cmd.exe must be quoted.
      if (isWindows && /[ ()&|<>^%[\]{}]/.test(commandPath) && !commandPath.startsWith('"')) {
        commandPath = `"${commandPath}"`;
      }

      // When shell: true is needed (Windows), merge args into command to avoid DEP0190
      // Node.js deprecation warning: shell mode doesn't escape array arguments, only concatenates them
      let finalCommand = commandPath;
```

- [ ] **Step 3: Run the tests — all three new tests must pass**

```
cd C:\Projects\codemie-code
npm run test:unit -- --reporter=verbose src/agents/core/__tests__/BaseAgentAdapter.test.ts
```

Expected output for the new describe block:

```
✓ run() — Windows command path quoting > wraps commandPath in double-quotes when getCommandPath returns null and path contains (
✓ run() — Windows command path quoting > leaves commandPath unchanged when path has no CMD.EXE metacharacters
✓ run() — Windows command path quoting > does not double-quote when getCommandPath returns a path that already contains (
```

All pre-existing tests must remain green. If any pre-existing test fails, do not proceed.

- [ ] **Step 4: Run the full unit test suite**

```
cd C:\Projects\codemie-code
npm run test:unit
```

Expected: all tests pass, no regressions.

- [ ] **Step 5: Commit**

```
cd C:\Projects\codemie-code
git add src/agents/core/__tests__/BaseAgentAdapter.test.ts src/agents/core/BaseAgentAdapter.ts
git commit -m "EPMCDME-12737: quote Windows commandPath when getCommandPath returns null"
```
