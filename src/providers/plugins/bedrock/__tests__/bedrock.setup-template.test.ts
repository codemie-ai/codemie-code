/**
 * AWS Bedrock setup-steps + template contract tests.
 *
 * setup-steps: mocks child_process.exec (via promisify custom symbol) so NO real
 * `aws` command runs and ~/.aws is never touched, and mocks inquirer so the
 * interactive getCredentials() flow runs deterministically. Asserts the exact
 * `aws configure ...` command strings the module WOULD run and the
 * unique-profile-name suffix logic surfaced through the "create new" default.
 *
 * template: pins exportEnvVars and the claude beforeRun model-tier routing,
 * including the distinct CLAUDE_CODE_SUBAGENT_MODEL behavior on single-tier
 * tenants (EPMCDME-12779), plus the wildcard AWS_* credential transform.
 *
 * All expected values were captured by probing the real compiled module first.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock child_process.exec so promisify(exec) resolves to our controllable fn.
// setup-steps does: import { exec } from 'child_process'; const execAsync = promisify(exec);
// promisify honors exec[util.promisify.custom], so we attach our mock there.
const execAsyncMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  const execFn = vi.fn() as unknown as Record<symbol, unknown>;
  execFn[promisify.custom] = execAsyncMock;
  return { ...actual, exec: execFn };
});

// --- Mock inquirer: queue-based prompt + Separator; records the questions asked.
const promptMock = vi.hoisted(() => vi.fn());
class SeparatorMock {}
vi.mock('inquirer', () => ({
  default: { prompt: promptMock, Separator: SeparatorMock },
}));

// --- Mock chalk so styling is a passthrough (no ANSI, no console noise concerns).
vi.mock('chalk', () => {
  const id = (s: string): string => s;
  return { default: new Proxy({}, { get: () => id }) };
});

import { BedrockSetupSteps } from '../bedrock.setup-steps.js';
import { BedrockTemplate } from '../bedrock.template.js';
import type { CodeMieConfigOptions } from '../../../../env/types.js';

/** Default execAsync behavior: pretend `aws` exists and answer each command. */
function installExecStub(initialProfiles: string[]): { profiles: string[] } {
  const state = { profiles: [...initialProfiles] };
  execAsyncMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'aws --version') return { stdout: 'aws-cli/2.15.0 Python/3.11', stderr: '' };
    if (cmd === 'aws configure list-profiles') {
      return { stdout: state.profiles.join('\n') + '\n', stderr: '' };
    }
    if (cmd.startsWith('aws configure get region')) return { stdout: 'eu-central-1\n', stderr: '' };
    if (cmd.startsWith('aws configure get aws_access_key_id')) return { stdout: 'AKIAABCDEFGH1234\n', stderr: '' };
    if (cmd.startsWith('aws configure set')) {
      const p = cmd.split('--profile ')[1];
      if (p && !state.profiles.includes(p)) state.profiles.push(p);
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  return state;
}

/** Queue answers returned by successive inquirer.prompt() calls. */
function queueAnswers(answers: Array<Record<string, unknown>>): Record<string, unknown>[][] {
  const seenQuestions: Record<string, unknown>[][] = [];
  let i = 0;
  promptMock.mockImplementation(async (questions: Record<string, unknown>[]) => {
    seenQuestions.push(questions);
    return answers[i++] ?? {};
  });
  return seenQuestions;
}

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllMocks();
  logSpy.mockRestore();
});

