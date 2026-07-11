import { createPluginInjector } from '../../core/plugin-injector.js';
import { AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE } from './azure-openai-sanitizer-source.js';

const injector = createPluginInjector(
  'azure-openai-sanitizer.ts',
  AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE,
  'azure-openai-sanitizer'
);

export const getAzureOpenAISanitizerPluginUrl = injector.getPluginFileUrl;
export const cleanupAzureOpenAISanitizerPlugin = injector.cleanup;
