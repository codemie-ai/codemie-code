/**
 * Claude Code Skill Generator
 *
 * Generates skill files for CodeMie assistants
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Assistant } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import { createSkillMarkdown } from './skill-template.js';

/**
 * Generate a Claude Code skill for an assistant
 */
export async function generateAssistantSkill(assistant: Assistant): Promise<string> {
  if (!assistant.slug) {
    throw new Error(`Assistant ${assistant.name} does not have a slug`);
  }

  const skillSlug = assistant.slug;
  const skillDir = path.join(os.homedir(), '.claude', 'skills', skillSlug);

  logger.debug('Generating skill for assistant', {
    assistantId: assistant.id,
    assistantName: assistant.name,
    skillSlug,
    skillDir
  });

  await fs.mkdir(skillDir, { recursive: true });

  // Generate skill content
  const skillContent = createSkillMarkdown(assistant);

  // Write SKILL.md
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(skillPath, skillContent, 'utf-8');

  logger.debug('Skill file generated', { skillPath });

  return skillSlug;
}

/**
 * Remove an assistant's skill file
 */
export async function removeAssistantSkill(skillSlug: string): Promise<void> {
  const skillDir = path.join(os.homedir(), '.claude', 'skills', skillSlug);

  try {
    await fs.rm(skillDir, { recursive: true, force: true });
    logger.debug('Skill removed', { skillSlug, skillDir });
  } catch (error) {
    logger.debug('Failed to remove skill (may not exist)', { skillSlug, error });
  }
}
