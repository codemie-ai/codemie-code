/**
 * Regression coverage for the Claude plugin's pre-spawn OTLP endpoint refresh (EPMCDME-16647
 * QA fix) against the REAL `refreshClaudeCodeOtlpEndpoint` primitive and a temp HOME.
 *
 * The sibling `claude.plugin.otlp-preflight.test.ts` mocks `ensureOtlpProxy` entirely, which
 * only proves the call is gated, attributed and timeout-bound — it never touches
 * `~/.claude/settings.json`, so it cannot catch a regression where the rewrite stops
 * happening, or starts happening too late (after Claude Code has already read the file).
 *
 * This file keeps `ensureOtlpProxy` itself mocked (its own cold-start/SSO/daemon-spawn
 * plumbing belongs to its own tests), but has the mock call the real
 * `refreshClaudeCodeOtlpEndpoint` against a temp HOME, so the settings file content is real
 * and the ordering guarantee — `beforeRun` (and therefore `executeBeforeRun`, and therefore
 * the Claude Code spawn that follows it) only returns once the rewrite has completed — is
 * actually exercised rather than assumed.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isClaudeCodeOtlpConnectedMock = vi.hoisted(() => vi.fn());
const ensureOtlpProxyMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../cli/commands/proxy/connectors/claude-code-otlp-endpoint.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../cli/commands/proxy/connectors/claude-code-otlp-endpoint.js')>()),
  isClaudeCodeOtlpConnected: isClaudeCodeOtlpConnectedMock,
}));

vi.mock('../../../../cli/commands/proxy/otlp-cold-start.js', () => ({
  ensureOtlpProxy: ensureOtlpProxyMock,
}));

vi.mock('@/utils/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/paths.js')>()),
  resolveHomeDir: vi.fn(),
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    notice: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    status: vi.fn(),
  },
}));

import { ClaudePluginMetadata } from '../claude.plugin.js';
import { refreshClaudeCodeOtlpEndpoint } from '../../../../cli/commands/proxy/connectors/claude-code-otlp-endpoint.js';
import { resolveHomeDir } from '@/utils/paths.js';

describe('ClaudePluginMetadata.lifecycle.beforeRun — real settings.json rewrite (EPMCDME-16647)', () => {
  let homeDir: string;
  const settingsPath = () => join(homeDir, '.claude', 'settings.json');
  // The live daemon the refresh must re-point Claude Code at — a rotated port/key, exactly
  // the shape a cold respawn produces.
  const liveDaemon = { url: 'http://127.0.0.1:51999', gatewayKey: 'rotated-key' };

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'codemie-otlp-beforerun-'));
    vi.mocked(resolveHomeDir).mockReturnValue(homeDir);

    isClaudeCodeOtlpConnectedMock.mockResolvedValue(true);
    ensureOtlpProxyMock.mockImplementation(async () => {
      await refreshClaudeCodeOtlpEndpoint(liveDaemon);
    });

    // Seed a CodeMie-owned settings.json still pointing at a STALE daemon — the cold-respawn
    // scenario this fix targets: Claude Code's settings carry the OLD endpoint until the
    // pre-spawn refresh (or, failing that, the next SessionStart hook) rewrites it.
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(
      settingsPath(),
      JSON.stringify({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:40000/v1/analytics/otlp',
          OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer stale-key',
        },
      }, null, 2)
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  // Mirrors the real call shape used by claude.plugin.otlp-preflight.test.ts: lifecycle-
  // helpers.ts's executeBeforeRun() does `hook.call(context, env, config)` and awaits the
  // result in full before the caller goes on to spawn Claude Code.
  async function runBeforeRun(): Promise<void> {
    await ClaudePluginMetadata.lifecycle?.beforeRun?.call(
      { metadata: { name: 'claude' } } as never,
      {} as never,
      {} as never
    );
  }

  it('rewrites settings.json to the live daemon endpoint before beforeRun returns, and completes before the next read — not only on the later SessionStart hook', async () => {
    const before = JSON.parse(await readFile(settingsPath(), 'utf-8'));
    expect(before.env.OTEL_EXPORTER_OTLP_ENDPOINT).toContain('40000');

    // The exact call executeBeforeRun() awaits before its caller spawns Claude Code.
    await runBeforeRun();

    // Read immediately on return, with no flush or delay: a regression that made the
    // refresh fire-and-forget (not awaited inside beforeRun) would read stale content here,
    // because the write would still be pending in the background.
    const after = JSON.parse(await readFile(settingsPath(), 'utf-8'));
    expect(after.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:51999/v1/analytics/otlp');
    expect(after.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer rotated-key');
  });
});
