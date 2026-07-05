# mcp-auth-proxy Windows Compatibility Implementation Plan

> **For agentic workers:** Implement task-by-task with `superpowers:test-driven-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `codemie mcp-auth-proxy` start, stop, and report status correctly on a Windows host — including *graceful* shutdown (SSE drain) — without regressing POSIX behavior.

**Architecture:** Windows has no POSIX signals — `process.kill(pid, 'SIGTERM')` unconditionally force-terminates the daemon, so its `SIGTERM`/`SIGINT` cleanup handlers never run (confirmed against Node docs: *"On Windows … Sending SIGINT, SIGTERM, or SIGKILL causes unconditional termination"*). We add a cross-platform loopback control channel: the daemon serves `POST /shutdown` (127.0.0.1-only, already loopback-bound) which invokes its own graceful `proxy.stop()` (drains SSE) → clears state → exits. The CLI `stop` POSTs to it first on **all** platforms, then falls back to the existing `SIGTERM→SIGKILL` sequence only if the daemon is unresponsive. Two smaller Windows fixes ride along: `windowsHide` on the detached spawn (no console-window flash) and treating `EPERM` from signal-0 as "process alive" (Windows liveness).

**Tech Stack:** Node.js `node:http` + `node:child_process` (`spawn` with `windowsHide`), `process.kill`, Vitest 4 (`vi.mock`/`vi.spyOn`/`vi.waitFor`).

**Non-goals:** Windows *service* registration (already de-scoped in the design doc). No new dependencies. No change to the OAuth rewrite logic.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/utils/processes.ts` | Modify `spawnDetached` (110-123) | Add `windowsHide: os.platform()==='win32'` — hides the detached daemon's console window on Windows (also fixes SSO + codebase daemons; `os` already imported). |
| `src/mcp/auth-proxy/state.ts` | Modify `isProcessAlive` (45-52) | `EPERM` ⇒ process exists ⇒ alive; only genuine "no such process" ⇒ dead. |
| `src/mcp/auth-proxy/config.ts` | Modify `RESERVED_ROUTE_IDS` (19) | Reserve `shutdown` so a user route can't shadow the control endpoint. |
| `src/mcp/auth-proxy/server.ts` | Modify `McpAuthProxy` (109-236) | Accept an `onShutdownRequested` callback; serve `POST /shutdown` → 202 then fire the callback after the response flushes; `405` on non-POST. |
| `src/mcp/auth-proxy/runtime.ts` | Modify `runAuthProxyDaemon` (28-64) | Build an idempotent `gracefulShutdown` (stop → exit); wire it to both the proxy's `onShutdownRequested` and `SIGTERM`/`SIGINT`. |
| `src/cli/commands/mcp-auth-proxy.ts` | Modify `stop` action (189-216) + add `requestShutdown` helper | POST `/shutdown` first (graceful, cross-platform), poll for exit, then `SIGTERM→SIGKILL` fallback only if still alive. |

**Test files:** `src/utils/__tests__/processes.test.ts` (new), `src/mcp/auth-proxy/__tests__/state.test.ts` (extend), `src/mcp/auth-proxy/__tests__/config.test.ts` (extend), `src/mcp/auth-proxy/__tests__/server.test.ts` (extend).

---

## Task 1: `windowsHide` on the detached daemon spawn

**Files:**
- Modify: `src/utils/processes.ts:115-121`
- Test: `src/utils/__tests__/processes.test.ts` (create)

Test-first: yes — a test asserting `spawnDetached` passes `windowsHide: true` when `os.platform()` is `win32` and `false` otherwise.

- [ ] **Step 1: Write the failing test**

Create `src/utils/__tests__/processes.test.ts`:

```typescript
/**
 * processes.ts — spawnDetached platform-conditional options.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 4242 })),
  exec: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { spawnDetached } from '../processes.js';

describe('spawnDetached', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides the console window on Windows (windowsHide: true)', () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    const pid = spawnDetached('node', ['daemon.js']);
    expect(pid).toBe(4242);
    expect(spawn).toHaveBeenCalledWith(
      'node',
      ['daemon.js'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true })
    );
  });

  it('does not hide the console window off Windows (windowsHide: false)', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    spawnDetached('node', ['daemon.js']);
    expect(spawn).toHaveBeenCalledWith(
      'node',
      ['daemon.js'],
      expect.objectContaining({ windowsHide: false })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/__tests__/processes.test.ts`
