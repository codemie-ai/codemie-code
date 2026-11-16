/**
 * OpenCode v2 loads a configured plugin only from a directory whose entry point is `index.ts`,
 * so the hooks plugin is handed over as a directory URL rather than a file URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { fileURLToPath } from 'url';
import { getHooksPluginDirUrl, cleanupHooksPluginDir } from '../inject-hooks.js';
import { SHELL_HOOKS_V2_PLUGIN_SOURCE } from '../shell-hooks-v2-source.js';

describe('OpenCode v2 hooks plugin directory', () => {
  // Named after this process, so one session's cleanup cannot remove another's running plugin.
  const pluginDir = join(tmpdir(), 'codemie-hooks', `opencode-v2-${process.pid}`);

  afterEach(() => {
    cleanupHooksPluginDir();
  });

  it("is the URL of this process's own plugin directory", () => {
    const dirUrl = getHooksPluginDirUrl();

    expect(fileURLToPath(dirUrl)).toBe(pluginDir + sep);
  });

  it('holds the v2 plugin as index.ts', () => {
    getHooksPluginDirUrl();

    expect(readFileSync(join(pluginDir, 'index.ts'), 'utf-8')).toBe(SHELL_HOOKS_V2_PLUGIN_SOURCE);
  });

  it('is removed on cleanup', () => {
    getHooksPluginDirUrl();

    cleanupHooksPluginDir();

    expect(existsSync(pluginDir)).toBe(false);
  });
});
