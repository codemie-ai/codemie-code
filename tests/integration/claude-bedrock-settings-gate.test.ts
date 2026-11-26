/**
 * Claude launch with AWS Bedrock enabled in the user's Claude Code settings: a non-interactive
 * `codemie-claude` run cannot ask whether to switch to the CodeMie gateway, so it must stop with
 * guidance on stderr, exit 1, and leave every settings file and the backup folder untouched.
 *
 * The real `codemie-claude` entry runs in a child process with a private CODEMIE_HOME and HOME,
 * so the assertions cross a process boundary and read state back from disk.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { describeRun, expectExit, isolatedEnv, realDir, type IsolatedRunResult } from '../helpers/isolated-cli.js';

// bin/codemie-claude.js imports ../dist. Like the other `cli` integration tests this suite runs
// against a prebuilt dist (locally run `npm run build` first) and never builds it itself.
const DIST_ENTRY = resolve('./dist/agents/core/AgentCLI.js');
const CLAUDE_ENTRY = resolve('./bin/codemie-claude.js');

const TEST_TIMEOUT_MS = 60_000;
const SPAWN_TIMEOUT_MS = 25_000;

const PROFILE = 'bedrock-gate-test';

// Guidance for the 'non-interactive' stop reason
// (src/agents/plugins/claude/cloud-provider-conflict/prompt.ts:209-211).
const NON_INTERACTIVE_HEADLINE =
  'AWS Bedrock settings were found, and no prompt is available here (non-interactive: ACP, --task, no TTY, CODEMIE_NO_PROMPTS, --silent or a scripted install):';
const NOTHING_CHANGED = 'Nothing was changed.';

// User settings that turn Bedrock on: the env block's CLAUDE_CODE_USE_BEDROCK with an "on" value
// (src/agents/plugins/claude/cloud-provider-conflict/provider.ts:34). Extra keys and the file's own
// formatting are there so a rewrite of any kind changes the bytes.
const BEDROCK_SETTINGS = `{
    "env": {
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "AWS_REGION": "us-east-1"
    },
    "theme": "dark"
}
`;

let sandbox: string;
let claudeShimDir: string;

/**
 * A `claude` executable so the launcher's "is it installed" check passes on hosts without the
 * real CLI. Node spawns it without a shell, so Windows needs a real .exe and POSIX a script.
 */
function createClaudeShim(dir: string): string {
  const shimDir = realDir(dir);
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(shimDir, 'claude.exe'));
  } else {
    const script = join(shimDir, 'claude');
    writeFileSync(script, '#!/bin/sh\necho 9.9.9\n', 'utf-8');
    chmodSync(script, 0o755);
  }
  return shimDir;
}

/** A complete non-Bedrock profile, so the launch reaches the provider-settings check. */
function writeProfile(codemieHome: string): void {
  writeFileSync(
    join(codemieHome, 'codemie-cli.config.json'),
    JSON.stringify({
      version: 2,
      activeProfile: PROFILE,
      profiles: {
        [PROFILE]: {
          name: PROFILE,
          provider: 'litellm',
          baseUrl: 'http://127.0.0.1:9/bedrock-gate-test',
          apiKey: 'bedrock-gate-test-key',
          model: 'claude-sonnet-4-5',
        },
      },
    }),
    'utf-8'
  );
}

/** Runs `codemie-claude` with no TTY (piped stdio) and CODEMIE_NO_PROMPTS=1. */
function runCodemieClaude(codemieHome: string, userHome: string, cwd: string): IsolatedRunResult {
  const baseEnv = isolatedEnv();
  // Windows spells the variable `Path`; setting a second `PATH` would be ambiguous.
  const pathKey = Object.keys(baseEnv).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  baseEnv[pathKey] = `${claudeShimDir}${delimiter}${baseEnv[pathKey] ?? ''}`;
  const result = spawnSync(process.execPath, [CLAUDE_ENTRY], {
    cwd,
    input: '',
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
    env: {
      ...baseEnv,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CODEMIE_HOME: codemieHome,
      HOME: userHome,
      USERPROFILE: userHome,
      CODEMIE_NO_PROMPTS: '1',
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
  };
}

function bedrockSwitchBackups(codemieHome: string): string[] {
  const backups = join(codemieHome, 'backups');
  return existsSync(backups) ? readdirSync(backups).filter((name) => name.startsWith('bedrock-switch-')) : [];
}

describe('Claude launch with AWS Bedrock in user settings', () => {
  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(`${DIST_ENTRY} not found: run \`npm run build\` before the cli integration tests.`);
    }
    sandbox = realDir(mkdtempSync(join(tmpdir(), 'codemie-bedrock-gate-')));
    claudeShimDir = createClaudeShim(join(sandbox, 'claude-shim'));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // @case codemie-cli-does-not-detect_TC_001
  it('should stop a non-interactive launch with guidance, exit 1 and change nothing', () => {
    const codemieHome = realDir(join(sandbox, 'tc001', 'codemie-home'));
    const userHome = realDir(join(sandbox, 'tc001', 'user-home'));
    const project = realDir(join(sandbox, 'tc001', 'project'));
    writeProfile(codemieHome);
    const settingsPath = join(userHome, '.claude', 'settings.json');
    mkdirSync(join(userHome, '.claude'), { recursive: true });
    writeFileSync(settingsPath, BEDROCK_SETTINGS, 'utf-8');
    const settingsBefore = readFileSync(settingsPath);

    const result = runCodemieClaude(codemieHome, userHome, project);

    // Step 1: guidance for the non-interactive stop, on stderr
    expect(result.stderr, describeRun(result)).toContain(NON_INTERACTIVE_HEADLINE);
    expect(result.stderr, describeRun(result)).toContain(NOTHING_CHANGED);
    expect(result.stderr.indexOf(NOTHING_CHANGED)).toBeGreaterThan(result.stderr.indexOf(NON_INTERACTIVE_HEADLINE));

    // Step 2: exit code 1 (src/agents/core/provider-settings-check.ts:78)
    expectExit(result, 1);

    // Step 3: settings untouched, no switch backup
    expect(readFileSync(settingsPath).equals(settingsBefore)).toBe(true);
    expect(bedrockSwitchBackups(codemieHome)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
