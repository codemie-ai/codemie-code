import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import chalk from 'chalk';
import { SessionStore } from '@/agents/core/session/SessionStore.js';
import {
  getSessionConversationPath,
  getSessionMetricsPath
} from '@/agents/core/session/session-config.js';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { discoverClaudeDesktopSessions } from '@/telemetry/clients/claude-desktop/claude-desktop.discovery.js';
import {
  getClaudeDesktopBaseDir,
  getClaudeDesktopCodeSessionsRoot,
  getClaudeDesktopLocalSessionsRoot
} from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import type { LocalTelemetryDiscoveredSession } from '@/telemetry/runtime/types.js';
import type { DaemonState } from './daemon-manager.js';

const DEFAULT_MAX_SESSIONS = 5;

interface DesktopInspectionResult {
  daemonRunning: boolean;
  daemonState: DaemonState | null;
  desktopBaseDir: string;
  localSessionsRoot: string;
  codeSessionsRoot: string;
  credentialsUrl?: string;
  hasCredentials: boolean;
  sessions: DesktopSessionInspection[];
}

interface DesktopSessionInspection {
  discovered: LocalTelemetryDiscoveredSession;
  codemieSessionId?: string;
  sessionStatus: string;
  metricsFileExists: boolean;
  conversationFileExists: boolean;
  reasons: string[];
}

function formatDate(timestamp: number | string | undefined): string {
  if (!timestamp) {
    return 'n/a';
  }

  const value = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  return new Date(value).toISOString();
}

function formatBoolean(value: boolean): string {
  return value ? chalk.green('yes') : chalk.red('no');
}

function formatSessionStatus(session: DesktopSessionInspection): string {
  if (session.codemieSessionId && session.metricsFileExists && session.conversationFileExists) {
    return chalk.green('ingested');
  }

  if (session.codemieSessionId) {
    return chalk.yellow('session-only');
  }

  return chalk.red('not-ingested');
}

async function countJsonlLines(path: string): Promise<number> {
  if (!existsSync(path)) {
    return 0;
  }

  const content = await readFile(path, 'utf-8');
  return content.split('\n').filter(Boolean).length;
}

async function inspectSessions(
  sessions: LocalTelemetryDiscoveredSession[],
  daemonState: DaemonState | null
): Promise<DesktopSessionInspection[]> {
  const sessionStore = new SessionStore();
  const daemonStartedAt = daemonState?.startedAt ? new Date(daemonState.startedAt).getTime() : undefined;
  const inspections: DesktopSessionInspection[] = [];

  for (const discovered of sessions) {
    const persisted = await sessionStore.findSessionByExternalId('claude-desktop', discovered.externalSessionId);
    const reasons: string[] = [];

    if (!daemonState) {
      reasons.push('daemon-not-running');
    } else if (daemonState.telemetryMode !== 'claude-desktop') {
      reasons.push('daemon-not-in-desktop-mode');
    }

    if (daemonStartedAt && discovered.createdAt < daemonStartedAt && !persisted) {
      reasons.push('session-created-before-daemon-start');
    }

    if (discovered.isArchived) {
      reasons.push('session-archived');
    }

    const codemieSessionId = persisted?.sessionId;
    const metricsPath = codemieSessionId ? getSessionMetricsPath(codemieSessionId) : '';
    const conversationPath = codemieSessionId ? getSessionConversationPath(codemieSessionId) : '';

    inspections.push({
      discovered,
      codemieSessionId,
      sessionStatus: persisted?.status ?? 'none',
      metricsFileExists: Boolean(codemieSessionId && existsSync(metricsPath)),
      conversationFileExists: Boolean(codemieSessionId && existsSync(conversationPath)),
      reasons
    });
  }

  return inspections;
}

