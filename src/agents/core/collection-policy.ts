import type { CollectionPolicy } from './types.js';

/** Runs every step it is handed as the adapter gave it: the collection of a machine with a CodeMie backend. */
export class BackendPolicy implements CollectionPolicy {
  admit(_sessionId: string | undefined, gate: () => Promise<'continue' | 'stop' | 'retry-after-proxy-start'>): Promise<'continue' | 'stop' | 'retry-after-proxy-start'> {
    return gate();
  }

  async evidenceInputs<T>(build: () => Promise<T>): Promise<T | undefined> {
    return build();
  }

  authorize<T>(check: () => Promise<T>): Promise<T> {
    return check();
  }

  onUntracked(_sessionId: string | undefined, _byFilter: boolean, stopMarker: () => Promise<void>): Promise<void> {
    return stopMarker();
  }

  scopeCorruptReason(): string {
    return 'connector scope configuration is corrupt; repair it and reconnect';
  }
}
