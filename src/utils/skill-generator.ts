/**
 * Claude Code Skill Generator
 *
 * Generates skill files for CodeMie assistants
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import type { Assistant } from 'codemie-sdk';
import { logger } from './logger.js';

/**
 * Generate a Claude Code skill for an assistant
 */
export async function generateAssistantSkill(assistant: Assistant): Promise<string> {
  const skillSlug = sanitizeSlug(assistant.name);
  const skillDir = path.join(os.homedir(), '.claude', 'skills', skillSlug);

  logger.debug('Generating skill for assistant', {
    assistantId: assistant.id,
    assistantName: assistant.name,
    skillSlug,
    skillDir
  });

  // Create skill directory
  await fs.mkdir(skillDir, { recursive: true });

  // Generate skill content
  const skillContent = generateSkillMarkdown(assistant, skillSlug);

  // Write SKILL.md
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(skillPath, skillContent, 'utf-8');

  logger.debug('Skill file generated', { skillPath });

  return skillSlug;
}

/**
 * Remove an assistant's skill file
 */
export async function removeAssistantSkill(assistantName: string): Promise<void> {
  const skillSlug = sanitizeSlug(assistantName);
  const skillDir = path.join(os.homedir(), '.claude', 'skills', skillSlug);

  try {
    await fs.rm(skillDir, { recursive: true, force: true });
    logger.debug('Skill removed', { skillSlug, skillDir });
  } catch (error) {
    logger.debug('Failed to remove skill (may not exist)', { skillSlug, error });
  }
}

/**
 * Generate skill markdown content
 */
function generateSkillMarkdown(assistant: Assistant, skillSlug: string): string {
  const description = assistant.description || `Interact with ${assistant.name} assistant`;
  const systemPrompt = assistant.system_prompt || '';

  // Build context section
  let contextSection = '';
  if (systemPrompt) {
    contextSection = `
## Assistant Context

${systemPrompt}
`;
  }

  // Build model info
  const modelInfo = assistant.llm_model_type ? `\nModel: ${assistant.llm_model_type}` : '';

  return `---
name: ${skillSlug}
description: ${description}
disable-model-invocation: true
allowed-tools: Bash(codemie:*)
argument-hint: "[message]"
---

# ${assistant.name}

${description}${modelInfo}
${contextSection}
## Usage

Send a message to this assistant:

\`\`\`
/${skillSlug} "your message here"
\`\`\`

## Implementation

This skill sends your message to the CodeMie assistant backend.

Message: $ARGUMENTS

\\\`\\\`\\\`bash
codemie assistants chat --assistant-id "${assistant.id}" "$ARGUMENTS" 2>&1
\\\`\\\`\\\`
`;
}

/**
 * Sanitize assistant name to valid slug
 */
function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 64);
}
