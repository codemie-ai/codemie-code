import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { getDirname } from '../../utils/paths.js';
import { buildModel } from './tree.js';
import { emitBash } from './bash.js';
import { emitZsh } from './zsh.js';
import { emitFish } from './fish.js';

export type CompletionShell = 'bash' | 'zsh' | 'fish';

export const COMPLETION_SHELLS: readonly CompletionShell[] = ['bash', 'zsh', 'fish'];

function readVersion(): string {
  const fail = (reason: string): Error =>
    new Error(`Cannot determine codemie version for the completion header: ${reason}`);
  let packageJson: { version?: unknown };
  try {
    const packageJsonPath = join(getDirname(import.meta.url), '../../../package.json');
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error));
  }
  if (typeof packageJson?.version !== 'string' || packageJson.version === '') {
    throw fail('package.json has no version string');
  }
  return packageJson.version;
}

/** Generate the static completion script for `shell` from the live command tree. */
export function generate(shell: CompletionShell, root: Command): string {
  const model = buildModel(root);
  const version = readVersion();
  switch (shell) {
    case 'bash':
      return emitBash(model, version);
    case 'zsh':
      return emitZsh(model, version);
    case 'fish':
      return emitFish(model, version);
  }
}
