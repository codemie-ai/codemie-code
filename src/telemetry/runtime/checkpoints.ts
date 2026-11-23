import type { Session } from '@/agents/core/session/types.js';

export interface RuntimeCheckpoint {
  externalSessionId: string;
  transcriptPath: string;
  lastDiscoveredAt: number;
  lastSeenActivityAt?: number;
  /**
   * Set when a chat unknown to CodeMie is first adopted although it was created before the
   * daemon started. Transcript content written before this time is marked as already synced
   * instead of being backfilled; the marker is cleared once that baseline is applied.
   */
  baselineCutoffMs?: number;
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
