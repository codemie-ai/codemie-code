/**
 * Attachment File Extraction and Saving for Claude Messages
 *
 * Claude sends file attachments across two related messages:
 * 1. User message with base64-encoded content (type: "image" or "document")
 * 2. Meta message with original file path, linked via parentUuid
 *
 * This module extracts and saves attachment files to disk.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { existsSync } from 'fs';
import { getCodemieHome } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { PathSecurityError } from '@/utils/errors.js';
import { createErrorContext } from '@/utils/errors.js';

// ============================================================================
// Types
// ============================================================================

type AttachmentType = 'image' | 'document';

interface AttachmentSource {
  type: 'base64';
  media_type: string;
  data: string;
}

interface AttachmentContentItem {
  type: AttachmentType;
  source?: AttachmentSource;
}

interface TextContentItem {
  type: 'text';
  text: string;
}

type ContentItem = AttachmentContentItem | TextContentItem | Record<string, unknown>;

interface ClaudeMessage {
  uuid?: string;
  type?: string;
  isMeta?: boolean;
  parentUuid?: string;
  message?: {
    content?: ContentItem[];
  };
}

// ============================================================================
// Constants
// ============================================================================

const ATTACHMENT_PATH_PATTERN = /\[(Image|Document): source: ([^\]]+)\]/g;
const ATTACHMENT_TYPES: AttachmentType[] = ['image', 'document'];
const USER_MESSAGE_TYPE = 'user';

// Blocks Windows/Unix reserved chars and control characters (0x00-0x1F)
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[<>:"|?*\x00-\x1f]/g;

// ============================================================================
// Type Guards & Validators
// ============================================================================

const isAttachmentType = (type: string): type is AttachmentType => {
  return ATTACHMENT_TYPES.includes(type as AttachmentType);
};

const isUserMessage = (message: ClaudeMessage): boolean => {
  return Boolean(message.uuid && message.type === USER_MESSAGE_TYPE);
};

const isMetaMessage = (message: ClaudeMessage): boolean => {
  return Boolean(message.isMeta && message.type === USER_MESSAGE_TYPE && message.parentUuid);
};

const hasContentArray = (message: ClaudeMessage): boolean => {
  return Array.isArray(message.message?.content);
};

const hasAttachmentContent = (message: ClaudeMessage): boolean => {
  if (!isUserMessage(message) || !hasContentArray(message)) {
    return false;
  }
  return message.message!.content!.some(
    (item) => typeof item.type === 'string' && isAttachmentType(item.type)
  );
};

// ============================================================================
// File Name Extraction
// ============================================================================

const extractFileName = (filePath: string): string => {
  return basename(filePath);
};

const extractFileNamesFromText = (text: string): string[] => {
  const fileNames: string[] = [];
  const matches = text.matchAll(ATTACHMENT_PATH_PATTERN);

  for (const match of matches) {
    fileNames.push(extractFileName(match[2]));
  }

  return fileNames;
};

const extractFileNamesFromMetaMessage = (message: ClaudeMessage): string[] => {
  if (!isMetaMessage(message) || !hasContentArray(message)) {
    return [];
  }

  const fileNames: string[] = [];
  for (const item of message.message!.content!) {
    if (item.type === 'text' && 'text' in item && typeof item.text === 'string') {
      fileNames.push(...extractFileNamesFromText(item.text));
    }
  }

  return fileNames;
};

// ============================================================================
// Attachment Map Building
// ============================================================================

const findMessagesWithAttachments = (messages: ClaudeMessage[]): Set<string> => {
  const messageUuids = new Set<string>();
  for (const message of messages) {
    if (hasAttachmentContent(message)) {
      messageUuids.add(message.uuid!);
    }
  }
  return messageUuids;
};

const buildAttachmentMap = (messages: ClaudeMessage[]): Map<string, string[]> => {
  const attachmentMap = new Map<string, string[]>();
  const messagesWithAttachments = findMessagesWithAttachments(messages);

  for (const message of messages) {
    const fileNames = extractFileNamesFromMetaMessage(message);

    if (fileNames.length > 0 && message.parentUuid && messagesWithAttachments.has(message.parentUuid)) {
      attachmentMap.set(message.parentUuid, fileNames);
    }
  }

  return attachmentMap;
};

// ============================================================================
// File Extraction & Saving
// ============================================================================

const getAttachmentContentItems = (message: ClaudeMessage): AttachmentContentItem[] => {
  if (!hasContentArray(message)) {
    return [];
  }
  return message.message!.content!.filter(
    (item): item is AttachmentContentItem => typeof item.type === 'string' && isAttachmentType(item.type)
  );
};

const generateFallbackFileName = (index: number): string => {
  return `attachment_${index}_${Date.now()}`;
};

const saveAttachmentItem = async (
  item: AttachmentContentItem,
  fileName: string,
  attachmentsDir: string
): Promise<string | null> => {
  if (item.source?.type !== 'base64' || !item.source.data) {
    return null;
  }

  const sanitizedFileName = basename(fileName);

  if (sanitizedFileName.startsWith('.') || UNSAFE_FILENAME_CHARS.test(sanitizedFileName)) {
    logger.warn(`[attachments] Blocked suspicious file name: ${fileName}`);
    return null;
  }

  const filePath = join(attachmentsDir, sanitizedFileName);
  const resolvedPath = resolve(filePath);
  const resolvedDir = resolve(attachmentsDir);

  if (!resolvedPath.startsWith(resolvedDir)) {
    logger.error(`[attachments] Path traversal attempt blocked: ${fileName}`);
    throw new PathSecurityError(
      `File path escapes attachments directory: ${fileName}`,
      createErrorContext(new Error(), { fileName, attachmentsDir })
    );
  }

  try {
    const buffer = Buffer.from(item.source.data, 'base64');
    await writeFile(filePath, buffer);
    logger.debug(`[attachments] Saved: ${sanitizedFileName} (${buffer.length} bytes)`);
    return filePath;
  } catch (error) {
    logger.error(`[attachments] Failed to save ${sanitizedFileName}:`, error);
    return null;
  }
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Save all attachment files from Claude messages to disk
 *
 * Extracts file attachments from messages and saves them to:
 * ~/.codemie/sessions/{sessionId}_attachments/{fileName}
 *
 * @param messages - All Claude messages from session
 * @param sessionId - Session ID for organizing files
 * @returns Map of message UUID to array of saved file paths
 *
 * @example
 * await saveAttachmentFiles(allMessages, sessionId);
 */
export const saveAttachmentFiles = async (
  messages: ClaudeMessage[],
  sessionId: string
): Promise<Map<string, string[]>> => {
  const attachmentsDir = join(getCodemieHome(), 'sessions', `${sessionId}_attachments`);

  if (!existsSync(attachmentsDir)) {
    await mkdir(attachmentsDir, { recursive: true });
  }

  const attachmentMap = buildAttachmentMap(messages);
  const savedFiles = new Map<string, string[]>();

  for (const message of messages) {
    if (!isUserMessage(message)) continue;

    const fileNames = attachmentMap.get(message.uuid!) ?? [];
    if (fileNames.length === 0) continue;

    const attachmentItems = getAttachmentContentItems(message);
    if (attachmentItems.length === 0) continue;

    const savedPaths: string[] = [];

    for (let i = 0; i < attachmentItems.length; i++) {
      const fileName = fileNames[i] ?? generateFallbackFileName(i);
      const savedPath = await saveAttachmentItem(attachmentItems[i], fileName, attachmentsDir);

      if (savedPath) {
        savedPaths.push(savedPath);
      }
    }

    if (savedPaths.length > 0) {
      savedFiles.set(message.uuid!, savedPaths);
    }
  }

  return savedFiles;
};
