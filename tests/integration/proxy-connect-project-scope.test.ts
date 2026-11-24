/**
 * Claude Code analytics connected for one project — CLI contract tests (EPMCDME-15423)
 *
 * Claude Code exports OpenTelemetry only from the `env` block of the user settings, not from a
 * project's `.claude/settings.json`. `codemie proxy connect --claude-otlp --scope project` must
 * therefore write the hooks and the OTel export settings to the user settings and limit tracking to
 * the current project through the tracked-project list, so a session in that project reaches CLI
 * Analytics with its hooks and its telemetry, and a session in any other project sends nothing.
 *
 * Runs the built `bin/codemie.js proxy connect` in an isolated temp home, which starts the real
 * detached proxy daemon against a local mock backend. Claude Code itself is stood in for: the test
 * fires the installed hook command with the settings' env, as Claude Code passes it to hooks, and
 * posts an OTLP/JSON log record to the endpoint and headers the settings name. No network, no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/proxy-connect-project-scope.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_DIST,
  EVENT_HOOKS_PATH,
  createCliHome,
  deliveredHookEvents,
  disposeCliHome,
  runCli,
  runHook,
  startMockBackend,
  storeSsoLogin,
  waitFor,
  writeGlobalConfig,
  type HookEvent,
  type MockBackend,
} from '../helpers/otlp-hook-session.js';

const PROFILE = 'sso-profile';
const PROJECT = 'scope-project';
// Claude Code session ids are UUIDs: the daemon keys OTel payloads by the first UUID v4 they hold.
const TRACKED_SESSION_ID = '3b776d9d-8b84-492d-ad9c-410f9b779316';
const UNTRACKED_SESSION_ID = '8c5d2ecf-d70a-4850-baa3-607aad67d916';
// Fixed fake cookie (not a real credential).
const COOKIE = { _oauth2_proxy: 'scope-session-cookie' };
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: [PROJECT],
  applications_admin: [],
};
const PROJECT_FILTER_ENV = 'CODEMIE_ANALYTICS_PROJECT_FILTER';
const DELIVERY_TIMEOUT_MS = 45_000;
// Delivery ticks every 3 s (OTLP_SEND_INTERVAL_MINUTES in the hook environment): several pass in this window.
const SEVERAL_TICKS_MS = 10_000;
// Chains CLI and hook processes and waits on the daemon's delivery, so it outlives the `cli` project's 30s default.
const TEST_TIMEOUT_MS = DELIVERY_TIMEOUT_MS + SEVERAL_TICKS_MS + 60_000;

interface ClaudeSettings {
  env?: Record<string, string>;
  hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
}

/** `k1=v1,k2=v2`, the OTEL_EXPORTER_OTLP_HEADERS format. */
function otlpHeaders(value: string): Record<string, string> {
  return Object.fromEntries(
    value.split(',').map((pair) => {
      const at = pair.indexOf('=');
      return [decodeURIComponent(pair.slice(0, at).trim()), decodeURIComponent(pair.slice(at + 1).trim())];
    })
  );
}

