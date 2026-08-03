import { existsSync, readFileSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import chalk from 'chalk';
import mime from 'mime-types';
import { logger } from '@/utils/logger.js';
import type { DetectedFile } from './types.js';

export const ATTACHMENT_CONSTRAINTS = {
  MAX_FILE_SIZE_MB: 100,
  RECENT_MESSAGES_LIMIT: 2,
  SUPPORTED_TYPES: ['image', 'document'] as const,
  MULTI_FILE: true,
} as const;

const LOG_PREFIX = '[uploadsUtils]';
const MAX_FILE_SIZE_BYTES = ATTACHMENT_CONSTRAINTS.MAX_FILE_SIZE_MB * 1024 * 1024;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

export function bytesToMB(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(2);
}

function detectMimeType(filePath: string): string {
  const mimeType = mime.lookup(filePath);
  return mimeType || 'application/octet-stream';
}

function detectFileType(mimeType: string): 'image' | 'document' {
  return mimeType.startsWith('image/') ? 'image' : 'document';
}

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
      const absolutePath = resolve(filePath);

      if (!existsSync(absolutePath)) {
        logger.warn(`${LOG_PREFIX} File does not exist`, { filePath: absolutePath });
        if (!quiet) {
          console.log(chalk.yellow(`⚠ File not found: ${filePath}`));
        }
        continue;
      }

      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        logger.warn(`${LOG_PREFIX} Path is not a file`, { filePath: absolutePath });
        if (!quiet) {
          console.log(chalk.yellow(`⚠ Not a file: ${filePath}`));
        }
        continue;
      }

      const fileSize = stats.size;
      if (fileSize > MAX_FILE_SIZE_BYTES) {
        logger.warn(`${LOG_PREFIX} File exceeds size limit`, {
          filePath: absolutePath,
          sizeMB: bytesToMB(fileSize),
          limit: ATTACHMENT_CONSTRAINTS.MAX_FILE_SIZE_MB
        });
        if (!quiet) {
          console.log(chalk.yellow(`⚠ File too large (>${ATTACHMENT_CONSTRAINTS.MAX_FILE_SIZE_MB}MB): ${filePath}`));
        }
        continue;
      }

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
      if (!quiet) {
        console.log(chalk.yellow(`⚠ Failed to read file: ${filePath}`));
      }
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
