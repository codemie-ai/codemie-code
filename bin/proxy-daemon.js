#!/usr/bin/env node

/**
 * CodeMie Proxy Daemon entry point
 * Imports compiled daemon from dist/
 */
import('../dist/bin/proxy-daemon.js').catch((error) => {
  process.stderr.write(`[proxy-daemon] Fatal: ${error.message}\n`);
  process.exit(1);
});
