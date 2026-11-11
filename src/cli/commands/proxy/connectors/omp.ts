/**
 * Connector that gives oh-my-pi (omp) the active CodeMie profile's live model catalog by installing
 * a CodeMie extension into omp's user extensions directory.
 *
 * The extension (connectors/omp/codemie-models.extension.ts, bundled by
 * scripts/bundle-omp-extension.mjs) registers `codemie` and `codemie-claude` providers whose models
 * come from the local proxy daemon at omp discovery time, so CodeMie never writes omp's models.yml.
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '@/utils/errors.js';
import { getDirname } from '@/utils/paths.js';

import { writeAtomically } from './vscode.js';

/** Installed file name; omp auto-loads every `.ts`/`.js` file in `<agentDir>/extensions/`. */
export const OMP_EXTENSION_FILENAME = 'codemie-models.js';
// scripts/bundle-omp-extension.mjs's `outfile` basename and `banner` prefix — keep in sync.
const BUNDLE_FILENAME = 'codemie-models.bundle.js';
const OWNERSHIP_MARKER = '// codemie-managed:';

/**
 * omp's active agent directory, resolved the way omp resolves it for the default profile:
 * `PI_CODING_AGENT_DIR` overrides it, `PI_CONFIG_DIR` renames the `~/.omp` root.
 */
export function getOmpExtensionPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), process.env.PI_CONFIG_DIR || '.omp', 'agent');
  return join(agentDir, 'extensions', OMP_EXTENSION_FILENAME);
}

export interface WriteOmpExtensionResult {
  path: string;
  /** False when the installed copy already matched this CLI version's bundle. */
  changed: boolean;
}

/**
 * Install (or refresh) the extension. A file at the target path that CodeMie did not write is left
 * alone unless `force` is set, since omp would otherwise lose a user's own extension.
 */
export async function writeOmpExtension(options: { force?: boolean } = {}): Promise<WriteOmpExtensionResult> {
  const path = getOmpExtensionPath();
  const bundle = await readFile(join(getDirname(import.meta.url), 'omp', BUNDLE_FILENAME), 'utf-8');

  if (existsSync(path)) {
    const current = await readFile(path, 'utf-8');
    if (current === bundle) {
      return { path, changed: false };
    }
    if (!current.startsWith(OWNERSHIP_MARKER) && !options.force) {
      throw new ConfigurationError(
        `${path} exists and was not installed by CodeMie. Move it away, or re-run with --force to replace it.`
      );
    }
  }

  await writeAtomically(path, bundle);
  return { path, changed: true };
}

/** Remove the extension; a file CodeMie did not write is never deleted. */
export async function removeOmpExtension(): Promise<{ path: string; removed: boolean }> {
  const path = getOmpExtensionPath();
  if (!existsSync(path)) {
    return { path, removed: false };
  }
  if (!(await readFile(path, 'utf-8')).startsWith(OWNERSHIP_MARKER)) {
    throw new ConfigurationError(`${path} was not installed by CodeMie; leaving it in place.`);
  }
  await rm(path);
  return { path, removed: true };
}
