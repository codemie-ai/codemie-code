/**
 * Startup migrations 001–004 — coverage for the four migrations that run on
 * EVERY `codemie` invocation but had no tests (005–007 were the only covered
 * ones). These rewrite real config/session/settings files on disk, so a bad
 * transform silently corrupts a user's setup and is caught only manually.
 *
 * ISOLATION / SAFETY
 * ------------------
 * Each migration captures its target directory at construction time:
 *   - 001 ConfigRename, 002 ConsolidateSessions → getCodemieHome() (CODEMIE_HOME)
 *   - 003 RemoveHooksNode → homedir()/.gemini/settings.json (HOME)
 *   - 004 SkillsAssistantsTopLevel → ConfigLoader (CODEMIE_HOME + cwd project)
 * So we point BOTH CODEMIE_HOME and HOME at a fresh temp dir per test and only
 * construct each migration AFTER the env is set. Migrations are imported
 * dynamically for the same reason. 004's up() would also write the repo's own
 * ./.codemie config, so 004 is exercised through its pure migrate() only —
 * never up() — to avoid mutating real project state. 001's project path scans
 * cwd/.codemie for the OLD `config.json`, which does not exist there, so it is a
 * safe no-op.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome: string;
let originalCodemieHome: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  originalCodemieHome = process.env.CODEMIE_HOME;
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'codemie-migrations-'));
  // Both are read at migration construction time; set before any dynamic import.
  process.env.CODEMIE_HOME = tmpHome;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalCodemieHome !== undefined) process.env.CODEMIE_HOME = originalCodemieHome;
  else delete process.env.CODEMIE_HOME;
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── 001: config.json → codemie-cli.config.json ────────────────────────────────
describe('001-config-rename', () => {
  const CODEMIE_CONFIG = { version: 2, activeProfile: 'default', profiles: { default: { provider: 'ai-run-sso' } } };

  it('renames a CodeMie-owned config.json to codemie-cli.config.json', async () => {
    const { ConfigRenameMigration } = await import('../001-config-rename.migration.js');
    writeFileSync(join(tmpHome, 'config.json'), JSON.stringify(CODEMIE_CONFIG), 'utf-8');

    const result = await new ConfigRenameMigration().up();

    expect(result.success).toBe(true);
    expect(result.migrated).toBe(true);
    expect(existsSync(join(tmpHome, 'codemie-cli.config.json'))).toBe(true);
    expect(existsSync(join(tmpHome, 'config.json'))).toBe(false);
    // Content is preserved verbatim.
    expect(JSON.parse(readFileSync(join(tmpHome, 'codemie-cli.config.json'), 'utf-8'))).toEqual(CODEMIE_CONFIG);
  });

  it('is a no-op when there is no old config.json', async () => {
    const { ConfigRenameMigration } = await import('../001-config-rename.migration.js');
    const result = await new ConfigRenameMigration().up();
    expect(result.migrated).toBe(false);
  });

  it('refuses to migrate a config.json that is not a CodeMie config', async () => {
    const { ConfigRenameMigration } = await import('../001-config-rename.migration.js');
    // A foreign tool's config with no CodeMie fields — must be left untouched.
    writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ someOtherTool: true }), 'utf-8');

    const result = await new ConfigRenameMigration().up();

    expect(result.migrated).toBe(false);
    expect(existsSync(join(tmpHome, 'config.json'))).toBe(true);
    expect(existsSync(join(tmpHome, 'codemie-cli.config.json'))).toBe(false);
  });
});

// ── 002: consolidate sessions under ~/.codemie/sessions/ ──────────────────────
describe('002-consolidate-sessions', () => {
  it('moves metrics + conversation session files into the unified sessions/ dir', async () => {
    const { ConsolidateSessionsMigration } = await import('../002-consolidate-sessions.migration.js');

    const metricsDir = join(tmpHome, 'metrics', 'sessions');
    const convDir = join(tmpHome, 'conversations', 'sessions');
    mkdirSync(metricsDir, { recursive: true });
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(metricsDir, 'session-a.jsonl'), '{"m":1}\n', 'utf-8');
    writeFileSync(join(metricsDir, 'session-a.json'), '{"m":1}', 'utf-8');
    writeFileSync(join(convDir, 'session-b.jsonl'), '{"c":1}\n', 'utf-8');
    // A non-session file must be ignored, not moved.
    writeFileSync(join(metricsDir, 'notes.txt'), 'ignore me', 'utf-8');

    const result = await new ConsolidateSessionsMigration().up();

    expect(result.success).toBe(true);
    expect(result.migrated).toBe(true);
    const sessionsDir = join(tmpHome, 'sessions');
    expect(existsSync(join(sessionsDir, 'session-a.jsonl'))).toBe(true);
    expect(existsSync(join(sessionsDir, 'session-a.json'))).toBe(true);
    expect(existsSync(join(sessionsDir, 'session-b.jsonl'))).toBe(true);
    // Moved, not copied.
    expect(existsSync(join(metricsDir, 'session-a.jsonl'))).toBe(false);
    // Non-session file left where it was.
    expect(existsSync(join(metricsDir, 'notes.txt'))).toBe(true);
  });

  it('is a no-op when there are no old session directories', async () => {
    const { ConsolidateSessionsMigration } = await import('../002-consolidate-sessions.migration.js');
    const result = await new ConsolidateSessionsMigration().up();
    expect(result.migrated).toBe(false);
  });
});

// ── 003: remove legacy hooks node from ~/.gemini/settings.json ────────────────
describe('003-remove-hooks-node', () => {
  it('removes hooks:{enabled:true} while preserving all other settings', async () => {
    const { RemoveHooksNodeMigration } = await import('../003-remove-hooks-node.migration.js');
    const geminiDir = join(tmpHome, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      join(geminiDir, 'settings.json'),
      JSON.stringify({ hooks: { enabled: true }, theme: 'dark', selectedAuthType: 'gemini-api-key' }),
      'utf-8',
    );

    const result = await new RemoveHooksNodeMigration().up();

    expect(result.success).toBe(true);
    expect(result.migrated).toBe(true);
    const after = JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf-8'));
    expect(after.hooks).toBeUndefined();
    expect(after.theme).toBe('dark');
    expect(after.selectedAuthType).toBe('gemini-api-key');
  });

  it('does not touch a hooks node that is not {enabled:true}', async () => {
    const { RemoveHooksNodeMigration } = await import('../003-remove-hooks-node.migration.js');
    const geminiDir = join(tmpHome, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(join(geminiDir, 'settings.json'), JSON.stringify({ hooks: { enabled: false } }), 'utf-8');

    const result = await new RemoveHooksNodeMigration().up();

    expect(result.migrated).toBe(false);
    expect(JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf-8')).hooks).toEqual({ enabled: false });
  });

  it('is a no-op when the settings file does not exist', async () => {
    const { RemoveHooksNodeMigration } = await import('../003-remove-hooks-node.migration.js');
    const result = await new RemoveHooksNodeMigration().up();
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('file-not-found');
  });
});

// ── 004: lift codemieSkills/codemieAssistants from profiles to top level ──────
// Tested via the pure migrate() to avoid up() writing the repo's own config.
describe('004-skills-assistants-top-level (pure migrate)', () => {
  it('moves per-profile skills/assistants to top level, de-duping by newest registeredAt', async () => {
    const { SkillsAssistantsTopLevelMigration } = await import('../004-skills-assistants-top-level.migration.js');
    const migration = new SkillsAssistantsTopLevelMigration();

    const config: any = {
      version: 2,
      activeProfile: 'a',
      profiles: {
        a: {
          provider: 'ai-run-sso',
          codemieSkills: [{ id: 's1', name: 'skill-1', registeredAt: '2024-01-01T00:00:00Z' }],
          codemieAssistants: [{ id: 'x1', name: 'asst-1', registeredAt: '2024-01-01T00:00:00Z' }],
        },
        b: {
          provider: 'anthropic-subscription',
          // Same skill id, newer registeredAt → this one wins.
          codemieSkills: [{ id: 's1', name: 'skill-1-newer', registeredAt: '2024-06-01T00:00:00Z' }],
        },
      },
    };

    const result = migration.migrate(config);

    expect(result.codemieSkills).toHaveLength(1);
    expect(result.codemieSkills![0].name).toBe('skill-1-newer');
    expect(result.codemieAssistants).toHaveLength(1);
    // Fields are stripped from every profile.
    expect((result.profiles.a as any).codemieSkills).toBeUndefined();
    expect((result.profiles.a as any).codemieAssistants).toBeUndefined();
    expect((result.profiles.b as any).codemieSkills).toBeUndefined();
    // Non-moving fields survive.
    expect(result.profiles.a.provider).toBe('ai-run-sso');
  });

  it('is idempotent — returns the same config once fields already live at top level', async () => {
    const { SkillsAssistantsTopLevelMigration } = await import('../004-skills-assistants-top-level.migration.js');
    const migration = new SkillsAssistantsTopLevelMigration();

    const config: any = {
      version: 2,
      activeProfile: 'a',
      profiles: { a: { provider: 'ai-run-sso' } },
      codemieSkills: [],
      codemieAssistants: [],
    };

    expect(migration.migrate(config)).toBe(config);
  });
});
