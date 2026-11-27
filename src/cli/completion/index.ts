/**
 * Shell completion generation entry point.
 */

import { generateBash } from './bash.js';
import { generateFish } from './fish.js';
import { generateZsh } from './zsh.js';
import type { CandidateMap, RootTree, Shell } from './types.js';

export function generateCompletion(
  shell: Shell,
  roots: RootTree[],
  candidates: CandidateMap
): string {
  switch (shell) {
    case 'bash':
      return generateBash(roots, candidates);
    case 'zsh':
      return generateZsh(roots, candidates);
    case 'fish':
      return generateFish(roots, candidates);
    default:
      throw new Error(`Unsupported shell: ${String(shell)}`);
  }
}

export type { CandidateMap, RootTree, Shell } from './types.js';
