import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BEDROCK } from '../provider.js';
import type { ConflictFlow, ConflictLayer, ConflictResolution } from '../resolver.js';
import { askSwitchOrCancel, stopGuidance, type ConflictFindings, type SwitchPrompt } from '../prompt.js';

const SECRET = 'SECRET-VALUE-9f3a';

function layer(over: Partial<ConflictLayer> = {}): ConflictLayer {
  return {
    path: '/home/u/.claude/settings.json',
    scope: 'user',
    editable: true,
    state: 'ok',
    inEffect: true,
    setsFlag: true,
    flag: 'on',
    flagKey: 'env.CLAUDE_CODE_USE_BEDROCK',
    keyNames: ['env.CLAUDE_CODE_USE_BEDROCK', 'env.AWS_REGION'],
    bedrockModelKeys: [],
    ...over,
  };
}

function findings(
  layers: ConflictLayer[] = [layer()],
  over: { flow?: ConflictFlow; verdict?: ConflictResolution['verdict']; unknownReason?: string } = {}
): ConflictFindings {
  return {
    provider: BEDROCK,
    flow: over.flow ?? 'claude-agent',
    resolution: {
      verdict: over.verdict ?? 'conflict-editable',
      layers,
      warnings: [],
      ...(over.unknownReason ? { unknownReason: over.unknownReason } : {}),
    },
  };
}

function harness(answer: 'switch' | 'cancel' | 'pending') {
  const lines: string[] = [];
  const questions: unknown[] = [];
  const prompt: SwitchPrompt = (qs) => {
    questions.push(...qs);
    return answer === 'pending' ? new Promise(() => undefined) : Promise.resolve({ choice: answer });
  };
  return { lines, questions, deps: { prompt, print: (l: string) => lines.push(l) } };
}