/** One OTLP/JSON log record of `sessionId`, as Claude Code exports a prompt event. */
function promptLogRecord(sessionId: string): object {
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  return {
    resourceLogs: [
      {
        resource: { attributes: [attribute('service.name', 'claude-code')] },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events' },
            logRecords: [
              {
                timeUnixNano: `${Date.now()}000000`,
                body: { stringValue: 'claude_code.user_prompt' },
                attributes: [attribute('event.name', 'user_prompt'), attribute('session.id', sessionId), attribute('prompt_length', '14')],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe.skipIf(!existsSync(DAEMON_DIST))('Claude Code analytics connected for one project', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  function projectDir(home: string, name: string): string {
    const dir = join(home, 'work', name);
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  }

  /** A prompt in `project`: the hooks Claude Code runs with the settings' env, then the OTel log it exports. */
  async function promptIn(home: string, settings: ClaudeSettings, project: string, sessionId: string): Promise<void> {
    const env = settings.env ?? {};
    for (const event of [
      { hook_event_name: 'SessionStart', source: 'startup', cwd: project },
      { hook_event_name: 'UserPromptSubmit', prompt: 'Reply with OK.', cwd: project },
    ]) {
      const run = await runHook(home, sessionId, event, { env: { [PROJECT_FILTER_ENV]: env[PROJECT_FILTER_ENV] } });
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
    }
    const response = await fetch(`${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`, {
      method: 'POST',
      headers: { ...otlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS), 'content-type': 'application/json' },
      body: JSON.stringify(promptLogRecord(sessionId)),
    });
    expect(response.status).toBe(200);
  }

  /** Requests to the backend's analytics API that carry `sessionId`. */
  function analyticsFor(backend: MockBackend, sessionId: string) {
    return backend.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/v1/analytics/') && r.body.includes(sessionId));
  }

  // The bug of EPMCDME-15423: project scope wrote the OTel export settings to the project's settings file, which Claude Code ignores, so the session had hooks only and never reached CLI Analytics.
  it(
    'writes the hooks and OTel export to the user settings, tracks only the current project, and delivers its session with hooks and telemetry',
    async () => {
      const backend = await startMockBackend(OWNER);
      closers.push(backend.close);
      const home = createCliHome(homes);
      writeGlobalConfig(home, PROFILE, {
        [PROFILE]: { baseUrl: backend.url, codeMieUrl: backend.url, codeMieProject: PROJECT },
      });
      storeSsoLogin(home, backend.url, COOKIE);
      const tracked = projectDir(home, 'tracked-project');
      const other = projectDir(home, 'other-project');

      const connect = await runCli(home, ['proxy', 'connect', '--claude-otlp', '--scope', 'project', '--yes'], '', {
        cwd: tracked,
        timeoutMs: 60_000,
      });
      expect(connect.code, connect.stdout + connect.stderr).toBe(0);
      expect(connect.stdout).toContain('Claude Code Analytics configured successfully');

      // Nothing in the repository: Claude Code would not export OTel from there.
      expect(existsSync(join(tracked, '.claude'))).toBe(false);
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')) as ClaudeSettings;
      expect(settings.env).toMatchObject({
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_TRACES_EXPORTER: 'otlp',
      });
      expect(settings.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+\//);
      expect(settings.env?.OTEL_EXPORTER_OTLP_HEADERS).toBeTruthy();
      expect(JSON.parse(settings.env?.[PROJECT_FILTER_ENV] ?? '[]').map((p: string) => realpathSync(p))).toEqual([tracked]);
      for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
        expect(settings.hooks?.[event]?.[0]?.hooks[0]?.command).toContain('hook --agent claude-code-otlp');
      }

      await promptIn(home, settings, tracked, TRACKED_SESSION_ID);
      await promptIn(home, settings, other, UNTRACKED_SESSION_ID);

      const hookEvents = await waitFor(
        () => {
          const events = deliveredHookEvents(backend).filter((e) => e.session_id === TRACKED_SESSION_ID);
          return events.some((e) => e.hook_event_name === 'UserPromptSubmit') ? events : undefined;
        },
        DELIVERY_TIMEOUT_MS,
        'the tracked project\'s hooks to reach the backend'
      );
      expect(hookEvents.map((e: HookEvent) => e.hook_event_name)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit']));
      await waitFor(
        () => (analyticsFor(backend, TRACKED_SESSION_ID).some((r) => r.path !== EVENT_HOOKS_PATH) ? true : undefined),
        DELIVERY_TIMEOUT_MS,
        'the tracked project\'s OTel log to reach the backend'
      );

      // Several delivery ticks pass: the other project's session never leaves the machine.
      await new Promise((r) => setTimeout(r, SEVERAL_TICKS_MS));
      expect(analyticsFor(backend, UNTRACKED_SESSION_ID)).toEqual([]);
      for (const delivery of analyticsFor(backend, TRACKED_SESSION_ID)) expect(delivery.project).toBe(PROJECT);
    },
    TEST_TIMEOUT_MS
  );
});
