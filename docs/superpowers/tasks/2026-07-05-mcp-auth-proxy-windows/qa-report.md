# QA Report — mcp-auth-proxy Windows compatibility

- **Task:** mcp-auth-proxy-windows
- **Branch:** feat/mcp-auth-proxy
- **Reviewed range:** `9c6eecd..HEAD` (7 commits)
- **UI surface:** none (CLI + background daemon) → feature-verification **skipped** (`ui=false`)

## Gate Results

| Gate | Command | Result |
|---|---|---|
| license-check | `npm run license-check` | ✅ PASS (dependency licenses only; no source headers in repo) |
| lint | `eslint '{src,tests}/**/*.ts' --max-warnings=0` | ✅ PASS (zero warnings) |
| typecheck | `tsc --noEmit` | ✅ PASS |
| build | `tsc && tsc-alias && copy-plugin` | ✅ PASS |
| unit | `vitest run src` | ✅ PASS — 2278 passed, 1 skipped (151 files); +6 new tests |
| integration | `vitest run tests/integration` | ✅ PASS — 220 passed, 1 skipped (27 files) |
| commitlint | Conventional Commits on `9c6eecd..HEAD` | ✅ PASS — 7/7 commits conform |

## New test coverage (+6)

- `src/utils/__tests__/spawn-detached.test.ts` — 2: `windowsHide: true` on win32, `false` off-Windows.
- `src/mcp/auth-proxy/__tests__/state.test.ts` — +1: `isProcessAlive` EPERM⇒alive, ESRCH⇒dead.
- `src/mcp/auth-proxy/__tests__/config.test.ts` — +1: `shutdown` rejected as reserved route id.
- `src/mcp/auth-proxy/__tests__/server.test.ts` — +2: `POST /shutdown`⇒202+callback-once / `GET`⇒405; `/shutdown` intercepted before route lookup.

## Non-browser functional evidence (real daemon smoke, isolated CODEMIE_HOME)

1. `start --port 42892` → daemon detached, `/healthz` → `{"status":"ok",...}`.
2. `POST /shutdown` → `202 {"status":"shutting_down"}` → daemon self-exits (connection refused) → state file cleared. **Proves the cross-platform graceful path** (this is the exact path Windows `stop` uses instead of a signal).
3. `codemie mcp-auth-proxy stop` → `✓ mcp-auth-proxy stopped` in ~722ms (graceful, < 5s), `/healthz` refused after; second `stop` → `mcp-auth-proxy is not running` (idempotent).

## Code review

Independent adversarial review (blind lens over the diff + full-file context): **approve, high confidence**. One low-severity finding (CR-W-001: discarded `requestShutdown` boolean) applied inline (commit after review); happy path re-verified unchanged. See `code-review-final.json`.

**Status: PASSED**
