import { createPluginInjector } from '../../core/plugin-injector.js';
import { SHELL_HOOKS_PLUGIN_SOURCE } from './shell-hooks-source.js';

const injector = createPluginInjector('shell-hooks.ts', SHELL_HOOKS_PLUGIN_SOURCE, 'hooks');

export const getHooksPluginFileUrl = injector.getPluginFileUrl;
export const cleanupHooksPlugin = injector.cleanup;
