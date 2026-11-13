import type { ClientIdentity } from './daemon-manager.js';

/** A daemon started before `clientType` was recorded and having only `telemetryMode: 'claude-desktop'` is a Claude Desktop daemon. */
export function getEffectiveClientType(identity: ClientIdentity): string {
  return identity.clientType ?? (identity.telemetryMode === 'claude-desktop'
    ? 'claude-desktop'
    : 'codemie-daemon');
}
