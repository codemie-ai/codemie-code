/**
 * `codemie proxy reset-mcp-auth` — clear the saved MCP sign-ins of a client so they can be redone.
 *
 * This handler alone owns message text, log lines and the exit code. Nothing it
 * prints or logs comes from the file or from an error message, only fixed text,
 * the path, the outcome, an error code and server names printed as JSON strings.
 * The daemon is not touched.
 */
import chalk from 'chalk';

import { getClaudeDesktopBaseDir } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

import { clearDesktopMcpSignIns, MCP_OAUTH_KEY, type ResetResult } from './connectors/desktop-mcp-auth.js';

export const RESET_RESTART_STEPS =
  'Fully quit Claude Desktop, start it again, then press Reconnect on each MCP server under Customize → Connectors.';
export const RESET_RERUN_HINT =
  'If the sign-ins come back, quit Claude Desktop, run this command again, then start Claude Desktop.';
export const RESET_NEXT_STEPS = `${RESET_RESTART_STEPS}\n${RESET_RERUN_HINT}`;

/** A user with hundreds of servers must not get hundreds of lines of names. */
const MAX_NAMED_SERVERS = 20;

/** Windows reports a rename blocked by an open Claude Desktop as one of these. */
const WINDOWS_BLOCKED_WRITE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

type FailureOutcome = Exclude<ResetResult['outcome'], 'cleared' | 'nothing'>;

const FAILURES: Record<FailureOutcome, { problem: string; effect: string }> = {
  missing: { problem: 'was not found', effect: 'nothing was changed' },
  unreadable: { problem: 'could not be read', effect: 'file was not changed' },
  'invalid-json': { problem: 'is not valid JSON', effect: 'file was not changed' },
  'not-object': { problem: 'is not a JSON object', effect: 'file was not changed' },
  'write-failed': { problem: 'could not be rewritten', effect: 'file left as it was' },
};

const RESET_TARGET_LIST = [
  'Select at least one client to reset:',
  '',
  `  --claude-desktop   Claude Desktop app (clears the saved MCP sign-ins, the ${MCP_OAUTH_KEY} entry of its config.json)`,
  '',
  'Example:',
  '  codemie proxy reset-mcp-auth --claude-desktop',
].join('\n');

export interface ResetMcpAuthOptions {
  claudeDesktop?: boolean;
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function codeSuffix(code: string | undefined): string {
  return code ? ` (code ${code})` : '';
}

/** Names go through JSON.stringify so one holding escape sequences cannot rewrite the lines after it. */
function formatServerNames(servers: string[]): string {
  const shown = servers.slice(0, MAX_NAMED_SERVERS).map((name) => JSON.stringify(name));
  const hidden = servers.length - shown.length;
  return hidden > 0 ? `${shown.join(', ')} and ${hidden} more` : shown.join(', ');
}

function printCleared(path: string, servers: string[]): void {
  console.log(
    chalk.green(
      servers.length > 0
        ? `✓ Cleared the saved MCP sign-ins of ${formatServerNames(servers)} (${path})`
        : `✓ MCP sign-ins cleared (${path})`,
    ),
  );
  console.log(chalk.yellow(RESET_NEXT_STEPS));
}

function printFailure(outcome: FailureOutcome, path: string, code: string | undefined): void {
  const { problem, effect } = FAILURES[outcome];
  console.error(chalk.red(`✗ Claude Desktop config.json at ${path} ${problem}${codeSuffix(code)}; ${effect}`));
  if (outcome === 'write-failed' && process.platform === 'win32' && code && WINDOWS_BLOCKED_WRITE_CODES.has(code)) {
    console.error(chalk.yellow(RESET_RERUN_HINT));
  }
}

function reportResult(result: ResetResult): void {
  logger.info(
    '[proxy] reset-mcp-auth result',
    ...sanitizeLogArgs({
      path: result.path,
      outcome: result.outcome,
      servers: result.outcome === 'cleared' ? result.servers.length : 0,
    }),
  );

  switch (result.outcome) {
    case 'cleared':
      printCleared(result.path, result.servers);
      return;
    case 'nothing':
      console.log(chalk.dim(`No saved sign-ins (${MCP_OAUTH_KEY}) in ${result.path}; file not changed`));
      return;
    default:
      printFailure(result.outcome, result.path, 'code' in result ? result.code : undefined);
      process.exitCode = 1;
  }
}

/** Reached by a failure outside the file logic's rows, such as an unsupported platform. */
function reportUnexpectedFailure(error: unknown): void {
  const code = errorCodeOf(error);
  logger.warn('[proxy] reset-mcp-auth failed', ...sanitizeLogArgs({ code }));
  console.error(chalk.red(`✗ Could not reset Claude Desktop MCP sign-ins on platform "${process.platform}"${codeSuffix(code)}`));
  process.exitCode = 1;
}

/** Bare reset-mcp-auth prints the client list and changes nothing. */
export async function resetMcpAuth(opts: ResetMcpAuthOptions): Promise<void> {
  if (!opts.claudeDesktop) {
    console.log(RESET_TARGET_LIST);
    return;
  }

  try {
    reportResult(await clearDesktopMcpSignIns(getClaudeDesktopBaseDir()));
  } catch (error) {
    reportUnexpectedFailure(error);
  }
}
