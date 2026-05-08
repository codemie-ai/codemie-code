import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dedent from 'dedent';
import { logger } from '@/utils/logger.js';
import type { Assistant } from 'codemie-sdk';

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
function createSkillMetadata(assistant: Assistant): string {
	const slug = assistant.slug || assistant.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
	const baseDescription = assistant.description || assistant.name;

	return dedent`
		---
		name: ${slug}
		description: ${baseDescription}
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

		1. Extract the user's message from the conversation context
		2. Execute the command with the message
		3. Return the response

		**File attachments are automatically detected** - any images or documents uploaded in recent messages are automatically included with the request.

		**ARGUMENTS**: "message"

		**Command format:**
		\`\`\`bash
		codemie assistants chat "${assistantId}" "message"
		\`\`\`

		## Examples

		**Simple message:**
		\`\`\`bash
		codemie assistants chat "${assistantId}" "help me with this"
		\`\`\`

		**ARGUMENTS**: "check this code" --file /path/to/your/script.py

		**With file attachment:**
		\`\`\`bash
		codemie assistants chat "${assistantId}" "analyze this code" --file "script.py"
		\`\`\`

		**With multiple files:**
		\`\`\`bash
		codemie assistants chat "${assistantId}" "review these files" --file "file1.png" --file "file2.py"
		\`\`\`
	`;
}

/**
 * Register an assistant as a Claude Code skill
 * Creates: ~/.claude/skills/{slug}/SKILL.md (global) or {cwd}/.claude/skills/{slug}/SKILL.md (local)
 */
export async function registerClaudeSkill(assistant: Assistant, scope: 'global' | 'local' = 'global', workingDir?: string): Promise<void> {
	const slug = assistant.slug || assistant.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
	const skillsDir = getSkillsDir(scope, workingDir);
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
 * Removes: ~/.claude/skills/{slug}/ (global) or {cwd}/.claude/skills/{slug}/ (local)
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