Expected: FAIL — the `objectContaining({ windowsHide: true })` assertion fails because `spawnDetached` passes no `windowsHide` key.

- [ ] **Step 3: Write minimal implementation**

In `src/utils/processes.ts`, change the `spawnDetached` body (currently lines 115-121):

```typescript
export function spawnDetached(
  command: string,
  args: string[] = [],
  options: DetachedSpawnOptions = {}
): number {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.stdio ?? 'ignore',
    // Detached background daemons must never flash a console window on Windows
    // (matches the exec.ts / BaseAgentAdapter idiom for attached spawns).
    windowsHide: os.platform() === 'win32',
  });
  child.unref();
  return child.pid ?? -1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/__tests__/processes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/processes.ts src/utils/__tests__/processes.test.ts
git commit -m "fix(utils): hide detached daemon console window on Windows

mcp-auth-proxy-windows Task 1"
```

---

## Task 2: `isProcessAlive` treats `EPERM` as alive on Windows

**Files:**
- Modify: `src/mcp/auth-proxy/state.ts:45-52`
- Test: `src/mcp/auth-proxy/__tests__/state.test.ts` (extend)

Test-first: yes — a test that mocks `process.kill` to throw `EPERM` (⇒ alive) and `ESRCH` (⇒ dead).

- [ ] **Step 1: Write the failing test**

In `src/mcp/auth-proxy/__tests__/state.test.ts`, add `vi` to the vitest import (line 5 becomes `import { describe, it, expect, afterEach, vi } from 'vitest';`) and append this test inside the `describe('auth proxy state file', …)` block (after the existing `isProcessAlive` test at line 59):

```typescript
  it('isProcessAlive: EPERM means the process exists (Windows), ESRCH means dead', () => {
    const killSpy = vi.spyOn(process, 'kill');

    killSpy.mockImplementationOnce(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(isProcessAlive(424242)).toBe(true);

    killSpy.mockImplementationOnce(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(isProcessAlive(424242)).toBe(false);

    killSpy.mockRestore();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/state.test.ts`
Expected: FAIL — current `isProcessAlive` catches *all* throws and returns `false`, so the `EPERM ⇒ true` assertion fails.

- [ ] **Step 3: Write minimal implementation**

Replace `isProcessAlive` in `src/mcp/auth-proxy/state.ts` (45-52):

```typescript
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but this user cannot signal it (common on
    // Windows) — that still means "alive". Only a genuine "no such process"
    // (ESRCH) means dead.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/state.test.ts`
Expected: PASS (all 4 tests, including the new one and the unchanged `2**30 ⇒ false`, which throws `ESRCH`).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/state.ts src/mcp/auth-proxy/__tests__/state.test.ts
git commit -m "fix(proxy): treat EPERM as alive in mcp-auth-proxy liveness check