describe('BedrockSetupSteps.getCredentials - create new AWS profile', () => {
  it('runs the exact aws configure set commands and derives a unique profile name (bedrock-2)', async () => {
    // 'bedrock' already exists -> unique default becomes 'bedrock-2'
    installExecStub(['default', 'bedrock']);
    const seen = queueAnswers([
      { authMethod: 'profile' },
      { profile: '__create_new__' },
      {
        profileName: 'bedrock-2',
        accessKeyId: 'AKIANEWKEY',
        secretAccessKey: 'topsecret',
        region: 'eu-central-1',
      },
    ]);

    const creds = await BedrockSetupSteps.getCredentials();

    const commands = execAsyncMock.mock.calls.map((c) => c[0]);
    // AWS CLI detection + profile listing happened
    expect(commands).toContain('aws --version');
    expect(commands).toContain('aws configure list-profiles');
    // Exact create-profile commands (order preserved)
    expect(commands).toContain('aws configure set aws_access_key_id AKIANEWKEY --profile bedrock-2');
    expect(commands).toContain('aws configure set aws_secret_access_key topsecret --profile bedrock-2');
    expect(commands).toContain('aws configure set region eu-central-1 --profile bedrock-2');
    const setIdx = commands.indexOf('aws configure set aws_access_key_id AKIANEWKEY --profile bedrock-2');
    expect(commands[setIdx + 1]).toBe('aws configure set aws_secret_access_key topsecret --profile bedrock-2');
    expect(commands[setIdx + 2]).toBe('aws configure set region eu-central-1 --profile bedrock-2');

    // The generated default profile name shown to the user (suffix logic)
    const createQuestions = seen[2];
    const profileNameQ = createQuestions.find((q) => q.name === 'profileName');
    expect(profileNameQ?.default).toBe('bedrock-2');

    // Returned credentials for the profile-success path
    expect(creds.baseUrl).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com');
    expect(creds.apiKey).toBe(''); // accessKeyId not stored when using a profile
    expect(creds.additionalConfig?.awsProfile).toBe('bedrock-2');
    expect(creds.additionalConfig?.awsRegion).toBe('eu-central-1');
    expect(creds.additionalConfig?.awsSecretAccessKey).toBeUndefined();
  });

  it('suffix logic: no collision keeps base name "bedrock"', async () => {
    installExecStub(['default', 'work']); // no 'bedrock'
    const seen = queueAnswers([
      { authMethod: 'profile' },
      { profile: '__create_new__' },
      { profileName: 'bedrock', accessKeyId: 'AK', secretAccessKey: 's', region: 'us-east-1' },
    ]);
    await BedrockSetupSteps.getCredentials();
    const q = seen[2].find((x) => x.name === 'profileName');
    expect(q?.default).toBe('bedrock');
  });

  it('suffix logic: bedrock and bedrock-2 taken -> default becomes bedrock-3', async () => {
    installExecStub(['bedrock', 'bedrock-2']);
    const seen = queueAnswers([
      { authMethod: 'profile' },
      { profile: '__create_new__' },
      { profileName: 'bedrock-3', accessKeyId: 'AK', secretAccessKey: 's', region: 'us-east-1' },
    ]);
    await BedrockSetupSteps.getCredentials();
    const q = seen[2].find((x) => x.name === 'profileName');
    expect(q?.default).toBe('bedrock-3');
  });

  it('falls back to direct credentials when profile creation cannot be verified', async () => {
    // list-profiles never reports the new profile -> verification fails -> fallback
    execAsyncMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'aws --version') return { stdout: 'aws-cli/2.15.0', stderr: '' };
      if (cmd === 'aws configure list-profiles') return { stdout: 'default\n', stderr: '' };
      if (cmd.startsWith('aws configure set')) return { stdout: '', stderr: '' };
      throw new Error(`unexpected: ${cmd}`);
    });
    queueAnswers([
      { authMethod: 'profile' },
      { profile: '__create_new__' },
      { profileName: 'bedrock', accessKeyId: 'AKIAFALLBACK', secretAccessKey: 'sek', region: 'us-west-2' },
    ]);

    const creds = await BedrockSetupSteps.getCredentials();

    // Fallback stores direct credentials, no profile
    expect(creds.additionalConfig?.awsProfile).toBeUndefined();
    expect(creds.apiKey).toBe('AKIAFALLBACK');
    expect(creds.additionalConfig?.awsSecretAccessKey).toBe('sek');
    expect(creds.additionalConfig?.awsRegion).toBe('us-west-2');
    expect(creds.baseUrl).toBe('https://bedrock-runtime.us-west-2.amazonaws.com');
  });
});

