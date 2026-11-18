/**
 * Cloud-provider descriptors for the settings-conflict gate.
 *
 * A descriptor names everything the gate needs to know about one cloud provider that Claude Code can be
 * pointed at directly: the flag that selects it, the keys that only make sense while that flag is set,
 * and the keys that carry model ids. Only Bedrock is filled in; Vertex and Foundry are deferred and
 * will be added as further instances of the same shape.
 */
import { CLOUD_FLAGS } from '@/agents/core/evidence/routing.js';

export interface CloudProviderDescriptor {
  /** Stable machine name. */
  name: string;
  /** Name shown to the user. */
  displayName: string;
  /** Environment flag that selects the provider; a member of the routing `CLOUD_FLAGS`. */
  flag: string;
  /** Keys removed from each layer that sets the flag. */
  flagScopedKeys: { env: string[]; topLevel: string[] };
  /** Keys that can carry a model id; only values that `isModelId` accepts are provider-specific. */
  modelKeys: { env: string[]; topLevel: string[]; list: string[] };
  /** True when the value is a provider model id. False for anything else, including non-strings. */
  isModelId(value: unknown): boolean;
  /** Prefix of the Claude Desktop applied-config keys that belong to this provider. */
  desktopKeyPrefix: string;
}

/**
 * Cross-region inference profiles (`us.`, `eu.`, `jp.`, `au.`, `us-gov.`, `apac.`, `global.` ...), bare
 * `anthropic.claude-…` ids, and ARNs in any AWS partition (`aws`, `aws-us-gov`, `aws-cn`).
 */
const BEDROCK_MODEL_ID = /^(?:(?:[a-z]{2,3}(?:-gov)?|apac|global)\.anthropic\.|anthropic\.claude-|arn:aws[a-z-]*:bedrock:)/i;

const BEDROCK_FLAG = 'CLAUDE_CODE_USE_BEDROCK';
if (!CLOUD_FLAGS.includes(BEDROCK_FLAG)) {
  throw new Error(`${BEDROCK_FLAG} is not a known cloud-provider flag`);
}

export const BEDROCK: CloudProviderDescriptor = {
  name: 'bedrock',
  displayName: 'AWS Bedrock',
  flag: BEDROCK_FLAG,
  flagScopedKeys: {
    env: [
      BEDROCK_FLAG,
      'ANTHROPIC_BEDROCK_BASE_URL',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_PROFILE',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ],
    topLevel: ['awsAuthRefresh', 'awsCredentialExport'],
  },
  modelKeys: {
    env: [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
    ],
    topLevel: ['model'],
    list: ['availableModels'],
  },
  isModelId: (value: unknown): boolean => typeof value === 'string' && BEDROCK_MODEL_ID.test(value.trim()),
  desktopKeyPrefix: 'inferenceBedrock',
};
