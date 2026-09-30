/**
 * Project root resolution shared by any feature that must agree on "the
 * project", independent of the current working directory a hook or command
 * happens to run from.
 *
 * `resolveLocalTargetPath('.codemie')` (`src/utils/paths.ts:106`) is purely
 * CWD-relative (`path.join(process.cwd(), baseTargetDir)`). That is fine for
 * commands invoked from the project root, but Cursor sets `cwd` per-event and
 * it need not be the workspace root for every hook (e.g. a monorepo
 * subpackage) - two features that each derive "project root" from `cwd()`
 * independently could silently diverge on where that is. This module is the
 * single shared resolver both the event-log writer (Task 6) and the
 * `.cursor/hooks.json` connector (Task 8) call, so their file locations can
 * never drift apart.
 */

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
