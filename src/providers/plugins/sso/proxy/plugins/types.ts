/**
 * Plugin types for CodeMie Proxy
 *
 * SOLID: Interface Segregation - plugins only implement what they need
 * KISS: Simple, clear interfaces
 */

import { IncomingHttpHeaders } from 'http';
import { ProxyConfig, ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';
import { SSOCredentials } from '../../../../core/types.js';
import type { CodeMieConfigOptions } from '../../../../../env/types.js';

/**
 * Plugin metadata and lifecycle
 */
export interface ProxyPlugin {
  /** Unique plugin identifier (e.g., '@codemie/proxy-analytics') */
  id: string;

  /** Display name */
  name: string;

  /** Plugin version */
  version: string;

  /** Execution priority (lower = earlier, 0-1000) */
  priority: number;

  /** Plugin dependencies (other plugin IDs) */
  dependencies?: string[];

  /** Create interceptor instance */
  createInterceptor(context: PluginContext): ProxyInterceptor | Promise<ProxyInterceptor>;

  /** Lifecycle hooks */
  onInstall?(): Promise<void>;
  onUninstall?(): Promise<void>;
  onEnable?(): Promise<void>;
  onDisable?(): Promise<void>;
}

/**
 * Context passed to plugins at creation
 */
export interface PluginContext {
  config: ProxyConfig;
  logger: typeof logger;
  credentials?: SSOCredentials;
  profileConfig?: CodeMieConfigOptions; // Full profile config (read once at CLI level)
  [key: string]: unknown; // Extensible
}

/**
 * Plugin configuration
 */
export interface PluginConfig {
  id: string;
  enabled: boolean;
  priority?: number; // Override default
  options?: Record<string, unknown>;
}

/**
 * Enhanced interceptor with streaming support
 */
export interface ProxyInterceptor {
  name: string;

  /** Called when proxy starts (for initialization) */
  onProxyStart?(): Promise<void>;

  /** Called when proxy stops (for cleanup) */
  onProxyStop?(): Promise<void>;

  /** Called before forwarding request */
  onRequest?(context: ProxyContext): Promise<void>;

  /** Called after response headers received (BEFORE body streaming) */
  onResponseHeaders?(context: ProxyContext, headers: IncomingHttpHeaders): Promise<void>;

  /** Called during streaming (optional, for transform/inspection) */
  onResponseChunk?(context: ProxyContext, chunk: Buffer): Promise<Buffer | null>;

  /** Called after response fully streamed */
  onResponseComplete?(context: ProxyContext, metadata: ResponseMetadata): Promise<void>;

  /** Called on any error */
  onError?(context: ProxyContext, error: Error): Promise<void>;
}

/**
 * Response metadata (after streaming)
 */
export interface ResponseMetadata {
  statusCode: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  bytesSent: number;
  durationMs: number;
}
