/**
 * Tests for detectSettingsConflict — detects when ~/.claude/settings.json
 * ANTHROPIC_BASE_URL would override the active profile value.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs/promises');
vi.mock('fs');
vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getCodemieHome: vi.fn(() => '/home/testuser/.codemie'),
  getCodemiePath: vi.fn((...parts: string[]) => `/home/testuser/.codemie/${parts.join('/')}`),
}));

describe('detectSettingsConflict', () => {
  let detectSettingsConflict: (env: NodeJS.ProcessEnv) => Promise<import('../settings-conflict.js').ConflictInfo | null>;
  let fsMod: typeof import('fs');
  let fsp: typeof import('fs/promises');

  const SETTINGS_PATH = '/home/testuser/claude/settings.json';
  const PROFILE_URL = 'https://ai-proxy.lab.epam.com';
  const SETTINGS_URL = 'https://other-proxy.example.com';

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();

    fsMod = await import('fs');
    fsp = await import('fs/promises');

    const mod = await import('../settings-conflict.js');
    detectSettingsConflict = mod.detectSettingsConflict;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when settings.json does not exist', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(false);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(vi.mocked(fsMod.existsSync)).toHaveBeenCalledWith(SETTINGS_PATH);
    expect(result).toBeNull();
  });

  it('returns null when settings.json has no ANTHROPIC_BASE_URL key', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ statusLine: 'some-value' }) as any);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toBeNull();
  });

  it('returns null when settings.json ANTHROPIC_BASE_URL equals env value', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ ANTHROPIC_BASE_URL: PROFILE_URL }) as any);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toBeNull();
  });

  it('returns ConflictInfo when settings.json URL differs from env URL', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ ANTHROPIC_BASE_URL: SETTINGS_URL }) as any);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(vi.mocked(fsMod.existsSync)).toHaveBeenCalledWith(SETTINGS_PATH);
    expect(result).toEqual({ settingsUrl: SETTINGS_URL, profileUrl: PROFILE_URL });
  });

  it('returns ConflictInfo with undefined profileUrl when env has no ANTHROPIC_BASE_URL', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ ANTHROPIC_BASE_URL: SETTINGS_URL }) as any);

    const result = await detectSettingsConflict({});

    expect(result).toEqual({ settingsUrl: SETTINGS_URL, profileUrl: undefined });
  });

  it('returns null when settings.json is malformed JSON', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue('{ not valid json' as any);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toBeNull();
  });

  it('returns null when settings.json ANTHROPIC_BASE_URL is an empty string', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ ANTHROPIC_BASE_URL: '' }) as any);

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toBeNull();
  });

  it('returns null when readFile rejects with a filesystem error', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsp.readFile).mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );

    const result = await detectSettingsConflict({ ANTHROPIC_BASE_URL: PROFILE_URL });

    expect(result).toBeNull();
  });
});
