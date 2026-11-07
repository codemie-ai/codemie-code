# Development Practices

**Project**: @codemieai/code · **Stack**: TypeScript (ESM, target ES2022, module NodeNext) commander CLI · **Scope**: errors, logger levels, stdout discipline, CodeMie-home paths and process execution; registries live in `.ai-run/guides/architecture/architecture.md`, HTTP retries in `.ai-run/guides/integration/external-integrations.md`

## Error handling

### Rules
- R5. Throw a `CodeMieError` subclass from `src/utils/errors.ts` rather than a bare `Error` (callers and `formatErrorForUser` key on the class). Known debt, to fix: src/utils/config.ts, src/agents/core/BaseAgentAdapter.ts, src/cli/commands/hook.ts, src/providers/plugins/sso/sso.http-client.ts, src/plugins/core/manifest-parser.ts. Evidence: `src/utils/errors.ts::CodeMieError`

## Logging

### Rules
- R1. Pick the logger level by where the line must appear: `debug` writes to file and stderr only when `CODEMIE_DEBUG` is `true`/`1`; `info`/`warn` go to the log file only; `error` goes to the file and reaches the console only in debug mode; `notice` always prints a yellow warning plus the log path; `success`/`status` print to stdout. Evidence: `src/utils/logger.ts::Logger.notice`
- R2. In a `codemie hook`/`codemie sound` process write nothing to stdout (it is the agent's protocol channel; `bin/codemie.js` nulls the logger console there): exit 2 with one `console.error` line to block, set `process.exitCode = 1` for a non-blocking failure, and prefer `process.exitCode` over `process.exit()` (Windows libuv assertion). Evidence: `src/cli/commands/hook.ts::createHookCommand`
- R3. Guard any new start-up step in `bin/codemie.js` (migration output, update check, notices) with both `isHookProcess` and `isMachineOutput` (a `--json` caller parses stdout and fails on any extra byte). Evidence: `src/utils/machine-output.ts::isMachineOutputInvocation`

## Configuration

### Rules
- R7. Build paths under the CodeMie home with `getCodemiePath()` (it honours `CODEMIE_HOME`, which every Vitest project points at a temp dir). Allowed exceptions: src/utils/npm-prefix.ts (getLegacyNpmPrefixPath), src/agents/plugins/claude/plugin/statusline.ts. Known debt, to fix: src/agents/plugins/claude/claude.plugin-installer.ts (ClaudePluginInstaller.getTargetPath), src/mcp/proxy-logger.ts (logDir), bin/codemie-mcp-proxy.js (logDir). Evidence: `src/utils/paths.ts::getCodemiePath`

## Dependencies

### Rules
- R4. Check `result.code` after `exec()` (it resolves on a non-zero exit in non-interactive mode and rejects only on spawn error, signal, timeout, or a non-zero exit with `interactive: true`). Evidence: `src/utils/exec.ts::exec`
- R6. Run a one-shot command whose output is captured through `exec()` (`src/utils/exec.ts`) or the npm/git helpers in `src/utils/processes.ts` (cross-platform path resolution, no shell on Unix); detached or streaming spawns may use `child_process` directly. Allowed exceptions: src/bin/codebase-memory-ui-daemon.ts, src/providers/plugins/bedrock/bedrock.setup-steps.ts, src/providers/plugins/sso/sso.auth.ts, src/agents/core/BaseAgentAdapter.ts, src/workflows/detector.ts, src/agents/core/signal-handlers.ts, src/utils/clipboard.ts, src/mcp/auth/mcp-oauth-provider.ts, src/cli/commands/sound.ts, src/cli/commands/skills/lib/run-skills-cli.ts, src/telemetry/runtime/DesktopRepositoryResolver.ts. Evidence: `src/utils/exec.ts::exec`

### Constraints
| Do not | Do instead | Why | Evidence |
|---|---|---|---|
| Do not copy `src/agents/plugins/claude/session/processors/claude.conversations-processor.ts::getAgentDisplayName` | Import `AgentRegistry` statically (or `await import()`) | `require` is undefined in this ESM package, so the call throws and always falls back to the raw name | `src/agents/plugins/claude/session/processors/claude.conversations-processor.ts::getAgentDisplayName` |
