/**
 * Skills Sync
 *
 * Silently re-fetches registered skills from the CodeMie platform
 * and updates their local SKILL.md files with the latest content.
 */

import { ConfigLoader } from '@/utils/config.js';
import { StorageScope } from '@/env/types.js';
import { getCodemieClient } from '@/utils/sdk-client.js';
import { registerClaudeSkill } from '@/cli/commands/skills/setup/generators/claude-skill-generator.js';
import { logger } from '@/utils/logger.js';

/**
 * Sync all registered skills with the latest content from the platform.
 * Respects scope: global skills → ~/.claude/skills/, local skills → cwd/.claude/skills/.
 * Runs silently — errors are logged but never surfaced to the user.
 */
export async function syncRegisteredSkills(profileName?: string, cwd?: string): Promise<void> {
	const workingDir = cwd ?? process.cwd();
	try {
		const [globalSkills, localSkills] = await Promise.all([
			ConfigLoader.loadSkillsByScope(StorageScope.GLOBAL, workingDir, profileName ?? 'default').catch(() => []),
			ConfigLoader.loadSkillsByScope(StorageScope.LOCAL, workingDir, profileName ?? 'default').catch(() => []),
		]);

		const allSkills = [
			...globalSkills.map(s => ({ skill: s, scope: StorageScope.GLOBAL })),
			...localSkills.map(s => ({ skill: s, scope: StorageScope.LOCAL })),
		];

		if (allSkills.length === 0) {
			return;
		}

		const client = await getCodemieClient();

		for (const { skill, scope } of allSkills) {
			try {
				const detail = await client.skills.get(skill.id);
				await registerClaudeSkill(detail, scope, scope === StorageScope.LOCAL ? workingDir : undefined);
				logger.debug(`[skills-sync] Synced skill: ${skill.name} (${scope})`);
			} catch (error) {
				logger.debug(`[skills-sync] Failed to sync skill ${skill.name}`, { error });
			}
		}
	} catch (error) {
		logger.debug('[skills-sync] Sync failed', { error });
	}
}
