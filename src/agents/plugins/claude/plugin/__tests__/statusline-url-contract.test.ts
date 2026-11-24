/**
 * Contract (EPMCDME-15411, AC10): the standalone statusline picks the session
 * profile's CodeMie URL by the same rule as ConfigLoader.resolveProfileIdentity(),
 * without importing ConfigLoader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { sessionCodeMieUrl } from '../statusline.js';
import { ConfigLoader } from '@/utils/config.js';
import * as paths from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import type { MultiProviderConfig } from '@/env/types.js';

const TEST_DIR = path.join(process.cwd(), 'tmp-test-statusline-url-contract');
const HOME = path.join(TEST_DIR, '.codemie');
const WORKING_DIR = path.join(TEST_DIR, 'work');

const config: MultiProviderConfig = {
  version: 2,
  activeProfile: 'own-same',
  workspace: { codeMieUrl: 'https://shared.example.com', codeMieProject: 'shared' },
  profiles: {
    'own-same': { provider: 'ai-run-sso', baseUrl: 'https://shared.example.com/code-assistant-api', codeMieProject: 'a' },
    'own-other': {
      provider: 'ai-run-sso', baseUrl: 'https://other.example.com/code-assistant-api',
      codeMieUrl: 'https://other.example.com', codeMieProject: 'b',
    },
    unowned: { provider: 'ai-run-sso', baseUrl: 'https://shared.example.com/code-assistant-api' },
    'unowned-own-url': { provider: 'ai-run-sso', codeMieUrl: 'https://own.example.com' },
    none: { provider: 'anthropic-subscription', codeMieProject: null },
  },
};

describe('statusline URL rule ↔ resolveProfileIdentity', () => {
  beforeEach(async () => {
    await fs.mkdir(HOME, { recursive: true });
    await fs.mkdir(WORKING_DIR, { recursive: true });
    await fs.writeFile(path.join(HOME, 'codemie-cli.config.json'), JSON.stringify(config));
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(HOME);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((p: string) => path.join(HOME, p));
  });

  afterEach(async () => {
    await logger.close();
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  for (const name of Object.keys(config.profiles)) {
    it(`agrees for profile "${name}"`, async () => {
      const resolved = await ConfigLoader.resolveProfileIdentity(WORKING_DIR, name);
      expect(sessionCodeMieUrl(config.profiles[name], config.workspace)).toBe(resolved.identity.codeMieUrl);
    });
  }

  it('a none profile has no URL even with a stale one on its record', () => {
    expect(sessionCodeMieUrl({ codeMieProject: null, codeMieUrl: 'https://stale' }, config.workspace)).toBeUndefined();
  });
});
