#!/usr/bin/env node
/**
 * End-to-end verification script for the Kimi Code agent integration.
 *
 * This script:
 *  - Creates an isolated temp directory and a fake `kimi` binary on PATH.
 *  - Verifies `codemie-kimi --version` and `codemie-kimi health` work.
 *  - Injects CodeMie lifecycle hooks into a temp Kimi config.toml.
 *  - Parses a fake `wire.jsonl` session with `KimiSessionAdapter` and extracts
 *    metrics with `KimiMetricsProcessor`.
 */

// This script is intentionally not covered by `npm run lint`, which only lints
// TypeScript files under `src/` and `tests/`.

import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const distRoot = join(repoRoot, 'dist');

// Pre-flight: ensure the dist build output is present before importing.
const registryPath = join(distRoot, 'agents', 'registry.js');
if (!existsSync(registryPath)) {
  console.error(
    `Error: Build output not found at ${registryPath}. Run "npm run build" first.`
  );
  process.exit(1);
}

// Load real built implementations from dist/.
const { KimiPluginMetadata } = await import(
  join(distRoot, 'agents/plugins/kimi/kimi.plugin.js')
);
const { KimiHookConfigInjector } = await import(
  join(distRoot, 'agents/plugins/kimi/kimi.hook-config-injector.js')
);
const { KimiSessionAdapter } = await import(
  join(distRoot, 'agents/plugins/kimi/kimi.session.js')
);
const { KimiMetricsProcessor } = await import(
  join(distRoot, 'agents/plugins/kimi/session/processors/kimi.metrics-processor.js')
);

const packageJsonPath = join(repoRoot, 'package.json');
const PACKAGE_VERSION = JSON.parse(readFileSync(packageJsonPath, 'utf-8')).version;
const SESSION_ID = 'verify-session-001';

const sampleWire = `\
{"type":"metadata","protocol_version":"1.4","created_at":1781363635367,"app_version":"0.14.2"}
{"type":"config.update","profileName":"agent","systemPrompt":"You are a helpful coding assistant.","modelAlias":"kimi-code/kimi-for-coding","thinkingLevel":"high","time":1781368649422}
{"type":"tools.set_active_tools","toolNames":["Read","Write","Edit","Bash","Glob"],"time":1781368649423}
{"type":"turn.prompt","role":"user","content":"Please read src/index.ts and then update it.","time":1781368649424}
{"type":"context.append_loop_event","event":{"type":"tool.call","uuid":"call-read-001","turnId":"0","step":1,"toolCallId":"tool_read_001","name":"Read","args":{"file_path":"/Users/alice/project/src/index.ts"},"description":"Read source file","display":{"kind":"brief","text":"Read src/index.ts"}},"time":1781368649425}
{"type":"context.append_loop_event","event":{"type":"tool.result","parentUuid":"call-read-001","toolCallId":"tool_read_001","result":{"output":"export const version = '1.0.0';\\n","isError":false}},"time":1781368649426}
{"type":"context.append_loop_event","event":{"type":"tool.call","uuid":"call-write-001","turnId":"0","step":2,"toolCallId":"tool_write_001","name":"Write","args":{"file_path":"/Users/alice/project/src/index.ts","content":"export const version = '1.1.0';\\n"},"description":"Write source file","display":{"kind":"brief","text":"Write src/index.ts"}},"time":1781368649427}
{"type":"context.append_loop_event","event":{"type":"tool.result","parentUuid":"call-write-001","toolCallId":"tool_write_001","result":{"output":"File written successfully","isError":false}},"time":1781368649428}
{"type":"context.append_loop_event","event":{"type":"display.render","uuid":"display-read-001","turnId":"0","step":1},"display":{"kind":"file_io","operation":"read","path":"/Users/alice/project/src/index.ts"},"time":1781368649429}
{"type":"context.append_loop_event","event":{"type":"display.render","uuid":"display-write-001","turnId":"0","step":2},"display":{"kind":"file_io","operation":"write","path":"/Users/alice/project/src/index.ts","content":"export const version = '1.1.0';\\n"},"time":1781368649430}
{"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":14341,"output":570,"inputCacheRead":14336,"inputCacheCreation":0},"usageScope":"turn","time":1781368649431}
`;

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    shell: false,
    env: { ...process.env, ...extraEnv },
  });

  if (result.error) {
    throw new Error(
      `Failed to execute "${command} ${args.join(' ')}": ${result.error.message}`
    );
  }

  return result;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

let tmpDir;

function cleanup() {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; do not mask the original failure.
    }
  }
}

