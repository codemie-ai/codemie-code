/**
 * JWT Bearer Authorization provider — unit tests.
 *
 * Pins current behavior of the four JWT plugin modules:
 *   - jwt.utils.ts       (token / env-var resolution)
 *   - jwt.models.ts      (JWTModelProxy.supports / fetchModels)
 *   - jwt.template.ts    (JWTTemplate.exportEnvVars — Bearer token wiring)
 *   - jwt.setup-steps.ts (interactive getCredentials, fetchModels, buildConfig, validateAuth)
 *
 * All external systems are mocked: the CodeMie models HTTP call (fetchCodeMieModels)
 * and the interactive inquirer prompts. No network, no real prompts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CodeMieConfigOptions } from '@/env/types.js';

// --- Mock the CodeMie models HTTP client (spread actual, replace one export) ---
const fetchCodeMieModelsMock = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
vi.mock('@/providers/plugins/sso/sso.http-client.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/providers/plugins/sso/sso.http-client.js')>();
  return { ...actual, fetchCodeMieModels: fetchCodeMieModelsMock };
});

// --- Mock inquirer so setup steps never open a real prompt ---
const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

import { JWTModelProxy } from '../jwt.models.js';
import { JWTTemplate } from '../jwt.template.js';
import { JWTBearerSetupSteps } from '../jwt.setup-steps.js';
import {
  resolveJwtToken,
  resolveJwtTokenEnvVar,
  JWT_TOKEN_DEFAULT_ENV_VAR,
} from '../jwt.utils.js';

/** Build a fake 3-part JWT whose payload is a base64-encoded JSON object. */
function makeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `header.${body}.signature`;
}

/** Minimal config helper. */
function cfg(overrides: Partial<CodeMieConfigOptions> = {}): CodeMieConfigOptions {
  return overrides as CodeMieConfigOptions;
}

