/**
 * Simple file logger for the MCP proxy.
 * Writes to ~/.codemie/mcp-proxy.log — independent of the main logger.
 * Enabled when CODEMIE_DEBUG=true or MCP_PROXY_DEBUG=true.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const enabled = process.env.CODEMIE_DEBUG === 'true'
  || process.env.CODEMIE_DEBUG === '1'
  || process.env.MCP_PROXY_DEBUG === 'true'
  || process.env.MCP_PROXY_DEBUG === '1';

const logDir = join(homedir(), '.codemie', 'logs');
const logFile = join(logDir, 'mcp-proxy.log');

try {
  mkdirSync(logDir, { recursive: true });
} catch {
  // ignore
}

export function proxyLog(message: string): void {
  if (!enabled) return;
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    appendFileSync(logFile, line);
  } catch {
    // ignore — can't log if file write fails
  }
}
