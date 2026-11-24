/**
 * Secrets in Claude Code hook payloads — CLI contract tests (EPMCDME-16383)
 *
 * Claude Code hands its hooks free text: the prompt, tool input and output, errors, notifications,
 * the final assistant message, scheduled prompts, background task commands and /compact
 * instructions. A secret in any of them must never reach CodeMie analytics: the fields analytics
 * use are masked before they leave the hook; the content of a credentials file the session reads,
 * a notification's text and the unbounded fields analytics do not use are not forwarded at all.
 *
 * Drives the built `bin/codemie.js hook --agent claude-code-otlp` for every hook event that carries
 * free text, and the real detached proxy daemon, in an isolated temp home against a local mock
 * backend that records every byte it receives. No network, no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/analytics-hook-secret-egress.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_DIST,
  createCliHome,
  deliveredHookEvents,
  disposeCliHome,
  recordProxyConnection,
  runHook,
  startMockBackend,
  storeSsoLogin,
  waitFor,
  writeGlobalConfig,
  type HookEvent,
} from '../helpers/otlp-hook-session.js';

const PROFILE = 'sso-profile';
const PROJECT = 'egress-project';
const SESSION_ID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';
// Fixed fake cookie (not a real credential).
const COOKIE = { _oauth2_proxy: 'egress-session-cookie' };
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: [PROJECT],
  applications_admin: [],
};
// Fixed fake secrets (not real credentials).
const FAKE_GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; // gitleaks:allow
const FAKE_OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD'; // gitleaks:allow
const SECRETS = [FAKE_GITHUB_TOKEN, FAKE_OPENAI_KEY];
const REDACTED = '[REDACTED]';
// Fields analytics never use; each held a secret in full before the fix.
const DROPPED_FIELDS = ['last_assistant_message', 'session_crons', 'background_tasks', 'custom_instructions'];
const ENV_OUTPUT = `GITHUB_TOKEN=${FAKE_GITHUB_TOKEN}\nOPENAI_API_KEY=${FAKE_OPENAI_KEY}\n`;
const DELIVERY_TIMEOUT_MS = 45_000;
// Chains one hook process per event and waits on the daemon's delivery, so it outlives the `cli` project's 30s default.
const TEST_TIMEOUT_MS = DELIVERY_TIMEOUT_MS + 60_000;

/** One event per hook that carries free text, each with a secret in every such field, in the order Claude Code fires them. */
const SESSION: HookEvent[] = [
  { hook_event_name: 'SessionStart', source: 'startup' },
  { hook_event_name: 'UserPromptSubmit', prompt: `deploy with ${FAKE_GITHUB_TOKEN} please` },
  {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    tool_input: { command: `curl -H "Authorization: Bearer ${FAKE_OPENAI_KEY}" https://api.example.test` },
  },
  {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'tool-2',
    tool_input: { command: 'env' },
    tool_response: { stdout: ENV_OUTPUT, stderr: '', interrupted: false },
  },
  {
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_use_id: 'tool-3',
    tool_input: { file_path: '.env' },
    tool_response: { type: 'text', file: { filePath: '.env', content: ENV_OUTPUT } },
  },
  {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_use_id: 'tool-4',
    tool_input: { command: 'git push' },
    error: `remote rejected token ${FAKE_GITHUB_TOKEN}`,
  },
  {
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    title: `Use ${FAKE_OPENAI_KEY}?`,
    message: `Claude needs permission to run with ${FAKE_GITHUB_TOKEN}`,
  },
  { hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: `keep ${FAKE_OPENAI_KEY} in the summary` },
  {
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: `Your key is ${FAKE_OPENAI_KEY}.`,
    session_crons: [{ id: 'cron-1', cron: '*/5 * * * *', prompt: `check with ${FAKE_GITHUB_TOKEN}` }],
    background_tasks: [{ id: 'task-1', command: `deploy --token ${FAKE_GITHUB_TOKEN}`, description: `uses ${FAKE_OPENAI_KEY}` }],
  },
];

describe.skipIf(!existsSync(DAEMON_DIST))('secrets in Claude Code hook payloads', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  /** Every file under `dir`, read as text. Walked by hand: recursive readdir and `Dirent.parentPath` need a later Node 20. */
  function filesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return filesUnder(path);
      return entry.isFile() ? [readFileSync(path, 'latin1')] : [];
    });
  }

  // The bug of EPMCDME-16383: free-text hook fields were forwarded to analytics with their secrets, some in full.
  it(
    'delivers every hook event with no secret in any field, masking the fields analytics use and dropping the rest',
    async () => {
      const backend = await startMockBackend(OWNER);
      closers.push(backend.close);
      const home = createCliHome(homes);
      writeGlobalConfig(home, PROFILE, {
        [PROFILE]: { baseUrl: backend.url, codeMieUrl: backend.url, codeMieProject: PROJECT },
      });
      recordProxyConnection(home, PROFILE);
      storeSsoLogin(home, backend.url, COOKIE);

      for (const event of SESSION) {
        // Debug logging writes the most, so a payload that reached any log line would show up in the scan below.
        const run = await runHook(home, SESSION_ID, event, { env: { CODEMIE_DEBUG: 'true' } });
        expect(run.code).toBe(0);
        expect(run.stdout).toBe('');
        expect(run.stderr).toBe('');
      }

      const delivered = await waitFor(
        () => {
          const events = deliveredHookEvents(backend);
          return events.some((e) => e.hook_event_name === 'Stop') ? events : undefined;
        },
        DELIVERY_TIMEOUT_MS,
        'the whole session to reach the backend'
      );
      const byName = (name: string, toolUseId?: string): HookEvent => {
        const event = delivered.find((e) => e.hook_event_name === name && (!toolUseId || e.tool_use_id === toolUseId));
        expect(event, `${name} ${toolUseId ?? ''} delivered`).toBeDefined();
        return event as HookEvent;
      };

      // Nothing the backend received holds a secret: not the events, not any other request.
      for (const request of backend.requests) {
        for (const secret of SECRETS) expect(request.body).not.toContain(secret);
      }
      // Neither does anything the hook or the daemon left on disk: spool, state, logs and config. The home holds no
      // legitimate copy of the secrets (the transcript is empty), so the whole of it is scanned.
      for (const file of filesUnder(home)) {
        for (const secret of SECRETS) expect(file).not.toContain(secret);
      }

      // The fields analytics use arrive, masked rather than emptied.
      expect(byName('UserPromptSubmit').prompt).toBe(`deploy with ${REDACTED} please`);
      expect(JSON.stringify(byName('PreToolUse').tool_input)).toContain(REDACTED);
      expect(JSON.stringify(byName('PostToolUse', 'tool-2').tool_response)).toContain(`GITHUB_TOKEN=${REDACTED}`);
      expect(byName('PostToolUseFailure').error).toBe(`remote rejected token ${REDACTED}`);
      // A credentials file's content, a notification's text and the unbounded fields are not forwarded at all.
      const envRead = byName('PostToolUse', 'tool-3');
      expect(envRead.tool_input).toBe(JSON.stringify({ file_path: '.env' }));
      expect(envRead).not.toHaveProperty('tool_response');
      expect(byName('Notification')).not.toHaveProperty('message');
      expect(byName('Notification')).not.toHaveProperty('title');
      expect(byName('Notification').notification_type).toBe('permission_prompt');
      for (const event of [byName('PreCompact'), byName('Stop')]) {
        for (const field of DROPPED_FIELDS) expect(event).not.toHaveProperty(field);
      }
      expect(byName('PreCompact').trigger).toBe('manual');
    },
    TEST_TIMEOUT_MS
  );
});
