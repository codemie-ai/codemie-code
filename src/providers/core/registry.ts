/**
 * Provider Registry
 *
 * Central registry for all provider plugins
 */

import type {
  ProviderTemplate,
  ProviderHealthCheck,
  ProviderModelFetcher,
  ProviderSetupSteps
} from './types.js';

/**
 * Provider Registry
 *
 * Central registry for all provider plugins
 */
export class ProviderRegistry {
  private static providers: Map<string, ProviderTemplate> = new Map();
  private static healthChecks: Map<string, ProviderHealthCheck> = new Map();
  private static modelProxies: Map<string, ProviderModelFetcher> = new Map();
  private static setupSteps: Map<string, ProviderSetupSteps> = new Map();

  /**
   * Register provider template
   */
  static registerProvider<T extends ProviderTemplate>(template: T): T {
    this.providers.set(template.name, template);
    return template;
  }

  /**
   * Register health check
   */
  static registerHealthCheck(name: string, healthCheck: ProviderHealthCheck): void {
    this.healthChecks.set(name, healthCheck);
  }

  /**
   * Register model proxy
   */
  static registerModelProxy(name: string, proxy: ProviderModelFetcher): void {
    this.modelProxies.set(name, proxy);
  }

  /**
   * Register setup steps
   */
  static registerSetupSteps(name: string, steps: ProviderSetupSteps): void {
    this.setupSteps.set(name, steps);
  }

  /**
   * Get provider by name
   */
  static getProvider(name: string): ProviderTemplate | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all providers
   */
  static getAllProviders(): ProviderTemplate[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get health check for provider
   */
  static getHealthCheck(provider: string): ProviderHealthCheck | undefined {
    // Find health check that supports this provider
    for (const healthCheck of this.healthChecks.values()) {
      if (healthCheck.supports(provider)) {
        return healthCheck;
      }
    }
    return undefined;
  }

  /**
   * Get model proxy for provider
   */
  static getModelProxy(provider: string): ProviderModelFetcher | undefined {
    // Find model proxy that supports this provider
    for (const proxy of this.modelProxies.values()) {
      if (proxy.supports(provider)) {
        return proxy;
      }
    }
    return undefined;
  }

  /**
   * Get setup steps for provider
   */
  static getSetupSteps(provider: string): ProviderSetupSteps | undefined {
    return this.setupSteps.get(provider);
  }

  /**
   * Check if provider is registered
   */
  static hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Get all provider names
   */
  static getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Clear all registrations (mainly for testing)
   */
  static clear(): void {
    this.providers.clear();
    this.healthChecks.clear();
    this.modelProxies.clear();
    this.setupSteps.clear();
  }
}
