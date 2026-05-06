/**
 * Unit tests for the skills.sh egress guard shim.
 *
 * The shim is a CommonJS file loaded into upstream child processes via
 * NODE_OPTIONS=--require. Here we evaluate it in the current Vitest worker by
 * using createRequire so we can verify it patches `globalThis.fetch` correctly.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'assets',
  'skills-sh-egress-guard.cjs'
);

let originalFetch: typeof globalThis.fetch | undefined;
let originalCaptureUpdateStdout: string | undefined;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCaptureUpdateStdout = process.env.CODEMIE_CAPTURE_SKILLS_SH_UPDATE_STDOUT;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    // @ts-expect-error - allow undefined reset
    delete globalThis.fetch;
  }
  if (originalCaptureUpdateStdout === undefined) {
    delete process.env.CODEMIE_CAPTURE_SKILLS_SH_UPDATE_STDOUT;
  } else {
    process.env.CODEMIE_CAPTURE_SKILLS_SH_UPDATE_STDOUT = originalCaptureUpdateStdout;
  }
  stderrSpy.mockRestore();
});

describe('skills-sh-egress-guard', () => {
  function loadShim() {
    const requireFromHere = createRequire(import.meta.url);
    // bust cache so each test starts fresh
    delete requireFromHere.cache[requireFromHere.resolve(SHIM_PATH)];
    requireFromHere(SHIM_PATH);
  }

  it('blocks add-skill.vercel.sh by host', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
    loadShim();

    await expect(globalThis.fetch('https://add-skill.vercel.sh/audit')).rejects.toThrow(
      /CODEMIE_SKILL_EGRESS_BLOCKED/
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it('blocks add-skill.vercel.sh when given a URL object', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
    loadShim();

    const url = new URL('https://add-skill.vercel.sh/track');
    await expect(globalThis.fetch(url)).rejects.toThrow(/CODEMIE_SKILL_EGRESS_BLOCKED/);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('lets unrelated hosts pass through unchanged (GitHub)', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
    loadShim();

    await globalThis.fetch('https://github.com/some/repo');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('lets unrelated hosts pass through unchanged (CodeMie)', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
    loadShim();

    await globalThis.fetch('https://codemie.lab.epam.com/code-assistant-api/v1/skills/events');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('lets through requests with an unparseable url instead of blocking', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
    loadShim();

    // A garbage URL should not be parsed as add-skill.vercel.sh; the shim
    // must let it fall through so unrelated traffic is never blocked.
    await globalThis.fetch('not a real url');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('handles Request-shaped input (object with url property)', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
    loadShim();

    const requestLike = { url: 'https://add-skill.vercel.sh/foo' };
    await expect(globalThis.fetch(requestLike as unknown as RequestInfo)).rejects.toThrow(
      /CODEMIE_SKILL_EGRESS_BLOCKED/
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it('captures successful update lines as structured telemetry without blocking stdout', () => {
    process.env.CODEMIE_CAPTURE_SKILLS_SH_UPDATE_STDOUT = '1';
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      loadShim();
      process.stdout.write('\u001b[32m✓\u001b[0m Updated alpha-skill\n');
      process.stdout.write('✓ Updated 1 skill(s)\n');

      expect(stderrSpy).toHaveBeenCalledWith(
        'CODEMIE_SKILLS_SH_TELEMETRY {"event":"update","skills":"alpha-skill"}\n'
      );
      expect(stderrSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('"skills":"1 skill(s)"')
      );
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
