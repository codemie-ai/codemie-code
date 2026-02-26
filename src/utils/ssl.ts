/**
 * SSL Certificate Handling Utilities
 *
 * Supports two modes:
 * 1. Full SSL bypass (CODEMIE_SSL_NO_VERIFY=true or sslVerify: false in config)
 * 2. Windows certificate store integration (auto-loads trusted root certs from Windows)
 */

import https from 'https';
import { exec } from './exec.js';
import { logger } from './logger.js';

/** Whether SSL has already been initialized (singleton guard) */
let initialized = false;

export interface SSLOptions {
  /** If false, disables all SSL verification (full bypass). Defaults to true. */
  sslVerify?: boolean;
}

/**
 * Fully disables SSL certificate verification.
 * Sets NODE_TLS_REJECT_UNAUTHORIZED=0 and patches https.globalAgent.
 * Emits a visible warning so users are aware of the insecure mode.
 */
export function disableSSLVerification(): void {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  https.globalAgent.options.rejectUnauthorized = false;

  // Suppress only the Node.js SecurityWarning for NODE_TLS_REJECT_UNAUTHORIZED;
  // all other process warnings continue to propagate normally.
  process.on('warning', (warning) => {
    if (warning.name === 'SecurityWarning' &&
        warning.message.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
      return; // suppress only this specific warning
    }
    // all other warnings propagate normally via default handler
  });

  // Visible warning — required whenever SSL bypass is active
  logger.warn('[SSL] Certificate verification is DISABLED. Do not use in production.');
  logger.debug('[SSL] Certificate verification disabled via CODEMIE_SSL_NO_VERIFY or sslVerify:false');
}

/**
 * Reads trusted root certificates from the Windows certificate store.
 * Returns an array of PEM-encoded certificate strings.
 * Returns empty array on non-Windows platforms or if PowerShell fails.
 */
export async function loadWindowsCertificates(): Promise<string[]> {
  const script = [
    '$store = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root","LocalMachine");',
    '$store.Open("ReadOnly");',
    'foreach ($cert in $store.Certificates) {',
    '"-----BEGIN CERTIFICATE-----"',
    '[Convert]::ToBase64String($cert.RawData, "InsertLineBreaks")',
    '"-----END CERTIFICATE-----"',
    '};',
    '$store.Close()'
  ].join(' ');

  try {
    const result = await exec('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { timeout: 10000 });

    // Parse PEM blocks from output
    const certs: string[] = [];
    const pemPattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
    const matches = result.stdout.match(pemPattern);
    if (matches) {
      certs.push(...matches);
    }

    logger.debug(`[SSL] Loaded ${certs.length} certificates from Windows certificate store`);
    return certs;
  } catch (error) {
    logger.debug(`[SSL] Failed to load Windows certificates: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Patches https.globalAgent and undici's global dispatcher to trust the
 * provided PEM-encoded certificates. This covers both Node.js https requests
 * and fetch() calls (which use undici in Node.js 18+).
 */
export async function applyWindowsCertificates(certs: string[]): Promise<void> {
  if (certs.length === 0) {
    return;
  }

  // Patch https.globalAgent for Node.js https module
  https.globalAgent.options.ca = certs;

  // Patch undici's global dispatcher so fetch() also trusts the certs.
  // node:undici is built into Node.js 18+ (required by this project >=20.0.0).
  try {
    const undici = await import('node:undici');
    if (undici.setGlobalDispatcher && undici.Agent) {
      undici.setGlobalDispatcher(new undici.Agent({ connect: { ca: certs } }));
      logger.debug('[SSL] Patched undici global dispatcher with Windows certificates');
    }
  } catch {
    logger.warn('[SSL] node:undici not available, fetch() calls will not use Windows certificates');
  }
}

/**
 * Initializes SSL configuration. Must be called as early as possible,
 * before any network calls are made.
 *
 * Priority:
 * 1. CODEMIE_SSL_NO_VERIFY env var or options.sslVerify === false → full bypass
 * 2. Windows platform → load certs from Windows certificate store
 * 3. Otherwise → no changes (system defaults apply)
 *
 * Uses a singleton guard to prevent double initialization.
 */
export async function initSSL(options: SSLOptions = {}): Promise<void> {
  if (initialized) {
    return;
  }
  initialized = true;

  const envDisable =
    process.env.CODEMIE_SSL_NO_VERIFY === 'true' ||
    process.env.CODEMIE_SSL_NO_VERIFY === '1';

  if (envDisable || options.sslVerify === false) {
    disableSSLVerification();
    return;
  }

  // On Windows, attempt to load certificates from the native cert store
  if (process.platform === 'win32') {
    const certs = await loadWindowsCertificates();
    if (certs.length > 0) {
      await applyWindowsCertificates(certs);
    }
  }
}
