import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPluginHooks } from '../hooks-loader.js';
import type { PluginManifest } from '../../core/types.js';

describe('loadPluginHooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints a visible notice and returns null for a malformed hooks.json', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'codemie-plugin-hooks-'));
    await mkdir(join(pluginDir, 'hooks'), { recursive: true });
    await writeFile(join(pluginDir, 'hooks', 'hooks.json'), '{ this is not valid json');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manifest: PluginManifest = { name: 'test-plugin' };

    const result = await loadPluginHooks(pluginDir, manifest);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('⚠'))).toBe(true);
  });
});
