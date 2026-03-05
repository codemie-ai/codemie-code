/**
 * Upload Detection for Assistants Chat
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import chalk from 'chalk';
import mime from 'mime-types';
import { logger } from '@/utils/logger.js';
import { readJSONL } from '@/agents/core/session/utils/jsonl-reader.js';
import type { ClaudeMessage } from '@/agents/plugins/claude/claude-message-types.js';
import type { Session } from '@/agents/core/session/types.js';
import { getSessionPath } from '@/agents/core/session/session-config.js';

const ATTACHMENT_PATH_PATTERN = /\[(Image|Document): source: ([^\]]+)\]/g;
const RECENT_MESSAGES_LIMIT = 2;
const MAX_FILE_SIZE_MB = 100;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

const MESSAGE_TYPE = {
  USER: 'user',
  TEXT: 'text',
  IMAGE: 'image',
  DOCUMENT: 'document'
} as const;

const SOURCE_TYPE = {
  BASE64: 'base64'
} as const;

const CORRELATION_STATUS = {
  MATCHED: 'matched'
} as const;

const DEFAULT_MEDIA_TYPE = 'application/octet-stream';
const LOG_PREFIX = '[uploadDetector]';

export interface DetectedFile {
  fileName: string;
  data: string;
  mediaType: string;
  type: 'image' | 'document';
  sizeBytes: number;
}

function isAttachmentType(type: string): boolean {
  return type === MESSAGE_TYPE.IMAGE || type === MESSAGE_TYPE.DOCUMENT;
}

function hasValidBase64Source(item: { source?: { type?: string; data?: string } }): boolean {
  return item.source?.type === SOURCE_TYPE.BASE64 &&
         !!item.source?.data &&
         item.source.data.length > 0;
}

function bytesToMB(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(2);
}

function generateFallbackFileName(fileCount: number, fileIndex: number): string {
  return `attachment_${fileCount}_${fileIndex}_${Date.now()}`;
}

function extractFileName(filePath: string): string {
  return basename(filePath);
}

function extractFileNamesFromMetaMessage(message: ClaudeMessage): string[] {
  if (!message.isMeta || !message.parentUuid || !Array.isArray(message.message?.content)) {
    return [];
  }

  const fileNames: string[] = [];
  for (const item of message.message.content) {
    if (item.type === MESSAGE_TYPE.TEXT && item.text) {
      const matches = item.text.matchAll(ATTACHMENT_PATH_PATTERN);
      for (const match of matches) {
        fileNames.push(extractFileName(match[2]));
      }
    }
  }

  return fileNames;
}

function buildAttachmentMap(messages: ClaudeMessage[]): Map<string, string[]> {
  const attachmentMap = new Map<string, string[]>();
  const messagesWithAttachments = new Set<string>();

  for (const msg of messages) {
    if (msg.type === MESSAGE_TYPE.USER && msg.uuid && Array.isArray(msg.message?.content)) {
      const hasAttachment = msg.message.content.some(item => isAttachmentType(item.type));
      if (hasAttachment) {
        messagesWithAttachments.add(msg.uuid);
      }
    }
  }

  for (const msg of messages) {
    const fileNames = extractFileNamesFromMetaMessage(msg);
    if (fileNames.length > 0 && msg.parentUuid && messagesWithAttachments.has(msg.parentUuid)) {
      const existing = attachmentMap.get(msg.parentUuid) || [];
      attachmentMap.set(msg.parentUuid, [...existing, ...fileNames]);
    }
  }

  return attachmentMap;
}

function readSessionMetadata(sessionId: string): Session | null {
  const sessionPath = getSessionPath(sessionId);

  if (!existsSync(sessionPath)) {
    logger.debug(`${LOG_PREFIX} Session metadata file does not exist`, { sessionPath });
    return null;
  }

  try {
    return JSON.parse(readFileSync(sessionPath, 'utf8')) as Session;
  } catch (error) {
    logger.debug(`${LOG_PREFIX} Failed to parse session metadata`, { error });
    return null;
  }
}

function extractAgentSessionFile(session: Session): string | null {
  if (!session.correlation || session.correlation.status !== CORRELATION_STATUS.MATCHED) {
    logger.debug(`${LOG_PREFIX} No correlation or not matched`, {
      status: session.correlation?.status
    });
    return null;
  }

  const agentSessionFile = session.correlation.agentSessionFile;
  if (!agentSessionFile) {
    logger.debug(`${LOG_PREFIX} No agentSessionFile in correlation`);
    return null;
  }

  if (!existsSync(agentSessionFile)) {
    logger.debug(`${LOG_PREFIX} Agent session file does not exist`, { agentSessionFile });
    return null;
  }

  return agentSessionFile;
}

function getRecentUserMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
  const recentMessages: ClaudeMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === MESSAGE_TYPE.USER && msg.uuid) {
      recentMessages.push(msg);
      if (recentMessages.length >= RECENT_MESSAGES_LIMIT) {
        break;
      }
    }
  }

  return recentMessages;
}

function processFileItem(
  item: { type: string; source?: { type?: string; data?: string; media_type?: string } },
  fileName: string,
  messageUuid?: string
): DetectedFile | null {
  if (!hasValidBase64Source(item)) {
    logger.warn(`${LOG_PREFIX} Missing base64 data for file`, { fileName });
    return null;
  }

  try {
    const fileSize = Buffer.from(item.source!.data!, 'base64').length;

    if (fileSize > MAX_FILE_SIZE_BYTES) {
      logger.warn(`${LOG_PREFIX} File exceeds size limit, skipping`, {
        fileName,
        sizeMB: bytesToMB(fileSize),
        limit: MAX_FILE_SIZE_MB
      });
      return null;
    }

    const detectedFile: DetectedFile = {
      fileName,
      data: item.source!.data!,
      mediaType: item.source!.media_type || DEFAULT_MEDIA_TYPE,
      type: item.type as 'image' | 'document',
      sizeBytes: fileSize
    };

    logger.debug(`${LOG_PREFIX} Extracted file content`, {
      fileName,
      mediaType: item.source!.media_type,
      dataLength: item.source!.data!.length,
      sizeMB: bytesToMB(fileSize),
      messageUuid
    });

    return detectedFile;
  } catch (error) {
    logger.warn(`${LOG_PREFIX} Invalid base64 data for file`, { fileName, error });
    return null;
  }
}

function extractFileContentFromMessages(
  messages: ClaudeMessage[],
  attachmentMap: Map<string, string[]>
): DetectedFile[] {
  const detectedFiles: DetectedFile[] = [];
  const recentUserMessages = getRecentUserMessages(messages);

  if (recentUserMessages.length === 0) {
    logger.debug(`${LOG_PREFIX} No user messages found`);
    return [];
  }

  for (const userMessage of recentUserMessages) {
    if (!Array.isArray(userMessage.message?.content)) {
      continue;
    }

    const fileNames = attachmentMap.get(userMessage.uuid!) ?? [];
    let fileIndex = 0;

    for (const item of userMessage.message.content) {
      if (isAttachmentType(item.type)) {
        const fileName = fileNames[fileIndex] ?? generateFallbackFileName(detectedFiles.length, fileIndex);
        const detectedFile = processFileItem(item, fileName, userMessage.uuid);

        if (detectedFile) {
          detectedFiles.push(detectedFile);
        }

        fileIndex++;
      }
    }
  }

  logger.debug(`${LOG_PREFIX} Checked recent messages`, {
    messagesChecked: recentUserMessages.length,
    filesFound: detectedFiles.length
  });

  return detectedFiles;
}

function logDetectedFiles(files: DetectedFile[], quiet: boolean): void {
  if (files.length === 0 || quiet) {
    return;
  }

  console.log(chalk.cyan(`\n📎 Detected ${files.length} file(s) with content:`));
  files.forEach((file, index) => {
    const sizeKB = Math.round(file.sizeBytes / BYTES_PER_KB);
    console.log(chalk.dim(`  ${index + 1}. ${file.fileName} (${file.mediaType}, ${sizeKB} KB)`));
  });
  console.log('');
}

/**
 * Detect MIME type from file path using mime-types library
 */
