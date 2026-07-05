/**
 * MCP Auth Proxy — OS trust-store integration for the locally-generated CA.
 *
 * Only the explicit `codemie mcp-auth-proxy trust` command calls this —
 * `start` never modifies the trust store (requirements decision, confirmed at
 * a security escalation gate). Uninstall matches the CA's exact subject CN so
 * only the CodeMie CA is ever removed.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TrustAction = 'install' | 'uninstall';

export interface TrustCommand {
  command: string;
  args: string[];
}

export interface TrustDeps {
  platform: NodeJS.Platform;
  /** exec() from src/utils/processes.ts (injected for testability). */
  exec: (
    command: string,
    args: string[]
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  caPath: string;
  caCommonName: string;
}

export interface TrustResult {
  ok: boolean;
  /** Manual per-OS instructions when the automated path is unavailable/failed. */
  manual?: string;
}

export function buildTrustCommands(
  platform: NodeJS.Platform,
  caPath: string,
  caCommonName: string,
  action: TrustAction
): TrustCommand[] | null {
  switch (platform) {
    case 'win32':
      return action === 'install'
        ? [{ command: 'certutil', args: ['-addstore', '-user', 'Root', caPath] }]
        : [{ command: 'certutil', args: ['-delstore', '-user', 'Root', caCommonName] }];
    case 'darwin': {
      const loginKeychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
      return action === 'install'
        ? [{ command: 'security', args: ['add-trusted-cert', '-k', loginKeychain, caPath] }]
        : [{ command: 'security', args: ['delete-certificate', '-c', caCommonName, loginKeychain] }];
    }
    case 'linux': {
      const nssDb = `sql:${join(homedir(), '.pki', 'nssdb')}`;
      return action === 'install'
        ? [
            {
              command: 'certutil',
              args: ['-d', nssDb, '-A', '-t', 'C,,', '-n', caCommonName, '-i', caPath],
            },
          ]
        : [{ command: 'certutil', args: ['-d', nssDb, '-D', '-n', caCommonName] }];
    }
    default:
      return null;
  }
}

export function getManualTrustInstructions(caPath: string): string {
  return [
    `Install the CA manually — certificate file: ${caPath}`,
    `  Windows : certutil -addstore -user Root "${caPath}"`,
    `  macOS   : security add-trusted-cert -k ~/Library/Keychains/login.keychain-db "${caPath}"`,
    `  Linux   : certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n "CodeMie mcp-auth-proxy CA" -i "${caPath}"`,
    '            (requires libnss3-tools; Chromium/Electron read the NSS user DB)',
  ].join('\n');
}

/**
 * Runs the trust-store commands for the platform. Never throws: an unusable
 * tool or unsupported platform yields { ok: false, manual } so the CLI can
 * print instructions and exit non-zero.
 */
export async function applyTrust(action: TrustAction, deps: TrustDeps): Promise<TrustResult> {
  const commands = buildTrustCommands(deps.platform, deps.caPath, deps.caCommonName, action);
  if (commands === null) {
    return { ok: false, manual: getManualTrustInstructions(deps.caPath) };
  }
  for (const { command, args } of commands) {
    try {
      const result = await deps.exec(command, args);
      if (result.code !== 0) {
        return { ok: false, manual: getManualTrustInstructions(deps.caPath) };
      }
    } catch {
      return { ok: false, manual: getManualTrustInstructions(deps.caPath) };
    }
  }
  return { ok: true };
}