function cleanupAndExit(signal) {
  cleanup();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

const sigintHandler = () => cleanupAndExit('SIGINT');
const sigtermHandler = () => cleanupAndExit('SIGTERM');
process.once('SIGINT', sigintHandler);
process.once('SIGTERM', sigtermHandler);

const originalKimiCodeHome = process.env.KIMI_CODE_HOME;

try {
  // 1. Prepare isolated temp directory with fake Kimi binary on PATH.
  tmpDir = mkdtempSync(join(tmpdir(), 'codemie-kimi-verify-'));
  const fakeBinDir = join(tmpDir, 'bin');
  const fakeSessionDir = join(tmpDir, 'sessions', SESSION_ID, 'agents', 'main');
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(fakeSessionDir, { recursive: true });

  const wirePath = join(fakeSessionDir, 'wire.jsonl');
  writeFileSync(wirePath, sampleWire, 'utf-8');

  const fakeKimiPath = join(fakeBinDir, 'kimi');
  // The fake binary is an ES module: we provide a local package.json with
  // "type": "module" so the extension-less file can use ESM syntax.
  writeFileSync(
    join(fakeBinDir, 'package.json'),
    JSON.stringify({ type: 'module' }),
    'utf-8'
  );
  const fakeKimiScript = `#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';

const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const wireDir = path.join(home, 'sessions', '${SESSION_ID}', 'agents', 'main');
const wirePath = path.join(wireDir, 'wire.jsonl');
const sample = ${JSON.stringify(sampleWire)};
fs.mkdirSync(wireDir, { recursive: true });
fs.writeFileSync(wirePath, sample, 'utf-8');
console.log('kimi 1.0.0');
`;
  writeFileSync(fakeKimiPath, fakeKimiScript, 'utf-8');
  chmodSync(fakeKimiPath, 0o755);

  const verificationEnv = {
    KIMI_CODE_HOME: tmpDir,
    PATH: `${fakeBinDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  };

  // 2. Verify codemie-kimi --version.
  const versionResult = run(
    'node',
    ['./bin/codemie-kimi.js', '--version'],
    verificationEnv
  );
  assert(versionResult.status === 0, `codemie-kimi --version failed: ${versionResult.stderr}`);
  assert(
    versionResult.stdout.includes(PACKAGE_VERSION),
    `Expected codemie-kimi --version to contain "${PACKAGE_VERSION}", got: ${versionResult.stdout}`
  );
  console.log(`✓ codemie-kimi --version: ${versionResult.stdout.trim()}`);

  // 3. Verify the fake binary is discovered and reports its version via health.
  const healthResult = run(
    'node',
    ['./bin/codemie-kimi.js', 'health'],
    verificationEnv
  );
  assert(healthResult.status === 0, `codemie-kimi health failed: ${healthResult.stderr}`);
  assert(
    healthResult.stdout.includes('installed and ready'),
    `Expected health output to report "installed and ready", got: ${healthResult.stdout}`
  );
  assert(
    healthResult.stdout.includes('1.0.0'),
    `Expected health output to contain fake kimi version "1.0.0", got: ${healthResult.stdout}`
  );
  console.log('✓ codemie-kimi health detected the fake kimi binary');

  // 4. Trigger hook config injection and verify config.toml contents.
  process.env.KIMI_CODE_HOME = tmpDir;
  const injector = new KimiHookConfigInjector();
  const injection = await injector.inject();
  assert(
    injection.success,
    `Kimi hook config injection failed: ${injection.error ?? 'unknown error'}`
  );

  const configContent = readFileSync(injection.configPath, 'utf-8');
  assert(
    configContent.includes('command = "codemie hook"'),
    `Expected ${injection.configPath} to contain 'command = "codemie hook"', got:\n${configContent}`
  );
  console.log('✓ config.toml contains command = "codemie hook"');

  // 5. Verify the session wire.jsonl can be parsed and metrics extracted.
  const adapter = new KimiSessionAdapter(KimiPluginMetadata);
  const session = await adapter.parseSessionFile(wirePath, SESSION_ID);
  assert(session.messages.length > 0, 'Expected parsed session to contain events');
  assert(
    session.metadata.model === 'kimi-code/kimi-for-coding',
    `Expected model "kimi-code/kimi-for-coding", got ${session.metadata.model}`
  );

  const processor = new KimiMetricsProcessor();
  const processingContext = {
    apiBaseUrl: '',
    cookies: '',
    clientType: 'test',
    version: '0.0.0',
    dryRun: true,
  };
  const processingResult = await processor.process(session, processingContext);
  assert(
    processingResult.success,
    `KimiMetricsProcessor failed: ${processingResult.message ?? 'unknown error'}`
  );
  assert(
    (session.metrics?.tools?.Read ?? 0) >= 1,
    `Expected at least one Read tool call, got: ${JSON.stringify(session.metrics?.tools)}`
  );
  assert(
    (session.metrics?.tools?.Write ?? 0) >= 1,
    `Expected at least one Write tool call, got: ${JSON.stringify(session.metrics?.tools)}`
  );
  assert(
    (session.metrics?.fileOperations?.length ?? 0) >= 2,
    `Expected at least two file operations, got: ${JSON.stringify(session.metrics?.fileOperations)}`
  );
  console.log('✓ KimiSessionAdapter and KimiMetricsProcessor work end-to-end');

  console.log('Verification passed');
} catch (error) {
  console.error('Verification failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  cleanup();
  process.off('SIGINT', sigintHandler);
  process.off('SIGTERM', sigtermHandler);
  if (originalKimiCodeHome === undefined) {
    delete process.env.KIMI_CODE_HOME;
  } else {
    process.env.KIMI_CODE_HOME = originalKimiCodeHome;
  }
}
