# Deferred from code review — 2026-10-02-vscode-model-token-limits (2026-10-05)

- **Fractional catalog token limits accepted** — `src/cli/commands/proxy/connectors/tenant-catalog.ts:58` — isPositiveFiniteNumber admits non-integers (e.g. 1000.5), which flow into maxInputTokens/maxOutputTokens. Pre-existing: the validator predates this change; the change only adds a subtraction on its output.
