import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getCopilotConnectorsConfigPath,
  readCopilotConnectorScope,
  writeCopilotConnectorScope,
  isCopilotProjectTracked,
  type CopilotConnectorScope,
} from '../copilot-connector-scope.js';

const CONNECTOR_ID = 'copilot-chat-otlp';
const OTHER_CONNECTOR_ID = 'copilot-cli-otlp';

async function writeRaw(content: string): Promise<void> {
  const path = getCopilotConnectorsConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

describe('copilot-connector-scope', () => {
  beforeEach(async () => {
    await rm(getCopilotConnectorsConfigPath(), { force: true });
  });

  afterEach(async () => {
    await rm(getCopilotConnectorsConfigPath(), { force: true });
  });

  describe('readCopilotConnectorScope (fail-closed)', () => {
    it('treats an absent config file as disabled', async () => {
      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'ok', value: { enabled: false } });
    });

    it('treats an empty config file as disabled', async () => {
      await writeRaw('');
      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'ok', value: { enabled: false } });
    });

    it('treats unparsable JSON as corrupt', async () => {
      await writeRaw('{ not json');
      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'corrupt' });
    });

    it('treats a non-object top level (array) as corrupt', async () => {
      await writeRaw(JSON.stringify([1, 2, 3]));
      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'corrupt' });
    });

    it('treats a missing version or connectors field as corrupt', async () => {
      await writeRaw(JSON.stringify({ connectors: {} }));
      expect(await readCopilotConnectorScope(CONNECTOR_ID)).toEqual({ kind: 'corrupt' });

      await writeRaw(JSON.stringify({ version: 1 }));
      expect(await readCopilotConnectorScope(CONNECTOR_ID)).toEqual({ kind: 'corrupt' });
    });

    it('treats an absent connector key as disabled, even when other connectors are configured', async () => {
      await writeRaw(JSON.stringify({ version: 1, connectors: { [OTHER_CONNECTOR_ID]: { enabled: true, scope: 'user' } } }));
      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'ok', value: { enabled: false } });
    });

    it('treats a malformed connector record as corrupt', async () => {
      await writeRaw(JSON.stringify({ version: 1, connectors: { [CONNECTOR_ID]: { enabled: true, scope: 'project' } } }));
      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'corrupt' });
    });

    it('treats scope:"project" with a non-string/empty path entry as corrupt', async () => {
      await writeRaw(
        JSON.stringify({ version: 1, connectors: { [CONNECTOR_ID]: { enabled: true, scope: 'project', paths: ['', '/ok'] } } })
      );
      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'corrupt' });
    });

    it('reads a valid user-scope record', async () => {
      await writeRaw(JSON.stringify({ version: 1, connectors: { [CONNECTOR_ID]: { enabled: true, scope: 'user' } } }));
      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'ok', value: { enabled: true, scope: 'user' } });
    });

    it('reads a valid project-scope record', async () => {
      await writeRaw(
        JSON.stringify({ version: 1, connectors: { [CONNECTOR_ID]: { enabled: true, scope: 'project', paths: ['/repo-a'] } } })
      );
      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'ok', value: { enabled: true, scope: 'project', paths: ['/repo-a'] } });
    });
  });

  describe('isCopilotProjectTracked (fail-closed)', () => {
    it('is not tracked when the scope read is corrupt', async () => {
      expect(await isCopilotProjectTracked('/repo', { kind: 'corrupt' })).toBe(false);
    });

    it('is not tracked when disabled', async () => {
      expect(await isCopilotProjectTracked('/repo', { kind: 'ok', value: { enabled: false } })).toBe(false);
    });

    it('is tracked for every project when scope is "user"', async () => {
      expect(await isCopilotProjectTracked('/anything', { kind: 'ok', value: { enabled: true, scope: 'user' } })).toBe(true);
      expect(await isCopilotProjectTracked(undefined, { kind: 'ok', value: { enabled: true, scope: 'user' } })).toBe(true);
    });

    it('is not tracked for scope "project" when cwd is missing', async () => {
      const scope: CopilotConnectorScope = { enabled: true, scope: 'project', paths: ['/repo-a'] };
      expect(await isCopilotProjectTracked(undefined, { kind: 'ok', value: scope })).toBe(false);
      expect(await isCopilotProjectTracked('', { kind: 'ok', value: scope })).toBe(false);
    });

    it('is tracked for scope "project" when cwd is nested under a tracked path', async () => {
      const scope: CopilotConnectorScope = { enabled: true, scope: 'project', paths: [process.cwd()] };
      expect(await isCopilotProjectTracked(process.cwd(), { kind: 'ok', value: scope })).toBe(true);
    });

    it('is not tracked for scope "project" when cwd sits outside every tracked path', async () => {
      const scope: CopilotConnectorScope = { enabled: true, scope: 'project', paths: [`${process.cwd()}-unrelated-sibling`] };
      expect(await isCopilotProjectTracked(process.cwd(), { kind: 'ok', value: scope })).toBe(false);
    });
  });

  describe('writeCopilotConnectorScope', () => {
    it('creates the config file atomically with the written connector record', async () => {
      await writeCopilotConnectorScope(CONNECTOR_ID, { enabled: true, scope: 'user' });

      const result = await readCopilotConnectorScope(CONNECTOR_ID);
      expect(result).toEqual({ kind: 'ok', value: { enabled: true, scope: 'user' } });

      const onDisk = JSON.parse(await readFile(getCopilotConnectorsConfigPath(), 'utf-8'));
      expect(onDisk.version).toBe(1);
    });

    it("preserves another connector's record on a merge-write", async () => {
      await writeCopilotConnectorScope(OTHER_CONNECTOR_ID, { enabled: true, scope: 'user' });
      await writeCopilotConnectorScope(CONNECTOR_ID, { enabled: true, scope: 'project', paths: ['/repo-a'] });

      expect(await readCopilotConnectorScope(OTHER_CONNECTOR_ID)).toEqual({ kind: 'ok', value: { enabled: true, scope: 'user' } });
      expect(await readCopilotConnectorScope(CONNECTOR_ID)).toEqual({
        kind: 'ok',
        value: { enabled: true, scope: 'project', paths: ['/repo-a'] },
      });
    });

    it('refuses to overwrite a corrupt config file, leaving it unchanged', async () => {
      await writeRaw('{ not json');

      await expect(writeCopilotConnectorScope(CONNECTOR_ID, { enabled: true, scope: 'user' })).rejects.toThrow();

      const onDisk = await readFile(getCopilotConnectorsConfigPath(), 'utf-8');
      expect(onDisk).toBe('{ not json');
    });

    it('overwrites an existing record for the same connector', async () => {
      await writeCopilotConnectorScope(CONNECTOR_ID, { enabled: true, scope: 'user' });
      await writeCopilotConnectorScope(CONNECTOR_ID, { enabled: false });

      expect(await readCopilotConnectorScope(CONNECTOR_ID)).toEqual({ kind: 'ok', value: { enabled: false } });
    });
  });
});
