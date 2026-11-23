import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAnalyticsSettings } from '../analytics-settings.js';

let home: string;
let project: string;
let savedHome: string | undefined;
let tick = 1_700_000_000;

function writeGlobal(content: string): void {
  const file = join(home, 'codemie-cli.config.json');
  writeFileSync(file, content);
  utimesSync(file, ++tick, tick);
}

function writeProject(content: string): void {
  mkdirSync(join(project, '.codemie'), { recursive: true });
  const file = join(project, '.codemie', 'codemie-cli.config.json');
  writeFileSync(file, content);
  utimesSync(file, ++tick, tick);
}

const cfg = (analytics: Record<string, string>): string =>
  JSON.stringify({ version: 2, activeProfile: 'default', profiles: {}, analytics });

beforeEach(() => {
  savedHome = process.env.CODEMIE_HOME;
  home = mkdtempSync(join(tmpdir(), 'cm-home-'));
  project = mkdtempSync(join(tmpdir(), 'cm-proj-'));
  process.env.CODEMIE_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('resolveAnalyticsSettings', () => {
  it('defaults to off with no tracker', () => {
    expect(resolveAnalyticsSettings(project)).toEqual({ obfuscation: 'off' });
  });

  it('project on + global off gives on', () => {
    writeGlobal(cfg({ obfuscation: 'off' }));
    writeProject(cfg({ obfuscation: 'on' }));
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('on');
  });

  it('project off + global on gives on', () => {
    writeGlobal(cfg({ obfuscation: 'on' }));
    writeProject(cfg({ obfuscation: 'off' }));
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('on');
  });

  it('resolves ticketTracker project over global and ignores invalid values', () => {
    writeGlobal(cfg({ ticketTracker: 'github' }));
    expect(resolveAnalyticsSettings(project).ticketTracker).toBe('github');
    writeProject(cfg({ ticketTracker: 'gitlab' }));
    expect(resolveAnalyticsSettings(project).ticketTracker).toBe('gitlab');
    writeProject(cfg({ ticketTracker: 'bogus' }));
    expect(resolveAnalyticsSettings(project).ticketTracker).toBe('github');
  });

  it('stays on when the config becomes unreadable after an on read (AC15)', () => {
    writeProject(cfg({ obfuscation: 'on' }));
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('on');
    writeProject('{ not json');
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('on');
  });

  it('stays on when another layer was on and this one is unreadable', () => {
    writeGlobal(cfg({ obfuscation: 'on' }));
    writeProject('{ not json');
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('on');
  });

  it('re-reads when the config mtime changes', () => {
    writeProject(cfg({ obfuscation: 'on' }));
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('on');
    writeProject(cfg({ obfuscation: 'off' }));
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('off');
  });

  it('keeps on when the config file is deleted after an on read', () => {
    writeGlobal(cfg({ obfuscation: 'on' }));
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('on');
    rmSync(join(home, 'codemie-cli.config.json'));
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('on');
  });

  it('treats a config that cannot be parsed on first read as on', () => {
    writeProject('{ not json');
    expect(resolveAnalyticsSettings(project).obfuscation).toBe('on');
  });

  it('skips the project layer for a missing cwd instead of throwing', () => {
    writeGlobal(cfg({ obfuscation: 'off' }));
    expect(resolveAnalyticsSettings(undefined).obfuscation).toBe('off');
  });
});
