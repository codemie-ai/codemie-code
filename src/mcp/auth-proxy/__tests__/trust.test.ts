/**
 * trust.ts tests — pure command builders + injected-exec action runner.
 * No real trust store (or real NSS DB) is ever touched.
 * @group unit
 */
import { describe, it, expect, vi } from 'vitest';
import { applyTrust, buildTrustCommands, getManualTrustInstructions } from '../trust.js';
import type { TrustDeps } from '../trust.js';

const CA_PATH = '/home/u/.codemie/mcp-auth-proxy-tls/ca.crt';
const CN = 'CodeMie mcp-auth-proxy CA u@host 2026-07-05';

function deps(overrides: Partial<TrustDeps>): TrustDeps {
  return {
    platform: 'linux',
    exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
    caPath: CA_PATH,
    caCommonName: CN,
    // Hermetic default: never probe/create the real ~/.pki/nssdb in tests.
    nssDbExists: () => true,
    ...overrides,
  };
}

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
    const result = await applyTrust('install', deps({ platform: 'win32', exec }));
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('certutil', ['-addstore', '-user', 'Root', CA_PATH]);
  });

  it('fails with manual instructions when the tool exits non-zero', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'denied' });
    const result = await applyTrust('install', deps({ exec }));
    expect(result.ok).toBe(false);
    expect(result.manual).toContain(CA_PATH);
  });

  it('surfaces the failing command stderr as detail', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'denied by policy' });
    const result = await applyTrust('install', deps({ platform: 'win32', exec }));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('denied by policy');
  });

  it('fails with manual instructions when the tool is missing (exec throws)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('spawn certutil ENOENT'));
    const result = await applyTrust('install', deps({ exec }));
    expect(result.ok).toBe(false);
    expect(result.manual).toContain(CA_PATH);
    expect(result.detail).toContain('ENOENT');
  });

  it('returns manual instructions directly on unsupported platforms', async () => {
    const exec = vi.fn();
    const result = await applyTrust('install', deps({ platform: 'freebsd', exec }));
    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('linux install bootstraps a missing NSS DB before adding the CA', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const createNssDbDir = vi.fn().mockResolvedValue(undefined);
    const result = await applyTrust(
      'install',
      deps({ exec, nssDbExists: () => false, createNssDbDir })
    );
    expect(result.ok).toBe(true);
    expect(createNssDbDir).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, 'certutil', [
      '-d',
      expect.stringContaining('nssdb'),
      '-N',
      '--empty-password',
    ]);
    expect(exec).toHaveBeenNthCalledWith(2, 'certutil', expect.arrayContaining(['-A', CN]));
  });

  it('linux install skips the bootstrap when the NSS DB exists', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const createNssDbDir = vi.fn();
    const result = await applyTrust('install', deps({ exec, createNssDbDir }));
    expect(result.ok).toBe(true);
    expect(createNssDbDir).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('certutil', expect.arrayContaining(['-A']));
  });

  it('uninstall treats the platform not-found result as idempotent success', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'CertUtil: -delstore command FAILED: 0x80092004',
    });
    const result = await applyTrust('uninstall', deps({ platform: 'win32', exec }));
    expect(result.ok).toBe(true);
    expect(result.notFound).toBe(true);
  });

  it('uninstall on a fresh linux profile (no NSS DB) is idempotent success', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 255,
      stdout: '',
      stderr: 'certutil: could not find certificate named "x": SEC_ERROR_BAD_DATABASE',
    });
    const result = await applyTrust('uninstall', deps({ exec }));
    expect(result.ok).toBe(true);
    expect(result.notFound).toBe(true);
  });

  it('a genuinely failed uninstall keeps the failure path with delete instructions', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'permission denied' });
    const result = await applyTrust('uninstall', deps({ platform: 'darwin', exec }));
    expect(result.ok).toBe(false);
    expect(result.notFound).toBeUndefined();
    expect(result.detail).toContain('permission denied');
    expect(result.manual).toContain('delete-certificate');
    expect(result.manual).toContain(CN);
  });
});

describe('getManualTrustInstructions', () => {
  it('install text mentions the CA path and all three platforms', () => {
    const text = getManualTrustInstructions(CA_PATH, CN);
    expect(text).toContain(CA_PATH);
    expect(text).toMatch(/certutil/);
    expect(text).toMatch(/security add-trusted-cert/);
    expect(text).toMatch(/nssdb/);
  });

  it('install text includes the Linux system-store fallback and the NSS note', () => {
    const text = getManualTrustInstructions(CA_PATH, CN, 'install');
    expect(text).toContain('/usr/local/share/ca-certificates/codemie-mcp-auth-proxy.crt');
    expect(text).toContain('update-ca-certificates');
    expect(text).toMatch(/NSS user DB/);
    expect(text).toMatch(/Claude Desktop/);
  });

  it('uninstall text lists the per-platform delete commands with the CN', () => {
    const text = getManualTrustInstructions(CA_PATH, CN, 'uninstall');
    expect(text).toContain(`certutil -delstore -user Root "${CN}"`);
    expect(text).toContain(`security delete-certificate -c "${CN}"`);
    expect(text).toContain(`-D -n "${CN}"`);
  });
});
