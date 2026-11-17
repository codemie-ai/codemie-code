import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncConnectorHookFile } from '../copilot-cli.plugin.js';
import { buildHookFileContent } from '../../../../cli/commands/proxy/connectors/copilot-cli-otlp.js';

const HOOK = join('hooks', 'codemie-copilot-cli-hooks.json');
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

let home: string;
let defaultHome: string;
let override: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cop-sync-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  defaultHome = join(home, '.copilot');
  override = join(home, 'elsewhere');
  mkdirSync(join(defaultHome, 'hooks'), { recursive: true });
});

afterEach(() => {
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
  rmSync(home, { recursive: true, force: true });
});

const expected = (): string => `${JSON.stringify(buildHookFileContent(), null, 2)}\n`;

describe('syncConnectorHookFile', () => {
  it('writes the CodeMie hook file into an overridden COPILOT_HOME when the connector is installed', async () => {
    writeFileSync(join(defaultHome, HOOK), '{"stale":true}');
    await syncConnectorHookFile(override);
    expect(readFileSync(join(override, HOOK), 'utf-8')).toBe(expected());
    expect(readFileSync(join(defaultHome, HOOK), 'utf-8')).toBe('{"stale":true}');
  });

  it('does nothing when the connector hook file does not exist in the default home', async () => {
    await syncConnectorHookFile(override);
    expect(existsSync(join(override, HOOK))).toBe(false);
  });

  it('does nothing when COPILOT_HOME is the default home, including a differently cased path', async () => {
    writeFileSync(join(defaultHome, HOOK), '{}');
    await syncConnectorHookFile(defaultHome);
    await syncConnectorHookFile(`${defaultHome}${process.platform === 'win32' ? '\\' : '/'}`);
    if (process.platform === 'win32') await syncConnectorHookFile(defaultHome.toUpperCase());
    expect(readFileSync(join(defaultHome, HOOK), 'utf-8')).toBe('{}');
  });

  it('leaves an up-to-date file untouched and never deletes anything', async () => {
    writeFileSync(join(defaultHome, HOOK), '{}');
    await syncConnectorHookFile(override);
    const before = statSync(join(override, HOOK)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await syncConnectorHookFile(override);
    expect(statSync(join(override, HOOK)).mtimeMs).toBe(before);
    expect(existsSync(join(defaultHome, HOOK))).toBe(true);
  });
});
