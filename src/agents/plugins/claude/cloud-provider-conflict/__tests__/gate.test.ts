import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routedViaCodemie } from '@/agents/core/evidence/routing.js';
import { logger } from '@/utils/logger.js';
import { BEDROCK } from '../provider.js';
import type { ConflictFlow, ConflictPaths } from '../resolver.js';
import type { SwitchPrompt, SwitchPromptDeps } from '../prompt.js';
import type { SwitchDeps } from '../switcher.js';
import { applyConsented, detectAndAsk, dropInheritedBedrockFlag, type GateOutcome } from '../gate.js';

const SECRET = 'SECRET-VALUE-9f3a';
const BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-5-v1:0';

describe('cloud-provider-conflict gate', () => {
  let root: string;
  let backupRoot: string;
  let printed: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const abs = (rel: string): string => join(root, rel);
  const put = (rel: string, body: unknown): string => {
    const file = abs(rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    return file;
  };
  const read = (file: string): string => readFileSync(file, 'utf-8');
  const paths = (): ConflictPaths => ({
    userSettings: abs('user/settings.json'),
    projectSettings: abs('proj/.claude/settings.json'),
    projectLocalSettings: abs('proj/.claude/settings.local.json'),
    managedFiles: [abs('managed/managed-settings.json')],
    managedDropInDirs: [abs('managed/managed-settings.d')],
  });
  const bedrockUser = (): Record<string, unknown> => ({
    model: BEDROCK_MODEL,
    theme: 'dark',
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: SECRET,
      ANTHROPIC_MODEL: BEDROCK_MODEL,
      MY_VAR: 'keep',
    },
  });
  const fakePrompt = (choice: 'switch' | 'cancel'): { prompt: ReturnType<typeof vi.fn> & SwitchPrompt } => ({
    prompt: vi.fn(async () => ({ choice })) as unknown as ReturnType<typeof vi.fn> & SwitchPrompt,
  });
  const switchDeps = (): SwitchDeps => ({ backupRoot, print: (line) => printed.push(line) });

  interface Over {
    flow?: ConflictFlow;
    canPrompt?: boolean;
    profile?: { provider?: string } | null;
    env?: NodeJS.ProcessEnv;
    promptDeps?: SwitchPromptDeps;
  }
  const run = (over: Over = {}): Promise<GateOutcome> =>
    detectAndAsk({
      flow: over.flow ?? 'claude-agent',
      canPrompt: over.canPrompt ?? true,
      profile: over.profile === undefined ? { provider: 'ai-run-sso' } : over.profile,
      paths: paths(),
      platform: 'linux',
      env: over.env ?? {},
      cwd: abs('proj'),
      prompt: over.promptDeps ?? { prompt: fakePrompt('cancel').prompt, print: (l) => printed.push(l) },
      switchDeps: switchDeps(),
    });
  const snapshot = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else out[full] = read(full);
      }
    };
    walk(root);
    return out;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conflict-gate-'));
    backupRoot = join(root, 'backups');
    printed = [];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  describe('stops', () => {
    it('returns stop cancel on cancel and leaves every file byte-identical', async () => {
      put('user/settings.json', bedrockUser());
      const before = snapshot();
      const fake = fakePrompt('cancel');

      const outcome = await run({ promptDeps: { prompt: fake.prompt, print: (l) => printed.push(l) } });

      expect(outcome).toMatchObject({ kind: 'stop', reason: 'cancel' });
      expect(fake.prompt).toHaveBeenCalledTimes(1);
      expect(snapshot()).toEqual(before);
      expect(existsSync(backupRoot)).toBe(false);
    });

    it('returns stop cancel when the prompt is closed by Ctrl-C', async () => {
      put('user/settings.json', bedrockUser());
      const before = snapshot();
      const rejecting = vi.fn(async () => {
        throw new Error('User force closed the prompt');
      }) as unknown as SwitchPrompt;

      const outcome = await run({ promptDeps: { prompt: rejecting, print: () => undefined } });

      expect(outcome).toMatchObject({ kind: 'stop', reason: 'cancel' });
      expect(snapshot()).toEqual(before);
    });

    it('returns stop non-interactive without asking when no prompt is available', async () => {
      put('user/settings.json', bedrockUser());
      const before = snapshot();
      const fake = fakePrompt('switch');

      const outcome = await run({ canPrompt: false, promptDeps: { prompt: fake.prompt } });

      expect(outcome).toMatchObject({ kind: 'stop', reason: 'non-interactive' });
      expect(fake.prompt).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    });

    it('returns stop managed for a managed policy, without asking', async () => {
      put('managed/managed-settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } });
      put('user/settings.json', bedrockUser());
      const before = snapshot();
      const fake = fakePrompt('switch');

      const outcome = await run({ promptDeps: { prompt: fake.prompt } });

      expect(outcome).toMatchObject({ kind: 'stop', reason: 'managed' });
      expect(fake.prompt).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    });

    it('returns stop unknown for an unrecognised flag spelling, without asking', async () => {
      put('user/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: 'maybe' } });
      const fake = fakePrompt('switch');

      const outcome = await run({ promptDeps: { prompt: fake.prompt } });

      expect(outcome).toMatchObject({ kind: 'stop', reason: 'unknown' });
      expect(fake.prompt).not.toHaveBeenCalled();
    });

    it('carries guidance on every stop and never prints it or leaks values', async () => {
      const cases: Array<[string, () => void, Over]> = [
        ['cancel', () => put('user/settings.json', bedrockUser()), {}],
        ['non-interactive', () => put('user/settings.json', bedrockUser()), { canPrompt: false }],
        ['managed', () => put('managed/managed-settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }), {}],
        ['unknown', () => put('user/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: 'maybe' } }), {}],
      ];
      for (const [reason, setup, over] of cases) {
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
        printed = [];
        setup();

        const outcome = await run(over);

        expect(outcome.kind).toBe('stop');
        if (outcome.kind !== 'stop') continue;
        expect(outcome.reason).toBe(reason);
        expect(outcome.guidance.length).toBeGreaterThan(0);
        expect(outcome.guidance).toContain('Nothing was changed');
        expect(outcome.guidance).not.toContain(SECRET);
        // Only the prompt itself may print; guidance is the caller's to show.
        expect(printed.join('\n')).not.toContain('Nothing was changed');
      }
    });
  });

  describe('proceeds', () => {
    it('proceeds with an inert token when nothing conflicts, and applyConsented does nothing', async () => {
      put('user/settings.json', { theme: 'dark', env: { MY_VAR: 'keep' } });
      const before = snapshot();
      const fake = fakePrompt('switch');

      const outcome = await run({ promptDeps: { prompt: fake.prompt } });

      expect(outcome.kind).toBe('proceed');
      expect(fake.prompt).not.toHaveBeenCalled();
      if (outcome.kind !== 'proceed') return;
      const result = await applyConsented(outcome.token);
      expect(result).toEqual({ backupDir: null, files: [], changed: [] });
      expect(snapshot()).toEqual(before);
    });

    it('skips (no resolution, no prompt) when the profile provider is bedrock', async () => {
      put('user/settings.json', bedrockUser());
      const before = snapshot();
      const fake = fakePrompt('switch');

      const outcome = await run({ profile: { provider: 'bedrock' }, promptDeps: { prompt: fake.prompt } });

      expect(outcome.kind).toBe('proceed');
      expect(fake.prompt).not.toHaveBeenCalled();
      if (outcome.kind === 'proceed') expect(await applyConsented(outcome.token)).toEqual({ backupDir: null, files: [], changed: [] });
      expect(snapshot()).toEqual(before);
    });

    it('skips for the install flow without a profile', async () => {
      put('user/settings.json', bedrockUser());
      const fake = fakePrompt('switch');

      for (const profile of [undefined, null] as const) {
        const outcome = await detectAndAsk({
          flow: 'install',
          canPrompt: true,
          profile,
          paths: paths(),
          platform: 'linux',
          env: {},
          cwd: abs('proj'),
          prompt: { prompt: fake.prompt },
          switchDeps: switchDeps(),
        });
        expect(outcome.kind).toBe('proceed');
      }
      expect(fake.prompt).not.toHaveBeenCalled();
    });

    it('does not skip the install flow when a profile exists', async () => {
      put('user/settings.json', bedrockUser());

      const outcome = await run({ flow: 'install', profile: { provider: 'ai-run-sso' } });

      expect(outcome).toMatchObject({ kind: 'stop', reason: 'cancel' });
    });

    it('only warns for the --claude-code-otlp target and never asks', async () => {
      put('user/settings.json', bedrockUser());
      const before = snapshot();
      const fake = fakePrompt('switch');

      const outcome = await run({ flow: 'connect-otlp-only', promptDeps: { prompt: fake.prompt } });

      expect(outcome.kind).toBe('proceed');
      expect(fake.prompt).not.toHaveBeenCalled();
      if (outcome.kind === 'proceed') expect(await applyConsented(outcome.token)).toEqual({ backupDir: null, files: [], changed: [] });
      expect(snapshot()).toEqual(before);
    });

    it('warns and proceeds without asking when only the inherited shell variable is on', async () => {
      put('user/settings.json', { theme: 'dark' });
      const fake = fakePrompt('switch');

      const outcome = await run({
        flow: 'install',
        env: { CLAUDE_CODE_USE_BEDROCK: '1' },
        promptDeps: { prompt: fake.prompt },
      });

      expect(outcome.kind).toBe('proceed');
      expect(fake.prompt).not.toHaveBeenCalled();
      if (outcome.kind === 'proceed') expect(await applyConsented(outcome.token)).toEqual({ backupDir: null, files: [], changed: [] });
    });

    it('still prompts when the shell variable and a settings file are both on', async () => {
      put('user/settings.json', bedrockUser());

      const outcome = await run({ flow: 'install', env: { CLAUDE_CODE_USE_BEDROCK: '1' } });

      // Settings outrank the shell variable, so the file is what decides; the user is asked about it.
      expect(outcome).toMatchObject({ kind: 'stop', reason: 'cancel' });
    });
  });

  describe('warnings shown to the user', () => {
    let notices: string[];
    let noticeSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      notices = [];
      noticeSpy = vi.spyOn(logger, 'notice').mockImplementation((message: string) => {
        notices.push(message);
      });
    });
    afterEach(() => {
      noticeSpy.mockRestore();
    });

    it('shows nothing when nothing is configured', async () => {
      expect((await run({ flow: 'claude-agent' })).kind).toBe('proceed');
      expect((await run({ flow: 'install' })).kind).toBe('proceed');
      expect(notices).toEqual([]);
    });

    it('shows the --claude-code-otlp warning on screen, not only in the log file', async () => {
      await run({ flow: 'connect-otlp-only' });
      expect(notices).toEqual([expect.stringMatching(/not checked for this target/)]);
    });

    it.each(['1', 'true', 'maybe'])('an install with the shell variable set to %s warns and proceeds, never stops', async (value) => {
      const fake = fakePrompt('switch');
      const outcome = await run({ flow: 'install', env: { CLAUDE_CODE_USE_BEDROCK: value }, promptDeps: { prompt: fake.prompt } });
      expect(outcome.kind).toBe('proceed');
      expect(fake.prompt).not.toHaveBeenCalled();
      expect(notices).toEqual([expect.stringContaining('CLAUDE_CODE_USE_BEDROCK')]);
    });

    it.each(['0', 'false', ''])('an install with the shell variable set to "%s" shows no warning', async (value) => {
      expect((await run({ flow: 'install', env: { CLAUDE_CODE_USE_BEDROCK: value } })).kind).toBe('proceed');
      expect(notices).toEqual([]);
    });

    it('shows the shell-variable warning when only the shell selects Bedrock for the launch', async () => {
      expect((await run({ flow: 'claude-agent', env: { CLAUDE_CODE_USE_BEDROCK: '1' } })).kind).toBe('proceed');
      expect(notices).toEqual([expect.stringContaining('CLAUDE_CODE_USE_BEDROCK')]);
    });

    it.each([
      ['broken JSON', '{ broken'],
      ['a null env', '{"env": null}'],
      ['an array root', '[]'],
    ])('a user settings file with %s proceeds and is named in one on-screen warning', async (_n, body) => {
      const file = put('user/settings.json', body);
      expect((await run({ flow: 'claude-agent' })).kind).toBe('proceed');
      expect(notices).toEqual([expect.stringContaining(file)]);
      expect(notices[0]).toMatch(/analytics attribution/i);
    });
  });

  describe('switch', () => {
    it('hands a consent token, applies the switch only on applyConsented, and routes to the gateway afterwards', async () => {
      const user = put('user/settings.json', bedrockUser());
      const original = read(user);
      const fake = fakePrompt('switch');
      const gatewayEnv = {
        CODEMIE_SESSION_ID: 'session-1',
        CODEMIE_BASE_URL: 'http://127.0.0.1:4141',
        CODEMIE_TARGET_API_URL: 'https://gateway.example/llm',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4141',
      };
      const routing = (): ReturnType<typeof routedViaCodemie> => {
        const settings = JSON.parse(read(user)) as { env?: Record<string, unknown> };
        return routedViaCodemie({
          env: gatewayEnv,
          settingsEnv: settings.env,
          codemieProvider: true,
          profileBaseUrl: 'https://gateway.example/llm',
        });
      };
      expect(routing().routed).toBe(false);

      const outcome = await run({ promptDeps: { prompt: fake.prompt, print: (l) => printed.push(l) } });

      expect(outcome.kind).toBe('proceed');
      expect(read(user)).toBe(original); // consent alone changes nothing
      if (outcome.kind !== 'proceed') return;

      const result = await applyConsented(outcome.token);

      expect(result.backupDir).toBeTruthy();
      expect(result.changed).toEqual([user]);
      const after = read(user);
      expect(after).not.toContain(BEDROCK_MODEL);
      expect(after).not.toContain('CLAUDE_CODE_USE_BEDROCK');
      expect(after).toContain('MY_VAR');
      expect(routing()).toEqual({ routed: true, routing_proof: 'proven' });
    });
  });

  describe('dropInheritedBedrockFlag', () => {
    it('removes the key for real (absent, never the string "undefined") and leaves other vars', () => {
      const env: NodeJS.ProcessEnv = { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', PATH: '/bin' };

      expect(dropInheritedBedrockFlag({ agent: 'claude', provider: 'ai-run-sso', env })).toBe(true);

      expect('CLAUDE_CODE_USE_BEDROCK' in env).toBe(false);
      expect(Object.keys(env)).not.toContain('CLAUDE_CODE_USE_BEDROCK');
      expect(Object.values(env)).not.toContain('undefined');
      expect(env).toEqual({ AWS_REGION: 'us-east-1', PATH: '/bin' });
    });

    it('works for claude-acp too', () => {
      const env: NodeJS.ProcessEnv = { CLAUDE_CODE_USE_BEDROCK: 'true' };
      expect(dropInheritedBedrockFlag({ agent: 'claude-acp', provider: 'litellm', env })).toBe(true);
      expect('CLAUDE_CODE_USE_BEDROCK' in env).toBe(false);
    });

    it('returns false when the key is not present', () => {
      const env: NodeJS.ProcessEnv = { PATH: '/bin' };
      expect(dropInheritedBedrockFlag({ agent: 'claude', provider: 'ai-run-sso', env })).toBe(false);
      expect(env).toEqual({ PATH: '/bin' });
    });

    it('does nothing for the bedrock provider', () => {
      const env: NodeJS.ProcessEnv = { CLAUDE_CODE_USE_BEDROCK: '1' };
      expect(dropInheritedBedrockFlag({ agent: 'claude', provider: 'bedrock', env })).toBe(false);
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    });

    it('does nothing for non-Claude agents', () => {
      for (const agent of ['codex', 'gemini', 'codemie-code', 'claude-code-otlp']) {
        const env: NodeJS.ProcessEnv = { CLAUDE_CODE_USE_BEDROCK: '1' };
        expect(dropInheritedBedrockFlag({ agent, provider: 'ai-run-sso', env })).toBe(false);
        expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      }
    });

    it('defaults to the process env but never touches anything else', () => {
      const saved = process.env.CLAUDE_CODE_USE_BEDROCK;
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      try {
        expect(dropInheritedBedrockFlag({ agent: 'claude', provider: 'ai-run-sso' })).toBe(true);
        expect('CLAUDE_CODE_USE_BEDROCK' in process.env).toBe(false);
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
        else process.env.CLAUDE_CODE_USE_BEDROCK = saved;
      }
    });

    it('uses the descriptor flag name', () => {
      expect(BEDROCK.flag).toBe('CLAUDE_CODE_USE_BEDROCK');
    });
  });
});
