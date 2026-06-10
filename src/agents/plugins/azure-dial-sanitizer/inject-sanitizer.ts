import { createPluginInjector } from '../../core/plugin-injector.js';
import { AZURE_DIAL_SANITIZER_PLUGIN_SOURCE } from './azure-dial-sanitizer-source.js';

const injector = createPluginInjector(
  'azure-dial-sanitizer.ts',
  AZURE_DIAL_SANITIZER_PLUGIN_SOURCE,
  'azure-dial-sanitizer'
);

export const getAzureDialSanitizerPluginUrl = injector.getPluginFileUrl;
export const cleanupAzureDialSanitizerPlugin = injector.cleanup;
