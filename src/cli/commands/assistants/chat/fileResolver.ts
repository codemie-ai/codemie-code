/**
 * File Upload Detection for Assistants Chat
 *
 * Detects file uploads from Claude session JSONL files.
 * Reads session metadata and parses conversation JSONL to detect image/document uploads.
 */

import { existsSync, readFileSync } from 'fs';
import chalk from 'chalk';
import { logger } from '@/utils/logger.js';
import { readJSONL } from '@/agents/core/session/utils/jsonl-reader.js';
import type { ClaudeMessage } from '@/agents/plugins/claude/claude-message-types.js';
import type { Session } from '@/agents/core/session/types.js';
import { getSessionPath } from '@/agents/core/session/session-config.js';

// ============================================================================
// Session File Upload Detection
// ============================================================================

// Pattern to extract file paths from meta messages: [Image: source: /path/to/file.png]
const ATTACHMENT_PATH_PATTERN = /\[(Image|Document): source: ([^\]]+)\]/g;

// Number of recent user messages to check for attachments
const RECENT_MESSAGES_LIMIT = 2;

/**
 * Extract file name from file path
 */
function extractFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

/**
 * Extract file names from meta message text
 */
function extractFileNamesFromMetaMessage(message: ClaudeMessage): string[] {
  // Meta messages have isMeta flag and parentUuid linking to the user message
  if (!message.isMeta || !message.parentUuid) {
    return [];
  }

  // Check if content is array
  if (!message.message?.content || !Array.isArray(message.message.content)) {
    return [];
  }

  const fileNames: string[] = [];

  // Look for text content items with attachment paths
  for (const item of message.message.content) {
    if (item.type === 'text' && item.text) {
      const matches = item.text.matchAll(ATTACHMENT_PATH_PATTERN);
      for (const match of matches) {
        fileNames.push(extractFileName(match[2]));
      }
    }
  }

  return fileNames;
}

/**
 * Build a map of user message UUIDs to their file names
 */
function buildAttachmentMap(messages: ClaudeMessage[]): Map<string, string[]> {
  const attachmentMap = new Map<string, string[]>();

  // First pass: find all user messages with attachments
  const messagesWithAttachments = new Set<string>();
  for (const msg of messages) {
    if (msg.type === 'user' && msg.uuid && msg.message?.content && Array.isArray(msg.message.content)) {
      const hasAttachment = msg.message.content.some(
        item => item.type === 'image' || item.type === 'document'
      );
      if (hasAttachment) {
        messagesWithAttachments.add(msg.uuid);
      }
    }
  }

  // Second pass: extract file names from meta messages
  for (const msg of messages) {
    const fileNames = extractFileNamesFromMetaMessage(msg);
    if (fileNames.length > 0 && msg.parentUuid && messagesWithAttachments.has(msg.parentUuid)) {
      attachmentMap.set(msg.parentUuid, fileNames);
    }
  }

  return attachmentMap;
}

/**
 * Read session metadata from disk
 *
 * @param sessionId - Session ID
 * @returns Session metadata or null if not found
 */
function readSessionMetadata(sessionId: string): Session | null {
  const sessionPath = getSessionPath(sessionId);

  if (!existsSync(sessionPath)) {
    logger.debug('[fileResolver] Session metadata file does not exist', { sessionPath });
    return null;
  }

  try {
    return JSON.parse(readFileSync(sessionPath, 'utf8')) as Session;
  } catch (error) {
    logger.debug('[fileResolver] Failed to parse session metadata', { error });
    return null;
  }
}

/**
 * Extract agent session file path from session metadata
 *
 * @param session - Session metadata
 * @returns Agent session file path or null if not available
 */
function extractAgentSessionFile(session: Session): string | null {
  if (!session.correlation || session.correlation.status !== 'matched') {
    logger.debug('[fileResolver] No correlation or not matched', {
      status: session.correlation?.status
    });
    return null;
  }

  const agentSessionFile = session.correlation.agentSessionFile;
  if (!agentSessionFile) {
    logger.debug('[fileResolver] No agentSessionFile in correlation');
    return null;
  }

  if (!existsSync(agentSessionFile)) {
    logger.debug('[fileResolver] Agent session file does not exist', { agentSessionFile });
    return null;
  }

  return agentSessionFile;
}

