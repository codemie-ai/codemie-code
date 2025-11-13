import { fileURLToPath } from 'url';
import { dirname } from 'path';

/**
 * Get the directory name of the current module (ESM equivalent of __dirname)
 * @param importMetaUrl - Pass import.meta.url from the calling module
 * @returns The directory path
 */
export function getDirname(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
