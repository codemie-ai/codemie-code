import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dedent from 'dedent';
import { logger } from '@/utils/logger.js';
import type { Assistant } from 'codemie-sdk';

/**
 * Get the skills directory path for Claude Code
 */
function getSkillsDir(): string {
	const homeDir = os.homedir();
	return path.join(homeDir, '.claude', 'skills');
}

/**
 * Create YAML frontmatter for Claude Code skill file
 */
function createSkillMetadata(assistant: Assistant): string {
	const slug = assistant.slug || assistant.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');

	return dedent`
		---
		name: ${slug}
		description: ${assistant.description || assistant.name}
		---
	`;
}

/**
 * Create full SKILL.md content for Claude Code
 */
function createSkillContent(assistant: Assistant): string {
	const metadata = createSkillMetadata(assistant);
	const name = assistant.name;
	const description = assistant.description || assistant.name;
	const assistantId = assistant.id;

	return dedent`
		${metadata}

		# ${name}

		${description}

		## Instructions

		Send the user's message to the ${name} assistant:

		\`\`\`bash
		codemie assistants chat "${assistantId}" "$ARGUMENTS"
		\`\`\`

		The assistant will process the request and return a response.
	`;
}

/**
 * Register an assistant as a Claude Code skill
 * Creates: ~/.claude/skills/{slug}/SKILL.md
 */
export async function registerClaudeSkill(assistant: Assistant): Promise<void> {
	const slug = assistant.slug || assistant.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
	const skillsDir = getSkillsDir();
	const skillDir = path.join(skillsDir, slug);
	const skillFile = path.join(skillDir, 'SKILL.md');

	try {
		await fs.mkdir(skillDir, { recursive: true });

		const content = createSkillContent(assistant);
		await fs.writeFile(skillFile, content, 'utf-8');

		logger.debug(`Registered Claude skill: ${skillFile}`);
	} catch (error) {
		logger.error(`Failed to register Claude skill for ${assistant.name}`, { error });
		throw error;
	}
}

/**
 * Unregister a Claude Code skill
 * Removes: ~/.claude/skills/{slug}/
 */
export async function unregisterClaudeSkill(slug: string): Promise<void> {
	const skillsDir = getSkillsDir();
	const skillDir = path.join(skillsDir, slug);

	try {
		try {
			await fs.access(skillDir);
		} catch {
			logger.debug(`Skill directory not found: ${skillDir}`);
			return;
		}

		await fs.rm(skillDir, { recursive: true, force: true });
		logger.debug(`Unregistered Claude skill: ${skillDir}`);
	} catch (error) {
		logger.error(`Failed to unregister Claude skill ${slug}`, { error });
		throw error;
	}
}
