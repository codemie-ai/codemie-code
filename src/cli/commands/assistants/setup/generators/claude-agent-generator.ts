/**
 * Claude Subagent Generator
 *
 * Generates Claude subagent files for Codemie assistants
 * Creates subagent Markdown files in ~/.claude/agents/
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dedent from 'dedent';
import type { Assistant } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';

/**
 * Create Claude subagent metadata for frontmatter
 */
export function createClaudeSubagentMetadata(assistant: Assistant): string {
  const description = assistant.description || `Interact with ${assistant.name}`;
  const sanitizedDescription = description
    .replace(/\n/g, ' ')
    .replace(/"/g, '\\"')
    .trim();

  return dedent(`
    ---
    name: ${assistant.slug}
    description: "${sanitizedDescription}"
    tools: Read, Bash
    model: inherit
    ---
  `);
}

/**
 * Create Claude subagent content (Markdown format for .claude/agents/)
 */
export function createClaudeSubagentContent(assistant: Assistant): string {
  const metadata = createClaudeSubagentMetadata(assistant);
  const description = assistant.description || `Interact with ${assistant.name}`;

  return dedent(`
    ${metadata}

    # ${assistant.name}

    ${description}

    ## Instructions

    1. Extract the user's message from the conversation context
    2. Execute the command with the message
    3. Return the response

    **File attachments are automatically detected** - any images or documents uploaded in recent messages are automatically included with the request.

    **ARGUMENTS**: "message"

    **Command format:**
    \`\`\`bash
    codemie assistants chat "${assistant.id}" "message"
    \`\`\`

    ## Examples

    **Simple message:**
    \`\`\`bash
    codemie assistants chat "${assistant.id}" "Help me with this task"
    \`\`\`

    **ARGUMENTS**: "check this code" --file /path/to/your/script.py

    **With file attachment:**
    \`\`\`bash
    codemie assistants chat "${assistant.id}" "Analyze this code" --file "script.py"
    \`\`\`

    **With multiple files:**
    \`\`\`bash
    codemie assistants chat "${assistant.id}" "Review these files" --file "file1.png" --file "file2.py"
    \`\`\`
  `);
}

/**
 * Get subagent file path for a given slug
 */
function getSubagentFilePath(slug: string, scope: 'global' | 'local' = 'global', workingDir?: string): string {
  const agentsDir = scope === 'local' && workingDir
    ? path.join(workingDir, '.claude', 'agents')
    : path.join(os.homedir(), '.claude', 'agents');
  return path.join(agentsDir, `${slug}.md`);
}

/**
 * Register Claude subagent
 * Creates subagent file in ~/.claude/agents/ (global) or {cwd}/.claude/agents/ (local)
 */
export async function registerClaudeSubagent(assistant: Assistant, scope: 'global' | 'local' = 'global', workingDir?: string): Promise<void> {
  const subagentPath = getSubagentFilePath(assistant.slug!, scope, workingDir);
  const claudeAgentsDir = path.dirname(subagentPath);

  logger.debug('Registering Claude subagent', {
    assistantId: assistant.id,
    assistantName: assistant.name,
    slug: assistant.slug,
    subagentPath
  });

  // Create directory if it doesn't exist
  await fs.mkdir(claudeAgentsDir, { recursive: true });

  // Create and write subagent file
  const content = createClaudeSubagentContent(assistant);
  await fs.writeFile(subagentPath, content, 'utf-8');

  logger.debug('Claude subagent registered', {
    slug: assistant.slug,
    subagentPath
  });
}

/**
 * Unregister Claude subagent
 * Removes subagent file from ~/.claude/agents/ (global) or {cwd}/.claude/agents/ (local)
 */
export async function unregisterClaudeSubagent(slug: string, scope: 'global' | 'local' = 'global', workingDir?: string): Promise<void> {
  const subagentPath = getSubagentFilePath(slug, scope, workingDir);

  try {
    await fs.unlink(subagentPath);
    logger.debug('Claude subagent unregistered', {
      slug,
      subagentPath
    });
  } catch (error) {
    logger.debug('Failed to remove subagent file (may not exist)', {
      slug,
      error
    });
  }
}
