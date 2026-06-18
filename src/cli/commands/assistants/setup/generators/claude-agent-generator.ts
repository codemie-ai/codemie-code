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
import { StorageScope } from '@/env/types.js';

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

    1. **Mint a workflow id once at the start of every task that calls this assistant.** Reuse it for every invocation in that task. Suggested patterns:
       - From a shell: \`workflow_id="${assistant.slug}-$(date +%Y%m%d-%H%M%S)-$$"\`
       - From an LLM caller: include the related ticket key (e.g. \`${assistant.slug}-EPMCDME-12345\`) or a fresh UUID.
    2. **Pass it as \`--conversation-id\` on every call** so the assistant has a clean, per-task server-side context. Do not rely on the implicit \`CODEMIE_SESSION_ID\` env-var fallback — that id is shared across every assistant invocation in your Claude session and causes cross-topic context bleed.
    3. **For state-changing operations (create / update / delete) put the full final payload in one message.** Do not split the work into a "draft" turn followed by a "confirm and apply" turn — if server-side context is lost between turns, the confirmation message itself can be persisted as the resource content.
    4. **After any write, re-fetch the resource and verify the written content matches what you sent.** If it does not match, the call was lost — resend in single-shot form with the full payload.

    **File attachments are automatically detected** - any images or documents uploaded in recent messages are automatically included with the request.

    **ARGUMENTS**: "message"

    **Command format:**
    \`\`\`bash
    codemie assistants chat "${assistant.id}" --conversation-id "<workflow-id>" "message"
    \`\`\`

    ## Examples

    **Simple message:**
    \`\`\`bash
    workflow_id="${assistant.slug}-$(date +%Y%m%d-%H%M%S)-$$"
    codemie assistants chat "${assistant.id}" --conversation-id "$workflow_id" "Help me with this task"
    \`\`\`

    **With file attachment** (reuse the same workflow id):
    \`\`\`bash
    codemie assistants chat "${assistant.id}" --conversation-id "$workflow_id" "Analyze this code" --file "script.py"
    \`\`\`

    **With multiple files** (reuse the same workflow id):
    \`\`\`bash
    codemie assistants chat "${assistant.id}" --conversation-id "$workflow_id" "Review these files" --file "file1.png" --file "file2.py"
    \`\`\`
  `);
}

/**
 * Get subagent file path for a given slug
 */
function getSubagentFilePath(slug: string, scope: StorageScope = StorageScope.GLOBAL, workingDir?: string): string {
  const agentsDir = scope === StorageScope.LOCAL && workingDir
    ? path.join(workingDir, '.claude', 'agents')
    : path.join(os.homedir(), '.claude', 'agents');
  return path.join(agentsDir, `${slug}.md`);
}

/**
 * Register Claude subagent
 * Creates subagent file in ~/.claude/agents/ (global) or {cwd}/.claude/agents/ (local)
 */
export async function registerClaudeSubagent(assistant: Assistant, scope: StorageScope = StorageScope.GLOBAL, workingDir?: string): Promise<void> {
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
export async function unregisterClaudeSubagent(slug: string, scope: StorageScope = StorageScope.GLOBAL, workingDir?: string): Promise<void> {
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
