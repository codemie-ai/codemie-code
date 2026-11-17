import { describe, expect, it } from 'vitest';
import { CLOUD_FLAGS } from '@/agents/core/evidence/routing.js';
import { BEDROCK } from '../provider.js';

describe('BEDROCK provider descriptor', () => {
  it('is identified as bedrock with a display name', () => {
    expect(BEDROCK.name).toBe('bedrock');
    expect(BEDROCK.displayName).toBe('AWS Bedrock');
    expect(BEDROCK.desktopKeyPrefix).toBe('inferenceBedrock');
  });

  it('uses a flag that is a member of the routing CLOUD_FLAGS', () => {
    expect(BEDROCK.flag).toBe('CLAUDE_CODE_USE_BEDROCK');
    expect(CLOUD_FLAGS).toContain(BEDROCK.flag);
  });

  it('lists the flag among its flag-scoped env keys', () => {
    expect(BEDROCK.flagScopedKeys.env).toEqual([
      'CLAUDE_CODE_USE_BEDROCK',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_PROFILE',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]);
    expect(BEDROCK.flagScopedKeys.topLevel).toEqual(['awsAuthRefresh', 'awsCredentialExport']);
  });

  it('lists the model-bearing keys', () => {
    expect(BEDROCK.modelKeys.env).toEqual([
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
    ]);
    expect(BEDROCK.modelKeys.topLevel).toEqual(['model']);
    expect(BEDROCK.modelKeys.list).toEqual(['availableModels']);
  });

  describe('isModelId', () => {
    it.each([
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      'eu.anthropic.claude-3-7-sonnet-20250219-v1:0',
      'apac.anthropic.claude-3-haiku-20240307-v1:0',
      'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-v1:0',
    ])('matches the Bedrock id %s', (id) => {
      expect(BEDROCK.isModelId(id)).toBe(true);
    });

    it.each(['claude-sonnet-4', 'claude-sonnet-4-20250514', 'gpt-5', 'my-gateway-alias', 'opus', ''])(
      'does not match the non-Bedrock value %j',
      (value) => {
        expect(BEDROCK.isModelId(value)).toBe(false);
      }
    );

    it.each([undefined, null, 42, true, {}, ['us.anthropic.claude-sonnet-4-v1:0']])(
      'is false for non-string input %j',
      (value) => {
        expect(BEDROCK.isModelId(value)).toBe(false);
      }
    );
  });
});
