import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dedent from 'dedent';
import type { Assistant } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';

function getSkillsDir(scope: 'global' | 'local' = 'global', workingDir?: string): string {
  if (scope === 'local' && workingDir) {
    return path.join(workingDir, '.codex', 'skills');
  }

  return path.join(os.homedir(), '.codex', 'skills');
}

function createSkillMetadata(assistant: Assistant): string {
  const slug = assistant.slug || assistant.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const description = (assistant.description || `Interact with ${assistant.name}`)
    .replace(/\n/g, ' ')
    .trim();

  return dedent`
    ---
    name: ${slug}
    description: ${description}
    ---
  `;
}

function createSkillContent(assistant: Assistant): string {
  const metadata = createSkillMetadata(assistant);
  const description = assistant.description || `Interact with ${assistant.name}`;

  return dedent`
    ${metadata}

    # ${assistant.name}

    ${description}

    ## Instructions

    Use this skill when the user asks to consult the ${assistant.name} assistant.

    Run CodeMie assistant chat with the user's message:

    \`\`\`bash
    codemie assistants chat "${assistant.id}" "message"
    \`\`\`

    File attachments can be passed through the chat command with \`--file\`:

    \`\`\`bash
    codemie assistants chat "${assistant.id}" "review this file" --file "path/to/file"
    \`\`\`
  `;
}

export async function registerCodexAssistantSkill(
  assistant: Assistant,
  scope: 'global' | 'local' = 'global',
  workingDir?: string
): Promise<void> {
  const slug = assistant.slug || assistant.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const skillDir = path.join(getSkillsDir(scope, workingDir), slug);
  const skillFile = path.join(skillDir, 'SKILL.md');

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillFile, createSkillContent(assistant), 'utf-8');

  logger.debug('Registered Codex assistant skill', {
    assistantId: assistant.id,
    slug,
    skillFile,
  });
}

export async function unregisterCodexAssistantSkill(
  slug: string,
  scope: 'global' | 'local' = 'global',
  workingDir?: string
): Promise<void> {
  const skillDir = path.join(getSkillsDir(scope, workingDir), slug);

  try {
    await fs.rm(skillDir, { recursive: true, force: true });
    logger.debug('Unregistered Codex assistant skill', { slug, skillDir });
  } catch (error) {
    logger.debug('Failed to remove Codex assistant skill (may not exist)', {
      slug,
      error,
    });
  }
}
