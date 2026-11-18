/**
 * VS Code BYOK remover.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeVsCodeLanguageModelsConfigAtPath } from '../connectors/vscode.js';

describe('removeVsCodeLanguageModelsConfigAtPath', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vscode-remove-'));
    file = join(dir, 'chatLanguageModels.json');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const codemie = (url: string) => ({
    name: 'CodeMie', vendor: 'customendpoint', models: [{ id: 'm', url }],
  });
  const mine = { name: 'Mine', vendor: 'customendpoint', models: [{ id: 'x', url: 'https://example.com/v1' }] };

  it('removes the loopback CodeMie provider and keeps user providers', async () => {
    await writeFile(file, JSON.stringify([mine, codemie('http://localhost:4001/v1/chat')]));
    expect(await removeVsCodeLanguageModelsConfigAtPath(file)).toEqual({ removed: true });
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([mine]);
  });

  it('keeps a CodeMie provider whose model URL is not loopback', async () => {
    const content = JSON.stringify([codemie('https://codemie.example.com/v1')]);
    await writeFile(file, content);
    expect(await removeVsCodeLanguageModelsConfigAtPath(file)).toEqual({ removed: false });
    expect(await readFile(file, 'utf-8')).toBe(content);
  });

  it('keeps a CodeMie provider when any one model URL is not loopback', async () => {
    const mixed = { name: 'CodeMie', vendor: 'customendpoint', models: [
      { id: 'a', url: 'http://127.0.0.1:4001/v1' }, { id: 'b', url: 'https://example.com/v1' },
    ] };
    await writeFile(file, JSON.stringify([mixed]));
    expect(await removeVsCodeLanguageModelsConfigAtPath(file)).toEqual({ removed: false });
  });

  it('is a no-op when the file does not exist', async () => {
    expect(await removeVsCodeLanguageModelsConfigAtPath(file)).toEqual({ removed: false });
  });
});
