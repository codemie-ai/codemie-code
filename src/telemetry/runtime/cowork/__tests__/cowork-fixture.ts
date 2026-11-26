/**
 * The synthetic Cowork fixture session. Its files are kept flat under short names: a real Desktop session's nested
 * directory names would exceed the path length a Windows checkout allows. `installCoworkFixture` lays them out the
 * way Claude Desktop does, under a Claude Desktop base directory.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cowork-session');
/** The two directory levels of the fixture session's account, under `local-agent-mode-sessions/`. */
export const COWORK_ACCOUNT_SEGMENTS = ['0f0f0f0f-aaaa-4bbb-8ccc-000000000001', '00000000-0000-4000-8000-000000000001'] as const;
const ACCOUNT_DIR = COWORK_ACCOUNT_SEGMENTS.join('/');
const INNER_DIR = `${ACCOUNT_DIR}/1a2b3c4d/.claude/projects/session`;

/** Each flat fixture file and its path under `local-agent-mode-sessions/` in the Desktop layout. */
const LAYOUT = {
  'metadata.json': `${ACCOUNT_DIR}/local_1a2b3c4d-1111-4222-8333-444455556666.json`,
  'audit.jsonl': `${ACCOUNT_DIR}/1a2b3c4d/audit.jsonl`,
  'main.jsonl': `${INNER_DIR}/7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f.jsonl`,
  'subagent.jsonl': `${INNER_DIR}/7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f/subagents/agent-a11111111111111111.jsonl`,
  'subagent.meta.json': `${INNER_DIR}/7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f/subagents/agent-a11111111111111111.meta.json`,
} as const;

/** The path of one flat fixture file. */
export function coworkFixtureFile(name: keyof typeof LAYOUT): string {
  return join(FIXTURE, name);
}

/** Copies the fixture session into `baseDir` (a Claude Desktop base directory) in the Desktop layout. */
export function installCoworkFixture(baseDir: string): void {
  for (const [name, target] of Object.entries(LAYOUT)) {
    const path = join(baseDir, 'local-agent-mode-sessions', ...target.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(FIXTURE, name), path);
  }
}
