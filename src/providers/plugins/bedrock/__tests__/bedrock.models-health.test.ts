/**
 * AWS Bedrock model fetch + health check contract tests.
 *
 * Pins the behavior of:
 *   - BedrockModelProxy.fetchModels (bedrock.models.ts): inference-profile
 *     mapping/sorting/filtering, credential-source branch selection
 *     (fromIni profile vs direct keys vs default chain), empty + error paths.
 *   - BedrockHealthCheck (bedrock.health.ts): pass/fail flows, credential
 *     extraction from config, custom messages/remediation.
 *   - toBedrockModelId (bedrock.utils.ts): region-prefixed inference-profile IDs.
 *
 * The AWS SDK is fully mocked — NO real AWS call ever happens. The dynamically
 * imported '@aws-sdk/client-bedrock' returns a fake BedrockClient whose send()
 * is a vi.fn, and '@aws-sdk/credential-providers'.fromIni is a sentinel-returning
 * spy so we can assert which credential branch the code chose.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeMieConfigOptions } from '../../../../env/types.js';

// --- AWS SDK mocks (hoisted so they exist before the module graph loads) ---

// send() is shared across all BedrockClient instances.
const sendMock = vi.hoisted(() => vi.fn());
// Records every clientConfig passed to `new BedrockClient(...)` so we can
// assert the credential-source branch chosen by fetchModels.
const clientConfigs = vi.hoisted(() => [] as any[]);
// Records inputs passed to ListInferenceProfilesCommand.
const commandInputs = vi.hoisted(() => [] as any[]);
// fromIni returns a distinctive sentinel so the profile branch is observable.
const fromIniMock = vi.hoisted(() =>
  vi.fn((opts: any) => ({ __fromIni: true, opts }))
);

vi.mock('@aws-sdk/client-bedrock', () => {
  class BedrockClient {
    config: any;
    send = sendMock;
    constructor(config: any) {
      this.config = config;
      clientConfigs.push(config);
    }
  }
  class ListInferenceProfilesCommand {
    input: any;
    constructor(input: any) {
      this.input = input;
      commandInputs.push(input);
    }
  }
  return { BedrockClient, ListInferenceProfilesCommand };
});

vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni: fromIniMock,
}));

import { BedrockModelProxy } from '../bedrock.models.js';
import { BedrockHealthCheck } from '../bedrock.health.js';
import { toBedrockModelId } from '../bedrock.utils.js';

/** Minimal config factory; all provider fields are optional. */
function cfg(fields: Partial<CodeMieConfigOptions> = {}): CodeMieConfigOptions {
  return {
    provider: 'bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    apiKey: '',
    model: 'temp',
    timeout: 300,
    ...fields,
  } as CodeMieConfigOptions;
}

const SUMMARIES = {
  inferenceProfileSummaries: [
    { inferenceProfileId: 'us.anthropic.claude-sonnet', inferenceProfileName: 'Zeta Sonnet' },
    { inferenceProfileId: 'us.meta.llama', inferenceProfileName: 'Alpha Llama' },
    // No name → name falls back to the id.
    { inferenceProfileId: 'us.mistral.large', inferenceProfileName: undefined },
    // No id → filtered out entirely.
    { inferenceProfileId: undefined, inferenceProfileName: 'Ghost Profile' },
  ],
};

beforeEach(() => {
  sendMock.mockReset();
  fromIniMock.mockClear();
  clientConfigs.length = 0;
  commandInputs.length = 0;
});

describe('BedrockModelProxy.fetchModels - model mapping', () => {
  it('maps inference-profile summaries to {id,name}, drops id-less entries, sorts by name', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    const proxy = new BedrockModelProxy('');

    const models = await proxy.fetchModels(cfg());

    // Ghost Profile (no id) filtered out → 3 models.
    expect(models).toHaveLength(3);
    // Sorted by name via localeCompare: Alpha, us.mistral.large (name fallback), Zeta.
    expect(models.map(m => m.name)).toEqual([
      'Alpha Llama',
      'us.mistral.large',
      'Zeta Sonnet',
    ]);
    // id preserved verbatim from inferenceProfileId.
    expect(models.map(m => m.id)).toEqual([
      'us.meta.llama',
      'us.mistral.large',
      'us.anthropic.claude-sonnet',
    ]);
    // name falls back to id when inferenceProfileName is absent.
    const mistral = models.find(m => m.id === 'us.mistral.large')!;
    expect(mistral.name).toBe('us.mistral.large');
  });

  it('sends an empty ListInferenceProfilesCommand input', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    await new BedrockModelProxy('').fetchModels(cfg());
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(commandInputs).toEqual([{}]);
  });

  it('supports(): only "bedrock"', () => {
    const proxy = new BedrockModelProxy('');
    expect(proxy.supports('bedrock')).toBe(true);
    expect(proxy.supports('openai')).toBe(false);
    expect(proxy.supports('')).toBe(false);
  });
});

