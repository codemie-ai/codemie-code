import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fetchJwtToken, writeJwtProfile } from '../../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';

const ASSISTANT_ID = process.env.CI_CODEMIE_ASSISTANT_ID ?? '';

function makeEnv(codemieHome: string, fakeHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEMIE_HOME: codemieHome, CI: '1' };
  // Override home so loadAssistantsByScope uses fakeHome for .claude/agents/ lookup
  if (platform() === 'win32') {
    env.USERPROFILE = fakeHome;
    env.HOMEDRIVE = fakeHome.slice(0, 2);
    env.HOMEPATH = fakeHome.slice(2);
  } else {
    env.HOME = fakeHome;
  }
  return env;
}

describe.runIf(INCLUDE_JWT_TESTS)('Assistants — setup and chat (TC-014)', () => {
  let testHome: string;   // CODEMIE_HOME
  let fakeHome: string;   // fake os.homedir() for .claude/agents/ lookup
  const assistantSlug = 'test-assistant';

  beforeAll(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'codemie-asst-home-'));
    testHome = join(fakeHome, '.codemie');

    const token = await fetchJwtToken();
    const profile = {
      name: 'jwt-autotest',
      provider: 'bearer-auth',
      authMethod: 'jwt',
      codeMieUrl: process.env.CI_CODEMIE_URL ?? '',
      baseUrl: process.env.CI_CODEMIE_API_DOMAIN ?? '',
      model: process.env.CI_CODEMIE_MODEL ?? 'claude-sonnet-4-6',
      jwtToken: token,
    };
    const assistant = {
      id: ASSISTANT_ID,
      name: 'Test Assistant',
      slug: assistantSlug,
      description: 'Integration test assistant',
      registrationMode: 'agent',
    };
    const config = {
      version: 2,
      activeProfile: 'jwt-autotest',
      profiles: { 'jwt-autotest': profile },
      codemieAssistants: [assistant],
    };
    mkdirSync(testHome, { recursive: true });
    writeFileSync(join(testHome, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');

    // Write the required .claude/agents/<slug>.md file that loadAssistantsByScope checks
    const agentsDir = join(fakeHome, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, `${assistantSlug}.md`), `# ${assistantSlug}\n`, 'utf-8');
  }, 30_000);

  afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

  it('assistants chat returns a response for a registered assistant', () => {
    const r = spawnSync(process.execPath, [CLI_BIN, 'assistants', 'chat', ASSISTANT_ID, 'Say PONG'], {
      env: makeEnv(testHome, fakeHome),
      encoding: 'utf-8',
      timeout: 60_000,
    });
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(0);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe.runIf(INCLUDE_JWT_TESTS)('Assistants chat — invalid ID (TC-015)', () => {
  let testHome: string;
  let fakeHome: string;

  beforeAll(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'codemie-asst-invalid-'));
    testHome = join(fakeHome, '.codemie');
    const token = await fetchJwtToken();
    writeJwtProfile(testHome, { jwtToken: token });
  }, 30_000);

  afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

  it('exits non-zero for a nonexistent assistant ID', () => {
    const r = spawnSync(
      process.execPath,
      [CLI_BIN, 'assistants', 'chat', 'nonexistent-assistant-id-xyz', 'hello'],
      {
        env: makeEnv(testHome, fakeHome),
        encoding: 'utf-8',
        timeout: 30_000,
      }
    );
    expect(r.status).not.toBe(0);
  });

  it('shows a not-found or error message', () => {
    const r = spawnSync(
      process.execPath,
      [CLI_BIN, 'assistants', 'chat', 'nonexistent-assistant-id-xyz', 'hello'],
      {
        env: makeEnv(testHome, fakeHome),
        encoding: 'utf-8',
        timeout: 30_000,
      }
    );
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/not found|error|invalid|no assistant/i);
  });
});
