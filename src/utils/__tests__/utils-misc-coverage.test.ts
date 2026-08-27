/**
 * Coverage for small pure/util modules under src/utils/:
 *   - parsers.ts       (parseMultiLineJSON, parseJSONL, normalizeModelName)
 *   - slug.ts          (sanitizeToSlug)
 *   - frontmatter.ts   (parseFrontmatter + helpers, error paths)
 *   - version-utils.ts (parse/validate/compare, boundary + special channels)
 *   - clipboard.ts     (exec mocked — no real clipboard access)
 *   - cli-updater.ts   (npm/fs isolated to a temp CODEMIE_HOME — no network,
 *                       version-compare + should-update + env toggles)
 *
 * All expectations were probed against the real (built) code first — they pin
 * today's behavior. External systems (npm view / installGlobal / child_process
 * exec / inquirer) are mocked; filesystem writes go to a unique temp dir.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Mocks for clipboard.ts external systems -------------------------------
// child_process.exec is wrapped via util.promisify at module load. Providing a
// promisify.custom implementation lets us control the async result deterministically.
const execAsyncMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFn = ((): void => undefined) as unknown as typeof actual.exec;
  (execFn as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    execAsyncMock;
  return { ...actual, exec: execFn, default: { ...actual, exec: execFn } };
});

// os.platform() is overridden per-test to exercise the platform switch; every
// other os export (homedir, tmpdir, ...) is preserved so paths.ts keeps working.
const platformMock = vi.hoisted(() => vi.fn(() => 'darwin'));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, platform: platformMock, default: { ...actual, platform: platformMock } };
});

// --- Mocks for cli-updater.ts external systems -----------------------------
const getLatestVersionMock = vi.hoisted(() => vi.fn());
const installGlobalMock = vi.hoisted(() => vi.fn());
vi.mock('../processes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../processes.js')>();
  return { ...actual, getLatestVersion: getLatestVersionMock, installGlobal: installGlobalMock };
});

const inquirerPromptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: inquirerPromptMock } }));

// Silence the real logger: it writes debug logs into CODEMIE_HOME/logs asynchronously,
// which would race with the temp-dir cleanup in afterEach (ENOENT). No-op keeps tests
// hermetic without touching the filesystem.
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseMultiLineJSON, parseJSONL, normalizeModelName } from '../parsers.js';
import { sanitizeToSlug } from '../slug.js';
import {
  parseFrontmatter,
  hasFrontmatter,
  extractMetadata,
  extractContent,
  FrontmatterParseError,
} from '../frontmatter.js';
import {
  parseSemanticVersion,
  isValidSemanticVersion,
  compareVersions,
} from '../version-utils.js';
import { hasClipboardImage, getClipboardImage } from '../clipboard.js';

// ===========================================================================
// parsers.ts
// ===========================================================================
describe('parsers.parseMultiLineJSON', () => {
  it('parses multiple pretty-printed objects', () => {
    expect(parseMultiLineJSON('{\n"a":1\n}\n{\n"b":2\n}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips malformed objects and keeps valid ones', () => {
    expect(parseMultiLineJSON('{"a":1}{bad}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('does not treat braces inside strings as object boundaries', () => {
    expect(parseMultiLineJSON('{"a":"}{"}')).toEqual([{ a: '}{' }]);
  });

  it('returns [] for empty or whitespace-only input', () => {
    expect(parseMultiLineJSON('')).toEqual([]);
    expect(parseMultiLineJSON('   \n  ')).toEqual([]);
  });
});

describe('parsers.parseJSONL', () => {
  it('parses line-delimited JSON, skipping blank and malformed lines', () => {
    expect(parseJSONL('{"a":1}\n{"b":2}\n\nbad\n{"c":3}')).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseJSONL('')).toEqual([]);
  });
});

describe('parsers.normalizeModelName', () => {
  it('extracts model from Bedrock converse format', () => {
    expect(
      normalizeModelName('converse/global.anthropic.claude-haiku-4-5-20251001-v1:0')
    ).toBe('claude-haiku-4-5-20251001');
  });

  it('extracts model from Bedrock direct (region-prefixed) format', () => {
    expect(normalizeModelName('us-east-1.anthropic.claude-opus-4-20250514-v1:0')).toBe(
      'claude-opus-4-20250514'
    );
  });

  it('returns standard names unchanged', () => {
    expect(normalizeModelName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
    expect(normalizeModelName('gpt-4.1-turbo')).toBe('gpt-4.1-turbo');
  });

  it('returns converse input unchanged when the inner pattern does not match', () => {
    expect(normalizeModelName('converse/foo')).toBe('converse/foo');
  });
});

// ===========================================================================
// slug.ts
// ===========================================================================
describe('slug.sanitizeToSlug', () => {
  it('lowercases and hyphenates non-alphanumeric runs', () => {
    expect(sanitizeToSlug('Hello World! 123')).toBe('hello-world-123');
  });

  it('drops non-ASCII characters (unicode not transliterated)', () => {
    expect(sanitizeToSlug('Café Ünïcode')).toBe('caf-n-code');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeToSlug('---Trim Me---')).toBe('trim-me');
  });

  it('returns empty string when nothing survives', () => {
    expect(sanitizeToSlug('')).toBe('');
    expect(sanitizeToSlug('!!!@@@')).toBe('');
  });
});

// ===========================================================================
// frontmatter.ts
// ===========================================================================
describe('frontmatter.parseFrontmatter', () => {
  it('parses metadata and trims body content', () => {
    const result = parseFrontmatter('---\nkey: value\nnum: 5\n---\nBody here');
    expect(result.metadata).toEqual({ key: 'value', num: 5 });
    expect(result.content).toBe('Body here');
  });

  it('throws when the opening delimiter is missing', () => {
    expect(() => parseFrontmatter('no delim')).toThrow(FrontmatterParseError);
    expect(() => parseFrontmatter('no delim')).toThrow(/must start with frontmatter delimiter/);
  });

  it('throws when the closing delimiter is missing', () => {
    expect(() => parseFrontmatter('---\nkey: value')).toThrow(/Missing closing frontmatter/);
  });

  it('throws when frontmatter is a YAML array, not an object', () => {
    expect(() => parseFrontmatter('---\n- a\n- b\n---\nx')).toThrow(
      /must be a YAML object/
    );
  });

  it('throws FrontmatterParseError on invalid YAML', () => {
    expect(() => parseFrontmatter('---\nkey: [unclosed\n---\nx')).toThrow(FrontmatterParseError);
  });

  it('carries the filePath on the thrown error', () => {
    try {
      parseFrontmatter('no delim', '/some/file.md');
      throw new Error('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FrontmatterParseError);
      expect((e as FrontmatterParseError).filePath).toBe('/some/file.md');
    }
  });
});

describe('frontmatter helpers', () => {
  it('hasFrontmatter reflects validity', () => {
    expect(hasFrontmatter('---\nk: v\n---\nx')).toBe(true);
    expect(hasFrontmatter('no frontmatter')).toBe(false);
  });

  it('extractMetadata / extractContent return the respective parts', () => {
    expect(extractMetadata('---\na: 1\n---\nbody')).toEqual({ a: 1 });
    expect(extractContent('---\na: 1\n---\nbody text')).toBe('body text');
  });
});

// ===========================================================================
// version-utils.ts
// ===========================================================================
describe('version-utils.parseSemanticVersion', () => {
  it('parses major.minor.patch', () => {
    expect(parseSemanticVersion('2.0.30')).toEqual({
      major: 2,
      minor: 0,
      patch: 30,
      raw: '2.0.30',
    });
  });

  it('strips a leading v but preserves the untrimmed raw string', () => {
    expect(parseSemanticVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, raw: 'v1.2.3' });
    expect(parseSemanticVersion('  1.2.3  ').raw).toBe('  1.2.3  ');
  });

  it('throws on malformed versions', () => {
    expect(() => parseSemanticVersion('1.2')).toThrow(/Invalid semantic version format/);
    expect(() => parseSemanticVersion('abc')).toThrow(/Invalid semantic version format/);
  });
});

describe('version-utils.isValidSemanticVersion', () => {
  it('validates well-formed versions and rejects the rest', () => {
    expect(isValidSemanticVersion('2.0.30')).toBe(true);
    expect(isValidSemanticVersion('v2.0.30')).toBe(true);
    expect(isValidSemanticVersion('invalid')).toBe(false);
    expect(isValidSemanticVersion('1.0')).toBe(false);
  });
});

describe('version-utils.compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('2.0.30', '2.0.45')).toBe(-1);
    expect(compareVersions('2.0.45', '2.0.30')).toBe(1);
    expect(compareVersions('2.0.30', '2.0.30')).toBe(0);
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
  });

  it('treats latest/stable channels as highest, case-insensitively', () => {
    expect(compareVersions('latest', 'stable')).toBe(0);
    expect(compareVersions('latest', '2.0.0')).toBe(1);
    expect(compareVersions('2.0.0', 'latest')).toBe(-1);
    expect(compareVersions('STABLE', '1.0.0')).toBe(1);
  });
});

// ===========================================================================
// clipboard.ts (exec + platform mocked)
// ===========================================================================
describe('clipboard', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  beforeEach(() => {
    execAsyncMock.mockReset();
    platformMock.mockReturnValue('darwin');
    warnSpy.mockClear();
    errSpy.mockClear();
  });

  afterAll(() => {
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('hasClipboardImage returns true when macOS clipboard info reports an image type', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '«class PNGf», «class furl»', stderr: '' });
    await expect(hasClipboardImage()).resolves.toBe(true);
  });

  it('hasClipboardImage returns false when no image types are present', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '«class utf8», «class furl»', stderr: '' });
    await expect(hasClipboardImage()).resolves.toBe(false);
  });

  it('hasClipboardImage returns false when the exec call rejects', async () => {
    execAsyncMock.mockRejectedValue(new Error('osascript failed'));
    await expect(hasClipboardImage()).resolves.toBe(false);
  });

  it('hasClipboardImage returns false and warns on an unsupported platform', async () => {
    platformMock.mockReturnValue('freebsd' as unknown as NodeJS.Platform);
    await expect(hasClipboardImage()).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    expect(execAsyncMock).not.toHaveBeenCalled();
  });

  it('getClipboardImage returns PNG data when the first probe yields a long payload', async () => {
    execAsyncMock.mockResolvedValueOnce({ stdout: 'A'.repeat(200), stderr: '' });
    const img = await getClipboardImage();
    expect(img).toEqual({ data: 'A'.repeat(200), mimeType: 'image/png' });
  });

  it('getClipboardImage falls back to JPEG when the PNG probe is too short', async () => {
    execAsyncMock
      .mockResolvedValueOnce({ stdout: 'short', stderr: '' }) // PNG probe
      .mockResolvedValueOnce({ stdout: 'B'.repeat(200), stderr: '' }); // JPEG probe
    const img = await getClipboardImage();
    expect(img).toEqual({ data: 'B'.repeat(200), mimeType: 'image/jpeg' });
  });

  it('getClipboardImage returns null when every probe is too short', async () => {
    execAsyncMock.mockResolvedValue({ stdout: 'short', stderr: '' });
    await expect(getClipboardImage()).resolves.toBeNull();
  });

  it('getClipboardImage returns null on an unsupported platform', async () => {
    platformMock.mockReturnValue('sunos' as unknown as NodeJS.Platform);
    await expect(getClipboardImage()).resolves.toBeNull();
  });
});

// ===========================================================================
// cli-updater.ts (npm/fs/inquirer mocked; CODEMIE_HOME -> temp dir)
// ===========================================================================
describe('cli-updater', () => {
  const CLI_PACKAGE_NAME = '@codemieai/code';
  let tempHome: string;
  const envSnapshot: Record<string, string | undefined> = {};
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  beforeAll(() => {
    for (const k of ['CODEMIE_HOME', 'CODEMIE_AUTO_UPDATE', 'CODEMIE_UPDATE_CHECK_INTERVAL']) {
      envSnapshot[k] = process.env[k];
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'codemie-updater-'));
    process.env.CODEMIE_HOME = tempHome;
    delete process.env.CODEMIE_AUTO_UPDATE;
    delete process.env.CODEMIE_UPDATE_CHECK_INTERVAL;
    getLatestVersionMock.mockReset();
    installGlobalMock.mockReset();
    inquirerPromptMock.mockReset();
    logSpy.mockClear();
    errSpy.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempHome, { recursive: true, force: true });
  });

  /** Fresh module load so module-level env constants (interval, paths) re-evaluate. */
  async function loadUpdater(): Promise<typeof import('../cli-updater.js')> {
    vi.resetModules();
    return import('../cli-updater.js');
  }

  describe('isAutoUpdateEnabled', () => {
    it('defaults to true when unset or empty', async () => {
      const { isAutoUpdateEnabled } = await loadUpdater();
      expect(isAutoUpdateEnabled()).toBe(true);
      process.env.CODEMIE_AUTO_UPDATE = '';
      expect(isAutoUpdateEnabled()).toBe(true);
    });

    it('accepts true/1/yes (case- and whitespace-insensitive)', async () => {
      const { isAutoUpdateEnabled } = await loadUpdater();
      for (const v of ['true', 'TRUE', '1', 'yes', '  Yes  ']) {
        process.env.CODEMIE_AUTO_UPDATE = v;
        expect(isAutoUpdateEnabled()).toBe(true);
      }
    });

    it('treats false/0/no/other values as disabled', async () => {
      const { isAutoUpdateEnabled } = await loadUpdater();
      for (const v of ['false', '0', 'no', 'off', 'anything']) {
        process.env.CODEMIE_AUTO_UPDATE = v;
        expect(isAutoUpdateEnabled()).toBe(false);
      }
    });
  });

  describe('getCurrentCliVersion', () => {
    it('reads a valid semantic version from the package manifest', async () => {
      const { getCurrentCliVersion } = await loadUpdater();
      const v = await getCurrentCliVersion();
      expect(v).toBeTruthy();
      expect(isValidSemanticVersion(v as string)).toBe(true);
    });
  });

  describe('checkForCliUpdate (version-compare decision)', () => {
    it('reports hasUpdate=true when npm reports a newer version', async () => {
      getLatestVersionMock.mockResolvedValue('999.0.0');
      const { checkForCliUpdate } = await loadUpdater();
      const result = await checkForCliUpdate();
      expect(result).not.toBeNull();
      expect(result?.latestVersion).toBe('999.0.0');
      expect(result?.hasUpdate).toBe(true);
      expect(isValidSemanticVersion(result?.currentVersion as string)).toBe(true);
      expect(getLatestVersionMock).toHaveBeenCalledWith(CLI_PACKAGE_NAME, { timeout: 5000 });
    });

    it('reports hasUpdate=false when npm version is older than current', async () => {
      getLatestVersionMock.mockResolvedValue('0.0.1');
      const { checkForCliUpdate } = await loadUpdater();
      const result = await checkForCliUpdate();
      expect(result?.hasUpdate).toBe(false);
    });

    it('returns null when npm returns no version', async () => {
      getLatestVersionMock.mockResolvedValue(null);
      const { checkForCliUpdate } = await loadUpdater();
      expect(await checkForCliUpdate()).toBeNull();
    });

    it('returns null when npm returns an invalid version string (security guard)', async () => {
      getLatestVersionMock.mockResolvedValue('not-a-version');
      const { checkForCliUpdate } = await loadUpdater();
      expect(await checkForCliUpdate()).toBeNull();
    });
  });

  describe('checkAndPromptForUpdate (rate-limit + auto/prompt toggles)', () => {
    const lastCheckFile = (): string => join(tempHome, '.last-update-check');

    it('skips the npm check when last check is within CODEMIE_UPDATE_CHECK_INTERVAL', async () => {
      process.env.CODEMIE_UPDATE_CHECK_INTERVAL = String(24 * 60 * 60 * 1000);
      writeFileSync(lastCheckFile(), String(Date.now()), 'utf-8');
      const { checkAndPromptForUpdate } = await loadUpdater();
      await checkAndPromptForUpdate();
      expect(getLatestVersionMock).not.toHaveBeenCalled();
    });

    it('performs the check when the last check is older than the interval', async () => {
      process.env.CODEMIE_UPDATE_CHECK_INTERVAL = '1000';
      writeFileSync(lastCheckFile(), '0', 'utf-8'); // epoch => far in the past
      getLatestVersionMock.mockResolvedValue('0.0.1'); // older => no update
      const { checkAndPromptForUpdate } = await loadUpdater();
      await checkAndPromptForUpdate();
      expect(getLatestVersionMock).toHaveBeenCalledTimes(1);
      expect(installGlobalMock).not.toHaveBeenCalled();
    });

    it('auto-updates silently and records the check timestamp (default toggle)', async () => {
      // No .last-update-check file => proceeds; CODEMIE_AUTO_UPDATE unset => auto.
      getLatestVersionMock.mockResolvedValue('999.0.0');
      installGlobalMock.mockResolvedValue(undefined);
      const { checkAndPromptForUpdate } = await loadUpdater();
      await checkAndPromptForUpdate();
      expect(installGlobalMock).toHaveBeenCalledTimes(1);
      const [pkg, opts] = installGlobalMock.mock.calls[0];
      expect(pkg).toBe(CLI_PACKAGE_NAME);
      expect(opts).toMatchObject({ version: '999.0.0', force: true });
      expect(existsSync(lastCheckFile())).toBe(true); // recordUpdateCheck ran
      expect(existsSync(join(tempHome, '.update-lock'))).toBe(false); // lock released
    });

    it('does not update when no newer version is available', async () => {
      getLatestVersionMock.mockResolvedValue('0.0.1');
      const { checkAndPromptForUpdate } = await loadUpdater();
      await checkAndPromptForUpdate();
      expect(installGlobalMock).not.toHaveBeenCalled();
    });

    it('prompts and skips the install when the user declines (CODEMIE_AUTO_UPDATE=false)', async () => {
      process.env.CODEMIE_AUTO_UPDATE = 'false';
      getLatestVersionMock.mockResolvedValue('999.0.0');
      inquirerPromptMock.mockResolvedValue({ shouldUpdate: false });
      const { checkAndPromptForUpdate } = await loadUpdater();
      await checkAndPromptForUpdate();
      expect(inquirerPromptMock).toHaveBeenCalledTimes(1);
      expect(installGlobalMock).not.toHaveBeenCalled();
    });
  });
});
