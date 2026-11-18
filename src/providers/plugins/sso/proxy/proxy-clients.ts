/**
 * The clients a proxy daemon serves and how a request names its client: by the gateway key it sends, the shared
 * key with the client's name appended (`<key>.<client name>`). The shared key alone names no client; it is served
 * as the daemon's default client.
 */

export const CLAUDE_DESKTOP = 'claude-desktop';
export const VSCODE_CLAUDE_CODE = 'vscode-claude-code';
export const CODEX_DESKTOP = 'codex-desktop';
export const VSCODE_BYOK = 'vscode-byok';
/** oh-my-pi, and the default client of the shared key when nothing else names one. */
export const CODEMIE_DAEMON = 'codemie-daemon';

export const PROXY_CLIENTS: readonly string[] = [CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE, CODEX_DESKTOP, VSCODE_BYOK, CODEMIE_DAEMON];

/** The message of the 401 a proxy answers to a gateway key it does not accept; clients tell that refusal by it. */
export const INVALID_GATEWAY_KEY_MESSAGE = 'Invalid API key';

/**
 * The client an `authorization` header names with the daemon's gateway key `key`: `{}` for exactly `Bearer <key>`
 * (the shared key), `{ client }` for exactly `Bearer <key>.<client>` with a known client name, null for anything
 * else. Case-sensitive, nothing trimmed.
 */
export function clientOfGatewayKey(authorization: string | undefined, key: string): { client?: string } | null {
  if (authorization === undefined) return null;
  const shared = `Bearer ${key}`;
  if (authorization === shared) return {};
  if (!authorization.startsWith(`${shared}.`)) return null;
  const client = authorization.slice(shared.length + 1);
  return PROXY_CLIENTS.includes(client) ? { client } : null;
}

/**
 * The client a request with the shared key is served as, from the identity an older CLI left in the connection
 * record: its `clientType` when that is a client name, `claude-desktop` for a record with no `clientType` and the
 * Desktop `telemetryMode`, else `codemie-daemon`.
 */
export function defaultClientOf(record: { clientType?: string; telemetryMode?: string } | null): string {
  if (record?.clientType) return PROXY_CLIENTS.includes(record.clientType) ? record.clientType : CODEMIE_DAEMON;
  return record?.telemetryMode === CLAUDE_DESKTOP ? CLAUDE_DESKTOP : CODEMIE_DAEMON;
}
