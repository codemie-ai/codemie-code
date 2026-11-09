/**
 * awaiting-login-listener unit tests
 * @group unit
 */
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startAwaitingLoginListener, type AwaitingLoginListener } from '../awaiting-login-listener.js';

const MESSAGE = 'SSO credentials not found for https://x.example.com. Please run: codemie profile login --url https://x.example.com';

describe('awaiting-login listener', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn()));
  });

  async function start(opts: Partial<Parameters<typeof startAwaitingLoginListener>[0]> = {}): Promise<AwaitingLoginListener> {
    const listener = await startAwaitingLoginListener({ host: '127.0.0.1', message: MESSAGE, ...opts });
    cleanup.push(() => listener.stop());
    return listener;
  }

  it('answers an Anthropic-shaped 401 with the sign-in message for any API request', async () => {
    const { url } = await start();

    const res = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' });

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: MESSAGE },
    });
  });

  it('keeps /health alive like the real proxy so the watcher sees a live socket', async () => {
    const { url, port } = await start();

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ok',
      port,
      pid: process.pid,
      analytics: { credentials: 'stale' },
    });
    // ...while the authenticated deep probe is rejected, which the watcher reads as "unauthorized".
    expect((await fetch(`${url}/v1/llm_models?include_all=true`)).status).toBe(401);
  });

  it('binds the requested port and frees it on stop', async () => {
    const probe = await start();
    const { port } = probe;
    await probe.stop();

    const listener = await start({ port, pinnedPort: true });
    expect(listener.port).toBe(port);
    await listener.stop();

    const reuse = createServer();
    await new Promise<void>((resolve) => reuse.listen(port, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => reuse.close(() => resolve()));
  });

  it('falls back to another port on the initial bind but never when pinned', async () => {
    const holder = await start();

    const fallback = await start({ port: holder.port });
    expect(fallback.port).not.toBe(holder.port);

    await expect(start({ port: holder.port, pinnedPort: true })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  }, 10000);
});
