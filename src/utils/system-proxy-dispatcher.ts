/**
 * Undici dispatcher that applies the shared system-proxy resolver to global fetch.
 */

import {
  Agent,
  Dispatcher,
  getGlobalDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
} from 'undici';
import { logger } from './logger.js';
import { sanitizeLogArgs } from './security.js';
import { isTlsVerificationEnabled, resolveProxyForUrl } from './system-proxy.js';

const dispatcherCache = new Map<string, Dispatcher>();
let installedDispatcher: SystemProxyDispatcher | undefined;
let previousDispatcher: Dispatcher | undefined;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Route each Undici request through the same per-URL proxy policy as Node HTTP clients. */
class SystemProxyDispatcher extends Dispatcher {
  private readonly directDispatcher: Agent;
  private readonly rejectUnauthorized: boolean;

  constructor() {
    super();
    this.rejectUnauthorized = isTlsVerificationEnabled();
    this.directDispatcher = new Agent({
      connect: { rejectUnauthorized: this.rejectUnauthorized },
    });
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    void this.selectDispatcher(options)
      .then(dispatcher => dispatcher.dispatch(options, handler))
      .catch(error => handler.onError?.(toError(error)));
    return true;
  }

  close(): Promise<void>;
  close(callback: () => void): void;
  close(callback?: () => void): Promise<void> | void {
    const closing = Promise.all([
      this.directDispatcher.close(),
      ...[...dispatcherCache.values()].map(dispatcher => dispatcher.close()),
    ]).then(() => undefined);
    if (callback) {
      void closing.then(callback, callback);
      return;
    }
    return closing;
  }

  destroy(): Promise<void>;
  destroy(error: Error | null): Promise<void>;
  destroy(callback: () => void): void;
  destroy(error: Error | null, callback: () => void): void;
  destroy(
    errorOrCallback: Error | null | (() => void) = null,
    callback?: () => void
  ): Promise<void> | void {
    const error = typeof errorOrCallback === 'function' ? null : errorOrCallback;
    const done = typeof errorOrCallback === 'function' ? errorOrCallback : callback;
    const destroying = Promise.all([
      this.directDispatcher.destroy(error),
      ...[...dispatcherCache.values()].map(dispatcher => dispatcher.destroy(error)),
    ]).then(() => undefined);
    if (done) {
      void destroying.then(done, done);
      return;
    }
    return destroying;
  }

  private async selectDispatcher(options: Dispatcher.DispatchOptions): Promise<Dispatcher> {
    if (!options.origin) return this.directDispatcher;

    const origin = new URL(options.origin.toString());
    const target = new URL(options.path, origin);
    const proxyUrl = await resolveProxyForUrl(target);
    if (!proxyUrl) return this.directDispatcher;

    const cacheKey = `${proxyUrl}|${this.rejectUnauthorized}`;
    const cached = dispatcherCache.get(cacheKey);
    if (cached) return cached;

    try {
      const dispatcher = new ProxyAgent({
        uri: proxyUrl,
        requestTls: { rejectUnauthorized: this.rejectUnauthorized },
        proxyTls: { rejectUnauthorized: this.rejectUnauthorized },
      });
      dispatcherCache.set(cacheKey, dispatcher);
      return dispatcher;
    } catch (error) {
      logger.debug(
        '[system-proxy] Failed to construct fetch proxy dispatcher; continuing direct',
        ...sanitizeLogArgs({ hasProxy: true, error: toError(error).message })
      );
      return this.directDispatcher;
    }
  }
}

/** Install the system-proxy dispatcher once for this process. */
export function installSystemProxyDispatcher(): void {
  if (installedDispatcher) return;
  previousDispatcher = getGlobalDispatcher();
  installedDispatcher = new SystemProxyDispatcher();
  setGlobalDispatcher(installedDispatcher);
}

/** Test seam for releasing dispatcher resources and allowing reinstallation. */
export async function resetSystemProxyDispatcher(): Promise<void> {
  if (installedDispatcher && previousDispatcher) setGlobalDispatcher(previousDispatcher);
  if (installedDispatcher) await installedDispatcher.destroy();
  installedDispatcher = undefined;
  previousDispatcher = undefined;
  dispatcherCache.clear();
}