describe('askSwitchOrCancel', () => {
  it('returns switch when the user picks the switch choice', async () => {
    const h = harness('switch');
    await expect(askSwitchOrCancel(findings(), h.deps)).resolves.toBe('switch');
  });

  it('returns cancel when the user picks cancel', async () => {
    const h = harness('cancel');
    await expect(askSwitchOrCancel(findings(), h.deps)).resolves.toBe('cancel');
  });

  it('offers exactly the two choices', async () => {
    const h = harness('cancel');
    await askSwitchOrCancel(findings(), h.deps);
    const q = h.questions[0] as { choices: Array<{ name: string; value: string }> };
    expect(q.choices.map((c) => c.value)).toEqual(['switch', 'cancel']);
    expect(q.choices[0].name).toBe('Back up and switch to the CodeMie gateway');
    expect(q.choices[1].name).toBe('Cancel');
  });

  it('resolves to cancel on SIGINT and restores the listener count', async () => {
    const h = harness('pending');
    const before = process.listenerCount('SIGINT');
    const pending = askSwitchOrCancel(findings(), h.deps);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    process.emit('SIGINT');
    await expect(pending).resolves.toBe('cancel');
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('restores the listener count after a normal answer', async () => {
    const h = harness('switch');
    const before = process.listenerCount('SIGINT');
    await askSwitchOrCancel(findings(), h.deps);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('treats a rejected prompt (closed by Ctrl-C) as cancel', async () => {
    const lines: string[] = [];
    const before = process.listenerCount('SIGINT');
    const result = await askSwitchOrCancel(findings(), {
      prompt: () => Promise.reject(new Error('prompt closed')),
      print: (l) => lines.push(l),
    });
    expect(result).toBe('cancel');
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('states the exclusion, lists paths and key names, and marks the shared project file', async () => {
    const h = harness('cancel');
    await askSwitchOrCancel(
      findings([
        layer(),
        layer({ path: '/repo/.claude/settings.json', scope: 'project', keyNames: ['env.CLAUDE_CODE_USE_BEDROCK'] }),
      ]),
      h.deps
    );
    const text = h.lines.join('\n');
    expect(text).toMatch(/cannot both be active/i);
    expect(text).toContain('/home/u/.claude/settings.json');
    expect(text).toContain('env.AWS_REGION');
    const projectLine = h.lines.find((l) => l.includes('/repo/.claude/settings.json')) ?? '';
    expect(projectLine).toMatch(/shared/i);
    const userLine = h.lines.find((l) => l.includes('/home/u/.claude/settings.json')) ?? '';
    expect(userLine).not.toMatch(/shared/i);
    expect(text).toMatch(/restart/i);
  });

  it('lists model keys removed from layers that do not carry the flag, whole entries for VS Code', async () => {
    const h = harness('cancel');
    await askSwitchOrCancel(
      findings(
        [
          layer(),
          layer({
            path: '/repo/.claude/settings.local.json',
            scope: 'project-local',
            setsFlag: false,
            inEffect: false,
            flag: 'unset',
            keyNames: ['env.ANTHROPIC_MODEL'],
            bedrockModelKeys: ['env.ANTHROPIC_MODEL'],
          }),
          layer({
            path: '/home/u/vscode/settings.json',
            scope: 'vscode',
            setsFlag: false,
            inEffect: false,
            flag: 'unset',
            flagKey: 'CLAUDE_CODE_USE_BEDROCK',
            keyNames: ['ANTHROPIC_MODEL'],
            bedrockModelKeys: ['ANTHROPIC_MODEL'],
          }),
        ],
        { flow: 'connect-vscode' }
      ),
      h.deps
    );
    const text = h.lines.join('\n');
    expect(text).toMatch(/also be removed/i);
    expect(text).toContain('/repo/.claude/settings.local.json');
    expect(text).toContain('whole environment-variable entries');
  });

  it('adds the install-only line for the install flow only', async () => {
    const install = harness('cancel');
    await askSwitchOrCancel(findings([layer()], { flow: 'install' }), install.deps);
    expect(install.lines.join('\n')).toMatch(/codemie-claude/);

    const agent = harness('cancel');
    await askSwitchOrCancel(findings([layer()], { flow: 'claude-agent' }), agent.deps);
    expect(agent.lines.join('\n')).not.toMatch(/nothing routes/i);
  });

  it('neutralises control characters in paths and key names', async () => {
    const h = harness('cancel');
    await askSwitchOrCancel(
      findings([layer({ path: '/tmp/\u001b[31mevil\u0007/settings.json', keyNames: ['env.A\u001bB'] })]),
      h.deps
    );
    const text = h.lines.join('\n') + JSON.stringify(h.questions);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(text).toContain('/tmp/[31mevil/settings.json');
  });

  it('never prints a setting value', async () => {
    const h = harness('cancel');
    await askSwitchOrCancel(findings(), h.deps);
    expect(h.lines.join('\n') + JSON.stringify(h.questions)).not.toContain(SECRET);
  });
});

describe('stopGuidance', () => {
  it('cancel: says what was found and where, that nothing changed, and how to resolve', () => {
    const text = stopGuidance('cancel', findings());
    expect(text).toContain('/home/u/.claude/settings.json');
    expect(text).toContain('env.CLAUDE_CODE_USE_BEDROCK');
    expect(text).toMatch(/nothing was changed/i);
    expect(text).toMatch(/remove/i);
    expect(text).toMatch(/choose switch|select switch|pick switch/i);
  });

  it('unknown: names the file and the exact key from the resolution', () => {
    const reason = '/home/u/.claude/settings.json: env.CLAUDE_CODE_USE_BEDROCK has a value that is not a recognised on/off spelling';
    const text = stopGuidance(
      'unknown',
      findings([layer({ flag: 'unknown', setsFlag: false, inEffect: false })], { verdict: 'unknown', unknownReason: reason })
    );
    expect(text).toContain(reason);
    expect(text).toMatch(/nothing was changed/i);
  });

  it('unknown: falls back to the layer flag key when no reason is set', () => {
    const text = stopGuidance(
      'unknown',
      findings([layer({ state: 'unreadable', flag: 'unset', setsFlag: false, inEffect: false })], { verdict: 'unknown' })
    );
    expect(text).toContain('/home/u/.claude/settings.json');
    expect(text).toContain('env.CLAUDE_CODE_USE_BEDROCK');
  });

  it('managed: says it is set by IT, cannot be changed by CodeMie, and names the managed source', () => {
    const text = stopGuidance(
      'managed',
      findings(
        [
          layer({ path: '/etc/claude-code/managed-settings.json', scope: 'managed', editable: false }),
          layer({ path: '/home/u/.claude/settings.json', scope: 'user' }),
        ],
        { verdict: 'conflict-managed' }
      )
    );
    expect(text).toContain('/etc/claude-code/managed-settings.json');
    expect(text).toMatch(/administrator|IT|managed policy/i);
    expect(text).toMatch(/cannot change/i);
    expect(text).not.toContain('/home/u/.claude/settings.json');
  });

  it('non-interactive: explains nothing was changed and how to resolve', () => {
    const text = stopGuidance('non-interactive', findings());
    expect(text).toContain('/home/u/.claude/settings.json');
    expect(text).toMatch(/no prompt|not interactive|non-interactive/i);
    expect(text).toMatch(/nothing was changed/i);
    expect(text).toMatch(/rerun/i);
  });

  it('mentions the residual connect bypass in one sentence for connect flows only', () => {
    const connect = stopGuidance('non-interactive', findings([layer()], { flow: 'connect-vscode' }));
    expect(connect).toMatch(/Bedrock project elsewhere/);
    expect(connect).toMatch(/user, managed, Desktop and VS Code/);
    const agent = stopGuidance('non-interactive', findings([layer()], { flow: 'claude-agent' }));
    expect(agent).not.toMatch(/Bedrock project elsewhere/);
  });

  it('neutralises control characters and never contains a setting value', () => {
    for (const reason of ['cancel', 'unknown', 'managed', 'non-interactive'] as const) {
      const text = stopGuidance(
        reason,
        findings(
          [layer({ path: '/tmp/\u001b[31mx/settings.json', scope: reason === 'managed' ? 'managed' : 'user', editable: reason !== 'managed' })],
          { unknownReason: '/tmp/\u001b[31mx/settings.json: env.K\u0007 cannot be read' }
        )
      );
      // eslint-disable-next-line no-control-regex
      expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      expect(text).not.toContain(SECRET);
    }
  });
});

describe('module hygiene', () => {
  it('never exits the process', () => {
    const source = readFileSync(fileURLToPath(new URL('../prompt.ts', import.meta.url)), 'utf-8');
    expect(source).not.toMatch(/process\s*\.\s*exit/);
    expect(source).not.toMatch(/\bexit\s*\(/);
  });
});
