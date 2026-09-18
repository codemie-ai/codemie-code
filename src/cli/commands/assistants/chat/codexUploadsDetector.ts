/**
 * Codex-specific file attachment detector.
 *
 * Discovers the active Codex rollout by scanning Codex sessions directories
 * (via getCodexDiscoverySessionRoots) for a rollout whose session_meta.cwd
 * resolves to process.cwd(), then extracts input_image/input_file blocks from
 * the most recent user response_item record.
 *
 * Uses direct JSONL scanning rather than CodexSessionAdapter because the adapter
 * requires AgentMetadata.dataPaths.home which is not available in the CLI layer.
 * Codex hooks also do not fire reliably, so hook-based correlation is skipped.
 */

import { realpath as fsRealpath, readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
import chalk from 'chalk';
import { logger } from '@/utils/logger.js';
import { readJSONLTolerant } from '@/agents/core/session/utils/jsonl-reader.js';
import {
  getCodexDiscoverySessionRoots,
  isCodexInjectedUserText,
} from '@/agents/plugins/codex/index.js';
import type {
  CodexRolloutRecord,
  CodexSessionMeta,
  CodexEventMsg,
  CodexResponseItemMessage,
  CodexContentBlock,
} from '@/agents/plugins/codex/index.js';
import type { DetectedFile } from './claudeUploadsDetector.js';

const LOG_PREFIX = '[codexUploadsDetector]';
const ROLLOUT_FILENAME = /^rollout-.*\.jsonl$/;
const IMAGE_WRAPPER_PATTERN = /<image name=\[.*?\] path="([^"]+)">/;
const MAX_FILE_SIZE_MB = 100;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_KB = 1024;
const DEFAULT_MEDIA_TYPE = 'application/octet-stream';
const MS_PER_DAY = 86_400_000;

export interface DetectCodexFileUploadsOptions {
  cwd: string;
  quiet?: boolean;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fsRealpath(p);
  } catch {
    return p;
  }
}

async function scanRecentRollouts(
  sessionsPath: string,
  nowMs: number
): Promise<Array<{ filePath: string; mtime: number }>> {
  const candidates: Array<{ filePath: string; mtime: number }> = [];

  for (let daysBack = 0; daysBack <= 1; daysBack++) {
    const d = new Date(nowMs - daysBack * MS_PER_DAY);
    const year = d.getFullYear().toString();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const dayPath = join(sessionsPath, year, month, day);

    let files: string[];
    try {
      files = await readdir(dayPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!ROLLOUT_FILENAME.test(file)) continue;
      const filePath = join(dayPath, file);
      try {
        const s = await stat(filePath);
        candidates.push({ filePath, mtime: s.mtime.getTime() });
      } catch {
        // skip unreadable
      }
    }
  }

  return candidates;
}

async function findMatchingRollout(cwdReal: string, nowMs: number): Promise<string | null> {
  const roots = getCodexDiscoverySessionRoots();
  if (!roots.length) {
    logger.debug(`${LOG_PREFIX} No Codex session directories found`);
    return null;
  }

  const allCandidates: Array<{ filePath: string; mtime: number }> = [];
  for (const root of roots) {
    const candidates = await scanRecentRollouts(root.sessionsPath, nowMs);
    allCandidates.push(...candidates);
  }

  allCandidates.sort((a, b) => b.mtime - a.mtime);

  for (const { filePath } of allCandidates) {
    const records = await readJSONLTolerant<CodexRolloutRecord>(filePath, LOG_PREFIX);
    const metaRecord = records.find((r) => r.type === 'session_meta');
    if (!metaRecord) continue;

    const sessionMeta = metaRecord.payload as CodexSessionMeta;
    if (!sessionMeta.cwd) continue;

    const metaReal = await safeRealpath(sessionMeta.cwd);
    if (metaReal === cwdReal) {
      logger.debug(`${LOG_PREFIX} Matched rollout`, { filePath, cwd: sessionMeta.cwd });
      return filePath;
    }
  }

  return null;
}

function processImageBlock(block: CodexContentBlock, fileName: string): DetectedFile | null {
  if (!block.image_url) {
    logger.warn(`${LOG_PREFIX} input_image block missing image_url`, { fileName });
    return null;
  }

  const commaIdx = block.image_url.indexOf(',');
  if (commaIdx === -1) {
    logger.warn(`${LOG_PREFIX} Malformed data URI in input_image block`, { fileName });
    return null;
  }

  const prefix = block.image_url.slice(0, commaIdx);
  const base64Data = block.image_url.slice(commaIdx + 1);

  if (!base64Data) {
    logger.warn(`${LOG_PREFIX} Empty data URI payload in input_image block`, { fileName });
    return null;
  }

  const mimeMatch = /data:([^;]+);base64/.exec(prefix);
  const mediaType = mimeMatch?.[1] ?? DEFAULT_MEDIA_TYPE;

  // Estimate decoded size without allocating the full buffer (Buffer.from on a large
  // payload can OOM before the size guard runs, silently dropping a valid attachment).
  const paddingChars = base64Data.endsWith('==') ? 2 : base64Data.endsWith('=') ? 1 : 0;
  const sizeBytes = Math.ceil(base64Data.length * 3 / 4) - paddingChars;

  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    logger.warn(`${LOG_PREFIX} File exceeds size limit, skipping`, {
      fileName,
      sizeMB: (sizeBytes / BYTES_PER_MB).toFixed(2),
      limit: MAX_FILE_SIZE_MB,
    });
    return null;
  }

  return {
    fileName,
    data: base64Data,
    mediaType,
    type: 'image',
    sizeBytes,
  };
}

