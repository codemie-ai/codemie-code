/**
 * Context Compression Plugin
 *
 * Registers the context compression plugin with the proxy plugin registry.
 * When tokenSavingMode is enabled in the profile config, this plugin
 * compresses LLM request message arrays to reduce token usage.
 *
 * Priority 50: runs alongside logging, after auth and header injection.
 */

import { ProxyPlugin, PluginContext } from '../types.js';
import { ContextCompressionInterceptor } from './interceptor.js';

export const contextCompressionPlugin: ProxyPlugin = {
  id: '@codemie/context-compression',
  name: 'Context Compression',
  version: '1.0.0',
  priority: 50,
  createInterceptor: (context: PluginContext) => new ContextCompressionInterceptor(context),
};

export { ContextCompressionInterceptor } from './interceptor.js';
