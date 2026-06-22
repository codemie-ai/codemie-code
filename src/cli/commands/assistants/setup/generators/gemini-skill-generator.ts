import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dedent from 'dedent';
import type { Assistant } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';

function getSkillsDir(scope: 'global' | 'local' = 'global', workingDir?: string): string {
  if (scope === 'local' && workingDir) {
    return path.join(workingDir, '.gemini', 'skills');
  }

  return path.join(os.homedir(), '.gemini', 'skills');
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
  const slug = assistant.slug || assistant.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return dedent`
    ${metadata}

    # ${assistant.name}

    ${description}

    ## Instructions

    Use this skill when the user asks to consult the ${assistant.name} assistant.

    1. **Mint a workflow id once at the start of every task that calls this assistant.** Reuse it for every invocation in that task. Suggested shell pattern: \`workflow_id="${slug}-$(date +%Y%m%d-%H%M%S)-$$"\`.
    2. **Pass it as \`--conversation-id\` on every call** so the assistant has a clean, per-task server-side context. Do not rely on the implicit \`CODEMIE_SESSION_ID\` env-var fallback — that id is shared across every assistant invocation in your Gemini session and causes cross-topic context bleed.
    3. **For state-changing operations (create / update / delete) put the full final payload in one message.** Do not split the work into a "draft" turn followed by a "confirm and apply" turn — if server-side context is lost between turns, the confirmation message itself can be persisted as the resource content.
    4. **After any write, re-fetch the resource and verify the written content matches what you sent.** If it does not match, the call was lost — resend in single-shot form with the full payload.

    Run CodeMie assistant chat with the user's message:

    \`\`\`bash
    workflow_id="${slug}-$(date +%Y%m%d-%H%M%S)-$$"
    codemie assistants chat "${assistant.id}" --conversation-id "$workflow_id" "message"
    \`\`\`

    File attachments can be passed through the chat command with \`--file\` (reuse the same workflow id):

    \`\`\`bash
    codemie assistants chat "${assistant.id}" --conversation-id "$workflow_id" "review this file" --file "path/to/file"
    \`\`\`
  `;
}

export async function registerGeminiAssistantSkill(
  assistant: Assistant,
  scope: 'global' | 'local' = 'global',
  workingDir?: string
): Promise<void> {
  const slug = assistant.slug || assistant.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const skillDir = path.join(getSkillsDir(scope, workingDir), slug);
  const skillFile = path.join(skillDir, 'SKILL.md');

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillFile, createSkillContent(assistant), 'utf-8');

  logger.debug('Registered Gemini assistant skill', {
    assistantId: assistant.id,
    slug,
    skillFile,
  });
}

export async function unregisterGeminiAssistantSkill(
  slug: string,
  scope: 'global' | 'local' = 'global',
  workingDir?: string
): Promise<void> {
  const skillDir = path.join(getSkillsDir(scope, workingDir), slug);

  await fs.rm(skillDir, { recursive: true, force: true });
  logger.debug('Unregistered Gemini assistant skill', { slug, skillDir });
}