/**
 * Parse messages and extract file uploads with their actual file names
 * Only checks the last X user messages (defined by RECENT_MESSAGES_LIMIT)
 *
 * @param messages - Array of Claude messages from JSONL
 * @returns Array of detected file names from recent user messages (empty if no attachments)
 */
function parseMessagesForUploads(messages: ClaudeMessage[]): string[] {
  // Build map of message UUIDs to file names
  const attachmentMap = buildAttachmentMap(messages);

  // Find the last X user messages
  const recentUserMessages: ClaudeMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    // Only check user messages with UUIDs
    if (msg.type === 'user' && msg.uuid) {
      recentUserMessages.push(msg);

      // Stop when we've collected enough messages
      if (recentUserMessages.length >= RECENT_MESSAGES_LIMIT) {
        break;
      }
    }
  }

  // No user messages found
  if (recentUserMessages.length === 0) {
    logger.debug('[fileResolver] No user messages found');
    return [];
  }

  // Extract files from all recent user messages
  const fileUploads: string[] = [];

  for (const userMessage of recentUserMessages) {
    // Check if content is array (not just string)
    if (!userMessage.message?.content || !Array.isArray(userMessage.message.content)) {
      continue;
    }

    // Get file names for this message from attachment map
    const fileNames = attachmentMap.get(userMessage.uuid!) ?? [];
    let fileIndex = 0;

    // Look for image/document content items
    for (const item of userMessage.message.content) {
      if (item.type === 'image' || item.type === 'document') {
        // Use actual file name from meta message, or generate fallback
        const fileName = fileNames[fileIndex] ?? `attachment_${fileUploads.length}_${Date.now()}`;
        fileUploads.push(fileName);
        logger.debug('[fileResolver] Detected file upload in recent message', {
          fileName,
          type: item.type,
          messageUuid: userMessage.uuid
        });
        fileIndex++;
      }
    }
  }

  logger.debug('[fileResolver] Checked recent messages', {
    messagesChecked: recentUserMessages.length,
    filesFound: fileUploads.length
  });

  return fileUploads;
}

/**
 * Log detected files to console
 *
 * @param files - Array of detected file names
 * @param quiet - Whether to suppress console output
 */
function logDetectedFiles(files: string[], quiet: boolean): void {
  if (files.length === 0 || quiet) {
    return;
  }

  console.log(chalk.cyan(`\n📎 Detected ${files.length} file upload(s) in conversation:`));
  files.forEach((file, index) => {
    console.log(chalk.dim(`  ${index + 1}. ${file}`));
  });
  console.log('');
}

/**
 * Detect file uploads from session JSONL conversation
 *
 * Reads session metadata, extracts JSONL path, parses messages to detect image/document uploads.
 * More direct than reading attachments directory - reads from source of truth.
 *
 * @param sessionId - Claude session ID for locating session metadata
 * @param options - Options (quiet mode)
 * @returns Array of file names detected in conversation (or empty array if none/error)
 *
 * @example
 * const files = await detectFileUploadsFromSession('session-123', { quiet: false });
 * // returns: ['Image attachment 1', 'Image attachment 2', ...]
 */
export async function detectFileUploadsFromSession(
  sessionId: string,
  options: { quiet?: boolean } = {}
): Promise<string[]> {
  const { quiet = false } = options;

  logger.debug('[fileResolver] Detecting file uploads from session', { sessionId });

  try {
    // Step 1: Read session metadata
    const sessionData = readSessionMetadata(sessionId);
    if (!sessionData) {
      return [];
    }

    // Step 2: Extract agent session file path
    const agentSessionFile = extractAgentSessionFile(sessionData);
    if (!agentSessionFile) {
      return [];
    }

    // Step 3: Read JSONL messages
    const messages = await readJSONL<ClaudeMessage>(agentSessionFile);
    logger.debug('[fileResolver] Read JSONL messages', {
      totalMessages: messages.length,
      agentSessionFile
    });

    // Step 4: Parse messages for uploads
    const fileUploads = parseMessagesForUploads(messages);

    // Step 5: Log detected files
    logDetectedFiles(fileUploads, quiet);

    logger.debug('[fileResolver] Detection complete', {
      filesDetected: fileUploads.length
    });

    return fileUploads;
  } catch (error) {
    logger.debug('[fileResolver] Failed to detect file uploads', { error });
    return [];
  }
}
