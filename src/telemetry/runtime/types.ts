import type { AggregatedResult, ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';

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
}
