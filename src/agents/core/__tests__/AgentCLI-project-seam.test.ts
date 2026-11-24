/**
 * Real launcher/config seam: AgentCLI.handleRun loads config BEFORE BaseAgentAdapter creates
 * CODEMIE_SESSION_ID, so a managed launch must export the profile's project even when a linked
 * folder's `.codemie` names another one. Nothing here presets CODEMIE_SESSION_ID or mocks ConfigLoader.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import '../../../providers/index.js';
import * as paths from '../../../utils/paths.js';

let tmp: string;

function adapter(run: AgentAdapter['run']): AgentAdapter {
  return {
    name: 'claude',
    displayName: 'Claude Code',
    description: 'seam test adapter',
    metadata: {
      name: 'claude',
      displayName: 'Claude Code',
      description: 'seam test adapter',
      npmPackage: null,
      cliCommand: 'claude',
      envMapping: {},
      supportedProviders: [],
    },
    install: async () => {},
    uninstall: async () => {},
    isInstalled: async () => true,
    run,
    getVersion: async () => null,
    getMetricsConfig: () => undefined,
  };
}

describe('AgentCLI.handleRun — project exported by a managed launch (no preset session id)', () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codemie-seam-'));
    const home = path.join(tmp, 'home', '.codemie');
    const linked = path.join(tmp, 'folder', '.codemie');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(linked, { recursive: true });
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(home);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((sub: string) => path.join(home, sub));
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'folder'));
    vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
    vi.stubEnv('CODEMIE_SESSION_ID', '');
    delete process.env.CODEMIE_SESSION_ID;
    vi.stubEnv('CODEMIE_PROJECT', '');
    delete process.env.CODEMIE_PROJECT;

    const profile = { name: 'g', provider: 'ai-run-sso', authMethod: 'sso', model: 'm', baseUrl: 'https://g.example.com/code-assistant-api' };
    await fs.writeFile(
      path.join(home, 'codemie-cli.config.json'),
      JSON.stringify({
        version: 2,
        activeProfile: 'g',
        profiles: { g: profile },
        workspace: { codeMieProject: 'profile-project', codeMieUrl: 'https://g.example.com' },
      })
    );
    await fs.writeFile(
      path.join(linked, 'codemie-cli.config.json'),
      JSON.stringify({ version: 2, activeProfile: 'other', profiles: { other: { name: 'other' } }, workspace: { codeMieProject: 'linked-project' } })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('exports the profile project, not the linked folder project', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(adapter(run)) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await cli.handleRun([], { task: 'x', profile: 'g' });

    expect(run).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ CODEMIE_PROJECT: 'profile-project' }),
      undefined
    );
    expect(process.env.CODEMIE_SESSION_ID).toBeUndefined();
  });
});