function detectMimeType(filePath: string): string {
  const mimeType = mime.lookup(filePath);
  return mimeType || DEFAULT_MEDIA_TYPE;
}

/**
 * Determine if file should be treated as image or document
 */
function detectFileType(mimeType: string): 'image' | 'document' {
  return mimeType.startsWith('image/') ? 'image' : 'document';
}

/**
 * Read files from disk and convert to DetectedFile format
 */
export async function readFilesFromPaths(
  filePaths: string[],
  options: { quiet?: boolean } = {}
): Promise<DetectedFile[]> {
  const { quiet = false } = options;
  const detectedFiles: DetectedFile[] = [];

  if (filePaths.length === 0) {
    return [];
  }

  logger.debug(`${LOG_PREFIX} Reading files from paths`, {
    fileCount: filePaths.length,
    paths: filePaths
  });

  for (const filePath of filePaths) {
    try {
      // Resolve to absolute path
      const absolutePath = resolve(filePath);

      // Check if file exists
      if (!existsSync(absolutePath)) {
        logger.warn(`${LOG_PREFIX} File does not exist`, { filePath: absolutePath });
        console.log(chalk.yellow(`⚠ File not found: ${filePath}`));
        continue;
      }

      // Check if it's a file (not directory)
      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        logger.warn(`${LOG_PREFIX} Path is not a file`, { filePath: absolutePath });
        console.log(chalk.yellow(`⚠ Not a file: ${filePath}`));
        continue;
      }

      // Check file size
      const fileSize = stats.size;
      if (fileSize > MAX_FILE_SIZE_BYTES) {
        logger.warn(`${LOG_PREFIX} File exceeds size limit`, {
          filePath: absolutePath,
          sizeMB: bytesToMB(fileSize),
          limit: MAX_FILE_SIZE_MB
        });
        console.log(chalk.yellow(`⚠ File too large (>${MAX_FILE_SIZE_MB}MB): ${filePath}`));
        continue;
      }

      // Read file content
      const fileBuffer = readFileSync(absolutePath);
      const base64Data = fileBuffer.toString('base64');
      const fileName = basename(absolutePath);
      const mimeType = detectMimeType(absolutePath);
      const fileType = detectFileType(mimeType);

      const detectedFile: DetectedFile = {
        fileName,
        data: base64Data,
        mediaType: mimeType,
        type: fileType,
        sizeBytes: fileSize
      };

      detectedFiles.push(detectedFile);

      logger.debug(`${LOG_PREFIX} Read file from disk`, {
        fileName,
        mediaType: mimeType,
        type: fileType,
        sizeMB: bytesToMB(fileSize)
      });

    } catch (error) {
      logger.warn(`${LOG_PREFIX} Failed to read file`, { filePath, error });
      console.log(chalk.yellow(`⚠ Failed to read file: ${filePath}`));
    }
  }

  if (!quiet && detectedFiles.length > 0) {
    console.log(chalk.cyan(`\n📎 Loaded ${detectedFiles.length} file(s) from disk:`));
    detectedFiles.forEach((file, index) => {
      const sizeKB = Math.round(file.sizeBytes / BYTES_PER_KB);
      console.log(chalk.dim(`  ${index + 1}. ${file.fileName} (${file.mediaType}, ${sizeKB} KB)`));
    });
    console.log('');
  }

  logger.debug(`${LOG_PREFIX} Files read from disk`, {
    requestedCount: filePaths.length,
    successCount: detectedFiles.length
  });

  return detectedFiles;
}

export async function detectFileUploadsFromSession(
  sessionId: string,
  options: { quiet?: boolean } = {}
): Promise<DetectedFile[]> {
  const { quiet = false } = options;

  logger.debug(`${LOG_PREFIX} Detecting file uploads from session`, { sessionId });

  try {
    const sessionData = readSessionMetadata(sessionId);
    if (!sessionData) {
      return [];
    }

    const agentSessionFile = extractAgentSessionFile(sessionData);
    if (!agentSessionFile) {
      return [];
    }

    const messages = await readJSONL<ClaudeMessage>(agentSessionFile);
    logger.debug(`${LOG_PREFIX} Read JSONL messages`, {
      totalMessages: messages.length,
      agentSessionFile
    });

    const attachmentMap = buildAttachmentMap(messages);
    const detectedFiles = extractFileContentFromMessages(messages, attachmentMap);

    logDetectedFiles(detectedFiles, quiet);

    logger.debug(`${LOG_PREFIX} Detection complete`, {
      filesDetected: detectedFiles.length
    });

    return detectedFiles;
  } catch (error) {
    logger.debug(`${LOG_PREFIX} Failed to detect file uploads`, { error });
    return [];
  }
}