mcp-auth-proxy-windows Task 2"
```

---

## Task 3: Reserve the `shutdown` route id

**Files:**
- Modify: `src/mcp/auth-proxy/config.ts:19`
- Test: `src/mcp/auth-proxy/__tests__/config.test.ts:60`

Test-first: yes — the existing `it.each(['as', 'healthz'])('rejects reserved route id …')` gains `'shutdown'`.

- [ ] **Step 1: Write the failing test**

In `src/mcp/auth-proxy/__tests__/config.test.ts`, change the reserved-id case (line 60) from:

```typescript
  it.each(['as', 'healthz'])('rejects reserved route id %j', (id) => {
```

to:

```typescript
  it.each(['as', 'healthz', 'shutdown'])('rejects reserved route id %j', (id) => {
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/config.test.ts`
Expected: FAIL for `id = 'shutdown'` — it is not yet reserved, so `validateAuthProxyConfig` does not throw `/reserved/`.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/auth-proxy/config.ts`, update `RESERVED_ROUTE_IDS` (line 19) and its comment (17-18):

```typescript
// `as` + `.well-known` are reserved by the route map; `healthz` by the health
// endpoint and `shutdown` by the graceful-shutdown control endpoint (design D6 —
// a route named "healthz"/"shutdown" would shadow GET /healthz / POST /shutdown).
const RESERVED_ROUTE_IDS = new Set(['as', '.well-known', 'healthz', 'shutdown']);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/config.test.ts`
Expected: PASS (reserved-id case now covers 3 ids).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/config.ts src/mcp/auth-proxy/__tests__/config.test.ts
git commit -m "feat(proxy): reserve 'shutdown' route id for the control endpoint

mcp-auth-proxy-windows Task 3"
```

---

## Task 4: Serve `POST /shutdown` from the daemon

**Files:**
- Modify: `src/mcp/auth-proxy/server.ts` — constructor (116-120), dispatch (196-224), add `handleShutdown`
- Test: `src/mcp/auth-proxy/__tests__/server.test.ts` (extend)

Test-first: yes — `POST /shutdown` ⇒ `202` and the `onShutdownRequested` callback fires once (after the response flushes); `GET /shutdown` ⇒ `405` and the callback does not fire.

- [ ] **Step 1: Write the failing test**

In `src/mcp/auth-proxy/__tests__/server.test.ts`, add `vi` to the vitest import (line 5 becomes `import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';`) and append this test inside the `describe('McpAuthProxy', …)` block (it reuses the outer `upstream` created in `beforeAll`):

```typescript
  it('POST /shutdown → 202 and fires the shutdown callback once; GET /shutdown → 405', async () => {
    const onShutdown = vi.fn();
    const controllable = new McpAuthProxy(
      { port: 0, servers: { radar: { upstreamUrl: `${upstream.origin}/mcp/radar` } } },
      onShutdown
    );
    const { url } = await controllable.start();
    try {
      const wrongMethod = await fetch(`${url}/shutdown`, { method: 'GET' });
      expect(wrongMethod.status).toBe(405);
      expect(onShutdown).not.toHaveBeenCalled();

      const res = await fetch(`${url}/shutdown`, { method: 'POST' });
      expect(res.status).toBe(202);
      expect((await res.json()) as JsonObject).toEqual({ status: 'shutting_down' });
      await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1));
    } finally {
      await controllable.stop();
    }
  });

  it('does not treat a configured route named like the control path as /shutdown', async () => {
    // /shutdown is intercepted before route lookup; a normal MCP route still passes through.
    const res = await fetch(`${proxyOrigin}/radar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-abc' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/server.test.ts`
Expected: FAIL — the `McpAuthProxy` constructor takes only `config` (a 2nd arg is ignored), and `/shutdown` currently falls through to `404 unknown_route`, so both the `405` and `202` assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/auth-proxy/server.ts`:

**(a)** Extend the constructor (116-120) to accept and store the callback:

```typescript
  constructor(
    private readonly config: AuthProxyConfig,
    private readonly onShutdownRequested?: () => void
  ) {
    this.port = config.port;
    this.client = new UpstreamClient();
    this.metadata = new MetadataCache((url) => this.client.fetchJson(url));
  }
```

**(b)** In `handleRequest`, add the `/shutdown` branch immediately after the `/healthz` branch (the new `else if` goes between the current lines 209 and 210, before the `.well-known` branch):

```typescript
      if (req.method === 'GET' && url.pathname === '/healthz') {
        kind = 'healthz';
        this.serveHealth(res);
      } else if (url.pathname === '/shutdown') {
        kind = 'shutdown';
        this.handleShutdown(req, res);
      } else if (segments[0] === '.well-known') {
```

**(c)** Add the `handleShutdown` method (place it next to `serveHealth`, in the "Health + errors" section around line 547):

```typescript
  /**
   * Graceful-shutdown control endpoint (loopback-only, like the whole server).
   * POST → ack 202, then run the daemon's own cleanup AFTER the response has
   * flushed so the caller (CLI stop) reliably receives the ack. Cross-platform:
   * this is how Windows shuts down gracefully, since it has no POSIX signals.
   */
  private handleShutdown(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    res.on('finish', () => this.onShutdownRequested?.());
    sendJson(res, 202, { status: 'shutting_down' });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/server.test.ts`
Expected: PASS (all existing tests plus the 2 new ones). Existing constructor calls (`new McpAuthProxy(config)`) still compile because the 2nd arg is optional.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/server.ts src/mcp/auth-proxy/__tests__/server.test.ts
git commit -m "feat(proxy): add loopback POST /shutdown control endpoint

mcp-auth-proxy-windows Task 4"
```

---

## Task 5: Wire the runtime's graceful shutdown to the endpoint + signals

**Files:**
- Modify: `src/mcp/auth-proxy/runtime.ts:35, 44-60`

Test-first: no — this is orchestration around `process.exit` and the full daemon bootstrap (config load + real server). Its delegated behaviors are already covered: the `/shutdown` → callback path by Task 4, graceful `proxy.stop()` SSE drain by the existing `server.test.ts` SSE test, and `EPERM` liveness by Task 2. A dedicated runtime test would have to mock `process.exit` and re-bootstrap config/server for negligible marginal coverage; the idempotency guard is trivial and reviewed here, and the end-to-end path is exercised by the Stage 6 smoke run.

- [ ] **Step 1: Implement the wiring**

Replace the body of `runAuthProxyDaemon` from the `const proxy = …` line through the signal registration (currently lines 35-60) with:

```typescript
  const routes = Object.keys(config.servers);

  // One idempotent graceful path shared by the /shutdown endpoint and POSIX
  // signals: stop the server (drains SSE), clear state, exit. On Windows the
  // endpoint is the only path that runs this — a signal there is a hard kill.
  let shuttingDown = false;
  const gracefulShutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void stop().then(() => process.exit(0));
  };

  const proxy = new McpAuthProxy(config, gracefulShutdown);
  const { port, url } = await proxy.start();

  await writeAuthProxyState(
    { pid: process.pid, port, routes, startedAt: new Date().toISOString() },
    stateFile
  );

  async function stop(): Promise<void> {
    try {
      await proxy.stop();
    } catch {
      // Best-effort shutdown
    }
    try {
      await clearAuthProxyState(stateFile);
    } catch {
      // Best-effort cleanup
    }
  }

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
```

Note: `stop` is now a hoisted `function` declaration so it can be referenced by `gracefulShutdown` (defined above `proxy`) while still being the `RunningDaemon.stop` returned at the end. The returned object keeps `stop` (unchanged signature: `() => Promise<void>`), so `RunningDaemon` and the `--foreground`/bin callers are unaffected.

- [ ] **Step 2: Verify the suite compiles + passes**

Run: `npx vitest run src/mcp/auth-proxy`
Expected: PASS — no test constructs the runtime directly; the server/state/config suites are unaffected.

Run: `npm run typecheck`
Expected: PASS — `McpAuthProxy`'s new optional 2nd ctor arg and the reordered `stop` declaration typecheck.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/auth-proxy/runtime.ts
git commit -m "feat(proxy): route graceful shutdown through endpoint and signals

mcp-auth-proxy-windows Task 5"
```

---

## Task 6: CLI `stop` — request graceful shutdown over HTTP, fall back to signals

**Files:**
- Modify: `src/cli/commands/mcp-auth-proxy.ts` — add `requestShutdown` helper (near `fetchHealth`, ~68), rewrite `stop` action (189-216)

Test-first: no — the CLI command file has no existing test harness, and the `stop` action is orchestration over `requestShutdown` (the `POST /shutdown` endpoint proven by Task 4), `isProcessAlive` (Task 2), and `process.kill` (unchanged). It is verified end-to-end by the Stage 6 real daemon smoke (start → `stop` → assert graceful drain + state cleared). Adding a Vitest harness here would require mocking `http`, `process.kill`, and the state file for little marginal value under `sdlc-light`.

- [ ] **Step 1: Add the `requestShutdown` helper**

In `src/cli/commands/mcp-auth-proxy.ts`, add after `fetchHealth` (which ends at line 87):

```typescript
/**
 * Ask the daemon to shut itself down gracefully via the loopback control
 * endpoint. Cross-platform graceful stop (Windows has no POSIX signals).
 * Resolves true if the daemon acknowledged (2xx), false on any error/timeout —
 * the caller then falls back to OS signals.
 */
function requestShutdown(port: number): Promise<boolean> {
  return new Promise((resolveShutdown) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: '/shutdown', method: 'POST', timeout: 2000 },
      (res) => {
        res.resume(); // drain the 202 body
        resolveShutdown(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    request.on('error', () => resolveShutdown(false));
    request.on('timeout', () => {
      request.destroy();
      resolveShutdown(false);
    });
    request.end();
  });
}
```

- [ ] **Step 2: Rewrite the `stop` action**

Replace the `stop` action body (currently lines 192-216) with:

```typescript
    .action(async () => {
      const state = await readAuthProxyState();
      if (!state || !isProcessAlive(state.pid)) {
        await clearAuthProxyState();
        console.log(chalk.yellow('mcp-auth-proxy is not running'));
        return;
      }

      // Graceful first (works on Windows and POSIX): ask the daemon to run its
      // own proxy.stop() + exit via the loopback control endpoint.
      await requestShutdown(state.port);
      for (let i = 0; i < 50; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
        if (!isProcessAlive(state.pid)) {
          break;
        }
      }

      // Fallback only if it did not exit: SIGTERM (POSIX graceful / Windows hard
      // kill), then SIGKILL. Skipped entirely when the daemon already shut down.
      if (isProcessAlive(state.pid)) {
        logger.warn('[mcp-auth-proxy] Graceful shutdown timed out; sending SIGTERM');
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch {
          // Already gone between the check and the signal — fine.
        }
        for (let i = 0; i < 50; i++) {
          await new Promise<void>((r) => setTimeout(r, 100));
          if (!isProcessAlive(state.pid)) {
            break;
          }
        }
      }
      if (isProcessAlive(state.pid)) {
        logger.warn('[mcp-auth-proxy] Daemon ignored SIGTERM; escalating to SIGKILL');
        try {
          process.kill(state.pid, 'SIGKILL');
        } catch {
          // Already gone — fine.
        }
      }

      await clearAuthProxyState();
      console.log(chalk.green('✓ mcp-auth-proxy stopped'));
    });
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS — `dist/` regenerated for the Stage 6 smoke.

- [ ] **Step 4: Real daemon smoke (POSIX graceful path)**

Run, from the repo root, in an isolated home so nothing touches the user's real config/state:

```bash
CODEMIE_HOME="$(mktemp -d)" bash -c '
  printf "%s" "{\"port\":42891,\"servers\":{\"radar\":{\"upstreamUrl\":\"https://mcp.epam.com/mcp/radar\"}}}" > "$CODEMIE_HOME/mcp-auth-proxy.json"
  node bin/codemie.js mcp-auth-proxy start --port 42891
  sleep 1
  node bin/codemie.js mcp-auth-proxy status
  # direct control-endpoint check: POST /shutdown must ack 202
  curl -s -o /dev/null -w "shutdown_status=%{http_code}\n" -X POST http://127.0.0.1:42891/shutdown || true
  sleep 1
  node bin/codemie.js mcp-auth-proxy status
  ls "$CODEMIE_HOME/mcp-auth-proxy.state.json" 2>/dev/null && echo "STATE LEFT BEHIND (bad)" || echo "state cleared (good)"
'
```

Expected: `start` prints the `claude mcp add` line; first `status` shows running; `shutdown_status=202`; second `status` shows "not running"; `state cleared (good)`. (Confirms the `POST /shutdown` → self-exit → state-clear path end-to-end. On Windows the same `stop` command drives this instead of a signal.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mcp-auth-proxy.ts
git commit -m "feat(cli): stop mcp-auth-proxy via graceful control endpoint first

mcp-auth-proxy-windows Task 6"
```

---

## Self-Review

**Spec coverage** (against the Stage-2 decision "Graceful shutdown endpoint, cross-platform"):
- Console-window flash → Task 1 (`windowsHide`). ✓
- Windows liveness (`EPERM`) → Task 2. ✓
- Control-endpoint id safety → Task 3 (reserve `shutdown`). ✓
- Graceful `POST /shutdown` (daemon side) → Task 4 (endpoint) + Task 5 (runtime wiring). ✓
- CLI drives graceful stop cross-platform with signal fallback → Task 6. ✓
- POSIX not regressed → Task 5 keeps `SIGTERM`/`SIGINT` handlers; Task 6 keeps the `SIGTERM→SIGKILL` fallback; existing server SSE-drain test still green.

**Type consistency:** `onShutdownRequested?: () => void` is the same name in the Task 4 ctor, the Task 5 `gracefulShutdown` wiring, and is invoked only inside `handleShutdown`. `requestShutdown(port: number): Promise<boolean>` (Task 6) matches its single call site. `isProcessAlive(pid: number): boolean` signature unchanged (Task 2 changes only the body). `stop` remains `() => Promise<void>` in `RunningDaemon` (Task 5).

**Placeholder scan:** none — every code step shows complete code.

**Windows-safe items intentionally NOT changed** (confirmed portable in research): `BIND_HOST='127.0.0.1'`, all `path.join`/`getCodemiePath` path building, atomic `tmp`+`rename` state writes, TCP-loopback-only transport.
