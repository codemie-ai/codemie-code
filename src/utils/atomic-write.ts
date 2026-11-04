import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'node:crypto';
import { ConfigurationError } from './errors.js';

export interface AtomicJsonWriteOptions {
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

/**
 * Write JSON atomically: a uniquely named temp file in the same directory, then a
 * rename over the target. The existing file mode is kept (new files get 0600), a
 * symlinked target is written through, and a failed write leaves no temp file.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
  options: AtomicJsonWriteOptions = {}
): Promise<void> {
  const target = await realTarget(filePath);
  let mode = 0o600;
  try {
    const stat = await fs.stat(target);
    mode = stat.mode & 0o777;
    if (options.refuseUnparsable) {
      const content = await fs.readFile(target, 'utf-8');
      if (content.trim().length > 0) {
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
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode });
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
