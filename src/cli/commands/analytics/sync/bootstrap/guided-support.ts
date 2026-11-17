/**
 * Helpers shared by the guided wizard's steps 1-4 (`./guided.ts`) and steps 5-8
 * (`./guided-late-steps.ts`).
 */

import { SyncConfigError } from '@/utils/errors.js';

import { BootstrapInputError } from './links.js';
import type { BootstrapState } from './state-store.js';
import type { BootstrapDeps } from './types.js';

/** Persists a patch onto the in-flight wizard state, both in memory and on disk, after
 * every step (spec.md "State is saved after every step"). */
export type SaveBootstrapState = (patch: Partial<BootstrapState>) => Promise<void>;

/**
 * Calls `deps.prompt.input(message, def)` in a loop, retrying on a {@link
 * BootstrapInputError} or {@link SyncConfigError} (printed to `deps.err`) until `validate`
 * accepts the answer — the two error classes steps 1-4 (`links.ts`, `timezones.ts`) and
 * steps 5-7 (`config-store.ts`'s trigger-URL and lookback validators) throw on a bad
 * answer. Any other thrown error propagates — it is a bug, not a bad answer.
 */
export async function askValidated<T>(
  deps: BootstrapDeps,
  message: string,
  validate: (raw: string) => T,
  def?: string
): Promise<T> {
  for (;;) {
    const raw = await deps.prompt.input(message, def);
    try {
      return validate(raw);
    } catch (err) {
      if (!(err instanceof BootstrapInputError) && !(err instanceof SyncConfigError)) {
        throw err;
      }
      deps.err(err.message);
    }
  }
}
