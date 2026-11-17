import type { AggregatedResult, ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';
import type { DesktopRepositoryResolver } from '@/telemetry/runtime/DesktopRepositoryResolver.js';
import type { DesktopGateway } from '@/telemetry/clients/claude-desktop/claude-desktop.gateway.js';

export interface LocalTelemetryDiscoveredSession {
  externalSessionId: string;
  agentSessionId: string;
  transcriptPath: string;
  metadataPath: string;
  workingDirectory: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  isArchived?: boolean;
}

export interface DesktopTelemetryRuntimeConfig {
  clientType: string;
  targetApiUrl: string;
  provider: string;
  version: string;
  profile?: string;
  syncApiUrl?: string;
  syncCodeMieUrl?: string;
  pollIntervalMs: number;
  inactivityTimeoutMs: number;
  repositoryResolver?: DesktopRepositoryResolver;
  /** The daemon's port and gateway key: Desktop is collected while its applied config points at both. */
  port: number;
  gatewayKey: string;
  /** Reads Desktop's applied gateway on each poll; default: the real config. */
  readDesktopGateway?: () => Promise<DesktopGateway | null>;
  /**
   * Told each time Desktop turns connected (the time collection counts from, ISO) or not connected (undefined);
   * awaited, a failure logged.
   */
  onDesktopConnectedChange?: (connectedSince: string | undefined) => Promise<void>;
}

export interface LocalTelemetryAdapter {
  readonly clientType: string;
  discoverSessions(sinceMs: number): Promise<LocalTelemetryDiscoveredSession[]>;
  parseSession(
    discovered: LocalTelemetryDiscoveredSession,
    codemieSessionId: string
  ): Promise<ParsedSession>;
  processParsedSession(
    parsedSession: ParsedSession,
    context: ProcessingContext
  ): Promise<AggregatedResult>;
  isSessionComplete?(discovered: LocalTelemetryDiscoveredSession, now: number): boolean;
  /**
   * Marks transcript content written before `cutoffMs` as already synced, without sending it,
   * and clears the session's baseline marker.
   */
  applyBaseline?(parsedSession: ParsedSession, cutoffMs: number, context: ProcessingContext): Promise<void>;
}
