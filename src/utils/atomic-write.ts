import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'node:crypto';
import { ConfigurationError } from './errors.js';

// Windows reports a rename over a file that is being replaced as one of these codes.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_RETRY_STEP_MS = 20;

export interface AtomicJsonWriteOptions {
  /** Explicit permissions for a newly created parent directory (for private evidence/spool state). */
  directoryMode?: number;
  /** Refuse to replace an existing, non-empty file whose content is not valid JSON. */
  refuseUnparsable?: boolean;
  /** Human-readable name of the file, used in error messages. */
  label?: string;
}

/** Path a write must replace: the target of a symlink, else the path itself. */
async function realTarget(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return filePath;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? '';
      if (process.platform !== 'win32' || attempt >= RENAME_MAX_ATTEMPTS || !RENAME_RETRY_CODES.has(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_STEP_MS * attempt));
    }
  }
}

/**
 * Write text atomically: a uniquely named temp file beside the target, then a rename
 * over it. A symlink is written through (its target replaced, the link kept); a
 * dangling link (its target missing) is replaced by a regular file. The
 * target's mode is kept (new files get 0600), a missing parent directory is created,
 * and a failed write leaves no temp file.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: { directoryMode?: number } = {}
): Promise<void> {
  const target = await realTarget(filePath);
  let mode = 0o600;
  try {
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(path.dirname(target), {
    recursive: true,
    ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode }),
  });
  const tempPath = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode });
    await renameWithRetry(tempPath, target);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Write JSON atomically through `writeFileAtomic` (a symlink written through, the
 * target's mode kept). With `refuseUnparsable`, an existing non-empty file that is not
 * valid JSON is left alone and a `ConfigurationError` thrown.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
  options: AtomicJsonWriteOptions = {}
): Promise<void> {
  if (options.refuseUnparsable) {
    const target = await realTarget(filePath);
    let content: string | undefined;
    try {
      content = await fs.readFile(target, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    if (content !== undefined && content.trim().length > 0) {
      try {
        JSON.parse(content);
      } catch {
        throw new ConfigurationError(
          `${options.label ?? 'Config file'} at ${target} is not valid JSON; not overwriting it. ` +
            'Fix or move the file, then retry.'
        );
      }
    }
  }

  await writeFileAtomic(filePath, JSON.stringify(data, null, 2), { directoryMode: options.directoryMode });
}
