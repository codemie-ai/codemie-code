import { existsSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Resolve the project root by walking up from `startDir` looking for a
 * `.git` entry (directory for a normal checkout, file for a git worktree or
 * submodule). Falls back to `startDir` itself if no `.git` is found before
 * reaching the filesystem root.
 *
 * @param startDir - Directory to start the walk from. Defaults to `process.cwd()`.
 */
export function resolveProjectRoot(startDir: string = process.cwd()): string {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      // Reached the filesystem root without finding `.git`.
      return startDir;
    }
    current = parent;
  }
}