describe('BedrockSetupSteps.getCredentials - existing profile', () => {
  it('uses the selected profile and reads its region via aws configure get', async () => {
    installExecStub(['default', 'prod']);
    queueAnswers([{ authMethod: 'profile' }, { profile: 'prod' }]);

    const creds = await BedrockSetupSteps.getCredentials();

    const commands = execAsyncMock.mock.calls.map((c) => c[0]);
    expect(commands).toContain('aws configure get region --profile prod');
    expect(commands).toContain('aws configure get aws_access_key_id --profile prod');
    expect(creds.additionalConfig?.awsProfile).toBe('prod');
    expect(creds.additionalConfig?.awsRegion).toBe('eu-central-1'); // from stub
    expect(creds.baseUrl).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com');
    expect(creds.apiKey).toBe(''); // profile path stores no access key
  });
});

describe('BedrockSetupSteps.getCredentials - no AWS CLI + direct keys', () => {
  it('detects missing CLI and takes the access-key path', async () => {
    // aws --version rejects -> isAwsCliInstalled() false; no list-profiles call expected
    execAsyncMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'aws --version') throw new Error('command not found: aws');
      throw new Error(`unexpected: ${cmd}`);
    });
    queueAnswers([
      { authMethod: 'keys' },
      { accessKeyId: 'AKIADIRECT', secretAccessKey: 'directsecret', region: 'ap-southeast-1' },
    ]);

    const creds = await BedrockSetupSteps.getCredentials();

    const commands = execAsyncMock.mock.calls.map((c) => c[0]);
    expect(commands).toEqual(['aws --version']); // no aws configure calls at all
    expect(creds.apiKey).toBe('AKIADIRECT');
    expect(creds.additionalConfig?.awsProfile).toBeUndefined();
    expect(creds.additionalConfig?.awsSecretAccessKey).toBe('directsecret');
    expect(creds.additionalConfig?.awsRegion).toBe('ap-southeast-1');
    expect(creds.baseUrl).toBe('https://bedrock-runtime.ap-southeast-1.amazonaws.com');
  });
});

describe('BedrockSetupSteps.buildConfig', () => {
  it('profile mode inserts placeholder apiKey and omits the secret', () => {
    const cfg = BedrockSetupSteps.buildConfig(
      { baseUrl: 'https://b', apiKey: 'AKIA', additionalConfig: { awsProfile: 'pf', awsRegion: 'us-east-1', awsSecretAccessKey: 'sek' } },
      'claude-sonnet-4-6',
    );
    expect(cfg.provider).toBe('bedrock');
    expect(cfg.model).toBe('claude-sonnet-4-6');
    expect(cfg.timeout).toBe(300);
    expect(cfg.awsProfile).toBe('pf');
    expect(cfg.apiKey).toBe('aws-profile'); // placeholder
    expect(cfg.awsRegion).toBe('us-east-1');
    expect(cfg.awsSecretAccessKey).toBeUndefined();
  });

  it('direct-key mode stores the real access key + secret', () => {
    const cfg = BedrockSetupSteps.buildConfig(
      { baseUrl: 'https://b', apiKey: 'AKIA', additionalConfig: { awsRegion: 'us-east-1', awsSecretAccessKey: 'sek' } },
      'm',
    );
    expect(cfg.apiKey).toBe('AKIA');
    expect(cfg.awsSecretAccessKey).toBe('sek');
    expect(cfg.awsProfile).toBeUndefined();
    expect(cfg.awsRegion).toBe('us-east-1');
  });
});

// ------------------------- bedrock.template.ts -------------------------

function cfg(over: Partial<CodeMieConfigOptions> = {}): CodeMieConfigOptions {
  return over as CodeMieConfigOptions;
}

describe('BedrockTemplate.exportEnvVars', () => {
  it('maps configured fields to CODEMIE_AWS_* / token vars', () => {
    const env = BedrockTemplate.exportEnvVars!(
      cfg({ awsProfile: 'p', awsRegion: 'us-west-2', awsSecretAccessKey: 'sek', maxOutputTokens: 8000, maxThinkingTokens: 2000 }),
    );
    expect(env).toEqual({
      CODEMIE_AWS_PROFILE: 'p',
      CODEMIE_AWS_REGION: 'us-west-2',
      CODEMIE_AWS_SECRET_ACCESS_KEY: 'sek',
      CODEMIE_MAX_OUTPUT_TOKENS: '8000',
      CODEMIE_MAX_THINKING_TOKENS: '2000',
    });
  });

  it('emits nothing for an empty config', () => {
    expect(BedrockTemplate.exportEnvVars!(cfg({}))).toEqual({});
  });
});