function extractAttachments(records: CodexRolloutRecord[]): DetectedFile[] {
  let targetResponseItem: CodexResponseItemMessage | null = null;
  let targetEventMsg: (CodexEventMsg & { local_images?: string[] }) | null = null;

  // First pass: locate the most-recent user response_item that carries attachments.
  let responseItemIndex = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type !== 'response_item') continue;
    const payload = record.payload as unknown as CodexResponseItemMessage;
    if (
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content) &&
      payload.content.some((b) => b.type === 'input_image' || b.type === 'input_file')
    ) {
      targetResponseItem = payload;
      responseItemIndex = i;
      break;
    }
  }

  if (!targetResponseItem) {
    logger.debug(`${LOG_PREFIX} No user response_item with attachments found`);
    return [];
  }

  // Second pass: find the matching event_msg at or before the response_item's position,
  // so a later follow-up message never severs the filename chain.
  for (let i = responseItemIndex; i >= 0; i--) {
    const record = records[i];
    if (record.type !== 'event_msg') continue;
    const payload = record.payload as CodexEventMsg & { local_images?: string[] };
    if (
      payload.type === 'user_message' &&
      typeof payload.message === 'string' &&
      !isCodexInjectedUserText(payload.message)
    ) {
      targetEventMsg = payload;
      break;
    }
  }

  const detectedFiles: DetectedFile[] = [];
  const content = targetResponseItem.content;
  // imageOnlyIndex tracks position within local_images (images-only array) separately
  // from input_file blocks, which do not appear in local_images.
  let imageOnlyIndex = 0;

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type !== 'input_image' && block.type !== 'input_file') continue;

    if (block.type === 'input_image') {
      let fileName: string | undefined;
      if (i > 0) {
        const prev = content[i - 1];
        if (prev.type === 'input_text' && typeof prev.text === 'string') {
          const match = IMAGE_WRAPPER_PATTERN.exec(prev.text);
          if (match) fileName = basename(match[1]);
        }
      }
      if (!fileName) {
        const localPath = targetEventMsg?.local_images?.[imageOnlyIndex];
        if (localPath) fileName = basename(localPath);
      }
      fileName = fileName ?? `attachment_${imageOnlyIndex}`;
      imageOnlyIndex++;

      const detectedFile = processImageBlock(block, fileName);
      if (detectedFile) detectedFiles.push(detectedFile);
    }
    // input_file blocks are not yet uploadable (no non-image upload path); skip silently.
  }

  logger.debug(`${LOG_PREFIX} Extracted attachments`, { count: detectedFiles.length });
  return detectedFiles;
}

/**
 * Detect file uploads from the active Codex rollout.
 *
 * Finds the most recent rollout in the Codex sessions directories whose
 * session_meta.cwd resolves to `options.cwd`, then extracts any files
 * attached in the most recent user turn.
 */
export async function detectCodexFileUploads(
  options: DetectCodexFileUploadsOptions
): Promise<DetectedFile[]> {
  const { cwd, quiet = false } = options;

  logger.debug(`${LOG_PREFIX} Detecting file uploads from Codex rollout`, { cwd });

  try {
    const nowMs = Date.now();
    const cwdReal = await safeRealpath(cwd);
    const rolloutPath = await findMatchingRollout(cwdReal, nowMs);

    if (!rolloutPath) {
      logger.debug(`${LOG_PREFIX} No matching rollout found for cwd`, { cwdReal });
      return [];
    }

    const records = await readJSONLTolerant<CodexRolloutRecord>(rolloutPath, LOG_PREFIX);
    const detectedFiles = extractAttachments(records);

    if (!quiet && detectedFiles.length > 0) {
      console.log(chalk.cyan(`\n📎 Detected ${detectedFiles.length} file(s) with content:`));
      detectedFiles.forEach((file, index) => {
        const sizeKB = Math.round(file.sizeBytes / BYTES_PER_KB);
        console.log(chalk.dim(`  ${index + 1}. ${file.fileName} (${file.mediaType}, ${sizeKB} KB)`));
      });
      console.log('');
    }

    logger.debug(`${LOG_PREFIX} Detection complete`, { filesDetected: detectedFiles.length });
    return detectedFiles;
  } catch (error) {
    logger.debug(`${LOG_PREFIX} Failed to detect file uploads`, { error });
    return [];
  }
}
