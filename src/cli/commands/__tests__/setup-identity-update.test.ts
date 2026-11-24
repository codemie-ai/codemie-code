/**
 * PR #758 review, finding 3: re-running setup on a profile keeps its stored identity when a
 * step did not complete. Driven through each provider's real setup step and buildConfig, then
 * globalProfileFromSetup and ConfigLoader.saveProfile (the setup save path).
 * Mocked: the integrations HTTP call, the logger and console output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { MultiProviderConfig, ProviderProfile } from '@/env/types.js';

const fetchCodeMieIntegrations = vi.fn();
vi.mock('@/providers/plugins/sso/sso.http-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/plugins/sso/sso.http-client.js')>()),
  fetchCodeMieIntegrations: (...args: unknown[]) => fetchCodeMieIntegrations(...args),
}));

const { ConfigLoader } = await import('@/utils/config.js');
const paths = await import('@/utils/paths.js');
const { logger } = await import('@/utils/logger.js');
const { globalProfileFromSetup } = await import('../setup.js');
const { JWTBearerSetupSteps, selectJwtProfileProject } = await import('@/providers/plugins/jwt/jwt.setup-steps.js');
const { SSOSetupSteps, selectIntegrationForProject } = await import('@/providers/plugins/sso/sso.setup-steps.js');

const TEST_DIR = path.join(process.cwd(), 'tmp-test-setup-identity-update');
const HOME = path.join(TEST_DIR, '.codemie');
const GLOBAL = path.join(HOME, 'codemie-cli.config.json');
const WORKING_DIR = path.join(TEST_DIR, 'work');

const MINE = { codeMieProject: 'mine', codeMieIntegration: { id: 'int-mine', alias: 'mine' } };

async function seed(): Promise<void> {
  const config: MultiProviderConfig = {
    version: 2,
    activeProfile: 'jwt',
    workspace: { codeMieUrl: 'https://shared.example.com', codeMieProject: 'someone-elses' },
    profiles: {
      jwt: {
        provider: 'bearer-auth', authMethod: 'jwt', model: 'm',
        baseUrl: 'https://jwt.example.com/code-assistant-api', codeMieUrl: 'https://jwt.example.com', ...MINE,
      } as ProviderProfile,
      sso: {
        provider: 'ai-run-sso', model: 'm',
        baseUrl: 'https://sso.example.com/code-assistant-api', codeMieUrl: 'https://sso.example.com', ...MINE,
      },
    },
  };
  await fs.writeFile(GLOBAL, JSON.stringify(config));
}

const read = async (): Promise<MultiProviderConfig> => JSON.parse(await fs.readFile(GLOBAL, 'utf-8'));

async function saveFromSetup(name: string, provider: string, config: Partial<ProviderProfile>): Promise<void> {
  await ConfigLoader.saveProfile(name, globalProfileFromSetup(provider, config));
}

function jwtSetupResult(url: string, project: string | undefined): Partial<ProviderProfile> {
  return JWTBearerSetupSteps.buildConfig({
    baseUrl: `${url}/code-assistant-api`,
    additionalConfig: { codeMieUrl: url, codeMieProject: project, authMethod: 'jwt', jwtConfig: { tokenEnvVar: 'CODEMIE_JWT_TOKEN' } },
  }, 'm2') as Partial<ProviderProfile>;
}

async function ssoSetupResult(url: string, project: string): Promise<Partial<ProviderProfile>> {
  const integration = await selectIntegrationForProject(`${url}/code-assistant-api`, { s: '1' }, project);
  return SSOSetupSteps.buildConfig({
    baseUrl: `${url}/code-assistant-api`,
    additionalConfig: { codeMieUrl: url, codeMieProject: project, codeMieIntegration: integration },
  }, 'm2') as Partial<ProviderProfile>;
}

describe('setup update keeps stored identity when a step did not complete', () => {
  beforeEach(async () => {
    await fs.mkdir(HOME, { recursive: true });
    await fs.mkdir(WORKING_DIR, { recursive: true });
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(HOME);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((p: string) => path.join(HOME, p));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchCodeMieIntegrations.mockReset();
    await seed();
  });

  afterEach(async () => {
    await logger.close();
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('JWT, project step skipped: project and integration stay, state stays own', async () => {
    const project = await selectJwtProfileProject('https://jwt.example.com/code-assistant-api', 'CODEMIE_JWT_TOKEN', {
      env: {},
      prompt: (async () => ({ source: 'skip' })) as never,
    });
    expect(project).toBeUndefined();

    await saveFromSetup('jwt', 'bearer-auth', jwtSetupResult('https://jwt.example.com', project));

    const stored = (await read()).profiles.jwt;
    expect(stored).toMatchObject({ model: 'm2', ...MINE, codeMieUrl: 'https://jwt.example.com' });
    const resolved = await ConfigLoader.resolveProfileIdentity(WORKING_DIR, 'jwt');
    expect(resolved).toMatchObject({ state: 'own', identity: { codeMieProject: 'mine' } });
  });

  it('JWT, project list fails: same result', async () => {
    const project = await selectJwtProfileProject('https://jwt.example.com/code-assistant-api', 'CODEMIE_JWT_TOKEN', {
      env: { CODEMIE_JWT_TOKEN: 'h.p.s' },
      prompt: (async () => ({ useEnv: true })) as never,
      select: async () => { throw new Error('HTTP 503'); },
    });
    expect(project).toBeUndefined();

    await saveFromSetup('jwt', 'bearer-auth', jwtSetupResult('https://jwt.example.com', project));

    expect((await read()).profiles.jwt).toMatchObject(MINE);
    expect((await ConfigLoader.resolveProfileIdentity(WORKING_DIR, 'jwt')).state).toBe('own');
  });

  it('SSO, integrations fetch fails: the stored integration stays', async () => {
    fetchCodeMieIntegrations.mockRejectedValue(new Error('HTTP 500'));

    await saveFromSetup('sso', 'ai-run-sso', await ssoSetupResult('https://sso.example.com', 'mine'));

    expect((await read()).profiles.sso).toMatchObject({ model: 'm2', ...MINE });
  });

  it('SSO, a different project with no integration: the old integration is dropped', async () => {
    fetchCodeMieIntegrations.mockRejectedValue(new Error('HTTP 500'));

    await saveFromSetup('sso', 'ai-run-sso', await ssoSetupResult('https://sso.example.com', 'other'));

    const stored = (await read()).profiles.sso;
    expect(stored.codeMieProject).toBe('other');
    expect(stored.codeMieIntegration).toBeUndefined();
  });

  it('a move to another CodeMie host with no project carries nothing over', async () => {
    await saveFromSetup('jwt', 'bearer-auth', jwtSetupResult('https://elsewhere.example.com', undefined));

    const stored = (await read()).profiles.jwt;
    expect(stored.codeMieUrl).toBe('https://elsewhere.example.com');
    expect(stored.codeMieProject).toBeUndefined();
    expect(stored.codeMieIntegration).toBeUndefined();
    expect((await ConfigLoader.resolveProfileIdentity(WORKING_DIR, 'jwt')).state).toBe('unowned');
  });
});
