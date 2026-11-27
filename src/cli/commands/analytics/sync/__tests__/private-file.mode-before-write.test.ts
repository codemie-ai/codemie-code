import { chmod, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writePrivateText } from '../private-file.js';

/** The target's mode at the moment the atomic writer is called; the writer itself is the real one. */
const modeAtWrite = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock('@/utils/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/atomic-write.js')>();
  const fs = await import('fs/promises');
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      modeAtWrite.value = (await fs.stat(args[0])).mode & 0o777;
      return actual.writeFileAtomic(...args);
    },
  };
});

describe('writePrivateText', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'private-file-mode-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('narrows a wider-mode file before the new content is written', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, '{}', 'utf-8');
    await chmod(path, 0o644);

    await writePrivateText(path, 'secret');

    expect(modeAtWrite.value).toBe(0o600);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
