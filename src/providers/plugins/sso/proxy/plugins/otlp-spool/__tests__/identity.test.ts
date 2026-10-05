import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import type { JWTCredentials } from '@/providers/core/types.js';

/** Builds a minimal unsigned JWT with the given payload claims. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('resolveIdentity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves from the jwt tier when the token carries a valid email claim', async () => {
    const { resolveIdentity } = await import('../identity.js');

    const credentials: JWTCredentials = {
      token: makeJwt({ email: 'dev@example.com' }),
      apiUrl: 'https://codemie.example.com',
    };

    const result = await resolveIdentity(credentials, 'C:/some/project');

    expect(result).toEqual({ developerName: 'dev@example.com', identitySource: 'jwt' });
  });

  it('falls through to git config user.email when the jwt tier is empty', async () => {
    const execModule = await import('@/utils/exec.js');
    const execSpy = vi.spyOn(execModule, 'exec').mockImplementation(async (_command, args) => {
      if (args?.[0] === 'config' && args?.[1] === 'user.email') {
        return { code: 0, stdout: 'git-user@example.com', stderr: '', signal: null };
      }
      return { code: 1, stdout: '', stderr: '', signal: null };
    });

    const { resolveIdentity } = await import('../identity.js');

    // Empty token: isJWTCredentials() still matches the shape, but decodeJwtClaims
    // yields no usable email, so the jwt tier is a miss.
    const credentials: JWTCredentials = { token: '', apiUrl: '' };

    const result = await resolveIdentity(credentials, 'C:/some/project');

    expect(result).toEqual({ developerName: 'git-user@example.com', identitySource: 'git' });
    expect(execSpy).toHaveBeenCalledWith('git', ['config', 'user.email'], { cwd: 'C:/some/project' });
  });

  it('falls through to os.userInfo().username when every other tier is empty', async () => {
    const execModule = await import('@/utils/exec.js');
    vi.spyOn(execModule, 'exec').mockResolvedValue({ code: 1, stdout: '', stderr: '', signal: null });

    const configModule = await import('@/utils/config.js');
    vi.spyOn(configModule.ConfigLoader, 'loadMultiProviderConfig').mockResolvedValue({
      version: 2,
      activeProfile: 'default',
      profiles: {},
    });

    const { resolveIdentity } = await import('../identity.js');

    const credentials: JWTCredentials = { token: '', apiUrl: '' };

    const result = await resolveIdentity(credentials, 'C:/some/project');

    expect(result.identitySource).toBe('os');
    expect(result.developerName).toBe(os.userInfo().username);
    expect(result.developerName.length).toBeGreaterThan(0);
  });
});
