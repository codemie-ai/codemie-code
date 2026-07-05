/**
 * trust.ts tests — pure command builders + injected-exec action runner.
 * No real trust store is ever touched.
 * @group unit
 */
import { describe, it, expect, vi } from 'vitest';
import { applyTrust, buildTrustCommands, getManualTrustInstructions } from '../trust.js';

const CA_PATH = '/home/u/.codemie/mcp-auth-proxy-tls/ca.crt';
const CN = 'CodeMie mcp-auth-proxy CA u@host 2026-07-05';

describe('buildTrustCommands', () => {
  it('win32 install/uninstall target the user Root store', () => {
    expect(buildTrustCommands('win32', CA_PATH, CN, 'install')).toEqual([
      { command: 'certutil', args: ['-addstore', '-user', 'Root', CA_PATH] },
    ]);
    expect(buildTrustCommands('win32', CA_PATH, CN, 'uninstall')).toEqual([
      { command: 'certutil', args: ['-delstore', '-user', 'Root', CN] },
    ]);
  });

  it('darwin install/uninstall use the login keychain', () => {
    const install = buildTrustCommands('darwin', CA_PATH, CN, 'install');
    expect(install?.[0]?.command).toBe('security');
    expect(install?.[0]?.args).toContain('add-trusted-cert');
    expect(install?.[0]?.args).toContain(CA_PATH);

    const uninstall = buildTrustCommands('darwin', CA_PATH, CN, 'uninstall');
    expect(uninstall?.[0]?.args).toContain('delete-certificate');
    expect(uninstall?.[0]?.args).toContain(CN);
  });

  it('linux targets the NSS user DB (what Chromium/Electron read)', () => {
    const install = buildTrustCommands('linux', CA_PATH, CN, 'install');
    expect(install?.[0]?.command).toBe('certutil');
    expect(install?.[0]?.args.join(' ')).toContain('.pki/nssdb');
    expect(install?.[0]?.args).toContain(CN);

    const uninstall = buildTrustCommands('linux', CA_PATH, CN, 'uninstall');
    expect(uninstall?.[0]?.args).toContain('-D');
    expect(uninstall?.[0]?.args).toContain(CN);
  });

  it('returns null for unsupported platforms', () => {
    expect(buildTrustCommands('freebsd', CA_PATH, CN, 'install')).toBeNull();
  });
});

describe('applyTrust', () => {
  it('runs the built commands and reports success', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const result = await applyTrust('install', {
      platform: 'win32',
      exec,
      caPath: CA_PATH,
      caCommonName: CN,
    });
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('certutil', ['-addstore', '-user', 'Root', CA_PATH]);
  });

  it('fails with manual instructions when the tool exits non-zero', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'denied' });
    const result = await applyTrust('install', {
      platform: 'linux',
      exec,
      caPath: CA_PATH,
      caCommonName: CN,
    });
    expect(result.ok).toBe(false);
    expect(result.manual).toContain(CA_PATH);
  });

  it('fails with manual instructions when the tool is missing (exec throws)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('spawn certutil ENOENT'));
    const result = await applyTrust('install', {
      platform: 'linux',
      exec,
      caPath: CA_PATH,
      caCommonName: CN,
    });
    expect(result.ok).toBe(false);
    expect(result.manual).toContain(CA_PATH);
  });

  it('returns manual instructions directly on unsupported platforms', async () => {
    const exec = vi.fn();
    const result = await applyTrust('install', {
      platform: 'freebsd',
      exec,
      caPath: CA_PATH,
      caCommonName: CN,
    });
    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('getManualTrustInstructions', () => {
  it('mentions the CA path and all three platforms', () => {
    const text = getManualTrustInstructions(CA_PATH);
    expect(text).toContain(CA_PATH);
    expect(text).toMatch(/certutil/);
    expect(text).toMatch(/security add-trusted-cert/);
    expect(text).toMatch(/nssdb/);
  });
});
