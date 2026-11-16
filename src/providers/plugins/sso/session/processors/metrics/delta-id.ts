import { createHash } from 'crypto';

/** A stable id for a set of metric deltas: a hash of their sorted record ids, whatever the order they are given in. */
export function deltaIdOf(recordIds: readonly string[]): string {
  return createHash('sha256').update([...recordIds].sort().join('\n')).digest('hex').slice(0, 32);
}
