/**
 * Plugin Skills Sync
 *
 * Installs the Claude plugin bundle and copies each bundled skill's SKILL.md
 * to ~/.claude/skills/ with ${CLAUDE_PLUGIN_ROOT} resolved to the real path.
 * This mirrors what --plugin-dir does in the CLI path, making plugin skills
 * (e.g. msgraph) available when using the proxy.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ClaudePluginInstaller } from '../../../../agents/plugins/claude/claude.plugin-installer.js';
import { ClaudePluginMetadata } from '../../../../agents/plugins/claude/claude.plugin.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Ensure the Claude plugin bundle is installed and sync its bundled skill files
 * to ~/.claude/skills/ so they are available without --plugin-dir.
 * Fire-and-forget — never throws.
 */
export async function syncPluginSkills(): Promise<void> {
  try {
    const installer = new ClaudePluginInstaller(ClaudePluginMetadata);
    const result = await installer.install();
    if (!result.success) {
      logger.debug('[plugin-skills-sync] Plugin install failed, skipping skill sync');
      return;
    }

    const pluginRoot = result.targetPath;
    const skillsSourceDir = path.join(pluginRoot, 'skills');

    try {
      await fs.access(skillsSourceDir);
    } catch {
      return;
    }

    const entries = await fs.readdir(skillsSourceDir, { withFileTypes: true });
    const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');

    const resolvedBase = path.resolve(skillsSourceDir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const resolvedSkillDir = path.resolve(skillsSourceDir, entry.name);
      if (!resolvedSkillDir.startsWith(resolvedBase + path.sep)) continue;

      const sourceMd = path.join(resolvedSkillDir, 'SKILL.md');
      try {
        let content = await fs.readFile(sourceMd, 'utf-8');
        content = content.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);

        const targetDir = path.join(claudeSkillsDir, entry.name);
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, 'SKILL.md'), content, 'utf-8');
        logger.debug(`[plugin-skills-sync] Synced plugin skill: ${entry.name}`);
      } catch {
        logger.debug(`[plugin-skills-sync] Skipping ${entry.name}`);
      }
    }
  } catch (error) {
    logger.debug('[plugin-skills-sync] Sync failed', { error });
  }
}
