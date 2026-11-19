/**
 * Detector of how each Claude client is configured today, and the route decision `--claude-otlp` takes from it.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult } from '@/utils/exec.js';

vi.mock('../connectors/vscode-claude-code.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/vscode-claude-code.js')>()),
  readVsCodeClaudeCodeRouteState: vi.fn(async () => 'none'),
}));

const { readVsCodeClaudeCodeRouteState } = await import('../connectors/vscode-claude-code.js');
const { detectClaudeLogin, decideVsCodeRoute, decideDesktopRoute } = await import('../claude-client-config-state.js');

type ExecFn = NonNullable<NonNullable<Parameters<typeof detectClaudeLogin>[0]>['exec']>;

function execReturning(stdout: string, code = 0): ReturnType<typeof vi.fn> {
  return vi.fn(async (): Promise<ExecResult> => ({ code, stdout, stderr: '' }));
}

const binary = async (): Promise<string | null> => '/usr/local/bin/claude';

describe('claude-client-config-state', () => {
  let scratch = '';

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'codemie-claude-state-'));
    vi.mocked(readVsCodeClaudeCodeRouteState).mockResolvedValue('none');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(scratch, { recursive: true, force: true });
  });

  describe('detectClaudeLogin', () => {
    it.each([
      ['none', 'logged-out'],
      ['claude.ai', 'configured'],
      ['oauth_token', 'configured'],
      ['api_key', 'configured'],
    ])('maps authMethod %s to %s', async (authMethod, expected) => {
      // The real `claude auth status` exits 1 when nobody is logged in and still prints the JSON.
      const exec = execReturning(JSON.stringify({ loggedIn: authMethod !== 'none', authMethod }), authMethod === 'none' ? 1 : 0);
      expect(await detectClaudeLogin({ exec: exec as unknown as ExecFn, resolveClaudeBinary: binary })).toBe(expected);
      expect(exec).toHaveBeenCalledWith('/usr/local/bin/claude', ['auth', 'status', '--json'], expect.objectContaining({ timeout: 5000 }));
    });

    it('strips every ANTHROPIC_* variable from the child environment', async () => {
      vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:1');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
      const exec = execReturning(JSON.stringify({ authMethod: 'none' }));
      await detectClaudeLogin({ exec: exec as unknown as ExecFn, resolveClaudeBinary: binary });
      const options = exec.mock.calls[0][2] as { unsetEnv?: string[] };
      expect(options.unsetEnv).toEqual(expect.arrayContaining(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']));
    });

    it('counts as configured when exec rejects, times out, prints nothing or prints junk', async () => {
      const rejecting = vi.fn(async () => { throw new Error('Command timed out after 5000ms'); });
      expect(await detectClaudeLogin({ exec: rejecting as unknown as ExecFn, resolveClaudeBinary: binary })).toBe('configured');
      expect(await detectClaudeLogin({ exec: execReturning('', 1) as unknown as ExecFn, resolveClaudeBinary: binary })).toBe('configured');
      expect(await detectClaudeLogin({ exec: execReturning('not json') as unknown as ExecFn, resolveClaudeBinary: binary })).toBe('configured');
      expect(await detectClaudeLogin({ exec: execReturning('{}') as unknown as ExecFn, resolveClaudeBinary: binary })).toBe('configured');
    });

    it('falls back to ~/.claude.json without a binary', async () => {
      const claudeJsonPath = join(scratch, '.claude.json');
      const seams = { resolveClaudeBinary: async (): Promise<string | null> => null, claudeJsonPath };
      expect(await detectClaudeLogin(seams)).toBe('logged-out');
      await writeFile(claudeJsonPath, JSON.stringify({ projects: {} }));
      expect(await detectClaudeLogin(seams)).toBe('logged-out');
      await writeFile(claudeJsonPath, JSON.stringify({ oauthAccount: {} }));
      expect(await detectClaudeLogin(seams)).toBe('configured');
    });
  });

  describe('decideVsCodeRoute', () => {
    const loggedOut = execReturning(JSON.stringify({ authMethod: 'none' })) as unknown as ExecFn;
    const loggedIn = execReturning(JSON.stringify({ authMethod: 'claude.ai' })) as unknown as ExecFn;

    it.each([
      ['none', 'logged-out', 'route'],
      ['none', 'configured', 'skip'],
      ['ours', 'logged-out', 'refresh'],
      ['ours', 'configured', 'refresh'],
      ['foreign', 'logged-out', 'skip'],
      ['foreign', 'configured', 'skip'],
    ] as const)('route state %s with login %s gives %s', async (state, login, expected) => {
      vi.mocked(readVsCodeClaudeCodeRouteState).mockResolvedValue(state);
      const exec = login === 'logged-out' ? loggedOut : loggedIn;
      expect(await decideVsCodeRoute(false, { exec, resolveClaudeBinary: binary })).toBe(expected);
    });

    it('does not ask the login state when the route state already decides', async () => {
      vi.mocked(readVsCodeClaudeCodeRouteState).mockResolvedValue('ours');
      const exec = execReturning('{}');
      await decideVsCodeRoute(false, { exec: exec as unknown as ExecFn, resolveClaudeBinary: binary });
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('decideDesktopRoute', () => {
    let desktop3pDir = '';
    let desktop1pDir = '';

    beforeEach(() => {
      desktop3pDir = join(scratch, 'Claude-3p');
      desktop1pDir = join(scratch, 'Claude');
    });

    async function applyConfig(config: Record<string, unknown> | null): Promise<void> {
      const lib = join(desktop3pDir, 'configLibrary');
      await mkdir(lib, { recursive: true });
      await writeFile(join(lib, '_meta.json'), JSON.stringify({ appliedId: 'cfg-1', entries: [] }));
      if (config) await writeFile(join(lib, 'cfg-1.json'), JSON.stringify(config));
    }

    it('routes when nothing is configured at all', async () => {
      expect(await decideDesktopRoute({ desktop3pDir, desktop1pDir })).toBe('route');
    });

    it('refreshes a config that already points at the local proxy', async () => {
      await applyConfig({ inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'http://127.0.0.1:4001' });
      expect(await decideDesktopRoute({ desktop3pDir, desktop1pDir })).toBe('refresh');
    });

    it('skips a foreign gateway', async () => {
      await applyConfig({ inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'https://gw.example.com' });
      expect(await decideDesktopRoute({ desktop3pDir, desktop1pDir })).toBe('skip-other-gateway');
    });

    it('skips an applied config that is not a gateway, or cannot be read', async () => {
      await applyConfig({ inferenceProvider: 'bedrock' });
      expect(await decideDesktopRoute({ desktop3pDir, desktop1pDir })).toBe('skip-other-gateway');
      await applyConfig(null);
      expect(await decideDesktopRoute({ desktop3pDir, desktop1pDir })).toBe('skip-other-gateway');
    });

    it('skips a Desktop that uses its own Claude account', async () => {
      await mkdir(desktop1pDir, { recursive: true });
      expect(await decideDesktopRoute({ desktop3pDir, desktop1pDir })).toBe('skip-1p');
    });

    it('routes when the 1p directory exists but the 3p deployment mode is set', async () => {
      await mkdir(desktop1pDir, { recursive: true });
      await mkdir(desktop3pDir, { recursive: true });
      await writeFile(join(desktop3pDir, 'claude_desktop_config.json'), JSON.stringify({ deploymentMode: '3p' }));
      expect(await decideDesktopRoute({ desktop3pDir, desktop1pDir })).toBe('route');
    });
  });
});
