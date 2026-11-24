#!/usr/bin/env node

/**
 * Bundles the oh-my-pi (omp) CodeMie models extension into a single self-contained ESM artifact.
 *
 * omp imports the extension from its own `<agentDir>/extensions/` directory, where neither
 * node_modules nor the rest of this project can be resolved. Bundling keeps the source normal
 * TypeScript with project imports (@/utils/...) while deploying one flat file.
 * src/cli/commands/proxy/connectors/omp.ts copies this script's output into omp — keep its
 * BUNDLE_FILENAME and OWNERSHIP_MARKER in sync with `outfile` and `banner` below.
 *
 * Entry point is the TypeScript SOURCE: esbuild transpiles it and resolves the `@/*` alias from
 * tsconfig.json, so this step does not depend on tsc output (type-checking stays with `tsc`).
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

await esbuild.build({
  entryPoints: [join(rootDir, 'src/cli/commands/proxy/connectors/omp/codemie-models.extension.ts')],
  outfile: join(rootDir, 'dist/cli/commands/proxy/connectors/omp/codemie-models.bundle.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  tsconfig: join(rootDir, 'tsconfig.json'),
  banner: { js: '// codemie-managed: installed by `codemie proxy connect --omp`; removed by `codemie proxy disconnect --omp`.' },
  logLevel: 'info',
});

console.log('omp extension bundled successfully!');
