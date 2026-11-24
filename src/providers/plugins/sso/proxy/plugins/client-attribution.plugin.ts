/**
 * Client Attribution Plugin
 * Priority: 8, after the gateway key (7) and before every client-gated plugin
 *
 * Settles the client of a request before any plugin acts on it: a request validated by the shared key that the
 * Desktop repository resolver attributes to a Cowork session is a `claude-desktop` request. The repository and
 * branch the resolver found go into the request's metadata for header injection. A `claude-desktop` request with a
 * session id leaves that session's served mark, which lets the Cowork producer send a Cowork session.
 *
 * The resolver is asked only for `claude-desktop` and `vscode-claude-code` requests and for a shared-key request
 * that carries `x-claude-code-session-id`; every other client carries no Desktop attribution. A shared-key request
 * whose default client is not `claude-desktop` neither reads nor fills the last-resolved slot and keeps the answer
 * only when it is Cowork. Without a resolver (a proxy outside the daemon) the plugin does nothing.
 */

import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { DesktopRepositoryResolver } from '../../../../../telemetry/runtime/DesktopRepositoryResolver.js';
import { markCoworkSessionServed } from '../../../../../telemetry/runtime/cowork/cowork-served-mark.js';
import { isSafeSessionId } from '../../../../../agents/core/session-id.js';
import { logger } from '../../../../../utils/logger.js';
import { CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE } from '../proxy-clients.js';

/** The metadata key of the resolved Desktop repository and branch, read by header injection. */
export const DESKTOP_ATTRIBUTION_KEY = 'desktopAttribution';

export interface ResolvedDesktopAttribution {
  repository?: string;
  branch?: string;
}

export class ClientAttributionPlugin implements ProxyPlugin {
  id = '@codemie/proxy-client-attribution';
  name = 'Client Attribution';
  version = '1.0.0';
  priority = 8;

  createInterceptor(context: PluginContext): ProxyInterceptor {
    return new ClientAttributionInterceptor(context.config.desktopRepositoryResolver);
  }
}

class ClientAttributionInterceptor implements ProxyInterceptor {
  name = 'client-attribution';

  constructor(private readonly resolver: DesktopRepositoryResolver | undefined) {}

  async handleRequest(context: ProxyContext): Promise<boolean> {
    if (!this.resolver) return false;
    const cliSessionId = context.headers['x-claude-code-session-id'] as string | undefined;
    const sharedKey = context.metadata.gatewayKeyValidated === true && context.metadata.gatewayKeyClient === undefined;
    const extension = context.agentName === VSCODE_CLAUDE_CODE;
    // A shared-key request served as another client is Desktop's only when the resolver says Cowork.
    const outsideDesktop = sharedKey && context.agentName !== CLAUDE_DESKTOP;

    if (context.agentName === CLAUDE_DESKTOP || extension || (sharedKey && cliSessionId)) {
      try {
        const attribution = await this.resolver.resolveForRequest(
          cliSessionId,
          { remotePort: context.remotePort, url: context.url },
          { skipLastResolved: extension || outsideDesktop }
        );
        if (attribution.isCowork && sharedKey) context.agentName = CLAUDE_DESKTOP;
        // A Cowork answer is not the extension's: it keeps its client and takes no repository from it.
        const keep = extension ? !attribution.isCowork : !outsideDesktop || attribution.isCowork;
        if (keep) {
          const resolved: ResolvedDesktopAttribution = {
            repository: attribution.repository ?? undefined,
            branch: attribution.branch ?? undefined,
          };
          context.metadata[DESKTOP_ATTRIBUTION_KEY] = resolved;
        }
      } catch (error) {
        logger.warn('[client-attribution] Desktop attribution failed; the request goes on unresolved', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (context.agentName === CLAUDE_DESKTOP && cliSessionId && isSafeSessionId(cliSessionId)) {
      try {
        await markCoworkSessionServed(cliSessionId);
      } catch (error) {
        logger.warn('[client-attribution] Served mark not written; retried at the next request of the session', {
          cliSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return false;
  }
}
