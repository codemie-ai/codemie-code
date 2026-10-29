import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { AuthRequiredServer } from '../auth-required-server.js';
import { startDetachedSsoLogin } from '@/providers/plugins/sso/sso.detached-login.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/providers/plugins/sso/sso.detached-login.js', () => ({
  startDetachedSsoLogin: vi.fn().mockResolvedValue('started'),
  describeLogin: (o?: string) => `login:${o ?? 'failed'}`,
}));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

describe('AuthRequiredServer', () => {
  let server: AuthRequiredServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    vi.mocked(startDetachedSsoLogin).mockClear();
  });

  it('keeps the port bound and answers an Anthropic-shaped 401 with the sign-in instructions', async () => {
    const port = await freePort();
    server = new AuthRequiredServer({ host: '127.0.0.1', port, loginUrl: 'https://example.test/api' });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{"model":"x"}' });
    const body = await res.json() as { type: string; error: { type: string; message: string } };

    expect(res.status).toBe(401);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('CodeMie SSO session expired.');
    expect(body.error.message).toContain('login:started');
    expect(startDetachedSsoLogin).toHaveBeenCalledWith('https://example.test/api');
  });

  it('answers /health with 200 without starting a sign-in', async () => {
    const port = await freePort();
    server = new AuthRequiredServer({ host: '127.0.0.1', port, loginUrl: 'https://example.test/api' });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/health`);

    expect(res.status).toBe(200);
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('releases the port on stop()', async () => {
    const port = await freePort();
    server = new AuthRequiredServer({ host: '127.0.0.1', port, loginUrl: 'https://example.test/api' });
    await server.start();
    await server.stop();
    server = undefined;

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
