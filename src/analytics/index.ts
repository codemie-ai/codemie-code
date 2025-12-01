/**
 * Analytics system for CodeMie CLI
 * Provides unified analytics tracking across all agents
 */

import type {
  AnalyticsConfig,
  AnalyticsEvent,
  EventType,
  SessionConfig,
} from './types.js';
import { EventCollector } from './collector.js';
import { AnalyticsWriter } from './writer.js';
import { SessionManager } from './session.js';
import { loadAnalyticsConfig } from './config.js';
import { getInstallationId } from '../utils/installation-id.js';
import { AnalyticsPlugin } from './plugins/types.js';

/**
 * Main analytics class
 * Handles event tracking, buffering, and persistence
 */
export class Analytics {
  private collector: EventCollector | null = null;
  private writer: AnalyticsWriter | null = null;
  private session: SessionManager;
  private config: AnalyticsConfig;
  private installationId: string | null = null;

  // Plugin system for extensibility
  private plugins: AnalyticsPlugin[] = [];

  // Session metrics aggregation
  private sessionMetrics = {
    totalLatencyMs: 0,
    apiRequestCount: 0,
  };

  constructor(config: Partial<AnalyticsConfig> = {}) {
    this.config = loadAnalyticsConfig(config);
    this.session = new SessionManager();

    // Only initialize if enabled
    if (this.config.enabled) {
      this.initialize();
    }
  }

  /**
   * Register an analytics plugin (Open/Closed principle)
   * Allows adding custom metrics without modifying core
   */
  registerPlugin(plugin: AnalyticsPlugin): void {
    this.plugins.push(plugin);

    // Initialize plugin if it has init method
    if (plugin.initialize) {
      plugin.initialize(this).catch(error => {
        console.error(`Plugin "${plugin.name}" initialization failed:`, error);
      });
    }
  }

  /**
   * Get all registered plugins
   */
  getPlugins(): AnalyticsPlugin[] {
    return [...this.plugins];
  }

  /**
   * Get current metrics from all plugins
   * Useful for displaying aggregated stats
   */
  getPluginMetrics(): Record<string, Record<string, unknown>> {
    const allMetrics: Record<string, Record<string, unknown>> = {};

    for (const plugin of this.plugins) {
      if (plugin.getMetrics) {
        try {
          allMetrics[plugin.name] = plugin.getMetrics();
        } catch (error) {
          console.error(`Error getting metrics from plugin "${plugin.name}":`, error);
          allMetrics[plugin.name] = { error: 'Failed to get metrics' };
        }
      }
    }

    return allMetrics;
  }

  /**
   * Get metrics from a specific plugin by name
   */
  getPluginMetricsByName(pluginName: string): Record<string, unknown> | null {
    const plugin = this.plugins.find(p => p.name === pluginName);

    if (!plugin || !plugin.getMetrics) {
      return null;
    }

    try {
      return plugin.getMetrics();
    } catch (error) {
      console.error(`Error getting metrics from plugin "${pluginName}":`, error);
      return null;
    }
  }

  /**
   * Initialize analytics components
   */
  private initialize(): void {
    this.collector = new EventCollector({
      maxBufferSize: this.config.maxBufferSize,
      flushInterval: this.config.flushInterval,
    });

    // Setup writer for local target
    if (this.config.target === 'local' || this.config.target === 'both') {
      this.writer = new AnalyticsWriter(this.config.localPath);
    }

    // Register flush callback
    this.collector.onFlush(async (events) => {
      if (this.writer) {
        await this.writer.write(events);
      }
    });
  }

  /**
   * Track an analytics event
   */
  async track(
    eventType: EventType,
    attributes: Record<string, unknown> = {},
    metrics?: Record<string, number>
  ): Promise<void> {
    if (!this.config.enabled || !this.collector || !this.session.isActive) {
      return;
    }

    try {
      // Lazy load installation ID
      if (!this.installationId) {
        this.installationId = await getInstallationId();
      }

      let event: AnalyticsEvent = {
        timestamp: new Date().toISOString(),
        eventType,
        sessionId: this.session.id,
        installationId: this.installationId,
        agent: this.session.agent,
        agentVersion: this.session.agentVersion,
        cliVersion: this.session.cliVersion,
        profile: this.session.profile,
        provider: this.session.provider,
        model: this.session.model,
        attributes,
        metrics: metrics || {},
      };

      // Process through plugins
      for (const plugin of this.plugins) {
        try {
          // 1. Allow plugins to transform event
          if (plugin.processEvent) {
            const processed = await plugin.processEvent(event);
            if (!processed) {
              // Plugin filtered out event
              return;
            }
            event = processed;
          }

          // 2. Enrich with plugin metrics
          if (plugin.enrichMetrics) {
            const pluginMetrics = await plugin.enrichMetrics(event);
            // Merge plugin metrics (cast to Record<string, number> for compatibility)
            event.metrics = { ...event.metrics, ...pluginMetrics as Record<string, number> };
          }
        } catch (pluginError) {
          // Plugin errors should not break analytics
          console.error(`Plugin "${plugin.name}" error:`, pluginError);
        }
      }

      // Aggregate session metrics
      if (eventType === 'api_request') {
        this.sessionMetrics.apiRequestCount++;
      }

      if (eventType === 'api_response' && event.metrics?.latencyMs) {
        this.sessionMetrics.totalLatencyMs += event.metrics.latencyMs;
      }

      this.collector.add(event);
    } catch (error) {
      // Silently fail - don't block agent execution
      console.error('Analytics tracking error:', error);
    }
  }




