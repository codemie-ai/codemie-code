/**
 * Per-agent flag-transform CONTRACT test.
 *
 * WHY: CodeMie exposes a common flag surface (--task, --resume, --model, …) that
 * each agent rewrites into its own native CLI via the two-stage pipeline
 * BaseAgentAdapter runs: lifecycle.enrichArgs() FIRST, then declarative
 * transformFlags(). Several of these transforms had no direct assertion (gemini
 * -m injection, opencode/codex enrichArgs, copilot). A silent change to any
 * mapping would ship a broken agent invocation. This pins the EXACT argv each
 * agent produces — the values below were captured from the real pipeline, so a
 * regression breaks the corresponding assertion.
 *
 * Deterministic and pure: enrichArgs reads env/config only (no FS/network). We
 * set CODEMIE_MODEL because pi throws without it and copilot injects --model
 * from it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { transformFlags } from '../../core/flag-transform.js';
import type { AgentConfig, AgentMetadata } from '../../core/types.js';
import { ClaudePluginMetadata } from '../claude/claude.plugin.js';
import { CodexPluginMetadata } from '../codex/codex.plugin.js';
import { GeminiPluginMetadata } from '../gemini/gemini.plugin.js';
import { OpenCodePluginMetadata } from '../opencode/opencode.plugin.js';
import { KimiPluginMetadata } from '../kimi/kimi.plugin.js';
import { PiPluginMetadata } from '../pi/pi.plugin.js';
import { CopilotCliPluginMetadata } from '../copilot-cli/copilot-cli.plugin.js';

const config: AgentConfig = { provider: 'test', model: 'test-model' };

/** Compose the real pipeline exactly as BaseAgentAdapter does: enrichArgs → transformFlags. */
async function finalArgs(meta: AgentMetadata, raw: string[]): Promise<string[]> {
  let args = raw;
  const enrich = meta.lifecycle?.enrichArgs;
  if (enrich) args = await Promise.resolve(enrich(args, config));
  if (meta.flagMappings) args = transformFlags(args, meta.flagMappings, config);
  return args;
}

let originalModel: string | undefined;
let originalSessionId: string | undefined;
beforeAll(() => {
  originalModel = process.env.CODEMIE_MODEL;
  process.env.CODEMIE_MODEL = 'test-model';
  // pi injects --session-id only when CODEMIE_SESSION_ID is set; pin it so the
  // pi contract is deterministic regardless of the ambient environment (CI has
  // no CODEMIE_SESSION_ID, a codemie-agent shell does).
  originalSessionId = process.env.CODEMIE_SESSION_ID;
  process.env.CODEMIE_SESSION_ID = 'test-session-id';
});
afterAll(() => {
  if (originalModel !== undefined) process.env.CODEMIE_MODEL = originalModel;
  else delete process.env.CODEMIE_MODEL;
  if (originalSessionId !== undefined) process.env.CODEMIE_SESSION_ID = originalSessionId;
  else delete process.env.CODEMIE_SESSION_ID;
});

describe('flag-transform contract — --task', () => {
  it('claude: --task X → -p X', async () => {
    expect(await finalArgs(ClaudePluginMetadata, ['--task', 'do X'])).toEqual(['-p', 'do X']);
  });

  it('kimi: --task X → -p X', async () => {
    expect(await finalArgs(KimiPluginMetadata, ['--task', 'do X'])).toEqual(['-p', 'do X']);
  });

  it('gemini: --task X → -m <model> -p X (model injected before the mapping)', async () => {
    expect(await finalArgs(GeminiPluginMetadata, ['--task', 'do X'])).toEqual(['-m', 'test-model', '-p', 'do X']);
  });

  it('opencode: --task X → run X', async () => {
    expect(await finalArgs(OpenCodePluginMetadata, ['--task', 'do X'])).toEqual(['run', 'do X']);
  });

  it('codex: --task X → exec subcommand with the task last + injected --model', async () => {
    const out = await finalArgs(CodexPluginMetadata, ['--task', 'do X']);
    expect(out).toContain('exec');
    expect(out[out.length - 1]).toBe('do X'); // task is the trailing positional
    expect(out.indexOf('exec')).toBeLessThan(out.length - 1);
    // Model is injected as a --model pair.
    const mi = out.indexOf('--model');
    expect(mi).toBeGreaterThanOrEqual(0);
    expect(out[mi + 1]).toBe('test-model');
  });

  it('pi: --task X → --provider <id> --model <model> -p X --session-id <uuid>', async () => {
    const out = await finalArgs(PiPluginMetadata, ['--task', 'do X']);
    expect(out.slice(0, 4)).toEqual(['--provider', 'codemie-proxy', '--model', 'test-model']);
    expect(out).toContain('-p');
    expect(out[out.indexOf('-p') + 1]).toBe('do X');
    // A session id is injected (value is a generated UUID, so assert presence only).
    expect(out).toContain('--session-id');
  });

  it('copilot: --task X → --prompt X --allow-all-tools --model <model>', async () => {
    // enrichArgs detects --task as a prompt indicator and adds --allow-all-tools
    // for non-interactive auto-approval, then --task is rewritten to --prompt.
    expect(await finalArgs(CopilotCliPluginMetadata, ['--task', 'do X'])).toEqual([
      '--prompt', 'do X', '--allow-all-tools', '--model', 'test-model',
    ]);
  });
});

describe('flag-transform contract — --resume', () => {
  it('claude: --resume ID → -r ID', async () => {
    expect(await finalArgs(ClaudePluginMetadata, ['--task', 'do X', '--resume', 'abc-123']))
      .toEqual(['-p', 'do X', '-r', 'abc-123']);
  });

  it('kimi: --resume ID → -S ID', async () => {
    expect(await finalArgs(KimiPluginMetadata, ['--task', 'do X', '--resume', 'abc-123']))
      .toEqual(['-p', 'do X', '-S', 'abc-123']);
  });

  it('opencode: --resume ID → -s ID', async () => {
    expect(await finalArgs(OpenCodePluginMetadata, ['--task', 'do X', '--resume', 'abc-123']))
      .toEqual(['run', 'do X', '-s', 'abc-123']);
  });

  it('codex: --resume ID + --task → exec resume ID … task', async () => {
    const out = await finalArgs(CodexPluginMetadata, ['--task', 'do X', '--resume', 'abc-123']);
    const ei = out.indexOf('exec');
    expect(ei).toBeGreaterThanOrEqual(0);
    expect(out[ei + 1]).toBe('resume');
    expect(out[ei + 2]).toBe('abc-123');
    expect(out[out.length - 1]).toBe('do X');
  });

  it('pi: with an explicit --resume, no --session-id is injected', async () => {
    const out = await finalArgs(PiPluginMetadata, ['--task', 'do X', '--resume', 'abc-123']);
    expect(out).toContain('--resume');
    expect(out).not.toContain('--session-id'); // argv already selects a session
  });
});
