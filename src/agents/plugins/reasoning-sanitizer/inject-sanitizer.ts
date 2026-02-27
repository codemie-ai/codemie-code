import { createPluginInjector } from '../../core/plugin-injector.js';
import { REASONING_SANITIZER_PLUGIN_SOURCE } from './reasoning-sanitizer-source.js';

const injector = createPluginInjector('reasoning-sanitizer.ts', REASONING_SANITIZER_PLUGIN_SOURCE, 'reasoning-sanitizer');

export const getReasoningSanitizerPluginUrl = injector.getPluginFileUrl;
export const cleanupReasoningSanitizerPlugin = injector.cleanup;
