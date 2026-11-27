/**
 * The order of the plugins that settle a request's client: the gateway key, then the client attribution that reads it,
 * then the Desktop models answer — by their priorities, whatever the registration order.
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../registry.js';
import { ClientAttributionPlugin, DesktopModelsPlugin, GatewayKeyPlugin } from '../index.js';

describe('plugin order', () => {
  it('runs the gateway key, the client attribution and the Desktop models in that order when registered in reverse', () => {
    const registry = new PluginRegistry();
    registry.register(new DesktopModelsPlugin());
    registry.register(new ClientAttributionPlugin());
    registry.register(new GatewayKeyPlugin());

    expect(registry['getEnabledPluginsSorted']().map((plugin) => plugin.id)).toEqual([
      '@codemie/proxy-gateway-key',
      '@codemie/proxy-client-attribution',
      '@codemie/proxy-desktop-models',
    ]);
  });
});
