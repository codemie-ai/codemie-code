/**
 * Launch env defaults: applying an agent's declared variables at launch, and describing their
 * effective value and source for `codemie doctor`.
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import type { LaunchEnvDefault, LaunchSettingsLayer } from '../types.js';
import {
  applyLaunchEnvDefaults,
  applyProviderAgentEnv,
  providerAgentEnv,
  defaultsApplyOnProvider,
  describeLaunchEnv,
  formatLaunchEnvReport,
  LAUNCH_ENV_HEADER,
} from '../launch-env.js';
import { ProviderRegistry } from '@/providers/core/registry.js';

ProviderRegistry.registerProvider({
  name: 'fake-replaces-claude',
  agentHooks: { claude: { beforeRun: async (env: NodeJS.ProcessEnv) => env } },
} as never);
ProviderRegistry.registerProvider({
  name: 'fake-env-provider',
  agentHooks: { claude: { env: { A: '0', P: 'provider-p' } } },
} as never);

describe('providerAgentEnv', () => {
  it("returns the env the provider declares for that agent, and nothing for any other", () => {
    expect(providerAgentEnv('fake-env-provider', 'claude')).toEqual({ A: '0', P: 'provider-p' });
    expect(providerAgentEnv('fake-env-provider', 'gemini')).toEqual({});
    expect(providerAgentEnv('no-such-provider', 'claude')).toEqual({});
    expect(providerAgentEnv(undefined, 'claude')).toEqual({});
  });

  it('declaring env alone does not replace the agent default beforeRun', () => {
    expect(defaultsApplyOnProvider('claude', 'fake-env-provider')).toBe(true);
  });
});

describe('applyProviderAgentEnv', () => {
  it('sets the provider values only where the variable is unset or empty', () => {
    const env: NodeJS.ProcessEnv = { CODEMIE_PROVIDER: 'fake-env-provider', A: '', P: 'shell-p' };
    applyProviderAgentEnv(env, 'claude');
    expect(env.A).toBe('0');
    expect(env.P).toBe('shell-p');
  });

  it('is a no-op without a provider', () => {
    const env: NodeJS.ProcessEnv = { A: '' };
    applyProviderAgentEnv(env, 'claude');
    expect(env).toEqual({ A: '' });
  });
});

const DEFAULTS: readonly LaunchEnvDefault[] = [
  { name: 'A', value: () => ({ value: '1', from: 'codemie-default' }), why: 'a' },
  {
    name: 'B',
    value: (env) => (env.P ? { value: env.P, from: 'profile' } : { value: '85', from: 'codemie-default' }),
    why: 'b',
  },
  { name: 'C', value: () => undefined, why: 'only on some providers' },
];

const LOW = '/home/u/.claude/settings.json';
const HIGH = '/proj/.claude/settings.local.json';

function layer(path: string, env: Record<string, unknown> | undefined, state: LaunchSettingsLayer['state'] = 'ok'): LaunchSettingsLayer {
  return { path, state, ...(env ? { env } : {}) };
}

describe('applyLaunchEnvDefaults', () => {
  it('sets only unset or empty variables, in declaration order', () => {
    const order: string[] = [];
    const tracked: LaunchEnvDefault[] = DEFAULTS.map((d) => ({
      ...d,
      value: (env) => {
        order.push(d.name);
        return d.value(env);
      },
    }));
    const env: NodeJS.ProcessEnv = { A: '', B: '70' };

    applyLaunchEnvDefaults(env, tracked);

    expect(env.A).toBe('1');
    expect(env.B).toBe('70');
    expect('C' in env).toBe(false);
    expect(order).toEqual(['A', 'C']);
  });
});

describe('defaultsApplyOnProvider', () => {
  it('is false only when the provider has a beforeRun for that agent name', () => {
    expect(defaultsApplyOnProvider('claude', 'fake-replaces-claude')).toBe(false);
    expect(defaultsApplyOnProvider('claude-acp', 'fake-replaces-claude')).toBe(true);
    expect(defaultsApplyOnProvider('claude', undefined)).toBe(true);
    expect(defaultsApplyOnProvider('claude', 'no-such-provider')).toBe(true);
  });
});

describe('describeLaunchEnv', () => {
  it('precedence: settings > shell > profile/codemie default', () => {
    const fromSettings = describeLaunchEnv(DEFAULTS, {
      shellEnv: { A: '1' },
      defaultsApply: true,
      settingsLayers: [layer(LOW, { A: '1' }), layer(HIGH, { A: '0' })],
    });
    expect(fromSettings.rows.find((r) => r.name === 'A')).toEqual({
      name: 'A',
      effective: '0',
      source: 'settings',
      path: HIGH,
      codemieValue: '1',
    });

    const fromShell = describeLaunchEnv(DEFAULTS, { shellEnv: { A: '1' }, defaultsApply: true, settingsLayers: [] });
    expect(fromShell.rows.find((r) => r.name === 'A')).toEqual({ name: 'A', effective: '1', source: 'shell' });

    const fromProfile = describeLaunchEnv(DEFAULTS, { shellEnv: { P: '70' }, defaultsApply: true, settingsLayers: [] });
    expect(fromProfile.rows.find((r) => r.name === 'B')).toEqual({ name: 'B', effective: '70', source: 'profile' });

    const fromDefault = describeLaunchEnv(DEFAULTS, { shellEnv: {}, defaultsApply: true, settingsLayers: [] });
    expect(fromDefault.rows.find((r) => r.name === 'B')).toEqual({ name: 'B', effective: '85', source: 'codemie-default' });
  });

  it('a provider value sits between the shell and the agent default', () => {
    const fromProvider = describeLaunchEnv(DEFAULTS, {
      shellEnv: {},
      defaultsApply: true,
      settingsLayers: [],
      providerEnv: { A: '0' },
    });
    expect(fromProvider.rows.find((r) => r.name === 'A')).toEqual({ name: 'A', effective: '0', source: 'provider', codemieValue: '1' });

    const shellWins = describeLaunchEnv(DEFAULTS, {
      shellEnv: { A: '7' },
      defaultsApply: true,
      settingsLayers: [],
      providerEnv: { A: '0' },
    });
    expect(shellWins.rows.find((r) => r.name === 'A')).toMatchObject({ effective: '7', source: 'shell' });

    const settingsWin = describeLaunchEnv(DEFAULTS, {
      shellEnv: {},
      defaultsApply: true,
      settingsLayers: [layer(HIGH, { A: '5' })],
      providerEnv: { A: '0' },
    });
    expect(settingsWin.rows.find((r) => r.name === 'A')).toMatchObject({ effective: '5', source: 'settings', codemieValue: '0' });
  });

  it('a provider value shows even when the provider replaces the agent hook', () => {
    const report = describeLaunchEnv(DEFAULTS, {
      shellEnv: {},
      defaultsApply: false,
      settingsLayers: [],
      providerEnv: { A: '0' },
    });
    expect(report).toEqual({ applied: false, rows: [{ name: 'A', effective: '0', source: 'provider' }], unreadable: [] });
  });

  it('a settings-key declaration reads the top-level key of a settings file, never the shell', () => {
    const KEY: LaunchEnvDefault[] = [{ name: 'promptCacheTtl', settingsKey: true, value: () => undefined, why: 'k' }];
    const report = describeLaunchEnv(KEY, {
      shellEnv: { promptCacheTtl: 'from-shell' },
      defaultsApply: true,
      settingsLayers: [
        { path: LOW, state: 'ok', settings: { promptCacheTtl: '1h' } },
        { path: HIGH, state: 'ok', settings: { promptCacheTtl: '5m' }, env: { promptCacheTtl: 'from-env-block' } },
      ],
    });
    expect(report.rows).toEqual([{ name: 'promptCacheTtl', effective: '5m', source: 'settings', path: HIGH }]);

    const unset = describeLaunchEnv(KEY, { shellEnv: { promptCacheTtl: '5m' }, defaultsApply: true, settingsLayers: [] });
    expect(unset.rows).toEqual([]);
  });

  it('a settings entry that blanks a variable wins, as an empty effective value', () => {
    const report = describeLaunchEnv(DEFAULTS, {
      shellEnv: { A: '1' },
      defaultsApply: true,
      settingsLayers: [layer(HIGH, { A: '' })],
    });
    expect(report.rows.find((r) => r.name === 'A')).toEqual({
      name: 'A',
      effective: '',
      source: 'settings',
      path: HIGH,
      codemieValue: '1',
    });
  });

  it('a variable nothing sets gets no row', () => {
    const report = describeLaunchEnv(DEFAULTS, { shellEnv: {}, defaultsApply: true, settingsLayers: [] });
    expect(report.rows.map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('an unreadable layer is listed in unreadable and skipped', () => {
    const report = describeLaunchEnv(DEFAULTS, {
      shellEnv: {},
      defaultsApply: true,
      settingsLayers: [layer(LOW, { A: '0' }), layer(HIGH, undefined, 'unreadable'), layer('/absent', undefined, 'absent')],
    });
    expect(report.unreadable).toEqual([HIGH]);
    expect(report.rows.find((r) => r.name === 'A')).toMatchObject({ effective: '0', path: LOW });
  });

  it('defaultsApply=false gives no rows', () => {
    expect(
      describeLaunchEnv(DEFAULTS, { shellEnv: { A: '1' }, defaultsApply: false, settingsLayers: [] })
    ).toEqual({ applied: false, rows: [], unreadable: [] });
  });
});

describe('formatLaunchEnvReport', () => {
  const opts = { provider: 'ai-run-sso', profileName: 'work' };

  it('words and grades each source', () => {
    const lines = formatLaunchEnvReport(
      {
        applied: true,
        unreadable: [],
        rows: [
          { name: 'A', effective: '1', source: 'codemie-default' },
          { name: 'B', effective: '70', source: 'profile' },
          { name: 'C', effective: 'x', source: 'shell', codemieValue: 'y' },
          { name: 'D', effective: '0', source: 'settings', path: HIGH, codemieValue: '1' },
          { name: 'E', effective: '', source: 'settings', path: HIGH, codemieValue: '1' },
        ],
      },
      opts
    );
    // One header, then `NAME = value  source` rows with names and values padded to one column each.
    expect(lines).toEqual([
      {
        status: 'info',
        message: LAUNCH_ENV_HEADER,
        children: [
          { status: 'ok', message: 'A = 1        CodeMie default' },
          { status: 'ok', message: 'B = 70       profile "work"' },
          { status: 'info', message: "C = x        your shell, overrides CodeMie's y" },
          { status: 'info', message: `D = 0        ${HIGH}, overrides CodeMie's 1` },
          { status: 'warn', message: `E = (empty)  ${HIGH}, overrides CodeMie's 1`, hint: `Remove E from ${HIGH}` },
        ],
      },
    ]);
  });

  it('names the provider that set a value', () => {
    expect(
      formatLaunchEnvReport(
        { applied: true, unreadable: [], rows: [{ name: 'A', effective: '0', source: 'provider', codemieValue: '1' }] },
        opts
      )
    ).toEqual([
      {
        status: 'info',
        message: LAUNCH_ENV_HEADER,
        children: [{ status: 'ok', message: 'A = 0  provider ai-run-sso, replaces default 1' }],
      },
    ]);
  });

  it('names an unreadable settings file and how to fix it', () => {
    expect(formatLaunchEnvReport({ applied: true, rows: [], unreadable: [HIGH] }, opts)).toEqual([
      {
        status: 'info',
        message: LAUNCH_ENV_HEADER,
        children: [
          {
            status: 'info',
            message: `Could not read ${HIGH}; its values are not shown`,
            hint: `Fix the JSON or the permissions of ${HIGH}`,
          },
        ],
      },
    ]);
  });

  it('prints nothing when there is nothing to show', () => {
    expect(formatLaunchEnvReport({ applied: true, rows: [], unreadable: [] }, opts)).toEqual([]);
  });

  it('is one line when the provider does not apply the defaults', () => {
    expect(formatLaunchEnvReport({ applied: false, rows: [], unreadable: [] }, { provider: 'bedrock', profileName: 'w' })).toEqual([
      { status: 'info', message: 'Launch defaults not applied on bedrock' },
    ]);
  });

  it('strips terminal controls from names, values and paths', () => {
    const lines = formatLaunchEnvReport(
      {
        applied: true,
        unreadable: ['/p/\x1b]0;evil\x07x.json'],
        rows: [{ name: 'A\x1b[31m', effective: 'v\x1b[2J', source: 'settings', path: '/p/\x1b[31ms.json' }],
      },
      opts
    );
    const children = lines[0].children ?? [];
    const text = children.map((l) => `${l.message} ${l.hint ?? ''}`).join('\n');
    expect(text).not.toMatch(/\x1b/); // eslint-disable-line no-control-regex
    expect(text).not.toContain('evil');
    expect(children[0].message).toBe('A = v  /p/s.json');
  });
});
