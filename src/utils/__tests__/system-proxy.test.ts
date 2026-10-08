/**
 * System proxy resolution — Windows Internet Settings static and PAC paths.
 *
 * The registry read is stubbed so these run identically on every platform.
 * @group unit
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.fn();
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
] as const;

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

async function loadSystemProxyWith(
  values: Record<string, string>,
  options: {
    policy?: Record<string, string>;
    machine?: Record<string, string>;
  } = {}
): Promise<typeof import('../system-proxy.js')> {
  vi.resetModules();
  execMock.mockReset();
  execMock.mockImplementation((_command: string, args: string[]) => {
    const key = args[1] ?? '';
    const selected = key.includes('\\Policies\\')
      ? (options.policy ?? {})
      : key.startsWith('HKLM\\')
        ? (options.machine ?? {})
        : values;
    return Promise.resolve({ code: 0, stdout: registryOutput(selected), stderr: '' });
  });

  const mod = await import('../system-proxy.js');
  mod.resetSystemProxyCache();
  return mod;
}

async function resolveWith(
  values: Record<string, string>,
  target: string
): Promise<string | undefined> {
  const mod = await loadSystemProxyWith(values);
  return mod.resolveProxyForUrl(new URL(target));
}

async function startPacServer(source: string): Promise<{ pacUrl: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
    response.end(source);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new TypeError('PAC test server did not expose a TCP address');
  }

  return {
    pacUrl: `http://127.0.0.1:${address.port}/proxy.pac`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function startPacHandlerServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ pacUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('PAC server address unavailable');
  return {
    pacUrl: `http://127.0.0.1:${address.port}/proxy.pac`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  delete process.env.CODEMIE_INSECURE;
  delete process.env.CODEMIE_NO_SYSTEM_PROXY;
}

describe('Windows system proxy', () => {
  beforeEach(clearProxyEnv);
  afterEach(() => {
    clearProxyEnv();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      {
        ProxyEnable: '0x1',
        ProxyServer: 'proxy.corp.example:8080',
        ProxyOverride: '*.example.com',
      },
      'https://api.example.com/'
    );
    expect(proxy).toBe('http://explicit.example:3128');
  });

  it('supports lowercase proxy and bypass environment variables', async () => {
    process.env.https_proxy = 'http://lowercase.example:3128';
    process.env.no_proxy = 'direct.example';
    const mod = await loadSystemProxyWith({
      ProxyEnable: '0x1',
      ProxyServer: 'registry.example:8080',
    });

    await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
      .resolves.toBe('http://lowercase.example:3128');
    await expect(mod.resolveProxyForUrl(new URL('https://direct.example')))
      .resolves.toBeUndefined();
  });

  it('goes direct when the registry has neither ProxyServer nor AutoConfigURL', async () => {
    const proxy = await resolveWith({ ProxyEnable: '0x0' }, 'https://api.example.com/');
    expect(proxy).toBeUndefined();
  });

  it('resolves a proxy from a fetched PAC script', async () => {
    const pac = await startPacServer(
      'function FindProxyForURL(url, host) { return "PROXY pac-proxy.example:8080"; }'
    );

    try {
      const proxy = await resolveWith({ AutoConfigURL: pac.pacUrl }, 'https://api.example.com/v1');
      expect(proxy).toBe('http://pac-proxy.example:8080');
    } finally {
      await pac.close();
    }
  });

  it('keeps per-host PAC routing after building the SDK proxy environment', async () => {
    const pac = await startPacServer(
      'function FindProxyForURL(url) { return url.includes("direct.example") ? "DIRECT" : "PROXY pac-proxy.example:8080"; }'
    );

    try {
      const mod = await loadSystemProxyWith({ AutoConfigURL: pac.pacUrl });
      await mod.applySystemProxyEnvironment('https://proxied.example/v1');

      expect(process.env.HTTPS_PROXY).toBe('http://pac-proxy.example:8080');
      expect(await mod.resolveProxyForUrl(new URL('https://direct.example/v1'))).toBeUndefined();
    } finally {
      await pac.close();
    }
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

  it('honours DIRECT as the first PAC directive without static fallback', async () => {
    const pac = await startPacServer(
      'function FindProxyForURL() { return "DIRECT; PROXY ignored.example:8080"; }'
    );

    try {
      const mod = await loadSystemProxyWith({
        AutoConfigURL: pac.pacUrl,
        ProxyEnable: '0x1',
        ProxyServer: 'static.example:3128',
      });
      await expect(mod.resolveProxyForUrlDetailed(new URL('https://api.example.com')))
        .resolves.toEqual({ kind: 'direct', source: 'pac' });
    } finally {
      await pac.close();
    }
  });

  it('falls back direct after every preceding PAC proxy is unreachable', async () => {
    const pac = await startPacServer(
      'function FindProxyForURL() { return "PROXY 127.0.0.1:1; DIRECT"; }'
    );

    try {
      const mod = await loadSystemProxyWith({ AutoConfigURL: pac.pacUrl });
      await expect(mod.resolveProxyForUrlDetailed(new URL('https://api.example.com')))
        .resolves.toEqual({ kind: 'direct', source: 'pac' });
    } finally {
      await pac.close();
    }
  });

  it('probes PAC proxies in order before its DIRECT fallback', async () => {
    const reachableProxy = await startPacServer('');
    const reachablePort = new URL(reachableProxy.pacUrl).port;
    const pac = await startPacServer(
      `function FindProxyForURL() { return "PROXY 127.0.0.1:1; PROXY 127.0.0.1:${reachablePort}; DIRECT"; }`
    );

    try {
      const mod = await loadSystemProxyWith({ AutoConfigURL: pac.pacUrl });
      await expect(mod.resolveProxyForUrlDetailed(new URL('https://api.example.com')))
        .resolves.toEqual({
          kind: 'proxy',
          url: `http://127.0.0.1:${reachablePort}`,
          source: 'pac',
        });
    } finally {
      await pac.close();
      await reachableProxy.close();
    }
  });

  it('retains a proxy-only PAC route so the real request surfaces connection failure', async () => {
    const pac = await startPacServer(
      'function FindProxyForURL() { return "PROXY 127.0.0.1:1; PROXY 127.0.0.1:2"; }'
    );

    try {
      const mod = await loadSystemProxyWith({ AutoConfigURL: pac.pacUrl });
      await expect(mod.resolveProxyForUrlDetailed(new URL('https://api.example.com')))
        .resolves.toEqual({ kind: 'proxy', url: 'http://127.0.0.1:1', source: 'pac' });
    } finally {
      await pac.close();
    }
  });

  it('uses a static proxy only when PAC retrieval is unavailable', async () => {
    const pac = await startPacServer('');

    try {
      const mod = await loadSystemProxyWith({
        AutoConfigURL: `${pac.pacUrl}/missing`,
        ProxyEnable: '0x1',
        ProxyServer: 'static.example:3128',
      });
      await expect(mod.resolveProxyForUrlDetailed(new URL('https://api.example.com')))
        .resolves.toEqual({
          kind: 'proxy',
          url: 'http://static.example:3128',
          source: 'windows-static',
        });
    } finally {
      await pac.close();
    }
  });

  it('bounds PAC downloads to one MiB', async () => {
    const pac = await startPacHandlerServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
      response.end('x'.repeat(1024 * 1024 + 1));
    });

    try {
      const mod = await loadSystemProxyWith({
        AutoConfigURL: pac.pacUrl,
        ProxyEnable: '0x1',
        ProxyServer: 'static.example:3128',
      });
      await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
        .resolves.toBe('http://static.example:3128');
    } finally {
      await pac.close();
    }
  });

  it('bounds PAC retrieval to three seconds', async () => {
    const pac = await startPacHandlerServer(() => {
      // Intentionally leave the response pending until the client timeout closes it.
    });

    try {
      const mod = await loadSystemProxyWith({
        AutoConfigURL: pac.pacUrl,
        ProxyEnable: '0x1',
        ProxyServer: 'static.example:3128',
      });
      const startedAt = Date.now();
      await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
        .resolves.toBe('http://static.example:3128');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2900);
      expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
      await pac.close();
    }
  });

  it('retries a failed PAC after the short failure TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let available = false;
    let requests = 0;
    const pac = await startPacHandlerServer((_request, response) => {
      requests += 1;
      if (!available) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end('function FindProxyForURL() { return "PROXY recovered.example:8080"; }');
    });

    try {
      const mod = await loadSystemProxyWith({
        AutoConfigURL: pac.pacUrl,
        ProxyEnable: '0x1',
        ProxyServer: 'static.example:3128',
      });
      await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
        .resolves.toBe('http://static.example:3128');
      available = true;
      await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
        .resolves.toBe('http://static.example:3128');
      expect(requests).toBe(1);

      vi.advanceTimersByTime(5001);
      await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
        .resolves.toBe('http://recovered.example:8080');
      expect(requests).toBe(2);
    } finally {
      await pac.close();
    }
  });

  it('expires successful PAC scripts and per-origin decisions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let direct = true;
    let requests = 0;
    const pac = await startPacHandlerServer((_request, response) => {
      requests += 1;
      response.writeHead(200);
      response.end(direct
        ? 'function FindProxyForURL() { return "DIRECT"; }'
        : 'function FindProxyForURL() { return "PROXY refreshed.example:8080"; }');
    });

    try {
      const mod = await loadSystemProxyWith({ AutoConfigURL: pac.pacUrl });
      await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
        .resolves.toBeUndefined();
      direct = false;
      await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
        .resolves.toBeUndefined();
      expect(requests).toBe(1);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
        .resolves.toBe('http://refreshed.example:8080');
      expect(requests).toBe(2);
    } finally {
      await pac.close();
    }
  });

  it('supports trailing IPv4 wildcards and bracketed IPv6 loopback', async () => {
    const mod = await loadSystemProxyWith({
      ProxyEnable: '0x1',
      ProxyServer: 'proxy.example:8080',
      ProxyOverride: '10.*;192.168.*',
    });

    expect(await mod.resolveProxyForUrl(new URL('https://10.44.1.2'))).toBeUndefined();
    expect(await mod.resolveProxyForUrl(new URL('https://192.168.7.4'))).toBeUndefined();
    expect(await mod.resolveProxyForUrl(new URL('http://[::1]:4318'))).toBeUndefined();
    expect(await mod.resolveProxyForUrl(new URL('https://172.16.1.2')))
      .toBe('http://proxy.example:8080');
  });

  it('uses HKLM settings when ProxySettingsPerUser policy is disabled', async () => {
    const mod = await loadSystemProxyWith(
      { ProxyEnable: '0x1', ProxyServer: 'user.example:8080' },
      {
        policy: { ProxySettingsPerUser: '0x0' },
        machine: { ProxyEnable: '0x1', ProxyServer: 'machine.example:8080' },
      }
    );

    await expect(mod.resolveProxyForUrl(new URL('https://api.example.com')))
      .resolves.toBe('http://machine.example:8080');
    expect(execMock.mock.calls.every(([command]) =>
      String(command).toLowerCase().endsWith('\\system32\\reg.exe'))).toBe(true);
    expect(execMock.mock.calls.some(([, args]) => String(args[1]).startsWith('HKCU\\'))).toBe(false);
  });

  it('builds independent HTTP and HTTPS proxy variables and merges bypass forms', async () => {
    const mod = await loadSystemProxyWith({
      ProxyEnable: '0x1',
      ProxyServer: 'http=hproxy.example:8080;https=sproxy.example:8443',
      ProxyOverride: '10.*;*.internal.example;<local>',
    });
    const env = await mod.buildSystemProxyEnvironment('https://api.example.com', {
      NO_PROXY: 'upper.example',
      no_proxy: 'lower.example',
    });

    expect(env.HTTP_PROXY).toBe('http://hproxy.example:8080');
    expect(env.http_proxy).toBe('http://hproxy.example:8080');
    expect(env.HTTPS_PROXY).toBe('http://sproxy.example:8443');
    expect(env.https_proxy).toBe('http://sproxy.example:8443');
    expect(env.NO_PROXY).toBe(
      'upper.example,lower.example,10.0.0.0/8,.internal.example,localhost,127.0.0.1,::1'
    );
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('preserves conflicting user proxy spellings and fills only missing variants', async () => {
    const mod = await loadSystemProxyWith({
      ProxyEnable: '0x1',
      ProxyServer: 'registry.example:8080',
    });
    const env = await mod.buildSystemProxyEnvironment('https://api.example.com', {
      HTTP_PROXY: 'http://upper-http.example:8000',
      http_proxy: 'http://lower-http.example:8001',
      https_proxy: 'http://lower-https.example:8443',
    });

    expect(env.HTTP_PROXY).toBe('http://upper-http.example:8000');
    expect(env.http_proxy).toBe('http://lower-http.example:8001');
    expect(env.HTTPS_PROXY).toBe('http://lower-https.example:8443');
    expect(env.https_proxy).toBe('http://lower-https.example:8443');
  });

  it('rejects malformed or unsupported proxy URLs safely', async () => {
    process.env.HTTPS_PROXY = 'file://local-proxy';
    const mod = await loadSystemProxyWith({
      ProxyEnable: '0x1',
      ProxyServer: 'ftp://registry-proxy.example:21',
    });

    await expect(mod.resolveProxyForUrlDetailed(new URL('https://api.example.com')))
      .resolves.toEqual({ kind: 'direct', source: 'invalid-proxy' });
  });

  it('does not log PAC or proxy credentials', async () => {
    const pac = await startPacServer(
      'function FindProxyForURL() { return "PROXY user:proxy-secret@127.0.0.1:1; DIRECT"; }'
    );

    try {
      const pacWithCredentials = pac.pacUrl.replace('http://', 'http://pac-user:pac-secret@');
      const mod = await loadSystemProxyWith({ AutoConfigURL: pacWithCredentials });
      const { logger } = await import('../logger.js');
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      await mod.resolveProxyForUrlDetailed(new URL('https://api.example.com'));

      const output = JSON.stringify(debug.mock.calls);
      expect(output).not.toContain('proxy-secret');
      expect(output).not.toContain('pac-secret');
    } finally {
      await pac.close();
    }
  });
});
