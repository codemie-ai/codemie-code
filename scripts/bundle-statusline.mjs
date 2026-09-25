#!/usr/bin/env node

/**
 * Bundles the Claude Code statusline into a single self-contained ESM artifact.
 *
 * statusline.ts runs standalone: Claude Code invokes it as `node <path>` from
 * ~/.claude/settings.json as a detached process after the CLI itself has already exited, so it
 * cannot resolve node_modules or import from the rest of the project at runtime. Bundling lets
 * its source stay normal TypeScript with normal project imports (@/utils/...) while still
 * deploying as one flat file with zero sibling dependencies. statusline-installer.ts reads this
 * script's output and writes it into ~/.claude/ — see that file for the deploy path.
 *
 * Entry point is the TypeScript SOURCE (not tsc's dist/ output): esbuild transpiles TS itself
 * and resolves the project's `@/*` path alias directly from tsconfig.json, so this step has no
 * ordering dependency on `tsc`/`tsc-alias` — type-checking still happens separately via
 * `npm run typecheck` / `tsc` in the build chain, this step only needs valid syntax.
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

await esbuild.build({
  entryPoints: [join(rootDir, 'src/agents/plugins/claude/plugin/statusline.ts')],
  outfile: join(rootDir, 'dist/agents/plugins/claude/plugin/statusline.bundle.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  tsconfig: join(rootDir, 'tsconfig.json'),
  logLevel: 'info',
});

console.log('Statusline bundled successfully!');
