# Deferred from code review — 2026-11-12-hook-exit-zero-without-agent (2026-11-12)

- **Unmanaged guard runs after JSON.parse** — `src/cli/commands/hook.ts:1696` — empty or malformed stdin from a non-CodeMie run still exits 2 with stderr output because the managed-session check sits after parsing. Pre-existing: the parse-then-fail ordering predates this change, and Claude Code always sends valid JSON; the task only covers missing env vars.
