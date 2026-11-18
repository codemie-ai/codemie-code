/**
 * Claude Code's analytics tracking scope in `~/.claude/settings.json`: reading the project list
 * (`readClaudeCodeOtlpScope`) and adding one project to it (`addClaudeCodeOtlpProject`), as `proxy analytics
 * include` and `proxy doctor` use them.
 */
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';
import { withPidLock } from '@/utils/pid-lock.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { ConnectorScopeRead } from '@/agents/core/project-allowlist.js';
import {
  CODEMIE_ANALYTICS_PROJECT_FILTER_ENV,
  addProjectPath,
  getClaudeSettingsPath,
  parseAllowlist,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { readSettingsFile, type ClaudeSettings } from './claude-code-otlp.js';
import { writeAtomically } from './vscode.js';

/**
 * Claude Code's tracking scope, from the project list in `~/.claude/settings.json` env: absent or empty
 * means every project (`user`), a non-empty list means `project`. Never throws.
 */
export async function readClaudeCodeOtlpScope(): Promise<ConnectorScopeRead> {
  const settingsPath = getClaudeSettingsPath();
  let existing: ClaudeSettings;
  try {
    existing = await readSettingsFile(settingsPath);
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
  const allowlist = parseAllowlist(existing.env?.[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]);
  if (allowlist.kind === 'invalid') {
    return { invalid: `${CODEMIE_ANALYTICS_PROJECT_FILTER_ENV} in ${settingsPath} is not a JSON array of absolute paths` };
  }
  if (allowlist.kind === 'absent' || allowlist.paths.length === 0) {
    return { scope: 'user', paths: [] };
  }
  return { scope: 'project', paths: allowlist.paths };
}

/**
 * Adds `projectPath` to Claude Code's project list. Only valid in project scope: an empty or absent list
 * already tracks every project, and writing one entry would narrow it. A no-op when already listed.
 *
 * The read-modify-write runs under a CodeMie pid lock, so two CodeMie processes adding projects never lose one.
 * The `settings.json.codemie-backup` needs no refresh: the backup never holds the project list (connect strips it
 * before taking the snapshot), the same as the project-scope remover's write.
 */
export async function addClaudeCodeOtlpProject(projectPath: string): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  await withPidLock(
    getCodemiePath('claude-settings.lock'),
    async () => {
      const existing = await readSettingsFile(settingsPath);
      const allowlist = parseAllowlist(existing.env?.[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]);
      if (allowlist.kind !== 'valid' || allowlist.paths.length === 0) {
        throw new ConfigurationError(`Claude Code does not track a project list in ${settingsPath}, so nothing was added.`);
      }
      const paths = await addProjectPath(allowlist.paths, projectPath);
      if (paths.length === allowlist.paths.length) return;
      const env = { ...(existing.env ?? {}), [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: JSON.stringify(paths) };
      await writeAtomically(settingsPath, JSON.stringify({ ...existing, env }, null, 2) + '\n');
      logger.info('[proxy] Added project to Claude Code analytics allowlist', ...sanitizeLogArgs({ settingsPath, paths }));
    },
    () => new ConfigurationError(`${settingsPath} is being changed by another CodeMie process and was not changed. Retry in a moment.`)
  );
}
