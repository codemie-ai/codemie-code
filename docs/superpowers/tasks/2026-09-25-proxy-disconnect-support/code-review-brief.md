# Code review (check round) — 2026-09-25-proxy-disconnect-support (2026-09-25)

**approve** · confidence: high · 5/5 prior blocking findings resolved · 0 unresolved · 0 superseded
Coverage: targeted verifier ✓

## Finding status

- CR-001 (decision, `src/cli/commands/proxy/connectors/desktop.ts:976`) — **resolved**: `removeDesktopConfig` now detects stranded gateway keys via `INFERENCE_KEYS.some(key in existing)` when no marker exists; covered by a new regression test.
- CR-002 (`src/cli/commands/proxy/connectors/desktop.ts:995`) — **resolved**: marker-clear write wrapped in try/catch; a clear failure is logged, not fatal.
- CR-003 (`src/cli/commands/proxy/connectors/vscode.ts`, `vscode-claude-code.ts`) — **resolved**: both connectors isolate per-location write failures; only throw when neither location succeeded.
- CR-004 (`src/cli/commands/proxy/disconnect-orchestrator.ts:47,157`) — **resolved**: `printSummary(results)` added and called, matching `connect-orchestrator.ts`'s convention exactly.
- CR-005 (`src/cli/commands/proxy/__tests__/connect-wiring.test.ts`) — **resolved**: three new `parseAsync` CLI-parser tests cover `--claude-desktop`/`--vscode`/`--vscode-claude-code`.

No blocking findings — the diff speaks for itself.
