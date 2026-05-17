#!/usr/bin/env node

/**
 * Codebase Memory UI daemon entry point.
 * Imports compiled daemon from dist/.
 */
import('../dist/bin/codebase-memory-ui-daemon.js').catch((error) => {
  process.stderr.write(`[codebase-memory-ui-daemon] Fatal: ${error.message}\n`);
  process.exit(1);
});
