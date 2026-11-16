import { createPluginInjector } from '../../core/plugin-injector.js';
import { SHELL_HOOKS_PLUGIN_SOURCE } from './shell-hooks-source.js';
import { SHELL_HOOKS_V2_PLUGIN_SOURCE } from './shell-hooks-v2-source.js';

const injector = createPluginInjector('shell-hooks.ts', SHELL_HOOKS_PLUGIN_SOURCE, 'hooks');

export const getHooksPluginFileUrl = injector.getPluginFileUrl;
export const cleanupHooksPlugin = injector.cleanup;

// OpenCode v2 loads a configured plugin only from a directory (entry point index.ts) and
// watches it, so the directory is this process's own: another session's cleanup must not
// remove a plugin this session is still running.
const v2Injector = createPluginInjector(
  `opencode-v2-${process.pid}/index.ts`,
  SHELL_HOOKS_V2_PLUGIN_SOURCE,
  'hooks'
);

/** The file:// URL of the directory that holds the OpenCode v2 hooks plugin. */
export const getHooksPluginDirUrl = (): string => new URL('.', v2Injector.getPluginFileUrl()).href;
export const cleanupHooksPluginDir = v2Injector.cleanup;
