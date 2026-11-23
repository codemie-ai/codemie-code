/**
 * The proxy clients: the client a gateway key names, and the default client of a connection record.
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import { PROXY_CLIENTS, clientOfGatewayKey, defaultClientOf } from '../proxy-clients.js';

describe('PROXY_CLIENTS', () => {
  it('names the five clients of the daemon', () => {
    expect(PROXY_CLIENTS).toEqual(['claude-desktop', 'vscode-claude-code', 'codex-desktop', 'vscode-byok', 'codemie-daemon']);
  });
});

describe('clientOfGatewayKey', () => {
  it.each(['claude-desktop', 'vscode-claude-code', 'codex-desktop', 'vscode-byok', 'codemie-daemon'])(
    'the key named %s gives that client',
    (client) => {
      expect(clientOfGatewayKey(`Bearer codemie-proxy.${client}`, 'codemie-proxy')).toEqual({ client });
    }
  );

  it('the shared key names no client', () => {
    expect(clientOfGatewayKey('Bearer codemie-proxy', 'codemie-proxy')).toEqual({});
  });

  it.each([
    ['an unknown name', 'Bearer codemie-proxy.unknown'],
    ['a known name with a suffix', 'Bearer codemie-proxy.claude-desktop.x'],
    ['an empty name', 'Bearer codemie-proxy.'],
    ['a lowercase scheme', 'bearer codemie-proxy'],
    ['another key', 'Bearer other-key'],
    ['a padded header', 'Bearer codemie-proxy '],
  ])('refuses %s', (_case, header) => {
    expect(clientOfGatewayKey(header, 'codemie-proxy')).toBeNull();
  });

  it('refuses a missing header', () => {
    expect(clientOfGatewayKey(undefined, 'codemie-proxy')).toBeNull();
  });

  it('names a client after a custom key, and refuses the default key there', () => {
    expect(clientOfGatewayKey('Bearer k.codex-desktop', 'k')).toEqual({ client: 'codex-desktop' });
    expect(clientOfGatewayKey('Bearer codemie-proxy.codex-desktop', 'k')).toBeNull();
  });
});

describe('defaultClientOf', () => {
  it('keeps a recorded client name', () => {
    expect(defaultClientOf({ clientType: 'codex-desktop' })).toBe('codex-desktop');
  });

  it('serves a record of the Desktop mode without a client type as claude-desktop', () => {
    expect(defaultClientOf({ telemetryMode: 'claude-desktop' })).toBe('claude-desktop');
  });

  it.each([
    ['claude-code-otlp', { clientType: 'claude-code-otlp' }],
    ['copilot-cli-otlp', { clientType: 'copilot-cli-otlp' }],
    ['claude', { clientType: 'claude' }],
    ['claude-acp', { clientType: 'claude-acp' }],
    ['an empty record', {}],
    ['no record', null],
    ['a type that sends no model request beside the Desktop mode', { clientType: 'claude-code-otlp', telemetryMode: 'claude-desktop' }],
  ])('serves %s as codemie-daemon', (_case, record) => {
    expect(defaultClientOf(record)).toBe('codemie-daemon');
  });
});