describe('BedrockModelProxy.fetchModels - credential source branches', () => {
  it('uses fromIni when a profile is configured (config.awsProfile wins)', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    const proxy = new BedrockModelProxy('', 'ctorKey', 'ctorSecret', 'ctorProfile', 'us-west-2');

    await proxy.fetchModels(cfg({ awsProfile: 'runtimeProfile', awsRegion: 'eu-west-1' }));

    expect(fromIniMock).toHaveBeenCalledTimes(1);
    expect(fromIniMock).toHaveBeenCalledWith({ profile: 'runtimeProfile' });
    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0].region).toBe('eu-west-1');
    // credentials is the fromIni sentinel (a provider function object).
    expect(clientConfigs[0].credentials).toMatchObject({ __fromIni: true });
  });

  it('uses direct access/secret keys when no profile is set', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    const proxy = new BedrockModelProxy('');

    await proxy.fetchModels(cfg({ apiKey: 'AKIA_DIRECT', awsSecretAccessKey: 'SECRET_DIRECT' }));

    expect(fromIniMock).not.toHaveBeenCalled();
    expect(clientConfigs[0].credentials).toEqual({
      accessKeyId: 'AKIA_DIRECT',
      secretAccessKey: 'SECRET_DIRECT',
    });
  });

  it('falls back to the default credential chain when neither profile nor both keys are present', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    const proxy = new BedrockModelProxy('');

    // Only an access key, no secret → not enough for direct creds.
    await proxy.fetchModels(cfg({ apiKey: 'onlyAccessKey' }));

    expect(fromIniMock).not.toHaveBeenCalled();
    // No credentials key → SDK default chain.
    expect(clientConfigs[0].credentials).toBeUndefined();
    // Region falls back to the constructor default (us-east-1) when config omits it.
    expect(clientConfigs[0].region).toBe('us-east-1');
  });

  it('prefers constructor credentials when config omits them', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    const proxy = new BedrockModelProxy('', 'ctorAccess', 'ctorSecret', undefined, 'us-east-2');

    await proxy.fetchModels(cfg({ apiKey: '', awsSecretAccessKey: undefined }));

    expect(clientConfigs[0].credentials).toEqual({
      accessKeyId: 'ctorAccess',
      secretAccessKey: 'ctorSecret',
    });
    expect(clientConfigs[0].region).toBe('us-east-2');
  });
});

describe('BedrockModelProxy.fetchModels - empty & error paths', () => {
  it('throws a wrapped "No inference profiles found" when the response has no summaries', async () => {
    sendMock.mockResolvedValue({});
    await expect(new BedrockModelProxy('').fetchModels(cfg()))
      .rejects.toThrow(/Failed to fetch Bedrock models: No inference profiles found/);
  });

  it('throws when all summaries are filtered out (no valid id)', async () => {
    sendMock.mockResolvedValue({
      inferenceProfileSummaries: [{ inferenceProfileName: 'no-id' }],
    });
    await expect(new BedrockModelProxy('').fetchModels(cfg()))
      .rejects.toThrow(/No inference profiles found/);
  });

  it('wraps SDK/network errors with the "Failed to fetch Bedrock models" prefix', async () => {
    sendMock.mockRejectedValueOnce(new Error('AccessDeniedException'));
    await expect(new BedrockModelProxy('').fetchModels(cfg()))
      .rejects.toThrow(/Failed to fetch Bedrock models: AccessDeniedException/);
  });

  it('handles a non-Error rejection with the "Unknown error" fallback', async () => {
    sendMock.mockRejectedValueOnce('boom-string');
    await expect(new BedrockModelProxy('').fetchModels(cfg()))
      .rejects.toThrow(/Failed to fetch Bedrock models: Unknown error/);
  });
});

