/**
 * ProxyHost — owns whichever server is bound to the daemon's port.
 *
 * Normally that is the full CodeMieProxy. If it cannot be (re)built because the SSO login has
 * expired, the host binds an AuthRequiredServer on the same port instead of leaving the port
 * dead, so clients get an actionable 401 rather than "connection refused".
 */
import { createHash } from 'node:crypto';
import { AuthenticationError } from '@/providers/plugins/sso/proxy/proxy-errors.js';
import { logger } from '@/utils/logger.js';

export type ProxyHostMode = 'full' | 'auth-required';

export interface HostedProxy {
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
}

export interface HostedAuthServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ProxyHostDeps {
  /** Builds a fresh proxy (already pinned to the daemon's port). */
  createProxy: () => HostedProxy;
  /** Builds the fallback listener on the same port. */
  createAuthServer: () => HostedAuthServer;
  /** True when a start() failure means "login needed" and is worth degrading for. */
  isAuthFailure: (error: unknown) => boolean;
}

export interface ProxyHostResult {
  mode: ProxyHostMode;
  /** URL of the full proxy; absent in auth-required mode (the daemon's pinned URL is unchanged). */
  url?: string;
}

export class ProxyHost {
  mode: ProxyHostMode = 'full';
  private proxy: HostedProxy | null = null;
  private authServer: HostedAuthServer | null = null;

  constructor(private readonly deps: ProxyHostDeps) {}

  /** Initial start: the full proxy or an error (the caller reports it and exits). */
  async start(): Promise<{ port: number; url: string }> {
    const proxy = this.deps.createProxy();
    const started = await proxy.start();
    this.proxy = proxy;
    this.mode = 'full';
    return started;
  }

  /**
   * Tear down whatever is running and bring the full proxy back. If that fails only because
   * the login is gone, bind the auth-required listener instead of throwing. Any other
   * failure still throws, so the watcher keeps its retry/backoff behaviour for those.
   */
  async restart(): Promise<ProxyHostResult> {
    await this.stopCurrent();

    const proxy = this.deps.createProxy();
    try {
      const { url } = await proxy.start();
      this.proxy = proxy;
      this.mode = 'full';
      return { mode: 'full', url };
    } catch (error) {
      if (!this.deps.isAuthFailure(error)) throw error;
      logger.warn(
        `[proxy-host] Cannot rebuild the proxy, sign-in needed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const authServer = this.deps.createAuthServer();
    await authServer.start();
    this.authServer = authServer;
    this.mode = 'auth-required';
    return { mode: 'auth-required' };
  }

  async stop(): Promise<void> {
    await this.stopCurrent();
  }

  private async stopCurrent(): Promise<void> {
    const { proxy, authServer } = this;
    this.proxy = null;
    this.authServer = null;
    try {
      await proxy?.stop();
    } catch (error) {
      logger.warn(`[proxy-host] proxy.stop() failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await authServer?.stop();
    } catch (error) {
      logger.warn(`[proxy-host] auth server stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The default `isAuthFailure`: the proxy raises AuthenticationError when stored SSO credentials are gone. */
export function isSsoAuthFailure(error: unknown): boolean {
  return error instanceof AuthenticationError;
}

/**
 * Stable fingerprint of a stored SSO login, used to tell "the user signed in again" from "the
 * same rejected credentials are still there". Null when nothing is stored. Never logged.
 */
export function fingerprintCredentials(creds: { cookies?: Record<string, string> } | null | undefined): string | null {
  if (!creds?.cookies) return null;
  const keys = Object.keys(creds.cookies).sort();
  if (keys.length === 0) return null;
  const hash = createHash('sha256');
  for (const key of keys) hash.update(`${key}=${creds.cookies[key]}\n`);
  return hash.digest('hex');
}
