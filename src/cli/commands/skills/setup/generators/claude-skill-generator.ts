import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dedent from 'dedent';
import { logger } from '@/utils/logger.js';
import type { SkillDetail } from 'codemie-sdk';

/**
 * Get the skills directory path for Claude Code
 */
function getSkillsDir(scope: 'global' | 'local' = 'global', workingDir?: string): string {
	if (scope === 'local' && workingDir) {
		return path.join(workingDir, '.claude', 'skills');
	}
	return path.join(os.homedir(), '.claude', 'skills');
}

/**
 * Create YAML frontmatter for Claude Code skill file
 */
function createSkillMetadata(skill: SkillDetail): string {
	const slug = generateSlug(skill);
	const description = skill.description || skill.name;

	return dedent`
		---
		name: ${slug}
		description: ${description}
		---
	`;
}

/**
 * Generate slug from skill name and ID
 */
function generateSlug(skill: SkillDetail): string {
	// Use skill name to create slug, fallback to ID
	const baseName = skill.name.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	return baseName || skill.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Create full SKILL.md content for Claude Code
 */
function createSkillContent(skill: SkillDetail): string {
	const metadata = createSkillMetadata(skill);
	const description = skill.description || skill.name;

	return dedent`
		${metadata}

		# ${skill.name}

		${description}

		## Instructions

		1. Extract the user's message from the conversation context
		2. Execute the command with the message
		3. Return the response to the user verbatim

		**File attachments are automatically detected** - any images or documents uploaded in
		recent messages are automatically included with the request.

		**ARGUMENTS**: "message"

		**Command format:**
		\`\`\`bash
		codemie skill run "${skill.id}" "message"
		\`\`\`

		## Examples

		**Simple message:**
		\`\`\`bash
		codemie skill run "${skill.id}" "help me with this"
		\`\`\`

		**With file attachment:**
		\`\`\`bash
		codemie skill run "${skill.id}" "analyze this code" --file "script.py"
		\`\`\`
	`;
}

/**
 * Register a CodeMie skill as a Claude Code skill
 * Creates: ~/.claude/skills/{slug}/SKILL.md
 */
export async function registerClaudeSkill(skill: SkillDetail, scope: 'global' | 'local' = 'global', workingDir?: string): Promise<string> {
	const slug = generateSlug(skill);
	const skillsDir = getSkillsDir(scope, workingDir);
	const skillDir = path.join(skillsDir, slug);
	const skillFile = path.join(skillDir, 'SKILL.md');

	try {
		await fs.mkdir(skillDir, { recursive: true });

		const content = createSkillContent(skill);
		await fs.writeFile(skillFile, content, 'utf-8');

		logger.debug(`Registered Claude skill: ${skillFile}`);
		return slug;
	} catch (error) {
		logger.error(`Failed to register Claude skill for ${skill.name}`, { error });
		throw error;
	}
}

/**
 * Unregister a Claude Code skill
 * Removes: ~/.claude/skills/{slug}/
 */
export async function unregisterClaudeSkill(slug: string, scope: 'global' | 'local' = 'global', workingDir?: string): Promise<void> {
	const skillsDir = getSkillsDir(scope, workingDir);
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
