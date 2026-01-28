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

  return dedent(`
    ---
    name: ${assistant.slug}
    description: ${description}
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

    When invoked:

    1. **Extract the user's message** from the conversation context
    2. **Execute the command**:
       \`\`\`bash
       codemie assistants chat "${assistant.id}" "$USER_MESSAGE"
       \`\`\`
    3. **Return the response** directly to the user

    The \`codemie assistants chat\` command communicates with the CodeMie platform to get responses from the ${assistant.name} assistant.

    ## Example

    User: "Help me review this code"

    You execute:
    \`\`\`bash
    codemie assistants chat "${assistant.id}" "Help me review this code"
    \`\`\`

    Then present the assistant's response to the user.
  `);
}

/**
 * Get subagent file path for a given slug
 */
function getSubagentFilePath(slug: string): string {
  const homeDir = os.homedir();
  const fileName = `${slug}.md`;
  return path.join(homeDir, '.claude', 'agents', fileName);
}

/**
 * Register Claude subagent
 * Creates subagent file in ~/.claude/agents/
 */
export async function registerClaudeSubagent(assistant: Assistant): Promise<void> {
  const subagentPath = getSubagentFilePath(assistant.slug!);
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
 * Removes subagent file from ~/.claude/agents/
 */
export async function unregisterClaudeSubagent(slug: string): Promise<void> {
  const subagentPath = getSubagentFilePath(slug);

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
