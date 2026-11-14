/**
 * Spool delivery summary: a read failure marks the summary incomplete instead of reporting an empty spool.
 * @group unit
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../spool-paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spool-paths.js')>()),
  listSessionIds: vi.fn().mockRejectedValue(new Error('boom')),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { summarizeSpoolDelivery } from '../delivery-summary.js';

describe('summarizeSpoolDelivery when the spool cannot be read', () => {
  it('marks the summary incomplete so zero pending bytes is not read as none', async () => {
    expect(await summarizeSpoolDelivery()).toEqual({ pendingBytes: 0, mismatchHeld: false, incomplete: true });
  });
});