// Snapshot + restore any env var we touch.
const ENV_KEYS = ['CODEMIE_JWT_TOKEN', 'MY_CUSTOM_TOKEN', 'CUSTOM_JWT'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fetchCodeMieModelsMock.mockReset();
  promptMock.mockReset();
  // Keep the console quiet — setup steps log a lot of chalk output.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// jwt.utils.ts
// ---------------------------------------------------------------------------
describe('jwt.utils — resolveJwtTokenEnvVar', () => {
  it('defaults to CODEMIE_JWT_TOKEN', () => {
    expect(JWT_TOKEN_DEFAULT_ENV_VAR).toBe('CODEMIE_JWT_TOKEN');
    expect(resolveJwtTokenEnvVar(cfg())).toBe('CODEMIE_JWT_TOKEN');
  });

  it('honours a custom env-var name from jwtConfig', () => {
    expect(resolveJwtTokenEnvVar(cfg({ jwtConfig: { tokenEnvVar: 'CUSTOM_JWT' } }))).toBe(
      'CUSTOM_JWT'
    );
  });
});

describe('jwt.utils — resolveJwtToken', () => {
  it('reads the token from the (trimmed) default env var', () => {
    process.env.CODEMIE_JWT_TOKEN = '  abc.def.ghi  ';
    expect(resolveJwtToken(cfg())).toBe('abc.def.ghi');
  });

  it('reads from a custom env var when configured', () => {
    process.env.CUSTOM_JWT = 'tok-123';
    expect(resolveJwtToken(cfg({ jwtConfig: { tokenEnvVar: 'CUSTOM_JWT' } }))).toBe('tok-123');
  });

  it('falls back to the inline config token when the env var is empty/whitespace', () => {
    process.env.CODEMIE_JWT_TOKEN = '   ';
    expect(resolveJwtToken(cfg({ jwtConfig: { token: 'inline-token' } }))).toBe('inline-token');
  });

  it('falls back to the inline config token when the env var is unset', () => {
    expect(resolveJwtToken(cfg({ jwtConfig: { token: 'inline-token' } }))).toBe('inline-token');
  });

  it('prefers the env var over the inline config token', () => {
    process.env.CODEMIE_JWT_TOKEN = 'env-token';
    expect(resolveJwtToken(cfg({ jwtConfig: { token: 'inline-token' } }))).toBe('env-token');
  });

  it('returns undefined when neither env var nor inline token is present', () => {
    expect(resolveJwtToken(cfg())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// jwt.models.ts — JWTModelProxy
// ---------------------------------------------------------------------------
describe('JWTModelProxy.supports', () => {
  it('supports only the bearer-auth provider', () => {
    const proxy = new JWTModelProxy();
    expect(proxy.supports('bearer-auth')).toBe(true);
    expect(proxy.supports('ai-run-sso')).toBe(false);
    expect(proxy.supports('litellm')).toBe(false);
    expect(proxy.supports('')).toBe(false);
  });
});

describe('JWTModelProxy.fetchModels', () => {
  const proxy = new JWTModelProxy();

  it('maps fetched model ids into {id, name} pairs', async () => {
    process.env.CODEMIE_JWT_TOKEN = 'the-token';
    fetchCodeMieModelsMock.mockResolvedValue(['gpt-4o', 'claude-sonnet-4-6']);

    const result = await proxy.fetchModels(cfg({ baseUrl: 'https://api.example.com' }));

    expect(result).toEqual([
      { id: 'gpt-4o', name: 'gpt-4o' },
      { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6' },
    ]);
    // Passes the resolved base URL + token straight through to the HTTP client.
    expect(fetchCodeMieModelsMock).toHaveBeenCalledWith('https://api.example.com', 'the-token');
  });

  it('returns an empty list when the API returns no models', async () => {
    process.env.CODEMIE_JWT_TOKEN = 'the-token';
    fetchCodeMieModelsMock.mockResolvedValue([]);
    const result = await proxy.fetchModels(cfg({ baseUrl: 'https://api.example.com' }));
    expect(result).toEqual([]);
  });

  it('throws (naming the env var) when no token is available', async () => {
    await expect(proxy.fetchModels(cfg({ baseUrl: 'https://api.example.com' }))).rejects.toThrow(
      /JWT token not found\. Set CODEMIE_JWT_TOKEN or pass --jwt-token/
    );
    expect(fetchCodeMieModelsMock).not.toHaveBeenCalled();
  });

  it('names the custom env var in the missing-token error', async () => {
    await expect(
      proxy.fetchModels(cfg({ baseUrl: 'https://api.example.com', jwtConfig: { tokenEnvVar: 'CUSTOM_JWT' } }))
    ).rejects.toThrow(/Set CUSTOM_JWT or pass --jwt-token/);
  });

  it('throws when no baseUrl is configured', async () => {
    process.env.CODEMIE_JWT_TOKEN = 'the-token';
    await expect(proxy.fetchModels(cfg())).rejects.toThrow(
      'No baseUrl configured for bearer-auth provider.'
    );
    expect(fetchCodeMieModelsMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// jwt.template.ts — exportEnvVars
// ---------------------------------------------------------------------------
describe('JWTTemplate metadata', () => {
  it('describes the bearer-auth provider with JWT auth', () => {
    expect(JWTTemplate.name).toBe('bearer-auth');
    expect(JWTTemplate.authType).toBe('jwt');
    expect(JWTTemplate.hidden).toBe(true);
    expect(JWTTemplate.requiresAuth).toBe(true);
    expect(JWTTemplate.defaultProfileName).toBe('jwt-bearer');
  });
});

describe('JWTTemplate.exportEnvVars', () => {
  it('always sets the JWT auth method', () => {
    const env = JWTTemplate.exportEnvVars!(cfg());
    expect(env.CODEMIE_AUTH_METHOD).toBe('jwt');
  });

  it('exports URL, token and project when present', () => {
    process.env.CODEMIE_JWT_TOKEN = 'env-jwt';
    const env = JWTTemplate.exportEnvVars!(
      cfg({ codeMieUrl: 'https://codemie.example.com', codeMieProject: 'my-project' })
    );
    expect(env).toEqual({
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_AUTH_METHOD: 'jwt',
      CODEMIE_JWT_TOKEN: 'env-jwt',
      CODEMIE_PROJECT: 'my-project',
    });
  });

  it('exports the inline config token when no env var is set', () => {
    const env = JWTTemplate.exportEnvVars!(cfg({ jwtConfig: { token: 'inline-jwt' } }));
    expect(env.CODEMIE_JWT_TOKEN).toBe('inline-jwt');
  });

  it('omits token/url/project keys when nothing is available', () => {
    const env = JWTTemplate.exportEnvVars!(cfg());
    expect(env).toEqual({ CODEMIE_AUTH_METHOD: 'jwt' });
    expect(env).not.toHaveProperty('CODEMIE_JWT_TOKEN');
    expect(env).not.toHaveProperty('CODEMIE_URL');
    expect(env).not.toHaveProperty('CODEMIE_PROJECT');
  });
});

// ---------------------------------------------------------------------------
// jwt.setup-steps.ts
// ---------------------------------------------------------------------------
describe('JWTBearerSetupSteps.getCredentials', () => {
  it('gathers the base URL and defaults to the standard token env var', async () => {
    promptMock
      .mockResolvedValueOnce({ baseUrl: 'https://my.codemie.com' })
      .mockResolvedValueOnce({ customEnvVar: false });

    const creds = await JWTBearerSetupSteps.getCredentials();

    // baseUrl gets the /code-assistant-api suffix; codeMieUrl keeps the user's input.
    expect(creds.baseUrl).toBe('https://my.codemie.com/code-assistant-api');
    expect(creds.additionalConfig).toMatchObject({
      codeMieUrl: 'https://my.codemie.com',
      authMethod: 'jwt',
      jwtConfig: { tokenEnvVar: 'CODEMIE_JWT_TOKEN' },
    });
  });

  it('captures a custom token env-var name when requested', async () => {
    promptMock
      .mockResolvedValueOnce({ baseUrl: 'https://x.com/' })
      .mockResolvedValueOnce({ customEnvVar: true })
      .mockResolvedValueOnce({ envVar: 'MY_CUSTOM_TOKEN' });

    const creds = await JWTBearerSetupSteps.getCredentials();

    const jwtConfig = creds.additionalConfig?.jwtConfig as { tokenEnvVar?: string };
    expect(jwtConfig.tokenEnvVar).toBe('MY_CUSTOM_TOKEN');
    // Trailing slash is stripped when the suffix is appended.
    expect(creds.baseUrl).toBe('https://x.com/code-assistant-api');
    expect(promptMock).toHaveBeenCalledTimes(3);
  });
});

describe('JWTBearerSetupSteps.fetchModels', () => {
  it('returns the static fallback model list without any network call', async () => {
    const models = await JWTBearerSetupSteps.fetchModels({});
    expect(models).toContain('claude-sonnet-4-6');
    expect(models).toContain('gpt-4o');
    expect(models.length).toBe(6);
    expect(fetchCodeMieModelsMock).not.toHaveBeenCalled();
  });
});

describe('JWTBearerSetupSteps.buildConfig', () => {
  it('assembles a bearer-auth config from credentials + selected model', () => {
    const config = JWTBearerSetupSteps.buildConfig(
      {
        baseUrl: 'https://x.com/code-assistant-api',
        additionalConfig: {
          codeMieUrl: 'https://x.com',
          jwtConfig: { tokenEnvVar: 'CUSTOM_JWT' },
        },
      },
      'gpt-4o'
    );

    expect(config).toEqual({
      provider: 'bearer-auth',
      codeMieUrl: 'https://x.com',
      baseUrl: 'https://x.com/code-assistant-api',
      model: 'gpt-4o',
      authMethod: 'jwt',
      jwtConfig: { tokenEnvVar: 'CUSTOM_JWT' },
    });
  });

  it('leaves jwtConfig undefined when additionalConfig has none', () => {
    const config = JWTBearerSetupSteps.buildConfig(
      { baseUrl: 'https://x.com/code-assistant-api' },
      'gpt-4o'
    );
    expect(config.jwtConfig).toBeUndefined();
    expect(config.codeMieUrl).toBeUndefined();
    expect(config.provider).toBe('bearer-auth');
  });
});

describe('JWTBearerSetupSteps.validateAuth', () => {
  it('fails (naming the env var) when the token is missing', async () => {
    const result = await JWTBearerSetupSteps.validateAuth!(cfg());
    expect(result.valid).toBe(false);
    expect(result.error).toContain('CODEMIE_JWT_TOKEN');
  });

  it('fails when the token is not a 3-part JWT', async () => {
    process.env.CODEMIE_JWT_TOKEN = 'not-a-jwt';
    const result = await JWTBearerSetupSteps.validateAuth!(cfg());
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Invalid JWT token format/);
  });

  it('accepts a well-formed token with a future expiry', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    process.env.CODEMIE_JWT_TOKEN = makeJwt({ sub: 'user', exp });
    const result = await JWTBearerSetupSteps.validateAuth!(cfg());
    expect(result).toEqual({ valid: true });
  });

  it('rejects an expired token and reports expiresAt', async () => {
    const exp = Math.floor(Date.now() / 1000) - 3600;
    process.env.CODEMIE_JWT_TOKEN = makeJwt({ sub: 'user', exp });
    const result = await JWTBearerSetupSteps.validateAuth!(cfg());
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/expired/i);
    expect(result.expiresAt).toBe(exp * 1000);
  });

  it('accepts a well-formed token that carries no exp claim', async () => {
    process.env.CODEMIE_JWT_TOKEN = makeJwt({ sub: 'user' });
    const result = await JWTBearerSetupSteps.validateAuth!(cfg());
    expect(result).toEqual({ valid: true });
  });

  it('treats a non-JSON payload as valid (skips the expiry check)', async () => {
    // 3 parts, but the middle segment does not decode to JSON — the catch swallows it.
    process.env.CODEMIE_JWT_TOKEN = 'header.@@@notjson@@@.signature';
    const result = await JWTBearerSetupSteps.validateAuth!(cfg());
    expect(result).toEqual({ valid: true });
  });
});
