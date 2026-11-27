import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@/utils/logger.js', () => ({
  logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() }
}));

const CONFIG = path.join('.codemie', 'codemie-cli.config.json');

describe('analytics reduction setting', () => {
  let root: string;
  let home: string;
  let project: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    warn.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'reduction-setting-'));
    home = path.join(root, 'home');
    project = path.join(root, 'project');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    savedHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = savedHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  async function put(file: string, content: string): Promise<string> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf-8');
    return file;
  }

  describe('readReductionFlag', () => {
    it('is off for a missing file', async () => {
      const { readReductionFlag } = await import('../analytics-reduction-setting.js');
      expect(await readReductionFlag(path.join(project, CONFIG))).toBe('off');
    });

    it('is off for a file without the key', async () => {
      const { readReductionFlag } = await import('../analytics-reduction-setting.js');
      const f = await put(path.join(project, CONFIG), '{"version":2}');
      expect(await readReductionFlag(f)).toBe('off');
    });

    it('is on only for a strict true, off for false or a missing key', async () => {
      const { readReductionFlag } = await import('../analytics-reduction-setting.js');
      const f = path.join(project, CONFIG);
      await put(f, '{"analytics":{"promptReduction":true}}');
      expect(await readReductionFlag(f)).toBe('on');
      for (const body of ['{"analytics":{"promptReduction":false}}', '{"analytics":{}}', '{}']) {
        await put(f, body);
        expect(await readReductionFlag(f)).toBe('off');
      }
    });

    it('treats a malformed setting (non-boolean flag, non-object analytics) as unreadable, so it fails closed', async () => {
      const { readReductionFlag } = await import('../analytics-reduction-setting.js');
      const f = path.join(project, CONFIG);
      for (const body of ['{"analytics":{"promptReduction":"true"}}', '{"analytics":{"promptReduction":1}}', '{"analytics":{"promptReduction":null}}', '{"analytics":"on"}', '{"analytics":[]}']) {
        await put(f, body);
        expect(await readReductionFlag(f)).toBe('unreadable');
      }
    });

    it('is unreadable for a conflict-marker file and for a non-object', async () => {
      const { readReductionFlag } = await import('../analytics-reduction-setting.js');
      const f = path.join(project, CONFIG);
      await put(f, '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n');
      expect(await readReductionFlag(f)).toBe('unreadable');
      await put(f, '[1]');
      expect(await readReductionFlag(f)).toBe('unreadable');
      await put(f, 'null');
      expect(await readReductionFlag(f)).toBe('unreadable');
    });

    it('is unreadable when the path cannot be read as a file', async () => {
      const { readReductionFlag } = await import('../analytics-reduction-setting.js');
      await fs.mkdir(path.join(project, CONFIG), { recursive: true });
      expect(await readReductionFlag(path.join(project, CONFIG))).toBe('unreadable');
    });
  });

  describe('isReductionOn', () => {
    it('is false with nothing configured', async () => {
      const { isReductionOn } = await import('../analytics-reduction-setting.js');
      expect(await isReductionOn({ configDirs: [project] })).toBe(false);
    });

    it('is on when the project or the global file is on (either wins)', async () => {
      const { isReductionOn } = await import('../analytics-reduction-setting.js');
      await put(path.join(project, CONFIG), '{"analytics":{"promptReduction":true}}');
      expect(await isReductionOn({ configDirs: [project] })).toBe(true);
      await fs.rm(path.join(project, CONFIG));
      expect(await isReductionOn({ configDirs: [project] })).toBe(false);
      await put(path.join(home, 'codemie-cli.config.json'), '{"analytics":{"promptReduction":true}}');
      expect(await isReductionOn({ configDirs: [project] })).toBe(true);
    });

    it('accepts a .codemie dir, and skips undefined, empty and duplicate entries', async () => {
      const { isReductionOn } = await import('../analytics-reduction-setting.js');
      await put(path.join(project, CONFIG), '{"analytics":{"promptReduction":true}}');
      expect(await isReductionOn({ configDirs: [path.join(project, '.codemie')] })).toBe(true);
      const dirs = [undefined, '', project, project] as unknown as string[];
      expect(await isReductionOn({ configDirs: dirs })).toBe(true);
    });

    it('treats an unreadable file as on and warns once across calls', async () => {
      const { isReductionOn } = await import('../analytics-reduction-setting.js');
      await put(path.join(project, CONFIG), '<<<<<<< HEAD\n');
      expect(await isReductionOn({ configDirs: [project] })).toBe(true);
      expect(await isReductionOn({ configDirs: [project] })).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).not.toContain('HEAD');
    });

    it('warns again after the file reads clean and breaks again', async () => {
      const { isReductionOn } = await import('../analytics-reduction-setting.js');
      const f = path.join(project, CONFIG);
      await put(f, '{{');
      await isReductionOn({ configDirs: [project] });
      await put(f, '{}');
      expect(await isReductionOn({ configDirs: [project] })).toBe(false);
      await put(f, '{{');
      await isReductionOn({ configDirs: [project] });
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('writeProjectReductionFlag', () => {
    it('writes only the flag into an empty repo', async () => {
      const { writeProjectReductionFlag } = await import('../analytics-reduction-setting.js');
      await writeProjectReductionFlag(project);
      expect(await fs.readFile(path.join(project, CONFIG), 'utf-8')).toBe('{"analytics":{"promptReduction":true}}');
    });

    it('preserves an existing file except the new key', async () => {
      const { writeProjectReductionFlag } = await import('../analytics-reduction-setting.js');
      const f = path.join(project, CONFIG);
      const original = JSON.stringify(
        { version: 2, activeProfile: 'a', profiles: { a: { provider: 'ai-run-sso', model: 'x' } } },
        null,
        4
      ) + '\n';
      await put(f, original);
      await writeProjectReductionFlag(project);
      const after = await fs.readFile(f, 'utf-8');
      const expected = JSON.stringify(
        { ...JSON.parse(original), analytics: { promptReduction: true } },
        null,
        4
      ) + '\n';
      expect(after).toBe(expected);
      expect(after.startsWith(original.slice(0, original.lastIndexOf('\n}')))).toBe(true);
    });

    it('keeps other analytics keys', async () => {
      const { writeProjectReductionFlag } = await import('../analytics-reduction-setting.js');
      const f = await put(path.join(project, CONFIG), '{"analytics":{"other":1}}');
      await writeProjectReductionFlag(project);
      expect(JSON.parse(await fs.readFile(f, 'utf-8'))).toEqual({ analytics: { other: 1, promptReduction: true } });
    });

    it('refuses to overwrite an unreadable file', async () => {
      const { writeProjectReductionFlag } = await import('../analytics-reduction-setting.js');
      const f = await put(path.join(project, CONFIG), '<<<<<<< HEAD\n');
      await expect(writeProjectReductionFlag(project)).rejects.toThrow();
      expect(await fs.readFile(f, 'utf-8')).toBe('<<<<<<< HEAD\n');
    });
  });

  describe('writeGlobalReductionFlag', () => {
    it('sets true and false in the global file', async () => {
      const { writeGlobalReductionFlag, readReductionFlag } = await import('../analytics-reduction-setting.js');
      const f = path.join(home, 'codemie-cli.config.json');
      await writeGlobalReductionFlag(true);
      expect(await readReductionFlag(f)).toBe('on');
      await writeGlobalReductionFlag(false);
      expect(await readReductionFlag(f)).toBe('off');
      expect(JSON.parse(await fs.readFile(f, 'utf-8'))).toEqual({ analytics: { promptReduction: false } });
    });
  });

  describe('opted-in projects', () => {
    it('is empty when the list is missing', async () => {
      const { readOptedInProjects } = await import('../analytics-reduction-setting.js');
      expect(await readOptedInProjects()).toEqual([]);
    });

    it('adds absolute paths without duplicates', async () => {
      const { readOptedInProjects, addOptedInProject } = await import('../analytics-reduction-setting.js');
      await addOptedInProject(project);
      await addOptedInProject(project);
      expect(await readOptedInProjects()).toEqual([project]);
      expect(JSON.parse(await fs.readFile(path.join(home, 'analytics-reduction-projects.json'), 'utf-8'))).toEqual([project]);
    });

    it('removes a project from the list and leaves the others', async () => {
      const { readOptedInProjects, addOptedInProject, removeOptedInProject } = await import('../analytics-reduction-setting.js');
      const other = path.join(root, 'other');
      await addOptedInProject(project);
      await addOptedInProject(other);
      await removeOptedInProject(project);
      expect(await readOptedInProjects()).toEqual([other]);
      await removeOptedInProject(project);
      expect(await readOptedInProjects()).toEqual([other]);
    });

    it('does not destroy an unreadable list on remove', async () => {
      const { removeOptedInProject } = await import('../analytics-reduction-setting.js');
      const f = await put(path.join(home, 'analytics-reduction-projects.json'), '<<<<<<<');
      await expect(removeOptedInProject(project)).rejects.toThrow();
      expect(await fs.readFile(f, 'utf-8')).toBe('<<<<<<<');
    });

    it('turns a project flag off with an explicit false and keeps every other key', async () => {
      const { readReductionFlag, writeProjectReductionFlag } = await import('../analytics-reduction-setting.js');
      const file = await put(path.join(project, CONFIG), JSON.stringify({ version: 2, profiles: {}, analytics: { promptReduction: true } }));
      await writeProjectReductionFlag(project, false);
      expect(await readReductionFlag(file)).toBe('off');
      expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toMatchObject({ version: 2, analytics: { promptReduction: false } });
    });

    it('rejects a relative path', async () => {
      const { addOptedInProject } = await import('../analytics-reduction-setting.js');
      await expect(addOptedInProject('rel/dir')).rejects.toThrow();
    });

    it('reports an unreadable list and does not destroy it on add', async () => {
      const { readOptedInProjects, addOptedInProject } = await import('../analytics-reduction-setting.js');
      const f = await put(path.join(home, 'analytics-reduction-projects.json'), '<<<<<<<');
      expect(await readOptedInProjects()).toBe('unreadable');
      await expect(addOptedInProject(project)).rejects.toThrow();
      expect(await fs.readFile(f, 'utf-8')).toBe('<<<<<<<');
    });
  });

  describe('profile selection is unaffected by a flag-only local file', () => {
    it('loadLocalConfigProfile, resolveProfileName and getActiveProfileName match the no-file result', async () => {
      const { ConfigLoader } = await import('../config.js');
      const { writeProjectReductionFlag } = await import('../analytics-reduction-setting.js');
      await put(path.join(home, 'codemie-cli.config.json'), JSON.stringify({
        version: 2, activeProfile: 'g', profiles: { g: { provider: 'ai-run-sso', model: 'm' } }
      }));
      const probe = async (): Promise<unknown> => {
        const loader = ConfigLoader as unknown as {
          resolveProfileName(d: string, n?: string): Promise<string | undefined>;
        };
        return {
          local: await ConfigLoader.loadLocalConfigProfile(project, 'g'),
          localDefault: await ConfigLoader.loadLocalConfigProfile(project),
          resolved: await loader.resolveProfileName(project),
          active: await ConfigLoader.getActiveProfileName(project)
        };
      };
      const before = await probe();
      await writeProjectReductionFlag(project);
      expect(await probe()).toEqual(before);
      expect((before as { active: string }).active).toBe('g');
      expect((before as { local: object }).local).toEqual({});
    });
  });
});
