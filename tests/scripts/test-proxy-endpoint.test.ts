import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { resolve } from 'node:path';

const execFile = promisify(execFileCallback);
const scriptPath = resolve(process.cwd(), 'scripts', 'test-proxy-endpoint.js');

describe('test-proxy-endpoint script', () => {
  let server: http.Server;
  let received: {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  } | null = null;
  let proxyUrl = '';

  beforeEach(async () => {
    received = null;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        received = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    proxyUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('posts a sample messages payload to /v1/messages', async () => {
    const result = await execFile(process.execPath, [scriptPath, '--url', proxyUrl], {
      encoding: 'utf8',
    });

    expect(result.stdout).toContain('/v1/messages');
    expect(result.stdout).toContain('200 OK');
    expect(received).not.toBeNull();
    expect(received?.method).toBe('POST');
    expect(received?.url).toBe('/v1/messages');
    expect(received?.headers['content-type']).toContain('application/json');

    const body = JSON.parse(received?.body ?? '{}');
    expect(body).toMatchObject({
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: 'Test proxy endpoint',
        },
      ],
    });
  });
});
