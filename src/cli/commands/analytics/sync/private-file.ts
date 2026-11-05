/**
 * Shared writer for a secret-bearing JSON file: `codemie analytics sync install`'s
 * `~/.codemie/analytics-sync.json` and the bootstrap wizard's
 * `~/.codemie/analytics-sync-bootstrap.json` both hold a webhook URL (with its signature),
 * so both must land mode `0o600`, with no window where another local user could read a
 * wider-mode file before the `chmod` lands.
 */

import { chmod, mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';

/** Secret-bearing files written by this module are always exactly this mode. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Serialise `data` as pretty-printed JSON and write it to `path`, mode {@link
 * PRIVATE_FILE_MODE}. Creates the parent directory if needed, then re-`chmod`s after the
 * write (`writeFile`'s own `mode` option is only honoured when the file does not already
 * exist, so a pre-existing wider-mode file would otherwise keep its old mode).
 */
export async function writePrivateJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), { mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE);
}
