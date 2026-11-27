/**
 * Shared writer for a secret-bearing JSON file: `codemie analytics sync install`'s
 * `~/.codemie/analytics-sync.json` and the bootstrap wizard's
 * `~/.codemie/analytics-sync-bootstrap.json` both hold a webhook URL (with its signature),
 * so both must land mode `0o600`, with no window where another local user could read the new
 * content under a wider mode. A hook reads the sync settings at any moment, so the file is
 * replaced whole through the atomic writer (a symlink written through, a Windows rename retried)
 * and never seen half-written.
 */

import { chmod } from 'fs/promises';

import { writeFileAtomic } from '@/utils/atomic-write.js';

/** Secret-bearing files written by this module are always exactly this mode. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Serialise `data` as pretty-printed JSON and write it to `path`, mode {@link
 * PRIVATE_FILE_MODE}, whatever mode a previous file had. Creates the parent directory if needed.
 */
export async function writePrivateJson(path: string, data: unknown): Promise<void> {
  await writePrivateText(path, JSON.stringify(data, null, 2));
}

/**
 * Write `text` to `path` as-is, with the same mode guarantees as {@link writePrivateJson}: an
 * existing target is narrowed to {@link PRIVATE_FILE_MODE} first, so the atomic writer, which keeps
 * the target's mode (a new file gets 0600), never exposes the new content wider; the mode is set
 * once more after the write, since the umask may narrow it further.
 */
export async function writePrivateText(path: string, text: string): Promise<void> {
  try {
    await chmod(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  await writeFileAtomic(path, text);
  await chmod(path, PRIVATE_FILE_MODE);
}
