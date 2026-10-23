/**
 * Bedrock model id helpers.
 *
 * Bedrock addresses a model either by its base model id (`anthropic.claude-sonnet-4-6`)
 * or through a cross-region inference profile, which prefixes that id with the routing
 * geography (`us.`, `eu.`, `apac.`, `jp.`, `au.`) or the global endpoint (`global.`),
 * optionally as a full ARN. Which prefix a model supports is AWS's call, not ours — the
 * published table is per model and generation (Claude on Amazon Bedrock: Sonnet 4.5 and
 * everything after it are offered as `global.` as well as per geography; Sonnet 4 and
 * earlier are not).
 */

/**
 * Routing prefixes. `us.` also covers `ca-*` and `us-gov-*`: Bedrock's geographies are
 * US, EU, JP, APAC and AU, and cross-region profiles route through the nearest one.
 */
const REGION_TO_GEOGRAPHY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^us(-gov)?-/, 'us.'],
  [/^ca-/, 'us.'],
  [/^eu-/, 'eu.'],
  // Tokyo and Osaka sit in the JP geography, Sydney and Melbourne in AU.
  [/^ap-northeast-(1|3)$/, 'jp.'],
  [/^ap-southeast-(2|4)$/, 'au.'],
  [/^ap-/, 'apac.'],
  [/^au-/, 'au.'],
];
// Preserve the shared helper's existing default for v1 and the built-in agent.
// A global inference profile must be selected explicitly by its qualified id.
const DEFAULT_GEOGRAPHY = 'us.';

/** Id already carrying a routing geography, e.g. `us.anthropic.claude-sonnet-4-6`. */
const HAS_ROUTING_PREFIX = /^(?:global|us|eu|apac|jp|au)\./i;

/** Id already carrying a Bedrock provider segment, e.g. `anthropic.…`, `meta.…`, `amazon.…`. */
const HAS_PROVIDER_SEGMENT = /^(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|openai|qwen|nvidia|writer|luma|stability|twelvelabs|ibm)\./i;

function routingPrefix(region?: string): string {
  if (!region) return DEFAULT_GEOGRAPHY;
  return REGION_TO_GEOGRAPHY.find(([pattern]) => pattern.test(region))?.[1] ?? DEFAULT_GEOGRAPHY;
}

/**
 * Qualify a short Claude model name into a Bedrock model id.
 *
 * Only the routing prefix and the `anthropic.` provider segment are added — no version
 * suffix is invented. Modern ids do not carry one (`anthropic.claude-sonnet-4-6`,
 * `anthropic.claude-opus-4-6-v1`), and appending `-v1:0` to every name produced ids AWS
 * rejects. A name that is missing a required suffix now fails loudly on AWS's side with
 * the model's real id in the message, which is a better failure than a silently wrong id.
 *
 * Examples:
 *   claude-sonnet-4-6                     → us.anthropic.claude-sonnet-4-6            (no region)
 *   claude-sonnet-4-6, 'us-east-1'        → us.anthropic.claude-sonnet-4-6
 *   claude-opus-4-6, 'ap-northeast-1'     → jp.anthropic.claude-opus-4-6
 *   claude-sonnet-4-5-20250929-v1:0       → us.anthropic.claude-sonnet-4-5-20250929-v1:0
 *   us.anthropic.claude-sonnet-4-5-…      → unchanged
 *   arn:aws:bedrock:…:inference-profile/… → unchanged
 *
 * Non-Claude names are returned untouched: a bare `llama3-70b` carries no provider to
 * infer, and prefixing it with a provider segment AWS never published is strictly worse
 * than letting the request name the model it cannot find.
 */
export function toBedrockModelId(modelId: string, region?: string): string {
  const id = modelId.trim();
  if (!id) return id;
  if (id.startsWith('arn:')) return id;
  if (HAS_ROUTING_PREFIX.test(id) || HAS_PROVIDER_SEGMENT.test(id)) return id;
  if (!/claude-/i.test(id)) return id;
  return `${routingPrefix(region)}anthropic.${id}`;
}
