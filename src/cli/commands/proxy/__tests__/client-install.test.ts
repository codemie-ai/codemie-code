/**
 * Client app install (download, check, install into ~/Applications).
 * The install tests drive the real ditto / hdiutil / codesign, so they only run on macOS.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { TempWorkspace } from '../../../../../tests/helpers/temp-workspace.js';
import {
  ClientInstallError,
  CLIENT_SPECS,
  downloadToFile,
  findInstalledClient,
  installClient,
  parseClaudeReleases,
  parseTeamIdentifier,
  parseVsCodeLatest,
  type ClientSpec,
} from '../client-install.js';

const isMac = process.platform === 'darwin';

/** fetch that serves `bytes` for any URL. */
function serving(bytes: Uint8Array): typeof fetch {
  return (async () => new Response(bytes)) as typeof fetch;
}

describe('download sources', () => {
  it('reads the VS Code zip URL and its checksum', () => {
    const got = parseVsCodeLatest({ url: 'https://x/VSCode-darwin-universal.zip', sha256hash: 'abc', productVersion: '1.140.0' });
    expect(got).toEqual({ url: 'https://x/VSCode-darwin-universal.zip', sha256: 'abc' });
  });

  it('refuses VS Code update info without a checksum', () => {
    expect(() => parseVsCodeLatest({ url: 'https://x/a.zip' })).toThrow();
    expect(() => parseVsCodeLatest({ url: 'https://x/a.zip', sha256hash: '' })).toThrow();
  });

  it('takes the current release from the Claude feed', () => {
    const feed = {
      currentRelease: '2.2.0',
      releases: [
        { version: '2.1.0', updateTo: { url: 'https://x/old.zip' } },
        { version: '2.2.0', updateTo: { url: 'https://x/new.zip' } },
      ],
    };
    expect(parseClaudeReleases(feed)).toBe('https://x/new.zip');
    expect(() => parseClaudeReleases({ releases: [] })).toThrow();
  });

  it('expects each vendor team and a download page for every app', () => {
    expect(CLIENT_SPECS.vscode.teamId).toBe('UBF8T346G9');
    expect(CLIENT_SPECS['claude-desktop'].teamId).toBe('Q6L2SF6YDW');
    expect(CLIENT_SPECS['codex-desktop'].teamId).toBe('2DC432GLL2');
    expect(CLIENT_SPECS['codex-desktop'].bundle).toBe('ChatGPT.app');
    for (const spec of Object.values(CLIENT_SPECS)) expect(spec.downloadPage).toMatch(/^https:\/\//);
  });
});

describe('codesign output', () => {
  it('reads the team identifier', () => {
    expect(parseTeamIdentifier('Identifier=com.microsoft.VSCode\nTeamIdentifier=UBF8T346G9\n')).toBe('UBF8T346G9');
    expect(parseTeamIdentifier('code object is not signed at all')).toBeNull();
  });
});

describe('findInstalledClient', () => {
  let ws: TempWorkspace;
  beforeEach(() => { ws = new TempWorkspace('codemie-client-find-'); });
  afterEach(() => ws.cleanup());

  it('finds the bundle in any of the given folders, else null', () => {
    const a = join(ws.path, 'a');
    const b = join(ws.path, 'b');
    mkdirSync(join(b, 'Claude.app'), { recursive: true });
    expect(findInstalledClient(CLIENT_SPECS['claude-desktop'], [a, b])).toBe(join(b, 'Claude.app'));
    expect(findInstalledClient(CLIENT_SPECS.vscode, [a, b])).toBeNull();
  });
});

describe('downloadToFile', () => {
  let ws: TempWorkspace;
  beforeEach(() => { ws = new TempWorkspace('codemie-client-dl-'); });
  afterEach(() => ws.cleanup());

  const bytes = new TextEncoder().encode('hello');
  const sha = createHash('sha256').update('hello').digest('hex');

  it('writes the file when the checksum matches', async () => {
    const dest = join(ws.path, 'f');
    await downloadToFile('https://x/f', dest, sha, serving(bytes));
    expect(readFileSync(dest, 'utf-8')).toBe('hello');
  });

  it('rejects a download that does not match its checksum', async () => {
    await expect(downloadToFile('https://x/f', join(ws.path, 'f'), sha, serving(new TextEncoder().encode('hellO'))))
      .rejects.toThrow('checksum mismatch');
  });

  it('reports a download it cannot save instead of crashing', async () => {
    const nowhere = join(ws.path, 'no-such-dir', 'f');
    await expect(downloadToFile('https://x/f', nowhere, undefined, serving(bytes))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gives up on a download that stops sending data', async () => {
    const stalled = (async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream({
        start(c) { c.enqueue(bytes); },
        cancel() {},
      });
      init?.signal?.addEventListener('abort', () => undefined);
      return new Response(body);
    }) as typeof fetch;
    await expect(downloadToFile('https://x/f', join(ws.path, 'f'), undefined, stalled, 50)).rejects.toThrow('the download stalled');
  });
});

describe.skipIf(!isMac)('installClient (macOS)', () => {
  let ws: TempWorkspace;
  let dest: string;
  let work: string;
  beforeEach(() => {
    ws = new TempWorkspace('codemie-client-install-');
    dest = join(ws.path, 'Applications');
    work = join(ws.path, 'work');
  });
  afterEach(() => ws.cleanup());

  /** A tiny ad-hoc signed app: a valid sealed signature whose team is "not set". */
  function standIn(dir: string, bundle: string): string {
    const app = join(dir, bundle);
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
    copyFileSync('/usr/bin/true', join(app, 'Contents', 'MacOS', 'stand-in'));
    writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>stand-in</string>
<key>CFBundleIdentifier</key><string>test.codemie.stand-in</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
</dict></plist>
`);
    writeFileSync(join(app, 'Contents', 'Resources', 'r.txt'), 'r');
    execFileSync('/usr/bin/codesign', ['-s', '-', '--force', app], { stdio: 'ignore' });
    return app;
  }

  function pack(kind: 'zip' | 'dmg', tamper = false): Uint8Array {
    const src = join(ws.path, 'src');
    const app = standIn(src, 'Stand In.app');
    if (tamper) writeFileSync(join(app, 'Contents', 'Resources', 'r.txt'), 'changed');
    const out = join(ws.path, `pkg.${kind}`);
    if (kind === 'zip') {
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, out]);
    } else {
      execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-srcfolder', src, out]);
    }
    return readFileSync(out);
  }

  function spec(kind: 'zip' | 'dmg', teamId = 'not set'): ClientSpec {
    return {
      app: 'claude-desktop',
      label: 'Stand In',
      bundle: 'Stand In.app',
      teamId,
      kind,
      downloadPage: 'https://example.com/download',
      resolve: async () => ({ url: 'https://example.com/pkg' }),
    };
  }

  const nothingLeft = () => {
    expect(existsSync(join(dest, 'Stand In.app'))).toBe(false);
    expect(existsSync(work)).toBe(false);
  };

  it.each(['zip', 'dmg'] as const)('installs a %s and reports each step', async (kind) => {
    const lines: string[] = [];
    const path = await installClient(spec(kind), { destDir: dest, workDir: work, fetchImpl: serving(pack(kind)), log: (l) => lines.push(l) });
    expect(path).toBe(join(dest, 'Stand In.app'));
    expect(existsSync(join(path, 'Contents', 'Info.plist'))).toBe(true);
    expect(lines).toEqual([
      '✓ Downloaded Stand In 1.2.3',
      '✓ Checked the download is genuine',
      '✓ Installed for your account',
    ]);
    expect(existsSync(work)).toBe(false);
  });

  it('detaches the disk image when it is done', async () => {
    await installClient(spec('dmg'), { destDir: dest, workDir: work, fetchImpl: serving(pack('dmg')), log: () => {} });
    const mounts = execFileSync('/usr/bin/hdiutil', ['info']).toString();
    expect(mounts).not.toContain(join(work, 'mnt'));
  });

  it('refuses an app signed by another team and leaves nothing behind', async () => {
    const err = await installClient(spec('zip', 'UBF8T346G9'), { destDir: dest, workDir: work, fetchImpl: serving(pack('zip')), log: () => {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientInstallError);
    expect((err as ClientInstallError).message).toContain("isn't signed by its vendor");
    expect((err as ClientInstallError).downloadPage).toBe('https://example.com/download');
    nothingLeft();
  });

  it('refuses a tampered app even from the right team', async () => {
    await expect(installClient(spec('dmg'), { destDir: dest, workDir: work, fetchImpl: serving(pack('dmg', true)), log: () => {} }))
      .rejects.toBeInstanceOf(ClientInstallError);
    nothingLeft();
    expect(execFileSync('/usr/bin/hdiutil', ['info']).toString()).not.toContain(join(work, 'mnt'));
  });

  it('refuses a download that does not match its published checksum', async () => {
    const withSha: ClientSpec = { ...spec('zip'), resolve: async () => ({ url: 'https://example.com/pkg', sha256: '00' }) };
    await expect(installClient(withSha, { destDir: dest, workDir: work, fetchImpl: serving(pack('zip')), log: () => {} }))
      .rejects.toThrow('published checksum');
    nothingLeft();
  });

  it('reports a failed download with the download page', async () => {
    const offline = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const err = await installClient(spec('zip'), { destDir: dest, workDir: work, fetchImpl: offline, log: () => {} })
      .catch((e: unknown) => e);
    expect((err as ClientInstallError).message).toContain("Couldn't download Stand In");
    expect((err as ClientInstallError).downloadPage).toBe('https://example.com/download');
    nothingLeft();
  });

  it('reports an install the OS refuses and leaves nothing behind', async () => {
    const locked = join(ws.path, 'locked');
    mkdirSync(locked);
    execFileSync('/bin/chmod', ['500', locked]);
    const blockedDest = join(locked, 'Applications');
    try {
      await expect(installClient(spec('zip'), { destDir: blockedDest, workDir: work, fetchImpl: serving(pack('zip')), log: () => {} }))
        .rejects.toThrow('IT policy');
      expect(existsSync(join(blockedDest, 'Stand In.app'))).toBe(false);
      expect(existsSync(work)).toBe(false);
    } finally {
      execFileSync('/bin/chmod', ['700', locked]);
    }
  });

  it('never overwrites an app that is already installed', async () => {
    mkdirSync(join(dest, 'Stand In.app', 'Contents'), { recursive: true });
    writeFileSync(join(dest, 'Stand In.app', 'Contents', 'mine'), 'keep');
    await expect(installClient(spec('zip'), { destDir: dest, workDir: work, fetchImpl: serving(pack('zip')), log: () => {} }))
      .rejects.toThrow('already installed');
    expect(readdirSync(join(dest, 'Stand In.app', 'Contents'))).toEqual(['mine']);
  });
});

describe('installClient off macOS', () => {
  it('says it is macOS only', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await expect(installClient(CLIENT_SPECS.vscode)).rejects.toThrow('only supported on macOS');
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });
});
