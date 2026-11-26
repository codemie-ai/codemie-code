/**
 * The hooks' decisions in the local mode: no sign-in, no evidence stamp; a session is gathered when the
 * `--include-external` answer allows it, and never once it fired a hook in a folder the developer's filters leave out.
 */
import { getCopilotConnectorsConfigPath } from '@/agents/core/copilot-connector-scope.js';
import type { CollectionPolicy } from '@/agents/core/types.js';
import {
  isSessionExcluded,
  markSessionExcluded,
} from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-exclusion-mark.js';

export class LocalPolicy implements CollectionPolicy {
  /** `includeExternalNow` — the `--include-external` answer for this platform: every session may be gathered. */
  constructor(private readonly includeExternalNow: boolean) {}

  /** The adapter's own gate is never run: a stop writes nothing and starts no daemon. */
  async admit(
    sessionId: string | undefined,
    _gate: () => Promise<'continue' | 'stop' | 'retry-after-proxy-start'>
  ): Promise<'continue' | 'stop'> {
    if (await isSessionExcluded(sessionId)) return 'stop';
    return this.includeExternalNow ? 'continue' : 'stop';
  }

  /** No evidence inputs: nothing is stamped, held for an owner or checked against a record. */
  async evidenceInputs<T>(_build: () => Promise<T>): Promise<T | undefined> {
    return undefined;
  }

  /** No sign-in: the adapter's "ok" answer. */
  async authorize<T>(_check: () => Promise<T>, allowed: T): Promise<T> {
    return allowed;
  }

  /**
   * Marks the session excluded only when the developer's filters left it out, then runs the adapter's own step — that
   * step runs even when the mark cannot be written, and the mark's error still rejects after it.
   */
  async onUntracked(sessionId: string | undefined, byFilter: boolean, stopMarker: () => Promise<void>): Promise<void> {
    try {
      if (byFilter) await markSessionExcluded(sessionId);
    } finally {
      await stopMarker();
    }
  }

  /** Names the install, not a reconnect: the local mode refuses `proxy connect`. */
  scopeCorruptReason(): string {
    return `connector scope configuration is corrupt; fix or delete ${getCopilotConnectorsConfigPath()} and run \`codemie analytics sync install\``;
  }
}
