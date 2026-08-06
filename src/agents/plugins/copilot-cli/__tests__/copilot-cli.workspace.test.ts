/**
 * workspace.yaml manifest reader unit tests.
 *
 * workspace.yaml is the discovery manifest for a Copilot CLI session — present in every
 * session directory, including ones with no transcript.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceManifest } from '../copilot-cli.workspace.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copilot-ws-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readWorkspaceManifest', () => {
  it('returns null when workspace.yaml is absent', () => {
    const dir = join(root, 'no-manifest');
    mkdirSync(dir);
    expect(readWorkspaceManifest(dir)).toBeNull();
  });

  it('parses a full manifest into epoch-ms timestamps', () => {
    const dir = join(root, '11111111-2222-3333-4444-555555555555');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'workspace.yaml'),
      [
        'id: 11111111-2222-3333-4444-555555555555',
        'cwd: /Users/x/repo',
        'git_root: /Users/x/repo',
        'repository: example-org/example-repo',
        'host_type: github',
        'branch: feat/example',
        'user_named: false',
        'summary_count: 0',
        'created_at: 2026-06-16T06:21:01.974Z',
        'updated_at: 2026-06-16T06:21:05.138Z',
        'name: example session title',
      ].join('\n')
    );

    const m = readWorkspaceManifest(dir);
    expect(m).not.toBeNull();
    expect(m!.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(m!.cwd).toBe('/Users/x/repo');
    expect(m!.gitRoot).toBe('/Users/x/repo');
    expect(m!.repository).toBe('example-org/example-repo');
    expect(m!.hostType).toBe('github');
    expect(m!.branch).toBe('feat/example');
    expect(m!.createdAt).toBe(Date.parse('2026-06-16T06:21:01.974Z'));
    expect(m!.updatedAt).toBe(Date.parse('2026-06-16T06:21:05.138Z'));
    expect(m!.name).toBe('example session title');
  });

  it('tolerates an older manifest missing host_type and name', () => {
    const dir = join(root, 'legacy');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'workspace.yaml'),
      ['id: legacy', 'cwd: /repo', 'created_at: 2026-01-29T10:59:02.482Z'].join('\n')
    );

    const m = readWorkspaceManifest(dir);
    expect(m).not.toBeNull();
    expect(m!.id).toBe('legacy');
    expect(m!.repository).toBeUndefined();
    expect(m!.branch).toBeUndefined();
    expect(m!.updatedAt).toBeUndefined();
  });

  it('returns null when the manifest carries no session id', () => {
    const dir = join(root, 'no-id');
    mkdirSync(dir);
    writeFileSync(join(dir, 'workspace.yaml'), 'cwd: /repo\n');
    expect(readWorkspaceManifest(dir)).toBeNull();
  });

  it('returns null on malformed YAML instead of throwing', () => {
    const dir = join(root, 'broken');
    mkdirSync(dir);
    writeFileSync(join(dir, 'workspace.yaml'), 'id: [unclosed\n  : :');
    expect(readWorkspaceManifest(dir)).toBeNull();
  });

  it('leaves timestamps undefined when they are unparseable', () => {
    const dir = join(root, 'bad-dates');
    mkdirSync(dir);
    writeFileSync(join(dir, 'workspace.yaml'), ['id: bad-dates', 'created_at: not-a-date'].join('\n'));

    const m = readWorkspaceManifest(dir);
    expect(m!.createdAt).toBeUndefined();
  });
});