  /**
   * Track agent response
   */
  async trackAgentResponse(
    response: string,
    attributes: Record<string, unknown> = {}
  ): Promise<void> {
    const eventAttrs: Record<string, unknown> = {
      ...attributes,
      responseLength: response.length,
    };

    await this.track('agent_response', eventAttrs);
  }

  /**
   * Track API response
   */
  async trackAPIResponse(data: {
    latency?: number;
    statusCode?: number;
    responseBody?: unknown;
    requestBody?: unknown;
  }): Promise<void> {
    const attributes: Record<string, unknown> = {};

    if (data.statusCode) {
      attributes.statusCode = data.statusCode;
    }

    const metrics: Record<string, number> = {};
    if (data.latency) metrics.latencyMs = data.latency;

    await this.track('api_response', attributes, metrics);
  }


  /**
   * Start analytics session
   */
  startSession(config: SessionConfig): void {
    this.session.start(config);
    this.resetMetrics(); // Reset metrics for new session

    void this.track('session_start', {
      workingDir: config.workingDir,
      interactive: config.interactive,
    });
  }

  /**
   * End analytics session
   */
  async endSession(
    exitReason: string,
    metrics?: Record<string, number>
  ): Promise<void> {
    if (!this.session.isActive) {
      return;
    }

    // Combine session metrics with provided metrics
    const sessionMetrics = {
      durationSeconds: this.session.duration,
      totalLatencyMs: this.sessionMetrics.totalLatencyMs,
      averageLatencyMs: this.sessionMetrics.apiRequestCount > 0
        ? this.sessionMetrics.totalLatencyMs / this.sessionMetrics.apiRequestCount
        : 0,
      apiRequestCount: this.sessionMetrics.apiRequestCount,

      ...metrics,
    };

    const attributes = {
      exitReason,
    };

    await this.track('session_end', attributes, sessionMetrics);

    // Force flush on session end
    await this.flush();

    // Reset metrics
    this.resetMetrics();

    this.session.end();
  }

  /**
   * Reset session metrics
   */
  private resetMetrics(): void {
    this.sessionMetrics = {
      totalLatencyMs: 0,
      apiRequestCount: 0,
    };
  }

  /**
   * Flush buffered events
   */
  async flush(): Promise<void> {
    if (this.collector) {
      await this.collector.flush();
    }
  }

  /**
   * Cleanup and destroy analytics
   */
  async destroy(): Promise<void> {
    if (this.collector) {
      await this.flush();
      this.collector.destroy();
    }
  }

  /**
   * Check if analytics is enabled
   */
  get isEnabled(): boolean {
    return this.config.enabled;
  }
}

/**
 * Singleton analytics instance
 */
let analyticsInstance: Analytics | null = null;

/**
 * Initialize global analytics instance
 * Automatically registers default plugins for API tracking
 */
export function initAnalytics(
  config: Partial<AnalyticsConfig> = {},
  options: { registerDefaultPlugins?: boolean } = { registerDefaultPlugins: true }
): void {
  analyticsInstance = new Analytics(config);

  // Register default plugins if enabled
  if (options.registerDefaultPlugins && analyticsInstance.isEnabled) {
    registerDefaultPlugins(analyticsInstance);
  }
}

/**
 * Register default analytics plugins
 * Tracks API request/response patterns, success rates, and latency
 */
export function registerDefaultPlugins(analytics: Analytics): void {
  try {
    // Import plugins dynamically to avoid unnecessary loading
    import('./plugins/index.js').then(({
      APIMetricsPlugin,
      ModelMetricsPlugin,
      ProviderMetricsPlugin
    }) => {
      analytics.registerPlugin(new APIMetricsPlugin());
      analytics.registerPlugin(new ModelMetricsPlugin());
      analytics.registerPlugin(new ProviderMetricsPlugin());
    }).catch(error => {
      // Plugins are optional - don't break if they fail to load
      console.warn('Failed to load default analytics plugins:', error);
    });
  } catch (error) {
    console.warn('Failed to register default analytics plugins:', error);
  }
}

/**
 * Get global analytics instance
 * Auto-initializes if not already initialized
 */
export function getAnalytics(): Analytics {
  if (!analyticsInstance) {
    // Auto-initialize with defaults
    initAnalytics();
  }
  return analyticsInstance!; // Safe: always initialized above
}

/**
 * Destroy global analytics instance
 */
export async function destroyAnalytics(): Promise<void> {
  if (analyticsInstance) {
    await analyticsInstance.destroy();
    analyticsInstance = null;
  }
}

// Re-export types
export type {
  AnalyticsConfig,
  AnalyticsEvent,
  EventType,
  SessionConfig,
} from './types.js';
export { DEFAULT_ANALYTICS_CONFIG } from './types.js';

// Re-export plugin types for convenience
export type { AnalyticsPlugin } from './plugins/types.js';
