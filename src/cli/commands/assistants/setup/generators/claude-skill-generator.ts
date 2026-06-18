import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dedent from 'dedent';
import { logger } from '@/utils/logger.js';
import { StorageScope } from '@/env/types.js';
import { sanitizeToSlug } from '@/utils/slug.js';
import type { Assistant } from 'codemie-sdk';

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
 * Create YAML frontmatter for Claude Code skill file
 */
function createSkillMetadata(assistant: Assistant): string {
	const slug = assistant.slug || sanitizeToSlug(assistant.id) || assistant.id;
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
	const slug = assistant.slug || sanitizeToSlug(assistant.id) || assistant.id;

	return dedent`
		${metadata}

		# ${name}

		${description}

		## Instructions

		1. **Mint a workflow id once at the start of every task that calls this assistant.** Reuse it for every invocation in that task. Suggested patterns:
		   - From a shell: \`workflow_id="${slug}-$(date +%Y%m%d-%H%M%S)-$$"\`
		   - From an LLM caller: include the related ticket key (e.g. \`${slug}-EPMCDME-12345\`) or a fresh UUID.
		2. **Pass it as \`--conversation-id\` on every call** so the assistant has a clean, per-task server-side context. Do not rely on the implicit \`CODEMIE_SESSION_ID\` env-var fallback — that id is shared across every assistant invocation in your Claude session and causes cross-topic context bleed.
		3. **For state-changing operations (create / update / delete) put the full final payload in one message.** Do not split the work into a "draft" turn followed by a "confirm and apply" turn — if server-side context is lost between turns, the confirmation message itself can be persisted as the resource content.
		4. **After any write, re-fetch the resource and verify the written content matches what you sent.** If it does not match, the call was lost — resend in single-shot form with the full payload.

		**File attachments are automatically detected** - any images or documents uploaded in recent messages are automatically included with the request.

		**ARGUMENTS**: "message"

		**Command format:**
		\`\`\`bash
		codemie assistants chat "${assistantId}" --conversation-id "<workflow-id>" "message"
		\`\`\`

		## Examples

		**Simple message:**
		\`\`\`bash
		workflow_id="${slug}-$(date +%Y%m%d-%H%M%S)-$$"
		codemie assistants chat "${assistantId}" --conversation-id "$workflow_id" "help me with this"
		\`\`\`

		**With file attachment** (reuse the same workflow id):
		\`\`\`bash
		codemie assistants chat "${assistantId}" --conversation-id "$workflow_id" "analyze this code" --file "script.py"
		\`\`\`

		**With multiple files** (reuse the same workflow id):
		\`\`\`bash
		codemie assistants chat "${assistantId}" --conversation-id "$workflow_id" "review these files" --file "file1.png" --file "file2.py"
		\`\`\`
	`;
}

/**
 * Register an assistant as a Claude Code skill
 * Creates: ~/.claude/skills/{slug}/SKILL.md (global) or {cwd}/.claude/skills/{slug}/SKILL.md (local)
 */
export async function registerClaudeSkill(assistant: Assistant, scope: StorageScope = StorageScope.GLOBAL, workingDir?: string): Promise<void> {
	const slug = assistant.slug || sanitizeToSlug(assistant.id) || assistant.id;
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
