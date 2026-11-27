/**
 * `codemie --task` runs the bundled CodeMie Code engine. The engine must not load the user's
 * global OpenCode config: a broken custom tool under `<XDG_CONFIG_HOME>/opencode/tool/` must not
 * crash the run with `Cannot find module '@opencode-ai/plugin'`.
 *
 * The real `codemie` entry and the real bundled engine run in a child process with a private
 * CODEMIE_HOME, HOME and XDG_CONFIG_HOME. The model endpoint is a closed local port, so the run
 * ends with a connection error once the engine gets past loading its tools; no network is used.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describeRun, realDir, runIsolatedCli } from '../helpers/isolated-cli.js';

// bin/codemie.js imports ../dist. Like the other `cli` integration tests this suite runs against
// a prebuilt dist (locally run `npm run build` first) and never builds it itself.
const DIST_ENTRY = resolve('./dist/cli/index.js');

// The engine binary comes from a platform-specific optional dependency
// (src/agents/plugins/codemie-code-binary.ts); without it there is no engine to run.
const ENGINE_BIN_NAME = process.platform === 'win32' ? 'codemie.exe' : 'codemie';
const ENGINE_CANDIDATES = [
  resolve('node_modules', '@codemieai', `codemie-opencode-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`, 'bin', ENGINE_BIN_NAME),
  resolve('node_modules', '@codemieai', 'codemie-opencode', 'bin', ENGINE_BIN_NAME),
];
const engineAvailable = ENGINE_CANDIDATES.some((candidate) => existsSync(candidate));

const TEST_TIMEOUT_MS = 150_000;
const SPAWN_TIMEOUT_MS = 120_000;

// A static model whose config key equals its id (src/agents/plugins/opencode/opencode-model-configs.ts),
// so the engine resolves it without the live model catalogue.
const MODEL = 'claude-sonnet-4-6';
// Nothing listens on port 9 (discard): the model request fails fast and offline.
const CLOSED_MODEL_ENDPOINT = 'http://127.0.0.1:9';

// A custom tool that cannot load: no node_modules next to it, and a relative import that never exists.
const BROKEN_TOOL = `import { tool } from "@opencode-ai/plugin"
import "./missing-helper.js"

export default tool({ description: "broken custom tool", args: {}, async execute() { return "unused" } })
`;

// The engine's crash when it loads the broken tool from the user's global config.
const BROKEN_TOOL_LOAD_ERROR = /Cannot find module '[^']+' from '[^']*broken-tool\.ts'/;

let sandbox: string;

describe('codemie --task with a broken tool in the user\'s global OpenCode config', () => {
  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(`${DIST_ENTRY} not found: run \`npm run build\` before the cli integration tests.`);
    }
    sandbox = realDir(mkdtempSync(join(tmpdir(), 'codemie-global-config-isolation-')));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // @case codemie-code-global-config-isolation_TC_001
  it.skipIf(!engineAvailable)('should run the task without loading tools from the user\'s global OpenCode config', () => {
    const codemieHome = realDir(join(sandbox, 'codemie-home'));
    const userHome = realDir(join(sandbox, 'user-home'));
    const userConfigHome = realDir(join(userHome, '.config'));
    const project = realDir(join(sandbox, 'project'));
    const toolDir = join(userConfigHome, 'opencode', 'tool');
    mkdirSync(toolDir, { recursive: true });
    const toolPath = join(toolDir, 'broken-tool.ts');
    writeFileSync(toolPath, BROKEN_TOOL, 'utf-8');

    const result = runIsolatedCli({ codemieHome, userHome }, ['--task', 'say hi'], {
      cwd: project,
      timeoutMs: SPAWN_TIMEOUT_MS,
      env: {
        CODEMIE_PROVIDER: 'litellm',
        CODEMIE_BASE_URL: CLOSED_MODEL_ENDPOINT,
        CODEMIE_API_KEY: 'not-a-real-key',
        CODEMIE_MODEL: MODEL,
        // The user's own OpenCode config location, and the rest of their XDG dirs, inside the sandbox
        XDG_CONFIG_HOME: userConfigHome,
        XDG_DATA_HOME: join(userHome, '.local', 'share'),
        XDG_CACHE_HOME: join(userHome, '.cache'),
        XDG_STATE_HOME: join(userHome, '.local', 'state'),
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(readFileSync(toolPath, 'utf-8')).toBe(BROKEN_TOOL);
    expect(result.error, describeRun(result)).toBeUndefined();
    // The engine started a session with the requested model, so it reached the point where it loads tools
    expect(output, describeRun(result)).toContain(`build · ${MODEL}`); // repro:precondition

    expect(output, describeRun(result)).not.toMatch(BROKEN_TOOL_LOAD_ERROR); // repro:symptom
    // The engine got past loading its tools and failed only on the closed model endpoint
    expect(output, describeRun(result)).toMatch(/Unable to connect/);
  }, TEST_TIMEOUT_MS);
});
