/**
 * ConfigLoader.updateProfile: set or clear fields of one stored profile, in the scope it lives in.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigLoader } from '../config.js';
import type { MultiProviderConfig } from '../../env/types.js';
import * as paths from '../paths.js';
import { logger } from '../logger.js';
import { ConfigurationError } from '../errors.js';

vi.mock('../cli-updater.js', () => ({ getCurrentCliVersion: vi.fn(async () => '0.0.0') }));

const TEST_DIR = path.join(process.cwd(), 'tmp-test-update-profile');
const GLOBAL_DIR = path.join(TEST_DIR, '.codemie');
const GLOBAL_CONFIG = path.join(GLOBAL_DIR, 'codemie-cli.config.json');
const WORKING_DIR = path.join(TEST_DIR, 'project');
const LOCAL_CONFIG = path.join(WORKING_DIR, '.codemie', 'codemie-cli.config.json');

const profile = { provider: 'ai-run-sso', baseUrl: 'https://codemie.example.com/code-assistant-api', model: 'claude-sonnet-5' };

async function write(file: string, config: MultiProviderConfig): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2));
}

async function read(file: string): Promise<MultiProviderConfig> {
  return JSON.parse(await fs.readFile(file, 'utf-8')) as MultiProviderConfig;
}

describe('ConfigLoader.updateProfile', () => {
  beforeEach(async () => {
    await fs.mkdir(WORKING_DIR, { recursive: true });
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(GLOBAL_DIR);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => path.join(GLOBAL_DIR, subpath));
    await write(GLOBAL_CONFIG, { version: 2, activeProfile: 'demo', profiles: { demo: { ...profile }, other: { ...profile } } });
  });

  afterEach(async () => {
    await logger.close();
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sets a field on the named global profile only', async () => {
    await ConfigLoader.updateProfile('demo', { claudeExtraModels: ['grok-4.6'] }, WORKING_DIR);

    const config = await read(GLOBAL_CONFIG);
    expect(config.profiles.demo.claudeExtraModels).toEqual(['grok-4.6']);
    expect(config.profiles.other.claudeExtraModels).toBeUndefined();
    expect(config.profiles.demo.model).toBe('claude-sonnet-5');
  });

  it('removes a field passed as undefined', async () => {
    await ConfigLoader.updateProfile('demo', { claudeExtraModels: ['grok-4.6'] }, WORKING_DIR);
    await ConfigLoader.updateProfile('demo', { claudeExtraModels: undefined }, WORKING_DIR);

    expect('claudeExtraModels' in (await read(GLOBAL_CONFIG)).profiles.demo).toBe(false);
  });

  it('updates the repository profile when the repository defines one of that name', async () => {
    await write(LOCAL_CONFIG, { version: 2, activeProfile: 'demo', profiles: { demo: { ...profile } } });

    await ConfigLoader.updateProfile('demo', { claudeExtraModels: ['grok-4.6'] }, WORKING_DIR);

    expect((await read(LOCAL_CONFIG)).profiles.demo.claudeExtraModels).toEqual(['grok-4.6']);
    expect((await read(GLOBAL_CONFIG)).profiles.demo.claudeExtraModels).toBeUndefined();
  });

  it('throws a ConfigurationError for an unknown profile', async () => {
    await expect(ConfigLoader.updateProfile('missing', { claudeExtraModels: [] }, WORKING_DIR))
      .rejects.toBeInstanceOf(ConfigurationError);
  });
});
