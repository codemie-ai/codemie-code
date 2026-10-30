import { mkdtemp, readFile, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { readMarker, writeMarker } from '../marker.js';

describe('marker', () => {
  let dir: string;
  let markerPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codemie-sync-marker-'));
    markerPath = join(dir, 'analytics-last-sent');
  });

  describe('readMarker', () => {
    it('returns null when the marker file is missing (ENOENT)', async () => {
      const now = new Date('2026-10-29T00:00:00.000Z');
      await expect(readMarker(now, markerPath)).resolves.toBeNull();
    });

    it('falls back to the file mtime when the content is empty', async () => {
      await writeFile(markerPath, '', 'utf-8');
      const fileMtime = (await stat(markerPath)).mtime;
      const now = new Date(fileMtime.getTime() + 60_000);

      await expect(readMarker(now, markerPath)).resolves.toEqual(fileMtime);
    });

    it('falls back to the file mtime when the content is invalid', async () => {
      await writeFile(markerPath, 'garbage', 'utf-8');
      const fileMtime = (await stat(markerPath)).mtime;
      const now = new Date(fileMtime.getTime() + 60_000);

      await expect(readMarker(now, markerPath)).resolves.toEqual(fileMtime);
    });

    it('returns null when the ISO content lies in the future relative to now', async () => {
      const now = new Date('2026-10-29T00:00:00.000Z');
      const future = new Date('2026-10-30T00:00:00.000Z');
      await writeFile(markerPath, future.toISOString(), 'utf-8');

      await expect(readMarker(now, markerPath)).resolves.toBeNull();
    });

    it('returns the parsed ISO date when it is valid and in the past', async () => {
      const now = new Date('2026-10-29T00:00:00.000Z');
      const past = new Date('2026-10-20T00:00:00.000Z');
      await writeFile(markerPath, past.toISOString(), 'utf-8');

      await expect(readMarker(now, markerPath)).resolves.toEqual(past);
    });
  });

  describe('writeMarker', () => {
    it('writes the ISO timestamp with file mode 0600', async () => {
      const at = new Date('2026-10-29T12:00:00.000Z');
      await writeMarker(at, markerPath);

      const content = await readFile(markerPath, 'utf-8');
      expect(content).toBe(at.toISOString());

      if (process.platform !== 'win32') {
        const mode = (await stat(markerPath)).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('round-trips through readMarker', async () => {
      const at = new Date('2026-10-29T12:00:00.000Z');
      const now = new Date('2026-10-29T13:00:00.000Z');
      await writeMarker(at, markerPath);

      await expect(readMarker(now, markerPath)).resolves.toEqual(at);
    });
  });
});