describe('BedrockTemplate wildcard (*) hook - AWS credential transform', () => {
  const star = () => BedrockTemplate.agentHooks!['*'].beforeRun!;

  it('profile auth: sets AWS_PROFILE and clears explicit/stale credentials', async () => {
    const out = await star()(
      { CODEMIE_AWS_PROFILE: 'p', CODEMIE_API_KEY: 'aws-profile', CODEMIE_AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'stale', AWS_SESSION_TOKEN: 'st' },
      cfg(),
    );
    expect(out.AWS_PROFILE).toBe('p');
    expect(out.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(out.AWS_SESSION_TOKEN).toBeUndefined();
    expect(out.AWS_REGION).toBe('us-east-1');
    expect(out.AWS_DEFAULT_REGION).toBe('us-east-1');
  });

  it('direct-key auth: sets AWS_ACCESS_KEY_ID/SECRET and clears AWS_PROFILE', async () => {
    const out = await star()(
      { CODEMIE_API_KEY: 'AKIA', CODEMIE_AWS_SECRET_ACCESS_KEY: 'sek', CODEMIE_AWS_REGION: 'eu-west-1', AWS_PROFILE: 'stale' },
      cfg(),
    );
    expect(out.AWS_ACCESS_KEY_ID).toBe('AKIA');
    expect(out.AWS_SECRET_ACCESS_KEY).toBe('sek');
    expect(out.AWS_PROFILE).toBeUndefined();
    expect(out.AWS_REGION).toBe('eu-west-1');
  });
});

describe('BedrockTemplate claude hook - model-tier routing', () => {
  const claude = () => BedrockTemplate.agentHooks!['claude'].beforeRun!;

  it('enables Bedrock mode and clears Anthropic auth/base-url', async () => {
    const out = await claude()({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'http://x', CODEMIE_MODEL: 'm' }, cfg());
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(out.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(out.ANTHROPIC_MODEL).toBe('m');
    expect(out.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('4096');
    expect(out.MAX_THINKING_TOKENS).toBe('1024');
  });

  it('multi-tier tenant: all three defaults set, subagent routes to sonnet', async () => {
    const out = await claude()({ CODEMIE_HAIKU_MODEL: 'h', CODEMIE_SONNET_MODEL: 's', CODEMIE_OPUS_MODEL: 'o' }, cfg());
    expect(out.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('h');
    expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('s');
    expect(out.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('o');
    expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBe('s');
  });

  it('sonnet-only tenant: sonnet default + subagent set, opus/haiku unset', async () => {
    const out = await claude()({ CODEMIE_SONNET_MODEL: 's' }, cfg());
    expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('s');
    expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBe('s');
    expect(out.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(out.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it('opus-only tenant: subagent routes to opus, sonnet default intentionally unset', async () => {
    const out = await claude()({ CODEMIE_OPUS_MODEL: 'o' }, cfg());
    expect(out.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('o');
    expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBe('o');
    expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined(); // EPMCDME-12779: avoid duplicate-ID
    expect(out.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it('haiku-only tenant: haiku default + subagent routes to haiku, sonnet unset', async () => {
    const out = await claude()({ CODEMIE_HAIKU_MODEL: 'h' }, cfg());
    expect(out.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('h');
    expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBe('h');
    expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(out.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it('sonnet equal to haiku collapses to the haiku-only branch (subagent = haiku)', async () => {
    const out = await claude()({ CODEMIE_HAIKU_MODEL: 'x', CODEMIE_SONNET_MODEL: 'x' }, cfg());
    expect(out.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('x');
    expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined(); // sonnet !== haiku is false
    expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBe('x');
  });

  it('respects user-configured token limits over defaults and cleans up intermediates', async () => {
    const out = await claude()({ CODEMIE_MAX_OUTPUT_TOKENS: '8192', CODEMIE_MAX_THINKING_TOKENS: '2048' }, cfg());
    expect(out.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8192');
    expect(out.MAX_THINKING_TOKENS).toBe('2048');
    expect(out.CODEMIE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(out.CODEMIE_MAX_THINKING_TOKENS).toBeUndefined();
  });
});
