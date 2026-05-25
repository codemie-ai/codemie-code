/**
 * Unit tests for `resolveAgentSelection`.
 *
 * Covers the four branches mandated by spec §4: explicit, auto-detected,
 * prompted, upstream fallback. Filesystem markers are simulated against a
 * temp workspace; the inquirer prompt is mocked.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

import inquirer from 'inquirer';
import { resolveAgentSelection } from '../agent-detection.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'codemie-agent-detection-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  vi.mocked(inquirer.prompt).mockReset();
});

describe('resolveAgentSelection', () => {
  it('returns explicit when --agent was provided, ignoring filesystem', () => {
    mkdirSync(path.join(workspace, '.claude'));
    mkdirSync(path.join(workspace, '.cursor'));

    return resolveAgentSelection({
      cwd: workspace,
      explicitAgents: ['some-agent'],
      interactive: true,
    }).then((selection) => {
      expect(selection).toEqual({ agents: ['some-agent'], mode: 'explicit' });
      expect(inquirer.prompt).not.toHaveBeenCalled();
    });
  });

  it('auto-detects claude-code from a single .claude/ marker', async () => {
    mkdirSync(path.join(workspace, '.claude'));
    const selection = await resolveAgentSelection({
      cwd: workspace,
      interactive: true,
    });
    expect(selection).toEqual({ agents: ['claude-code'], mode: 'auto_detected' });
  });

  it('auto-detects cursor from a single .cursor/ marker', async () => {
    mkdirSync(path.join(workspace, '.cursor'));
    const selection = await resolveAgentSelection({
      cwd: workspace,
      interactive: true,
    });
    expect(selection).toEqual({ agents: ['cursor'], mode: 'auto_detected' });
  });

  it('falls through to upstream when no marker exists', async () => {
    const selection = await resolveAgentSelection({
      cwd: workspace,
      interactive: true,
    });
    expect(selection).toEqual({ agents: [], mode: 'upstream' });
    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  it('prompts when multiple markers exist and interactive=true', async () => {
    mkdirSync(path.join(workspace, '.claude'));
    mkdirSync(path.join(workspace, '.cursor'));
    vi.mocked(inquirer.prompt).mockResolvedValueOnce({ selected: ['claude-code'] });

    const selection = await resolveAgentSelection({
      cwd: workspace,
      interactive: true,
    });
    expect(selection).toEqual({ agents: ['claude-code'], mode: 'prompted' });
    expect(inquirer.prompt).toHaveBeenCalledTimes(1);
  });

  it('falls through to upstream on multiple markers when interactive=false', async () => {
    mkdirSync(path.join(workspace, '.claude'));
    mkdirSync(path.join(workspace, '.cursor'));

    const selection = await resolveAgentSelection({
      cwd: workspace,
      interactive: false,
    });
    expect(selection).toEqual({ agents: [], mode: 'upstream' });
    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  it('does not auto-detect from weak markers like AGENTS.md (spec §4)', async () => {
    // AGENTS.md is intentionally NOT a strong marker because it can apply to
    // many runtimes.
    mkdirSync(workspace, { recursive: true });
    // Create AGENTS.md as a file
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# agents');

    const selection = await resolveAgentSelection({
      cwd: workspace,
      interactive: true,
    });
    expect(selection).toEqual({ agents: [], mode: 'upstream' });
  });

  it('returns multiple selected agents when prompt yields several', async () => {
    mkdirSync(path.join(workspace, '.claude'));
    mkdirSync(path.join(workspace, '.cursor'));
    vi.mocked(inquirer.prompt).mockResolvedValueOnce({
      selected: ['claude-code', 'cursor'],
    });

    const selection = await resolveAgentSelection({
      cwd: workspace,
      interactive: true,
    });
    expect(selection.mode).toBe('prompted');
    expect(selection.agents).toEqual(['claude-code', 'cursor']);
  });
});
