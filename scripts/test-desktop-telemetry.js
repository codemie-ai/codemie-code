#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolve } from 'path';

function printUsage() {
  console.log(`Usage: node scripts/test-desktop-telemetry.js [options]

Options:
  --latest                 Use the most recently updated Desktop session (default)
  --session <local_id>     Use a specific Desktop local session id
  --dry-run                Build and sync through processors without remote writes (default)
  --live                   Attempt real sync using stored SSO credentials
  --target-url <url>       Override API base URL for sync
  --codemie-url <url>      Override CodeMie URL for credential lookup
  --codemie-home <dir>     Override CODEMIE_HOME for isolated local output
  --limit <count>          Number of recent sessions to search while resolving --session (default: 20)
  --help                   Show this help
`);
}

function parseArgs(argv) {
  const args = {
    latest: true,
    sessionId: undefined,
    dryRun: true,
    targetUrl: undefined,
    codeMieUrl: undefined,
    codemieHome: undefined,
    limit: 20
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--latest':
        args.latest = true;
        break;
      case '--session':
        args.sessionId = argv[index + 1];
        args.latest = false;
        index += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--live':
        args.dryRun = false;
        break;
      case '--target-url':
        args.targetUrl = argv[index + 1];
        index += 1;
        break;
      case '--codemie-url':
        args.codeMieUrl = argv[index + 1];
        index += 1;
        break;
      case '--codemie-home':
        args.codemieHome = argv[index + 1];
        index += 1;
        break;
      case '--limit':
        args.limit = Number.parseInt(argv[index + 1], 10);
        index += 1;
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.codemieHome) {
  process.env.CODEMIE_HOME = resolve(args.codemieHome);
}

const distRoot = resolve(process.cwd(), 'dist');
if (!existsSync(distRoot)) {
  console.error('dist/ is missing. Run: rtk npm run build');
  process.exit(1);
}

const [
  { discoverClaudeDesktopSessions },
  { ClaudeDesktopTelemetryAdapter },
  { SessionStore },
  { getSessionConversationPath, getSessionMetricsPath },
  { SessionSyncer },
  { CodeMieSSO },
  { detectGitBranch, detectGitRemoteRepo },
] = await Promise.all([
  import('../dist/telemetry/clients/claude-desktop/claude-desktop.discovery.js'),
  import('../dist/telemetry/clients/claude-desktop/ClaudeDesktopTelemetryAdapter.js'),
  import('../dist/agents/core/session/SessionStore.js'),
  import('../dist/agents/core/session/session-config.js'),
  import('../dist/providers/plugins/sso/session/SessionSyncer.js'),
  import('../dist/providers/plugins/sso/sso.auth.js'),
  import('../dist/utils/processes.js')
]);

const discoveredSessions = await discoverClaudeDesktopSessions(0);
const recentSessions = discoveredSessions
  .sort((a, b) => b.updatedAt - a.updatedAt)
  .slice(0, Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 20);

const selected = args.sessionId
  ? recentSessions.find((session) => session.externalSessionId === args.sessionId)
  : recentSessions[0];

if (!selected) {
  console.error('No matching Claude Desktop local session found.');
  process.exit(1);
}

const sessionStore = new SessionStore();
let session = await sessionStore.findSessionByExternalId('claude-desktop', selected.externalSessionId);

if (!session) {
  const [gitBranch, repository] = await Promise.all([
    detectGitBranch(selected.workingDirectory),
    detectGitRemoteRepo(selected.workingDirectory)
  ]);

  session = {
    sessionId: randomUUID(),
    agentName: 'claude-desktop',
    provider: 'ai-run-sso',
    startTime: selected.createdAt,
    workingDirectory: selected.workingDirectory,
    gitBranch: gitBranch || undefined,
    repository: repository || undefined,
    status: 'active',
    activeDurationMs: 0,
    correlation: {
      status: 'matched',
      agentSessionId: selected.agentSessionId,
      agentSessionFile: selected.transcriptPath,
      retryCount: 0
    },
    runtimeCheckpoint: {
      externalSessionId: selected.externalSessionId,
      transcriptPath: selected.transcriptPath,
      lastDiscoveredAt: Date.now(),
      lastSeenActivityAt: selected.updatedAt
    }
  };

  await sessionStore.saveSession(session);
}

const targetUrl = args.targetUrl
  || process.env.CODEMIE_TEST_API_URL
  || process.env.CODEMIE_API_URL
  || 'http://127.0.0.1:3000';
const codeMieUrl = args.codeMieUrl
  || process.env.CODEMIE_TEST_CODEMIE_URL
  || process.env.CODEMIE_URL
  || targetUrl;

let cookies = '';
if (!args.dryRun) {
  const credentials = await new CodeMieSSO().getStoredCredentials(codeMieUrl);
  if (!credentials?.cookies) {
    console.error(`No stored SSO credentials found for ${codeMieUrl}`);
    process.exit(1);
  }
  cookies = Object.entries(credentials.cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

const adapter = new ClaudeDesktopTelemetryAdapter();
const parsedSession = await adapter.parseSession(selected, session.sessionId);
const context = {
  apiBaseUrl: targetUrl,
  cookies,
  clientType: 'claude-desktop',
  version: readCliVersion(),
  dryRun: args.dryRun,
  sessionId: session.sessionId,
  agentSessionId: selected.agentSessionId,
  agentSessionFile: selected.transcriptPath
};

const processed = await adapter.processParsedSession(parsedSession, context);
const syncResult = await new SessionSyncer().sync(session.sessionId, context);
const metricsPath = getSessionMetricsPath(session.sessionId);
const conversationPath = getSessionConversationPath(session.sessionId);

console.log('Claude Desktop telemetry simulation');
console.log(`  mode:              ${args.dryRun ? 'dry-run' : 'live'}`);
console.log(`  local session:     ${selected.externalSessionId}`);
console.log(`  cli session:       ${selected.agentSessionId}`);
console.log(`  codemie session:   ${session.sessionId}`);
console.log(`  updated at:        ${new Date(selected.updatedAt).toISOString()}`);
console.log(`  transcript:        ${selected.transcriptPath}`);
console.log(`  messages parsed:   ${parsedSession.messages.length}`);
console.log(`  metrics path:      ${metricsPath}${existsSync(metricsPath) ? '' : ' (missing)'}`);
console.log(`  conversation path: ${conversationPath}${existsSync(conversationPath) ? '' : ' (missing)'}`);
console.log(`  processors:        ${processed.success ? 'ok' : 'failed'} (${processed.totalRecords} records)`);
console.log(`  sync:              ${syncResult.success ? 'ok' : 'failed'} (${syncResult.message})`);

if (existsSync(metricsPath)) {
  const lines = readFileSync(metricsPath, 'utf-8').split('\n').filter(Boolean).length;
  console.log(`  metrics lines:     ${lines}`);
}

if (existsSync(conversationPath)) {
  const lines = readFileSync(conversationPath, 'utf-8').split('\n').filter(Boolean).length;
  console.log(`  conversation lines:${String(lines).padStart(2, ' ')}`);
}

function readCliVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
