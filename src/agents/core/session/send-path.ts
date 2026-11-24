/**
 * The send path: where a launch sends requests that carry SSO credentials, and the hook config a
 * reconciled record is processed with.
 */
import type { HookProcessingConfig } from '@/cli/commands/hook.js';
import type { Session } from './types.js';

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * This launch can send: a CodeMie URL and the API the end metric goes to — `CODEMIE_SYNC_API_URL`,
 * or `CODEMIE_BASE_URL` only when it is the started proxy (`CODEMIE_TARGET_API_URL` set): otherwise
 * it is the profile's upstream LLM host, which must never get the SSO cookies.
 */
export function hasSendPath(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CODEMIE_URL && (env.CODEMIE_SYNC_API_URL || (env.CODEMIE_BASE_URL && env.CODEMIE_TARGET_API_URL)));
}

/** The API a request with SSO credentials goes to: this launch's send path, else undefined. */
export function sendPathApiUrl(env: NodeJS.ProcessEnv): string | undefined {
  return hasSendPath(env) ? env.CODEMIE_SYNC_API_URL || env.CODEMIE_BASE_URL : undefined;
}

export function sameHost(record: Session, env: NodeJS.ProcessEnv): boolean {
  const recordHost = hostOf(record.codemieUrl);
  return recordHost !== undefined && recordHost === hostOf(env.CODEMIE_URL);
}

/** A record's client type, else its own agent's: the launch delivering it may run another agent. */
async function recordClientType(record: Session): Promise<string | undefined> {
  if (record.clientType) return record.clientType;
  // Lazy: the registry loads the plugins, which import this module
  const { AgentRegistry } = await import('../../registry.js');
  return AgentRegistry.getAgent(record.agentName)?.metadata.ssoConfig?.clientType;
}

/**
 * The config a record is processed with: its own agent / provider / project / client type / model,
 * this launch's URL and send path when it delivers, none when it is finalized locally.
 */
export async function recordHookConfig(
  record: Session,
  env: NodeJS.ProcessEnv,
  options: { deliver: boolean; abortSignal?: AbortSignal; deadlineMs?: number }
): Promise<HookProcessingConfig> {
  const clientType = await recordClientType(record);
  return {
    agentName: record.agentName,
    sessionId: record.sessionId,
    provider: record.provider,
    ...(record.project && { project: record.project }),
    ...(clientType && { clientType }),
    ...(record.model && { model: record.model }),
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    ...(options.deliver
      ? {
        apiBaseUrl: env.CODEMIE_BASE_URL,
        ssoUrl: env.CODEMIE_URL,
        syncApiUrl: env.CODEMIE_SYNC_API_URL,
        env,
      }
      : { localOnly: true }),
    ...(options.abortSignal && { abortSignal: options.abortSignal }),
    ...(options.deadlineMs !== undefined && { deadlineMs: options.deadlineMs }),
    holdsReconcileLock: true,
  };
}
