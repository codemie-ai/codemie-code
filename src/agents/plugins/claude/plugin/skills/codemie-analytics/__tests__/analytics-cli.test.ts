import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, hostname, platform, arch } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../scripts/analytics-cli.js');
const API_URL = 'http://127.0.0.1:1';

function encrypt(plain: string): string {
  const machineId = hostname() + platform() + arch();
  const hex = createHash('sha256').update(machineId).digest('hex');
  const key = createHash('sha256').update(hex).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = cipher.update(plain, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc}`;
}

describe('analytics-cli resolveAuth expiry', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'analytics-cwd-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function run(cookies: Record<string, string>): string {
    const key = `sso-${createHash('sha256').update(API_URL).digest('hex')}`;
    mkdirSync(join(home, 'credentials'), { recursive: true });
    writeFileSync(
      join(home, 'credentials', `${key}.enc`),
      encrypt(JSON.stringify({ cookies, apiUrl: API_URL, expiresAt: Date.now() - 60_000 }))
    );
    const env = { ...process.env, CODEMIE_HOME: home, CODEMIE_URL: API_URL };
    delete env.CODEMIE_API_KEY;
    const res = spawnSync('node', [SCRIPT, 'summaries'], { env, cwd, encoding: 'utf8', timeout: 20000 });
    return `${res.stdout}${res.stderr}`;
  }

  it('ignores past expiresAt for cookie-only credentials', () => {
    expect(run({ _oauth2_proxy: 'x' })).not.toContain('SSO credentials expired');
  });

  it('reports expiry when codemie_access_token cookie is present', () => {
    const out = run({ codemie_access_token: 'x' });
    expect(out).toContain('SSO credentials expired');
    expect(out).toContain('No CodeMie credentials found');
  });
});
