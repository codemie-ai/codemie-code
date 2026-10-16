import { createPluginInjector, createPluginDirInjector } from '../../core/plugin-injector.js';
import { SHELL_HOOKS_PLUGIN_SOURCE } from './shell-hooks-source.js';
import { SHELL_HOOKS_V2_PLUGIN_SOURCE } from './shell-hooks-v2-source.js';

const injector = createPluginInjector('shell-hooks.ts', SHELL_HOOKS_PLUGIN_SOURCE, 'hooks');
const v2Injector = createPluginDirInjector(
  'shell-hooks-v2',
  { 'index.ts': SHELL_HOOKS_V2_PLUGIN_SOURCE },
  'hooks-v2',
);

export const getHooksPluginFileUrl = injector.getPluginFileUrl;
export const cleanupHooksPlugin = injector.cleanup;
export const getHooksV2PluginDirUrl = v2Injector.getPluginDirUrl;
export const cleanupHooksV2Plugin = v2Injector.cleanup;
