/**
 * Writes/removes CodeMie's hooks-only wiring for native (non-managed) GitHub Copilot CLI
 * sessions: one CodeMie-owned hook-definitions file under `$COPILOT_HOME/hooks/` (default
 * `~/.copilot/hooks/`), plus this connector's project scope record
 * (`copilot-connector-scope.ts`). Never written to `.github/hooks/`.
 *
 * v1 scope: hooks-only, no OTel settings, no new route. The hook-file JSON shape below (camelCase
 * event name -> array of `{exec, args, timeoutSec}` entries, with `exec`/`args` as absolute
 * commands and an explicit `timeoutSec`).
 */

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { getDirname } from '@/utils/paths.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import {
  isCopilotProjectTracked,
  readCopilotConnectorScope,
  writeCopilotConnectorScope,
  type CopilotConnectorScope,
} from '@/agents/core/copilot-connector-scope.js';
import { addProjectPath, removeProjectPath } from '@/agents/core/project-allowlist.js';
import { getCopilotHome } from '@/agents/plugins/copilot-cli/copilot-cli.paths.js';
import { CLI_HOOK_EVENT_NAMES, COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import { writeAtomically } from './vscode.js';

export const CLI_HOOK_TIMEOUT_SECONDS = 30;
const CLI_HOOK_FILE_NAME = 'codemie-copilot-cli-hooks.json';

export interface WriteCopilotCliOtlpOptions {
  scope?: 'user' | 'project';
}

export interface WriteCopilotCliOtlpResult {
  hookFilePath: string;
  hookEvents: number;
  /** Tracked project roots; empty means all projects. */
  allowlist: string[];
}

export interface RemoveCopilotCliOtlpOptions {
  scope?: 'user' | 'project';
}

export interface RemoveCopilotCliOtlpResult {
  removed: boolean;
  mode: 'entry-removed' | 'full' | 'noop';
  hookFilePath: string;
  reason?: string;
  allowlist?: string[];
}

export function getCopilotCliHookFilePath(): string {
  return join(getCopilotHome(), 'hooks', CLI_HOOK_FILE_NAME);
}

/** Absolute `node` + script path per event, so the hook runner's PATH doesn't matter. */
function resolveHookEntry(eventName: string): { exec: string; args: string[]; timeoutSec: number } {
  // dist/cli/commands/proxy/connectors/copilot-cli-otlp.js -> ../../../../../bin/codemie.js (repo root's bin/)
  const cliEntry = join(getDirname(import.meta.url), '../../../../../bin/codemie.js');
  return {
    exec: process.execPath,
    args: [cliEntry, 'hook', '--agent', COPILOT_CLI_OTLP_AGENT_NAME, '--event', eventName],
    timeoutSec: CLI_HOOK_TIMEOUT_SECONDS,
  };
}

/** Copilot CLI hook config: `version` must be the literal 1 and events live under `hooks`. */
export function buildHookFileContent(): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const eventName of CLI_HOOK_EVENT_NAMES) {
    hooks[eventName] = [resolveHookEntry(eventName)];
  }
  return { version: 1, hooks };
}

async function resolveScope(opts: { scope?: 'user' | 'project' }): Promise<CopilotConnectorScope> {
  if (opts.scope !== 'project') {
    return { enabled: true, scope: 'user' };
  }
  const existing = await readCopilotConnectorScope(COPILOT_CLI_OTLP_AGENT_NAME);
  const currentPaths = existing.kind === 'ok' && existing.value.enabled && existing.value.scope === 'project'
    ? existing.value.paths
    : [];
  const paths = await addProjectPath(currentPaths, resolveProjectRoot());
  return { enabled: true, scope: 'project', paths };
}

export async function writeCopilotCliOtlpConfig(
  opts: WriteCopilotCliOtlpOptions = {}
): Promise<WriteCopilotCliOtlpResult> {
  const hookFilePath = getCopilotCliHookFilePath();

  await writeAtomically(hookFilePath, `${JSON.stringify(buildHookFileContent(), null, 2)}\n`);

  const scope = await resolveScope(opts);
  await writeCopilotConnectorScope(COPILOT_CLI_OTLP_AGENT_NAME, scope);

  const allowlist = scope.enabled && scope.scope === 'project' ? scope.paths : [];
  logger.info(
    '[proxy] Configured Copilot CLI hooks-only analytics',
    ...sanitizeLogArgs({ hookFilePath, hookEvents: CLI_HOOK_EVENT_NAMES.length, allowlist })
  );

  return { hookFilePath, hookEvents: CLI_HOOK_EVENT_NAMES.length, allowlist };
}

export async function removeCopilotCliOtlpConfig(
  opts: RemoveCopilotCliOtlpOptions = {}
): Promise<RemoveCopilotCliOtlpResult> {
  const hookFilePath = getCopilotCliHookFilePath();

  if (opts.scope === 'project') {
    const existing = await readCopilotConnectorScope(COPILOT_CLI_OTLP_AGENT_NAME);
    if (existing.kind !== 'ok' || !existing.value.enabled || existing.value.scope !== 'project') {
      return {
        removed: false,
        mode: 'noop',
        hookFilePath,
        reason: existing.kind === 'corrupt'
          ? 'connector scope config is corrupt; fix it manually or disconnect without --scope project'
          : 'connector is not scoped to specific projects',
      };
    }
    const projectRoot = resolveProjectRoot();
    const remaining = await removeProjectPath(existing.value.paths, projectRoot);
    if (remaining.length === existing.value.paths.length) {
      return { removed: false, mode: 'noop', hookFilePath, reason: 'current project is not tracked' };
    }
    if (remaining.length > 0) {
      await writeCopilotConnectorScope(COPILOT_CLI_OTLP_AGENT_NAME, {
        enabled: true,
        scope: 'project',
        paths: remaining,
      });
      logger.info('[proxy] Removed project from Copilot CLI analytics scope', ...sanitizeLogArgs({ remaining }));
      return { removed: true, mode: 'entry-removed', hookFilePath, allowlist: remaining };
    }
    // Last tracked project removed: fall through to full removal below.
  }

  const existed = existsSync(hookFilePath);
  if (existed) {
    await unlink(hookFilePath);
  }
  await writeCopilotConnectorScope(COPILOT_CLI_OTLP_AGENT_NAME, { enabled: false });

  if (!existed) {
    return { removed: false, mode: 'noop', hookFilePath, reason: 'no CodeMie hook file found' };
  }

  logger.info('[proxy] Removed Copilot CLI analytics hooks', ...sanitizeLogArgs({ hookFilePath }));
  return { removed: true, mode: 'full', hookFilePath };
}

/** Allowlist read used by `codemie proxy status`. */
export async function describeCopilotCliScope(): Promise<string> {
  const scope = await readCopilotConnectorScope(COPILOT_CLI_OTLP_AGENT_NAME);
  if (scope.kind === 'corrupt') return 'corrupt (fix manually or reconnect)';
  if (!scope.value.enabled) return 'disabled';
  if (scope.value.scope === 'user') return 'all projects';
  return scope.value.paths.join(', ') || 'no projects tracked';
}

/** Exposed for tests / `isTracked()` parity checks only; not part of the write path above. */
export async function isCopilotCliCwdTracked(cwd: string | undefined): Promise<boolean> {
  return isCopilotProjectTracked(cwd, await readCopilotConnectorScope(COPILOT_CLI_OTLP_AGENT_NAME));
}
