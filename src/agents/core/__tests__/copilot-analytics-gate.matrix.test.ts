/**
 * Copilot analytics disable matrix: disable-all and exclude-one-project crossed with the existing
 * connector scope (user / project), driven through the REAL gate, preferences and connector-scope
 * modules (only the storage directory is redirected to a temp dir).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let tempDir: string = tmpdir();

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return {
    ...actual,
    getCodemiePath: (...paths: string[]) => join(tempDir, ...paths),
  };
});

const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
const { updateCopilotAnalyticsPreferences, getCopilotAnalyticsPreferencesPath } = await import(
  '../copilot-analytics-preferences.js'
);
const { writeCopilotConnectorScope } = await import('../copilot-connector-scope.js');

const CONNECTORS = ['copilot-cli-otlp', 'copilot-chat-otlp'] as const;

describe.each(CONNECTORS)('regression: EPMCDME-16396 — copilot analytics matrix (%s)', (connectorId) => {
  const other = CONNECTORS.find((c) => c !== connectorId) as string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codemie-copilot-matrix-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe.each([
    ['user scope', { enabled: true, scope: 'user' } as const],
    ['project scope', { enabled: true, scope: 'project', paths: ['/work/a', '/work/b'] } as const],
  ])('%s', (_label, scope) => {
    beforeEach(async () => {
      await writeCopilotConnectorScope(connectorId, scope);
    });

    it('with no preferences file the project is tracked (default is fully enabled)', async () => {
      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).toEqual({ tracked: true });
    });

    it('exclude /work/a blocks it with project-excluded and leaves /work/b tracked', async () => {
      await updateCopilotAnalyticsPreferences(connectorId, (c) => ({ ...c, excludedProjects: ['/work/a'] }));

      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).toEqual({
        tracked: false,
        reason: 'project-excluded',
      });
      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a/nested')).toEqual({
        tracked: false,
        reason: 'project-excluded',
      });
      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/b')).toEqual({ tracked: true });
    });

    it('a sibling sharing a string prefix with the excluded project stays tracked', async () => {
      await writeCopilotConnectorScope(connectorId, { enabled: true, scope: 'user' });
      await updateCopilotAnalyticsPreferences(connectorId, (c) => ({ ...c, excludedProjects: ['/work/a'] }));

      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/ab')).toEqual({ tracked: true });
    });

    it('disable all stops every project', async () => {
      await updateCopilotAnalyticsPreferences(connectorId, (c) => ({ ...c, enabled: false }));

      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).toEqual({
        tracked: false,
        reason: 'analytics-disabled',
      });
      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/b')).toEqual({
        tracked: false,
        reason: 'analytics-disabled',
      });
    });

    it('enable restores tracking after disable, include restores it after exclude', async () => {
      await updateCopilotAnalyticsPreferences(connectorId, (c) => ({
        ...c,
        enabled: false,
        excludedProjects: ['/work/a'],
      }));
      await updateCopilotAnalyticsPreferences(connectorId, (c) => ({ ...c, enabled: true }));
      expect((await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).tracked).toBe(false);

      await updateCopilotAnalyticsPreferences(connectorId, (c) => ({ ...c, excludedProjects: [] }));
      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).toEqual({ tracked: true });
    });

    it('preferences for the other copilot connector do not affect this one', async () => {
      await updateCopilotAnalyticsPreferences(other, (c) => ({ ...c, enabled: false, excludedProjects: ['/work/a'] }));

      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).toEqual({ tracked: true });
    });

    it('a corrupt preferences file fails closed with preferences-corrupt', async () => {
      const path = getCopilotAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{not json', 'utf-8');

      expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).toEqual({
        tracked: false,
        reason: 'preferences-corrupt',
      });
    });

    it('an undefined or empty cwd never throws and fails closed when something is excluded', async () => {
      await updateCopilotAnalyticsPreferences(connectorId, (c) => ({ ...c, excludedProjects: ['/work/a'] }));

      for (const cwd of [undefined, '']) {
        expect(await evaluateCopilotAnalyticsGate(connectorId, cwd)).toEqual({ tracked: false, reason: 'project-excluded' });
      }
    });

    it('an undefined or empty cwd with nothing excluded behaves exactly as before the exclusion layer', async () => {
      for (const cwd of [undefined, '']) {
        const decision = await evaluateCopilotAnalyticsGate(connectorId, cwd);
        expect(decision).toEqual(scope.scope === 'user' ? { tracked: true } : { tracked: false, reason: 'scope-untracked' });
      }
    });
  });

  it('a connector that was never connected stays untracked even with analytics enabled (opt-in is preserved)', async () => {
    expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).toEqual({
      tracked: false,
      reason: 'scope-disabled',
    });
  });

  it('writing analytics preferences never touches copilot-connectors.json (connect state is independent)', async () => {
    await writeCopilotConnectorScope(connectorId, { enabled: true, scope: 'project', paths: ['/work/a'] });
    await updateCopilotAnalyticsPreferences(connectorId, (c) => ({ ...c, enabled: false, excludedProjects: ['/work/a'] }));

    const { readCopilotConnectorScope } = await import('../copilot-connector-scope.js');
    expect(await readCopilotConnectorScope(connectorId)).toEqual({
      kind: 'ok',
      value: { enabled: true, scope: 'project', paths: ['/work/a'] },
    });
  });

  it('re-running connect (fresh user-scope literal) does not wipe analytics preferences', async () => {
    await writeCopilotConnectorScope(connectorId, { enabled: true, scope: 'user' });
    await updateCopilotAnalyticsPreferences(connectorId, (c) => ({ ...c, excludedProjects: ['/work/a'] }));

    await writeCopilotConnectorScope(connectorId, { enabled: true, scope: 'user' });

    expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).toEqual({
      tracked: false,
      reason: 'project-excluded',
    });
  });

  it('disconnect (scope disabled) then reconnect keeps the analytics preferences', async () => {
    await writeCopilotConnectorScope(connectorId, { enabled: true, scope: 'user' });
    await updateCopilotAnalyticsPreferences(connectorId, (c) => ({ ...c, enabled: false }));

    await writeCopilotConnectorScope(connectorId, { enabled: false });
    await writeCopilotConnectorScope(connectorId, { enabled: true, scope: 'user' });

    expect(await evaluateCopilotAnalyticsGate(connectorId, '/work/a')).toEqual({
      tracked: false,
      reason: 'analytics-disabled',
    });
  });
});
