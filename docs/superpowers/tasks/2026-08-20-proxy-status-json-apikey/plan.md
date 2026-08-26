# Proxy Status API Key + JSON Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "API Key" line to `codemie proxy status`'s human-readable output and a `--json` flag that emits the same status information as machine-readable JSON.

**Architecture:** Single-file change to the `status` subcommand's `.action()` handler in `src/cli/commands/proxy/index.ts`. No new modules — all data (`gatewayKey`, health fields) already exists on `DaemonState`/`ProxyHealthResult` returned by the existing `checkStatus()`/`checkProxyHealth()` calls. A `--json` boolean option branches the handler between a new JSON-serialization path and the existing (lightly modified) human-readable path.

**Tech Stack:** TypeScript, Commander.js, Vitest.

---

## File Structure

- Modify: `src/cli/commands/proxy/index.ts` — `status` subcommand definition and `.action()` handler (lines ~190-238).
- Modify: `src/cli/commands/proxy/__tests__/index.test.ts` — extend the existing `describe('proxy status', ...)` block (from line 500).

No new files. The change is additive within the existing `status` action handler.

---

### Task 1: Add "API Key" line to human-readable output

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:223-232`
- Test: `src/cli/commands/proxy/__tests__/index.test.ts`

Test-first: yes — a test asserting `console.log` was called with `'  API Key: local-key'` (currently the line does not exist, so the assertion fails).

- [ ] **Step 1: Write the failing test**

Add this test inside `describe('proxy status', ...)` in `src/cli/commands/proxy/__tests__/index.test.ts` (after the existing `'shows client and project context'` test, before the closing `});` of the describe block):

```typescript
  it('shows the API key', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith('  API Key: local-key');
    consoleLogSpy.mockRestore();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/cli/commands/proxy/__tests__/index.test.ts -t "shows the API key"`
Expected: FAIL — `expect(consoleLogSpy).toHaveBeenCalledWith('  API Key: local-key')` was not called with that string.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/commands/proxy/index.ts`, in the `status` action handler, change:

```typescript
      console.log(`  URL:     ${state.url}`);
      console.log(`  Port:    ${state.port}`);
      console.log(`  Profile: ${state.profile}`);
```

to:

```typescript
      console.log(`  URL:     ${state.url}`);
      console.log(`  Port:    ${state.port}`);
      console.log(`  API Key: ${state.gatewayKey}`);
      console.log(`  Profile: ${state.profile}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit src/cli/commands/proxy/__tests__/index.test.ts -t "shows the API key"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/index.ts src/cli/commands/proxy/__tests__/index.test.ts
git commit -m "feat(proxy): show API key in proxy status output"
```

---

### Task 2: Add `--json` flag with running/healthy output

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:190-238`
- Test: `src/cli/commands/proxy/__tests__/index.test.ts`

Test-first: yes — a test asserting `console.log` was called with the JSON-stringified running/healthy payload (fails today because `--json` doesn't exist and the handler always prints formatted lines).

- [ ] **Step 1: Write the failing test**

Add this test inside `describe('proxy status', ...)`:

```typescript
  it('emits JSON when --json is passed (running, healthy)', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        clientType: 'vscode-byok',
        project: 'team-project',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status', '--json'], { from: 'user' });

    const printed = consoleLogSpy.mock.calls.map((call) => call[0]).join('\n');
    const payload = JSON.parse(printed);
    expect(payload).toEqual({
      status: 'healthy',
      apiKey: 'local-key',
      url: 'http://127.0.0.1:4001',
      port: 4001,
      profile: 'work',
      clientType: 'vscode-byok',
      project: 'team-project',
      uptimeSec: payload.uptimeSec,
      level: 'shallow',
    });
    expect(typeof payload.uptimeSec).toBe('number');
    consoleLogSpy.mockRestore();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/cli/commands/proxy/__tests__/index.test.ts -t "emits JSON when --json is passed \(running, healthy\)"`
Expected: FAIL — Commander errors with "unknown option '--json'" (the option doesn't exist yet), or `JSON.parse` throws on the formatted-text output.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/commands/proxy/index.ts`, change the `status` command definition and the start of its action handler from:

```typescript
  proxy
    .command('status')
    .description('Show proxy daemon status')
    .option('--deep', 'Also verify upstream/auth reachability (slower)')
    .action(async (opts) => {
      const { running, state } = await checkStatus();
      if (!running || !state) {
        console.log('Status: stopped');
        return;
      }

      const uptimeSec = Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
      const uptime = uptimeSec < 60
        ? `${uptimeSec}s`
        : uptimeSec < 3600
          ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
          : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

      const health = await checkProxyHealth({
        port: state.port,
        gatewayKey: state.gatewayKey,
        deep: Boolean(opts.deep),
      });

      if (health.healthy) {
```

to:

```typescript
  proxy
    .command('status')
    .description('Show proxy daemon status')
    .option('--deep', 'Also verify upstream/auth reachability (slower)')
    .option('--json', 'Emit status as JSON instead of formatted output')
    .action(async (opts) => {
      const { running, state } = await checkStatus();
      if (!running || !state) {
        if (opts.json) {
          console.log(JSON.stringify({ status: 'stopped' }, null, 2));
        } else {
          console.log('Status: stopped');
        }
        return;
      }

      const uptimeSec = Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
      const uptime = uptimeSec < 60
        ? `${uptimeSec}s`
        : uptimeSec < 3600
          ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
          : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

      const health = await checkProxyHealth({
        port: state.port,
        gatewayKey: state.gatewayKey,
        deep: Boolean(opts.deep),
      });

      if (opts.json) {
        const payload: Record<string, unknown> = {
          status: health.healthy ? 'healthy' : 'unhealthy',
          apiKey: state.gatewayKey,
          url: state.url,
          port: state.port,
          profile: state.profile,
          uptimeSec,
          level: health.level,
        };
        if (state.clientType) payload.clientType = state.clientType;
        if (state.project) payload.project = state.project;
        if (!health.healthy) payload.reason = health.reason ?? state.healthReason ?? 'unknown';
        if (state.health === 'unhealthy' && state.healthReason && health.healthy) {
          payload.lastRecordedIssue = state.healthReason;
        }
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (health.healthy) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit src/cli/commands/proxy/__tests__/index.test.ts -t "emits JSON when --json is passed \(running, healthy\)"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/index.ts src/cli/commands/proxy/__tests__/index.test.ts
git commit -m "feat(proxy): add --json flag to proxy status"
```

---

### Task 3: Cover unhealthy, deep, and stopped `--json` branches

**Files:**
- Modify: `src/cli/commands/proxy/__tests__/index.test.ts` (tests only — Task 2 already implemented the branches)

Test-first: yes — these branches (`reason` on unhealthy, `level: 'deep'`, and the stopped JSON shape) are implemented in Task 2 but not yet covered by a test; write the tests now and confirm they pass without further implementation changes. If any fails, the implementation has a bug in that branch and must be fixed before continuing.

- [ ] **Step 1: Write the tests**

Add these three tests inside `describe('proxy status', ...)`:

```typescript
  it('emits JSON with a reason when unhealthy', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({
      healthy: false,
      level: 'shallow',
      code: 'unreachable',
      reason: 'connection refused',
    });

    await createProxyCommand().parseAsync(['status', '--json'], { from: 'user' });

    const payload = JSON.parse(consoleLogSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(payload.status).toBe('unhealthy');
    expect(payload.reason).toBe('connection refused');
    consoleLogSpy.mockRestore();
  });

  it('emits JSON with level "deep" when --deep is passed', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });

    await createProxyCommand().parseAsync(['status', '--deep', '--json'], { from: 'user' });

    const payload = JSON.parse(consoleLogSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(payload.level).toBe('deep');
    consoleLogSpy.mockRestore();
  });

  it('emits { status: "stopped" } JSON when the daemon is not running', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });

    await createProxyCommand().parseAsync(['status', '--json'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ status: 'stopped' }, null, 2));
    consoleLogSpy.mockRestore();
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run --project unit src/cli/commands/proxy/__tests__/index.test.ts`
Expected: PASS for all three new tests (and every pre-existing test in the file). If any fails, fix the corresponding branch in `src/cli/commands/proxy/index.ts` added in Task 2 before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/proxy/__tests__/index.test.ts
git commit -m "test(proxy): cover unhealthy, deep, and stopped --json branches"
```

---

### Task 4: Cover the `lastRecordedIssue` edge case and confirm no regression to default output

**Files:**
- Modify: `src/cli/commands/proxy/__tests__/index.test.ts`

Test-first: yes — the `lastRecordedIssue` field (set when a fresh health check passes but `state.health === 'unhealthy'` with a recorded `state.healthReason`) is implemented in Task 2 but has no test yet; write it now. Also add a regression test proving the default (non-`--json`) human-readable output is unchanged aside from the new API Key line.

- [ ] **Step 1: Write the tests**

Add these two tests inside `describe('proxy status', ...)`:

```typescript
  it('emits lastRecordedIssue in JSON when a prior unhealthy state recovered', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
        health: 'unhealthy',
        healthReason: 'timed out once',
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status', '--json'], { from: 'user' });

    const payload = JSON.parse(consoleLogSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(payload.status).toBe('healthy');
    expect(payload.lastRecordedIssue).toBe('timed out once');
    consoleLogSpy.mockRestore();
  });

  it('leaves the default (non-JSON) output byte-identical aside from the new API Key line', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status'], { from: 'user' });

    const lines = consoleLogSpy.mock.calls.map((call) => call[0]);
    expect(lines).toContain('  URL:     http://127.0.0.1:4001');
    expect(lines).toContain('  Port:    4001');
    expect(lines).toContain('  API Key: local-key');
    expect(lines).toContain('  Profile: work');
    consoleLogSpy.mockRestore();
  });
```

- [ ] **Step 2: Run the full proxy test file**

Run: `npx vitest run --project unit src/cli/commands/proxy/__tests__/index.test.ts`
Expected: PASS for every test in the file (all pre-existing tests plus every test added in Tasks 1-4).

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/proxy/__tests__/index.test.ts
git commit -m "test(proxy): cover lastRecordedIssue and default-output regression"
```
