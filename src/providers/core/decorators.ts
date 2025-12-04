/**
 * Provider Decorators
 *
 * Auto-registration decorators for provider plugins
 */

import { ProviderRegistry } from './registry.js';
import type { ProviderTemplate } from './types.js';

/**
 * Auto-registration decorator
 *
 * Automatically registers provider on import
 */
export function registerProvider<T extends ProviderTemplate>(template: T): T {
  return ProviderRegistry.registerProvider(template);
}
