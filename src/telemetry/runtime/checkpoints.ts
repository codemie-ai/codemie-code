import type { Session } from '@/agents/core/session/types.js';

export interface RuntimeCheckpoint {
  externalSessionId: string;
  transcriptPath: string;
  lastDiscoveredAt: number;
  lastSeenActivityAt?: number;
}

export function getRuntimeCheckpoint(session: Session): RuntimeCheckpoint | undefined {
  return session.runtimeCheckpoint;
}

export function setRuntimeCheckpoint(
  session: Session,
  checkpoint: RuntimeCheckpoint
): Session {
  session.runtimeCheckpoint = checkpoint;
  return session;
}
