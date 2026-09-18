/**
 * System proxy resolution — static (non-PAC) Windows Internet Settings path.
 *
 * The registry read is stubbed so these run identically on every platform.
 * @group unit
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.fn();

vi.mock('../exec.js', () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => 'win32', homedir: () => '/nonexistent-home' };
});

function registryOutput(values: Record<string, string>): string {
  const lines = ['', 'HKEY_CURRENT_USER\\Software\\...\\Internet Settings', ''];
  for (const [name, raw] of Object.entries(values)) {
    const type = raw.startsWith('0x') ? 'REG_DWORD' : 'REG_SZ';
    lines.push(`    ${name}    ${type}    ${raw}`);
  }
  return lines.join('\r\n');
}

async function resolveWith(
  values: Record<string, string>,
  target: string
): Promise<string | undefined> {
  vi.resetModules();
  execMock.mockReset();
  execMock.mockResolvedValue({ code: 0, stdout: registryOutput(values), stderr: '' });

  const mod = await import('../system-proxy.js');
  mod.resetSystemProxyCache();
  return mod.resolveProxyForUrl(new URL(target));
}

describe('static Windows proxy (no PAC)', () => {
  beforeEach(() => {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      delete process.env[k];
    }
  });

  it('uses a bare host:port ProxyServer for https', async () => {
    const proxy = await resolveWith(
      { ProxyEnable: '0x1', ProxyServer: 'proxy.corp.example:8080' },
      'https://api.example.com/v1'
    );
    expect(proxy).toBe('http://proxy.corp.example:8080');
  });

  it('uses a bare host:port ProxyServer for plain http too', async () => {
    const proxy = await resolveWith(
      { ProxyEnable: '0x1', ProxyServer: 'proxy.corp.example:8080' },
      'http://api.example.com/v1'
    );
    expect(proxy).toBe('http://proxy.corp.example:8080');
  });

  it('honours ProxyEnable=0 and goes direct', async () => {
    const proxy = await resolveWith(
      { ProxyEnable: '0x0', ProxyServer: 'proxy.corp.example:8080' },
      'https://api.example.com/v1'
    );
    expect(proxy).toBeUndefined();
  });

  it('picks the per-protocol entry from an http=..;https=.. list', async () => {
    const values = {
      ProxyEnable: '0x1',
      ProxyServer: 'http=hproxy.example:80;https=sproxy.example:443;ftp=f.example:21',
    };
    expect(await resolveWith(values, 'https://api.example.com/')).toBe('http://sproxy.example:443');
    expect(await resolveWith(values, 'http://api.example.com/')).toBe('http://hproxy.example:80');
  });

  it('falls back to the http entry when no https entry exists', async () => {
    const proxy = await resolveWith(
      { ProxyEnable: '0x1', ProxyServer: 'http=hproxy.example:80' },
      'https://api.example.com/'
    );
    expect(proxy).toBe('http://hproxy.example:80');
  });

  it('bypasses hosts matching a *.domain ProxyOverride entry', async () => {
    const values = {
      ProxyEnable: '0x1',
      ProxyServer: 'proxy.corp.example:8080',
      ProxyOverride: '*.internal.example;<local>',
    };
    expect(await resolveWith(values, 'https://svc.internal.example/')).toBeUndefined();
    expect(await resolveWith(values, 'https://internal.example/')).toBeUndefined();
    expect(await resolveWith(values, 'https://elsewhere.example/')).toBe('http://proxy.corp.example:8080');
  });

  it('bypasses dotless hostnames via the <local> token', async () => {
    const proxy = await resolveWith(
      { ProxyEnable: '0x1', ProxyServer: 'proxy.corp.example:8080', ProxyOverride: '<local>' },
      'https://intranet/'
    );
    expect(proxy).toBeUndefined();
  });

  it('never proxies loopback', async () => {
    const values = { ProxyEnable: '0x1', ProxyServer: 'proxy.corp.example:8080' };
    expect(await resolveWith(values, 'http://127.0.0.1:4000/v1/models')).toBeUndefined();
    expect(await resolveWith(values, 'http://localhost:4000/')).toBeUndefined();
  });

  it('lets an explicit HTTPS_PROXY env var override the registry', async () => {
    process.env.HTTPS_PROXY = 'http://explicit.example:3128';
    const proxy = await resolveWith(
      { ProxyEnable: '0x1', ProxyServer: 'proxy.corp.example:8080' },
      'https://api.example.com/'
    );
    expect(proxy).toBe('http://explicit.example:3128');
  });

  it('goes direct when the registry has neither ProxyServer nor AutoConfigURL', async () => {
    const proxy = await resolveWith({ ProxyEnable: '0x0' }, 'https://api.example.com/');
    expect(proxy).toBeUndefined();
  });

  it('does not spawn reg query when system detection is disabled', async () => {
    process.env.CODEMIE_NO_SYSTEM_PROXY = '1';
    try {
      const proxy = await resolveWith(
        { ProxyEnable: '0x1', ProxyServer: 'proxy.corp.example:8080' },
        'https://api.example.com/'
      );
      expect(proxy).toBeUndefined();
      expect(execMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.CODEMIE_NO_SYSTEM_PROXY;
    }
  });
});
