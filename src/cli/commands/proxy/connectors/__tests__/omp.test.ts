import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '@/utils/errors.js';

const { getBundleRoot } = vi.hoisted(() => ({ getBundleRoot: vi.fn<() => string>() }));
vi.mock('@/utils/paths.js', async importOriginal => ({
  ...await importOriginal(),
  getDirname: getBundleRoot,
}));

import { getOmpExtensionPath, removeOmpExtension, writeOmpExtension } from '../omp.js';

const BUNDLE = '// codemie-managed: test\nexport default () => {};\n';

describe('omp extension installer', () => {
  let bundleRoot: string;
  let agentDir: string;

  beforeEach(() => {
    bundleRoot = mkdtempSync(join(tmpdir(), 'codemie-omp-bundle-'));
    agentDir = mkdtempSync(join(tmpdir(), 'codemie-omp-agent-'));
    mkdirSync(join(bundleRoot, 'omp'));
    writeFileSync(join(bundleRoot, 'omp', 'codemie-models.bundle.js'), BUNDLE);
    getBundleRoot.mockReturnValue(bundleRoot);
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    vi.stubEnv('PI_CONFIG_DIR', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    rmSync(bundleRoot, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('resolves the active omp agent directory using both environment overrides', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    vi.stubEnv('PI_CONFIG_DIR', '.omp-test');
    expect(getOmpExtensionPath()).toBe(join(agentDir, 'extensions', 'codemie-models.js'));
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    expect(getOmpExtensionPath()).toBe(join(homedir(), '.omp-test', 'agent', 'extensions', 'codemie-models.js'));
    vi.stubEnv('PI_CONFIG_DIR', '');
    expect(getOmpExtensionPath()).toBe(join(homedir(), '.omp', 'agent', 'extensions', 'codemie-models.js'));
  });

  it('installs a fresh bundle and reports an identical install as unchanged', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const path = join(agentDir, 'extensions', 'codemie-models.js');
    expect(await writeOmpExtension()).toEqual({ path, changed: true });
    expect(readFileSync(path, 'utf-8')).toBe(BUNDLE);
    expect(await writeOmpExtension()).toEqual({ path, changed: false });
  });

  it('replaces an older extension carrying the CodeMie ownership marker', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const path = join(agentDir, 'extensions', 'codemie-models.js');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    writeFileSync(path, '// codemie-managed: previous\nold bundle');
    expect(await writeOmpExtension()).toEqual({ path, changed: true });
    expect(readFileSync(path, 'utf-8')).toBe(BUNDLE);
  });

  it('preserves a foreign extension unless force is requested', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const path = join(agentDir, 'extensions', 'codemie-models.js');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    const foreign = 'export default () => "user extension";\n';
    writeFileSync(path, foreign);
    await expect(writeOmpExtension()).rejects.toBeInstanceOf(ConfigurationError);
    await expect(writeOmpExtension()).rejects.toThrow(/--force/);
    expect(readFileSync(path, 'utf-8')).toBe(foreign);
    expect(await writeOmpExtension({ force: true })).toEqual({ path, changed: true });
    expect(readFileSync(path, 'utf-8')).toBe(BUNDLE);
  });

  it('removes only a CodeMie-owned extension and leaves absent or foreign files intact', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const path = join(agentDir, 'extensions', 'codemie-models.js');
    expect(await removeOmpExtension()).toEqual({ path, removed: false });
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    writeFileSync(path, BUNDLE);
    expect(await removeOmpExtension()).toEqual({ path, removed: true });
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, 'a foreign extension');
    await expect(removeOmpExtension()).rejects.toThrow(ConfigurationError);
    expect(readFileSync(path, 'utf-8')).toBe('a foreign extension');
  });

  describe('an extension path that is a symbolic link', () => {
    let path: string;
    let target: string;

    beforeEach(() => {
      vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
      path = join(agentDir, 'extensions', 'codemie-models.js');
      target = join(agentDir, 'dotfiles', 'codemie-models.js');
      mkdirSync(join(agentDir, 'extensions'), { recursive: true });
      mkdirSync(join(agentDir, 'dotfiles'), { recursive: true });
      symlinkSync(target, path);
    });

    it.skipIf(process.platform === 'win32')('removes the CodeMie bundle the link points to and the link', async () => {
      writeFileSync(target, '// codemie-managed: previous\nold bundle');
      await writeOmpExtension();
      expect(readFileSync(target, 'utf-8')).toBe(BUNDLE);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);

      expect(await removeOmpExtension()).toEqual({ path, removed: true });

      expect(existsSync(target)).toBe(false);
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await removeOmpExtension()).toEqual({ path, removed: false });
    });

    it.skipIf(process.platform === 'win32')('leaves a foreign target and the link in place', async () => {
      writeFileSync(target, 'a foreign extension');

      await expect(removeOmpExtension()).rejects.toThrow('was not installed by CodeMie');

      expect(readFileSync(target, 'utf-8')).toBe('a foreign extension');
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('is a no-op on a link to nothing, the link kept', async () => {
      expect(await removeOmpExtension()).toEqual({ path, removed: false });

      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    });
  });
});
