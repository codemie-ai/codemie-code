import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../../../../providers/index.js';
import { loadCopilotLaunchEnv } from '../copilot-cli.launch-env.js';

describe('loadCopilotLaunchEnv (the model lookup behind codemie-copilot --model-list)', () => {
  let tmp: string;
  let envBefore: NodeJS.ProcessEnv;

  beforeEach(async () => {
    envBefore = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith('CODEMIE_')) delete process.env[key];
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-env-'));
    vi.stubEnv('CODEMIE_HOME', path.join(tmp, 'home'));
    await fs.mkdir(path.join(tmp, 'home'), { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('from a repo subfolder uses the repo profile model and the subfolder .env', async () => {
    const repo = path.join(tmp, 'repo');
    const sub = path.join(repo, 'sub');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(path.join(repo, '.codemie'), { recursive: true });
    await fs.mkdir(sub, { recursive: true });
    const profile = (model: string) => ({ provider: 'ai-run-sso', authMethod: 'sso', model, baseUrl: 'https://g.example.com/code-assistant-api' });
    await fs.writeFile(
      path.join(tmp, 'home', 'codemie-cli.config.json'),
      JSON.stringify({ version: 2, activeProfile: 'x', profiles: { g: profile('g-model'), x: profile('x-model') } })
    );
    await fs.writeFile(path.join(repo, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'g', profiles: {} }));
    await fs.writeFile(path.join(sub, '.env'), 'CODEMIE_TIMEOUT=111\n');
    await fs.writeFile(path.join(repo, '.env'), 'CODEMIE_TIMEOUT=222\n');

    const env = await loadCopilotLaunchEnv(sub, {});

    expect(env.CODEMIE_MODEL).toBe('g-model');
    expect(env.CODEMIE_TIMEOUT).toBe('111');
  });
});