describe('BedrockHealthCheck', () => {
  it('supports(): only "bedrock"', () => {
    const hc = new BedrockHealthCheck();
    expect(hc.supports('bedrock')).toBe(true);
    expect(hc.supports('ollama')).toBe(false);
  });

  it('reports healthy with model count when profiles are returned', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    const hc = new BedrockHealthCheck();

    const result = await hc.check(cfg({ awsRegion: 'us-east-1', model: 'us.meta.llama' }));

    expect(result.status).toBe('healthy');
    expect(result.provider).toBe('bedrock');
    expect(result.message).toMatch(/AWS Bedrock is accessible with 3 model\(s\) available/);
    expect(result.version).toBe('Region: us-east-1');
    expect(result.models).toHaveLength(3);
    // Configured model present → an 'ok' detail is emitted.
    expect(result.details).toEqual([
      { status: 'ok', message: "Model 'us.meta.llama' available" },
    ]);
  });

  it('warns when the configured model is not in the available list', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    const hc = new BedrockHealthCheck();

    const result = await hc.check(cfg({ model: 'nonexistent-model' }));

    expect(result.status).toBe('healthy');
    expect(result.details?.[0].status).toBe('warning');
    expect(result.details?.[0].message).toMatch(/not found/);
  });

  it('returns an unreachable result with remediation when listing fails', async () => {
    sendMock.mockRejectedValue(new Error('InvalidSignatureException'));
    const hc = new BedrockHealthCheck();

    const result = await hc.check(cfg({ awsRegion: 'ap-southeast-1' }));

    expect(result.status).toBe('unreachable');
    expect(result.message).toBe('Cannot connect to AWS Bedrock');
    expect(result.remediation).toMatch(/currently: ap-southeast-1/);
    expect(result.remediation).toMatch(/AWS Console/);
  });

  it('extracts direct credentials from config (apiKey as access key id)', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    const hc = new BedrockHealthCheck();

    await hc.check(cfg({ apiKey: 'AKIA_HC', awsSecretAccessKey: 'SECRET_HC', awsRegion: 'us-west-2' }));

    // check() runs ping (1 fetch) + listModels (1 fetch) → 2 client constructions.
    expect(clientConfigs.length).toBeGreaterThanOrEqual(1);
    expect(fromIniMock).not.toHaveBeenCalled();
    expect(clientConfigs[0].credentials).toEqual({
      accessKeyId: 'AKIA_HC',
      secretAccessKey: 'SECRET_HC',
    });
    expect(clientConfigs[0].region).toBe('us-west-2');
  });

  it('treats apiKey === "aws-profile" as NOT a direct access key, using the profile branch', async () => {
    sendMock.mockResolvedValue(SUMMARIES);
    const hc = new BedrockHealthCheck();

    await hc.check(cfg({ apiKey: 'aws-profile', awsProfile: 'myprofile', awsRegion: 'eu-central-1' }));

    expect(fromIniMock).toHaveBeenCalledWith({ profile: 'myprofile' });
    expect(clientConfigs[0].credentials).toMatchObject({ __fromIni: true });
  });
});

describe('toBedrockModelId (bedrock.utils)', () => {
  it('returns the id unchanged when it already contains "anthropic."', () => {
    const arn = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    expect(toBedrockModelId(arn)).toBe(arn);
    expect(toBedrockModelId('anthropic.claude-x', 'eu-west-1')).toBe('anthropic.claude-x');
  });

  it('defaults to the "us" prefix when no region is given', () => {
    expect(toBedrockModelId('claude-opus-4-6')).toBe('us.anthropic.claude-opus-4-6-v1:0');
  });

  it('maps eu* regions to the "eu" prefix', () => {
    expect(toBedrockModelId('claude-opus-4-6', 'eu-west-1')).toBe('eu.anthropic.claude-opus-4-6-v1:0');
  });

  it('maps ap* regions to the "ap" prefix', () => {
    expect(toBedrockModelId('claude-sonnet', 'ap-southeast-2')).toBe('ap.anthropic.claude-sonnet-v1:0');
  });

  it('maps us* regions to the "us" prefix', () => {
    expect(toBedrockModelId('claude-haiku', 'us-east-1')).toBe('us.anthropic.claude-haiku-v1:0');
  });

  it('falls back to "us" for any other region (e.g. ca-central-1)', () => {
    expect(toBedrockModelId('claude-x', 'ca-central-1')).toBe('us.anthropic.claude-x-v1:0');
  });
});
