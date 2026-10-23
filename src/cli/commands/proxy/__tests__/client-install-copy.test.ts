/**
 * Client app install: a copy cut short never leaves an app that looks installed.
 * macOS only (real ditto / codesign for everything except the cut-short copy).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TempWorkspace } from '../../../../../tests/helpers/temp-workspace.js';

// The copy into the destination folder writes half the app, then fails.
vi.mock('../../../../utils/exec.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../utils/exec.js')>();
  return {
    exec: vi.fn(async (cmd: string, args: string[] = [], opts?: Parameters<typeof actual.exec>[2]) => {
      const target = args[1] ?? '';
      if (cmd === '/usr/bin/ditto' && args.length === 2 && target.includes('Applications')) {
        mkdirSync(join(target, 'Contents'), { recursive: true });
        writeFileSync(join(target, 'Contents', 'half'), 'x');
        return { code: 1, stdout: '', stderr: 'interrupted' };
      }
      return actual.exec(cmd, args, opts);
    }),
  };
});

describe.skipIf(process.platform !== 'darwin')('installClient copy step', () => {
  let ws: TempWorkspace;
  beforeEach(() => { ws = new TempWorkspace('codemie-client-copy-'); });
  afterEach(() => ws.cleanup());

  it('leaves no app, complete or partial, when the copy fails', async () => {
    const { installClient, findInstalledClient, ClientInstallError } = await import('../client-install.js');
    const src = join(ws.path, 'src');
    const app = join(src, 'Stand In.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    copyFileSync('/usr/bin/true', join(app, 'Contents', 'MacOS', 'stand-in'));
    writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>stand-in</string>
<key>CFBundleIdentifier</key><string>test.codemie.stand-in</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
    execFileSync('/usr/bin/codesign', ['-s', '-', '--force', app], { stdio: 'ignore' });
    const zip = join(ws.path, 'pkg.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    const bytes = readFileSync(zip);
    const dest = join(ws.path, 'Applications');
    const spec = {
      app: 'claude-desktop' as const, label: 'Stand In', bundle: 'Stand In.app', teamId: 'not set', kind: 'zip' as const,
      downloadPage: 'https://example.com/download', resolve: async () => ({ url: 'https://example.com/pkg' }),
    };

    const err = await installClient(spec, {
      destDir: dest, workDir: join(ws.path, 'work'), fetchImpl: (async () => new Response(bytes)) as typeof fetch, log: () => {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClientInstallError);
    expect(existsSync(join(dest, 'Stand In.app'))).toBe(false);
    expect(readdirSync(dest)).toEqual([]);
    expect(findInstalledClient(spec, [dest])).toBeNull();
  });
});