export async function inspectDesktopProxy(
  daemonRunning: boolean,
  daemonState: DaemonState | null,
  options: { limit?: number } = {}
): Promise<DesktopInspectionResult> {
  const localSessionsRoot = getClaudeDesktopLocalSessionsRoot();
  const codeSessionsRoot = getClaudeDesktopCodeSessionsRoot();
  const desktopBaseDir = getClaudeDesktopBaseDir();
  const credentialsUrl = daemonState?.syncCodeMieUrl || daemonState?.targetUrl;
  const credentials = credentialsUrl
    ? await new CodeMieSSO().getStoredCredentials(credentialsUrl).catch(() => null)
    : null;
  const discovered = await discoverClaudeDesktopSessions(0);
  const sortedSessions = discovered
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, options.limit ?? DEFAULT_MAX_SESSIONS);

  return {
    daemonRunning,
    daemonState,
    desktopBaseDir,
    localSessionsRoot,
    codeSessionsRoot,
    credentialsUrl,
    hasCredentials: Boolean(credentials?.cookies),
    sessions: await inspectSessions(sortedSessions, daemonState)
  };
}

export async function printDesktopInspection(
  daemonRunning: boolean,
  daemonState: DaemonState | null,
  options: { limit?: number } = {}
): Promise<void> {
  const result = await inspectDesktopProxy(daemonRunning, daemonState, options);

  console.log(chalk.bold('Claude Desktop Proxy Inspection'));
  console.log(`Daemon running:      ${daemonRunning ? chalk.green('yes') : chalk.red('no')}`);
  console.log(`Telemetry mode:      ${daemonState?.telemetryMode ?? chalk.red('none')}`);
  console.log(`Daemon clientType:   ${daemonState?.clientType ?? 'n/a'}`);
  console.log(`Target URL:          ${daemonState?.targetUrl ?? 'n/a'}`);
  console.log(`Sync API URL:        ${daemonState?.syncApiUrl ?? 'n/a'}`);
  console.log(`CodeMie URL:         ${daemonState?.syncCodeMieUrl ?? 'n/a'}`);
  console.log(`Started at:          ${formatDate(daemonState?.startedAt)}`);
  console.log(`Desktop base dir:    ${result.desktopBaseDir} (${formatBoolean(existsSync(result.desktopBaseDir))})`);
  console.log(`Local sessions root: ${result.localSessionsRoot} (${formatBoolean(existsSync(result.localSessionsRoot))})`);
  console.log(`Code sessions root:  ${result.codeSessionsRoot} (${formatBoolean(existsSync(result.codeSessionsRoot))})`);
  console.log(`SSO credentials:     ${formatBoolean(result.hasCredentials)}${result.credentialsUrl ? ` (${result.credentialsUrl})` : ''}`);
  console.log('');

  if (result.sessions.length === 0) {
    console.log(chalk.yellow('No Claude Desktop local-agent sessions found.'));
    return;
  }

  console.log(chalk.bold(`Recent sessions (${result.sessions.length})`));
  for (const session of result.sessions) {
    const metricsPath = session.codemieSessionId ? getSessionMetricsPath(session.codemieSessionId) : undefined;
    const conversationPath = session.codemieSessionId ? getSessionConversationPath(session.codemieSessionId) : undefined;
    const [metricsLines, conversationLines] = await Promise.all([
      metricsPath ? countJsonlLines(metricsPath) : Promise.resolve(0),
      conversationPath ? countJsonlLines(conversationPath) : Promise.resolve(0)
    ]);

    console.log(`- ${session.discovered.externalSessionId}`);
    console.log(`  Updated:          ${formatDate(session.discovered.updatedAt)}`);
    console.log(`  Created:          ${formatDate(session.discovered.createdAt)}`);
    console.log(`  CLI session id:   ${session.discovered.agentSessionId}`);
    console.log(`  Model:            ${session.discovered.model ?? 'n/a'}`);
    console.log(`  Working dir:      ${session.discovered.workingDirectory}`);
    console.log(`  Transcript:       ${session.discovered.transcriptPath}`);
    console.log(`  CodeMie session:  ${session.codemieSessionId ?? 'none'}`);
    console.log(`  Status:           ${formatSessionStatus(session)} (${session.sessionStatus})`);
    console.log(`  Metrics JSONL:    ${session.metricsFileExists ? chalk.green(`yes (${metricsLines} lines)`) : chalk.red('no')}`);
    console.log(`  Conversation JSONL: ${session.conversationFileExists ? chalk.green(`yes (${conversationLines} lines)`) : chalk.red('no')}`);
    console.log(`  Reasons:          ${session.reasons.length > 0 ? session.reasons.join(', ') : 'eligible'}`);
    console.log('');
  }
}
