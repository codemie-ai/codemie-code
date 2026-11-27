/**
 * The order of the plugins that settle a request's client: the gateway key, then the client attribution that reads it,
 * then the model value guard, then the Desktop models answer — by their priorities, whatever the registration order.
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../registry.js';
import {
  ClientAttributionPlugin,
  DesktopModelsPlugin,
  GatewayKeyPlugin,
  ModelValueGuardPlugin,
} from '../index.js';

describe('plugin order', () => {
  it('runs the gateway key, the client attribution, the model value guard and the Desktop models in that order when registered in reverse', () => {
    const registry = new PluginRegistry();
    registry.register(new DesktopModelsPlugin());
    registry.register(new ModelValueGuardPlugin());
    registry.register(new ClientAttributionPlugin());
    registry.register(new GatewayKeyPlugin());

    expect(registry['getEnabledPluginsSorted']().map((plugin) => plugin.id)).toEqual([
      '@codemie/proxy-gateway-key',
      '@codemie/proxy-client-attribution',
      '@codemie/proxy-model-value-guard',
      '@codemie/proxy-desktop-models',
    ]);
  });

  it('gives the model value guard a priority strictly between 8 and 10, and not 9', () => {
    const { priority } = new ModelValueGuardPlugin();
    expect(priority).toBeGreaterThan(8);
    expect(priority).toBeLessThan(10);
    expect(priority).not.toBe(9);
  });
});
