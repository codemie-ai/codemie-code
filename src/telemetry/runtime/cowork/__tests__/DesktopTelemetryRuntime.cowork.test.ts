/**
 * Which Desktop runtime builds the Cowork producer: the runtime of Claude Desktop's own adapter gets one with the
 * daemon's profile, a runtime of another adapter gets none. Real modules over a temp Claude Desktop tree (HOME) holding
 * the Cowork fixture and a temp ~/.codemie (CODEMIE_HOME) holding the profile; `fetch` is the stubbed boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { ClaudeDesktopTelemetryAdapter } from '@/telemetry/clients/claude-desktop/ClaudeDesktopTelemetryAdapter.js';
import { getClaudeDesktopBaseDir } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { DesktopTelemetryRuntime } from '../../DesktopTelemetryRuntime.js';
import { DesktopRepositoryResolver } from '../../DesktopRepositoryResolver.js';
import { ClientAttributionPlugin } from '@/providers/plugins/sso/proxy/plugins/client-attribution.plugin.js';
import type { ProxyContext } from '@/providers/plugins/sso/proxy/proxy-types.js';
import type { DesktopTelemetryRuntimeConfig, LocalTelemetryAdapter } from '../../types.js';
import { installCoworkFixture } from './cowork-fixture.js';

const CLI = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const LAST_LINE_MS = Date.parse('2026-11-10T10:00:30.000Z');

const config: DesktopTelemetryRuntimeConfig = {
  clientType: 'claude-desktop',
  targetApiUrl: 'https://api.example.com',
  provider: 'ai-run-sso',
  version: '1.0.0',
  profile: 'cowork',
  pollIntervalMs: 10_000,
  inactivityTimeoutMs: 300_000,
  // Desktop connected to this daemon on every poll
  port: 4001,
  gatewayKey: 'codemie-proxy',
  readDesktopGateway: async () => ({ port: 4001, apiKey: 'codemie-proxy' })
};

let home: string;
let codemieHome: string;

function spoolPath(): string {
  return join(codemieHome, 'proxy', 'otlp-spool', `${CLI}.hooks.ndjson`);
}

/** Polls as often as the producer's quiet rule needs (it sees the files, then reads them), each run awaited. */
async function pollTwice(runtime: DesktopTelemetryRuntime): Promise<void> {
  for (let poll = 0; poll < 2; poll++) {
    await runtime.triggerPoll();
    await (runtime as unknown as { cowork?: { inFlight?: Promise<void> } }).cowork?.inFlight;
  }
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cowork-runtime-home-')));
  codemieHome = realpathSync(mkdtempSync(join(tmpdir(), 'cowork-runtime-codemie-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'));
  vi.stubEnv('CODEMIE_HOME', codemieHome);
  for (const key of [
    'CODEMIE_PROJECT', 'CODEMIE_PROFILE_CONFIG', 'CODEMIE_PROFILE_NAME', 'CLAUDE_PROJECT_DIR', 'CODEMIE_LAUNCH_MODE',
    'CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS', 'OTLP_ALLOW_HOOKS_ONLY_FORWARD',
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('no network in this test');
  }));
  installCoworkFixture(getClaudeDesktopBaseDir());
  // The session was served by this daemon
  mkdirSync(join(codemieHome, 'analytics', 'state'), { recursive: true });
  writeFileSync(join(codemieHome, 'analytics', 'state', `${CLI}.cowork-served`), '');
  const profile = (project: string) => ({
    provider: 'ai-run-sso', baseUrl: 'https://api.example.com', model: 'model', codeMieUrl: 'https://api.example.com', codeMieProject: project,
  });
  // The active profile is another one: the project comes from the daemon's profile only.
  writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify({
    version: 2, activeProfile: 'other', profiles: { other: profile('other-project'), cowork: profile('synthetic-project') },
  }));
  // The runtime and the producer read the clock; the fixture's lines are of 2026-11-10.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LAST_LINE_MS + 20_000);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await logger.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(codemieHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('DesktopTelemetryRuntime and the Cowork producer', () => {
  it('builds the producer for the Claude Desktop adapter, with the daemon\'s profile', async () => {
    const runtime = new DesktopTelemetryRuntime(new ClaudeDesktopTelemetryAdapter(), config);

    await pollTwice(runtime);

    expect(existsSync(spoolPath())).toBe(true);
    const lines = readFileSync(spoolPath(), 'utf-8').split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse((JSON.parse(line) as { hookEvent: string }).hookEvent)).toMatchObject({ codemie_project_name: 'synthetic-project' });
    }
  });

  it('a session being collected gets its end and final summary while Desktop is not connected', async () => {
    let gateway: { port: number; apiKey: string } | null = { port: 4001, apiKey: 'codemie-proxy' };
    const runtime = new DesktopTelemetryRuntime(new ClaudeDesktopTelemetryAdapter(), { ...config, readDesktopGateway: async () => gateway });
    await pollTwice(runtime);
    expect(existsSync(join(codemieHome, 'analytics', 'state', `${CLI}.cowork.json`))).toBe(true);

    gateway = null;
    vi.setSystemTime(LAST_LINE_MS + 30_000);
    await pollTwice(runtime);
    vi.setSystemTime(LAST_LINE_MS + config.inactivityTimeoutMs + 40_000);
    await pollTwice(runtime);

    const spooled = readFileSync(spoolPath(), 'utf-8').split('\n').filter((line) => line.length > 0)
      .map((line) => JSON.parse((JSON.parse(line) as { hookEvent: string }).hookEvent) as Record<string, unknown>);
    expect(spooled.filter((event) => event['type'] === 'agent.session.end')).toHaveLength(1);
    expect(spooled.filter((event) => event['type'] === 'agent.session.summary' && event['is_final'] === true)).toHaveLength(1);
  });

  it('builds no producer for another adapter', async () => {
    const adapter: LocalTelemetryAdapter = {
      clientType: 'synthetic-client',
      discoverSessions: async () => [],
      parseSession: async () => {
        throw new Error('no session to parse');
      },
      processParsedSession: async () => {
        throw new Error('no session to process');
      },
    };
    const runtime = new DesktopTelemetryRuntime(adapter, config);

    await pollTwice(runtime);

    expect(existsSync(join(codemieHome, 'proxy', 'otlp-spool'))).toBe(false);
  });

  it('a session the poll saw before its first request is Cowork: a shared-key request of it becomes claude-desktop and leaves its mark', async () => {
    const mark = join(codemieHome, 'analytics', 'state', `${CLI}.cowork-served`);
    rmSync(mark);
    const resolver = new DesktopRepositoryResolver();
    // Started before the session's last activity, so the poll tracks the session and publishes it to the resolver
    vi.setSystemTime(LAST_LINE_MS - 60_000);
    const runtime = new DesktopTelemetryRuntime(new ClaudeDesktopTelemetryAdapter(), { ...config, repositoryResolver: resolver });
    vi.setSystemTime(LAST_LINE_MS + 20_000);
    await runtime.triggerPoll();
    const request: ProxyContext = {
      requestId: 'r1', sessionId: 'unknown', agentName: 'codemie-daemon', method: 'POST', url: '/v1/messages',
      headers: { 'x-claude-code-session-id': CLI }, requestBody: null, requestStartTime: 0,
      metadata: { gatewayKeyValidated: true },
    };

    await new ClientAttributionPlugin().createInterceptor({ config: { targetApiUrl: 'http://127.0.0.1:9', desktopRepositoryResolver: resolver }, logger })
      .handleRequest!(request, {} as never, {} as never, {} as never);

    expect(request.agentName).toBe('claude-desktop');
    expect(existsSync(mark)).toBe(true);
  });
});
