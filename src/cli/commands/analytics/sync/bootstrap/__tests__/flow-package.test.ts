import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildFlowPackage,
  FLOW_PACKAGE_FILENAME,
  resolveFlowTemplateDir,
  writeFlowPackage,
  type FlowConfigInputs
} from '../flow-package.js';

const INPUTS: FlowConfigInputs = {
  siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
  folderPath: 'Shared Documents/CodeMie "exports"',
  teamId: '11111111-2222-3333-4444-555555555555',
  channelId: '19:abcDEF123@thread.tacv2',
  timeZone: 'W. Europe Standard Time'
};

const templateDir = resolveFlowTemplateDir();
const TEMPLATE_FILES = [
  'manifest.json',
  'Microsoft.Flow/flows/manifest.json',
  'Microsoft.Flow/flows/3806f7f4-f5aa-4ecc-a271-e0171d1ae740/apisMap.json',
  'Microsoft.Flow/flows/3806f7f4-f5aa-4ecc-a271-e0171d1ae740/connectionsMap.json',
  'Microsoft.Flow/flows/3806f7f4-f5aa-4ecc-a271-e0171d1ae740/definition.json'
];
const DEFINITION_PATH = 'Microsoft.Flow/flows/3806f7f4-f5aa-4ecc-a271-e0171d1ae740/definition.json';

describe('resolveFlowTemplateDir', () => {
  it('resolves to an existing flow-template directory next to this module', () => {
    expect(templateDir.endsWith('flow-template')).toBe(true);
  });
});

describe('buildFlowPackage', () => {
  it('holds exactly the 5 template paths', async () => {
    const entries = unzipSync(await buildFlowPackage(INPUTS, templateDir));
    expect(Object.keys(entries).sort()).toEqual([...TEMPLATE_FILES].sort());
  });

  it('sets Flow_config.inputs on definition.json to the given inputs', async () => {
    const entries = unzipSync(await buildFlowPackage(INPUTS, templateDir));
    const definition = JSON.parse(Buffer.from(entries[DEFINITION_PATH]).toString('utf-8'));
    expect(definition.properties.definition.actions.Flow_config.inputs).toEqual(INPUTS);
  });

  it('leaves the other 4 files byte-identical to the template', async () => {
    const entries = unzipSync(await buildFlowPackage(INPUTS, templateDir));
    for (const name of TEMPLATE_FILES) {
      if (name === DEFINITION_PATH) continue;
      const original = readFileSync(join(templateDir, name));
      expect(Buffer.from(entries[name])).toEqual(original);
    }
  });

  it('never holds a webhook URL or signature', async () => {
    const entries = unzipSync(await buildFlowPackage(INPUTS, templateDir));
    for (const [name, data] of Object.entries(entries)) {
      const text = Buffer.from(data).toString('utf-8');
      expect(text, `${name} contains sig=`).not.toMatch(/sig=/);
      expect(text, `${name} contains a trigger URL`).not.toMatch(/https:\/\/\S*trigger/i);
    }
  });

  it('throws ConfigurationError-shaped error when the template directory is missing', async () => {
    await expect(buildFlowPackage(INPUTS, join(templateDir, 'does-not-exist'))).rejects.toThrow();
  });
});

describe('writeFlowPackage', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-package-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the package to <dir>/codemie-analytics-flow.zip, not overwriting on first write', async () => {
    const result = await writeFlowPackage(dir, INPUTS);
    expect(result.path).toBe(join(dir, FLOW_PACKAGE_FILENAME));
    expect(result.overwritten).toBe(false);

    const entries = unzipSync(readFileSync(result.path));
    expect(Object.keys(entries).sort()).toEqual([...TEMPLATE_FILES].sort());
  });

  it('reports overwritten: true on a second write into the same directory', async () => {
    await writeFlowPackage(dir, INPUTS);
    const second = await writeFlowPackage(dir, INPUTS);
    expect(second.overwritten).toBe(true);
  });
});
