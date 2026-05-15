import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dedent from 'dedent';
import { logger } from '@/utils/logger.js';
import { StorageScope } from '@/env/types.js';
import { sanitizeToSlug } from '@/utils/slug.js';
import type { SkillDetail } from 'codemie-sdk';

/**
 * Get the skills directory path for Claude Code
 */
function getSkillsDir(scope: StorageScope = StorageScope.GLOBAL, workingDir?: string): string {
	if (scope === StorageScope.LOCAL && workingDir) {
		return path.join(workingDir, '.claude', 'skills');
	}
	return path.join(os.homedir(), '.claude', 'skills');
}

/**
 * Generate the skill name used in SKILL.md frontmatter (autocomplete key).
 * Uses only the base name so autocomplete stays clean.
 *
 * Known limitation: if two skills from different projects share the same base name,
 * they produce the same slash command key (e.g. /my-skill). Claude Code will surface
 * only one of them. The directory slug (see generateSlug) is unique, but the autocomplete
 * name is intentionally shared — changing it would break the UX for the common case.
 */
function generateName(skill: SkillDetail): string {
	const baseName = sanitizeToSlug(skill.name);
	return baseName || sanitizeToSlug(skill.id);
}

/**
 * Create YAML frontmatter for Claude Code skill file
 */
function createSkillMetadata(skill: SkillDetail): string {
	const name = generateName(skill);
	const description = skill.description || skill.name;

	return dedent`
		---
		name: ${name}
		description: ${description}
		---
	`;
}

/**
 * Generate slug used as the directory name for the skill.
 * Appends project and scope suffixes to prevent directory collisions when
 * multiple skills share the same name across different projects or scopes.
 */
function generateSlug(skill: SkillDetail, scope: StorageScope): string {
	const base = sanitizeToSlug(skill.name) || sanitizeToSlug(skill.id) || skill.id;
	const projectSuffix = skill.project ? `-${sanitizeToSlug(skill.project) || skill.project}` : '';
	return `${base}${projectSuffix}-${scope}`;
}

/**
 * Create full SKILL.md content for Claude Code
 */
function createSkillContent(skill: SkillDetail): string {
	const metadata = createSkillMetadata(skill);
	const content = skill.content || `# ${skill.name}\n\n${skill.description || ''}`;

	return dedent`
		${metadata}

		${content}
	`;
}

/**
 * Register a CodeMie skill as a Claude Code skill
 * Creates: ~/.claude/skills/{slug}/SKILL.md
 */
export async function registerClaudeSkill(skill: SkillDetail, scope: StorageScope = StorageScope.GLOBAL, workingDir?: string): Promise<string> {
	const slug = generateSlug(skill, scope);
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
export async function unregisterClaudeSkill(slug: string, scope: StorageScope = StorageScope.GLOBAL, workingDir?: string): Promise<void> {
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
