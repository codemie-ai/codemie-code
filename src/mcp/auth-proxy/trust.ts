/**
 * MCP Auth Proxy — OS trust-store integration for the locally-generated CA.
 *
 * Only the explicit `codemie mcp-auth-proxy trust` command calls this —
 * `start` never modifies the trust store (requirements decision, confirmed at
 * a security escalation gate). Uninstall matches the CA's exact subject CN so
 * only the CodeMie CA is ever removed.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
  /** Linux NSS DB presence probe (injected for testability; defaults to existsSync). */
  nssDbExists?: () => boolean;
  /** Creates the NSS DB directory (injected for testability; defaults to recursive mkdir). */
  createNssDbDir?: () => Promise<void>;
}

export interface TrustResult {
  ok: boolean;
  /** Uninstall only: the CA was not in the trust store — idempotent success. */
  notFound?: boolean;
  /** stderr (or error message) of the failing command, for user-facing diagnostics. */
  detail?: string;
  /** Manual per-OS instructions when the automated path is unavailable/failed. */
  manual?: string;
}

/** Platform "certificate not found" errors — uninstall treats these as already removed. */
const UNINSTALL_NOT_FOUND_PATTERN =
  /not\s?found|no matching|could not (?:be )?found|unable to find|CRYPT_E_NOT_FOUND|SEC_ERROR_UNRECOGNIZED_OID|SEC_ERROR_BAD_DATABASE|0x80092004/i;

function nssDbDir(): string {
  return join(homedir(), '.pki', 'nssdb');
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
      const nssDb = `sql:${nssDbDir()}`;
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

export function getManualTrustInstructions(
  caPath: string,
  caCommonName: string,
  action: TrustAction = 'install'
): string {
  if (action === 'uninstall') {
    return [
      `Remove the CA manually — subject CN: ${caCommonName}`,
      `  Windows : certutil -delstore -user Root "${caCommonName}"`,
      `  macOS   : security delete-certificate -c "${caCommonName}" ~/Library/Keychains/login.keychain-db`,
      `  Linux   : certutil -d sql:$HOME/.pki/nssdb -D -n "${caCommonName}"`,
    ].join('\n');
  }
  return [
    `Install the CA manually — certificate file: ${caPath}`,
    `  Windows : certutil -addstore -user Root "${caPath}"`,
    `  macOS   : security add-trusted-cert -k ~/Library/Keychains/login.keychain-db "${caPath}"`,
    `  Linux   : certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n "${caCommonName}" -i "${caPath}"`,
    '            (requires libnss3-tools; Chromium/Electron read the NSS user DB, so this',
    '            command is what Claude Desktop needs)',
    '  Linux system store (fallback when NSS certutil is unavailable):',
    `            sudo cp "${caPath}" /usr/local/share/ca-certificates/codemie-mcp-auth-proxy.crt && sudo update-ca-certificates`,
  ].join('\n');
}

function failure(deps: TrustDeps, action: TrustAction, detail: string): TrustResult {
  const result: TrustResult = {
    ok: false,
    manual: getManualTrustInstructions(deps.caPath, deps.caCommonName, action),
  };
  if (detail !== '') {
    result.detail = detail;
  }
  return result;
}

/**
 * Runs the trust-store commands for the platform. Never throws: an unusable
 * tool or unsupported platform yields { ok: false, manual } so the CLI can
 * print instructions and exit non-zero.
 */
export async function applyTrust(action: TrustAction, deps: TrustDeps): Promise<TrustResult> {
  const commands = buildTrustCommands(deps.platform, deps.caPath, deps.caCommonName, action);
  if (commands === null) {
    return failure(deps, action, '');
  }

  if (deps.platform === 'linux' && action === 'install') {
    // Fresh profiles have no ~/.pki/nssdb, and `certutil -A` cannot create one.
    const dbExists = deps.nssDbExists ? deps.nssDbExists() : existsSync(nssDbDir());
    if (!dbExists) {
      try {
        if (deps.createNssDbDir) {
          await deps.createNssDbDir();
        } else {
          await mkdir(nssDbDir(), { recursive: true });
        }
      } catch (error) {
        return failure(deps, action, (error as Error).message);
      }
      commands.unshift({
        command: 'certutil',
        args: ['-d', `sql:${nssDbDir()}`, '-N', '--empty-password'],
      });
    }
  }

  let notFound = false;
  for (const { command, args } of commands) {
    try {
      const result = await deps.exec(command, args);
      if (result.code !== 0) {
        const output = `${result.stdout}\n${result.stderr}`;
        if (action === 'uninstall' && UNINSTALL_NOT_FOUND_PATTERN.test(output)) {
          notFound = true; // already absent — idempotent success
          continue;
        }
        return failure(deps, action, result.stderr.trim() || result.stdout.trim());
      }
    } catch (error) {
      return failure(deps, action, (error as Error).message);
    }
  }
  return notFound ? { ok: true, notFound: true } : { ok: true };
}
