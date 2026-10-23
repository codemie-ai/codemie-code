import { join } from 'path';
import os from 'os';
import { statSync } from 'fs';
import chalk from 'chalk';
import type { AgentMetadata, AgentConfig, CanonicalReasoningEffort } from '../../core/types.js';
import { normalizeReasoningEffort, clampToSupported } from '../../core/reasoning-effort.js';
import { logger } from '../../../utils/logger.js';
import { ConfigurationError, ToolExecutionError } from '@/utils/errors.js';
import { getModelConfig, getChatCompletionsModelConfigs, getResponsesApiModelConfigs } from './opencode-model-configs.js';
import { fetchDynamicModelConfigs } from './opencode-dynamic-models.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import { commandExists, getCommandPath } from '../../../utils/processes.js';
import { exec } from '../../../utils/exec.js';
import { OpenCodeSessionAdapter } from './opencode.session.js';
import { getOpenCodeConfigDir, resolveOpenCodeDbPath } from './opencode.paths.js';
import {
  startOpenCodeIncrementalSync,
  stopOpenCodeIncrementalSync,
} from './opencode.incremental-sync.js';
import { getHooksPluginFileUrl, cleanupHooksPlugin, cleanupHooksV2Plugin, getHooksV2PluginDirUrl } from '../codemie-code-hooks/index.js';
import type { HookProcessingConfig } from '../../../cli/commands/hook.js';
import { toBedrockModelId } from '../../../providers/plugins/bedrock/bedrock.utils.js';
import { MAX_ENV_SIZE, writeConfigToTempFile } from '../../core/temp-config.js';
import { ensureSessionFile } from '../../core/session/ensure-session.js';

const OPENCODE_SUBCOMMANDS = ['run', 'chat', 'config', 'init', 'help', 'version'];

// V2 flag capabilities, not agent ownership or additional command support.
// Keep the legacy owned-subcommand list above unchanged for v1.
const V2_STANDALONE_SUBCOMMANDS = new Set(['run', 'mini', 'api', 'models', 'stats', 'reload', 'auth', 'session']);
const V2_PASSTHROUGH_SUBCOMMANDS = new Set(['debug', 'mcp', 'plugin', 'upgrade', 'update', 'uninstall', 'serve', 'service', 'acp', 'pair']);
const V2_STANDALONE_GROUPS = new Map<string, ReadonlySet<string>>([
  ['auth', new Set(['list', 'login', 'logout', 'export', 'import', 'switch'])],
  ['session', new Set(['list', 'delete', 'export', 'import'])],
]);
// Skip root option values when identifying a command; --resume is mapped later.
const V2_ROOT_VALUE_FLAGS = new Set(['--session', '-s', '--prompt', '--resume']);

const OPENCODE_CLIENT_TYPE = 'codemie-opencode';

type OpenCodeConfigVersion = 'v1' | 'v2';

/** v2 runtime packages (v1 uses `npm: @ai-sdk/openai-compatible`). */
const V2_CHAT_PACKAGE = '@opencode/ai/providers/openai-compatible';
const V2_RESPONSES_PACKAGE = '@opencode/ai/providers/openai-compatible/responses';

/**
 * Marker set by beforeRun when the requested effort has a configured variant.
 * The gate also checks final argv before reporting it as applied.
 */
const V2_EFFORT_APPLIED_ENV = 'CODEMIE_OPENCODE_V2_EFFORT_APPLIED';

/** Version resolved by beforeRun for synchronous CLI argument enrichment. */
const RESOLVED_CONFIG_VERSION_ENV = 'CODEMIE_OPENCODE_RESOLVED_CONFIG_VERSION';

/**
 * Full `provider/model#variant` reference assembled by beforeRun when the effort
 * was honored. Read back by enrichArgs (synchronously) to pass `-m <ref>` on the
 * argv: `run` resolves the variant — and therefore the body overlays — only from
 * the CLI `--model` reference (parseRunModel → switchModel → withVariant), while
 * the `#variant` suffix on the config `model:` key is ignored at session init
 * (verified live: config suffix alone sends no effort params; CLI flag does).
 * Set alongside V2_EFFORT_APPLIED_ENV; absent unless honored.
 */
const V2_MODEL_REF_ENV = 'CODEMIE_OPENCODE_V2_MODEL_REF';

/**
 * Canonical effort levels, reused as v2 variant ids (config VariantID
 * forbids only `#`, so every canonical level is a legal id).
 */
const V2_EFFORT_LEVELS: CanonicalReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * How long a successful probe result is trusted. A per-invocation CLI process
 * finishes well inside it, so the probe still runs at most once per run; a
 * long-lived process picks up an installed or upgraded binary without a
 * restart (second-audit F2: the cache used to live for the whole process).
 */
const CONFIG_VERSION_CACHE_TTL_MS = 5 * 60_000;

/**
 * How long a failed probe's v1 fallback is trusted. Kept short so a transient
 * failure (timeout, PATH not yet populated) is retried soon, but nonzero so
 * the repeated calls within a single launch — the reasoningEffort gate,
 * beforeRun, the v2 branches — do not each re-spend the 3s probe timeout.
 */
const CONFIG_VERSION_FAILURE_TTL_MS = 30_000;

interface ConfigVersionCacheEntry {
  readonly version: OpenCodeConfigVersion;
  /** When the probe settled — `Date.now()` at cache-write time. */
  readonly cachedAt: number;
  /** `false` when the entry records a failed probe's v1 fallback. */
  readonly fromSuccessfulProbe: boolean;
}

let cachedConfigVersion: ConfigVersionCacheEntry | undefined;

const isConfigVersionCacheEntryFresh = (entry: ConfigVersionCacheEntry): boolean => {
  const ttl = entry.fromSuccessfulProbe ? CONFIG_VERSION_CACHE_TTL_MS : CONFIG_VERSION_FAILURE_TTL_MS;
  return Date.now() - entry.cachedAt < ttl;
};

/**
 * Resolve which config schema the installed OpenCode binary speaks.
 *
 * OpenCode 1.x reads `provider` (singular) + `npm` + `options`;
 * OpenCode 2.x reads `providers` (plural) + `package` + `settings`.
 * The major version is probed via `opencode --version` and cached with a
 * TTL — a successful probe for `CONFIG_VERSION_CACHE_TTL_MS`, a failed
 * probe's v1 fallback for `CONFIG_VERSION_FAILURE_TTL_MS` — so neither
 * result outlives a binary install/upgrade for the rest of the process.
 *
 * `CODEMIE_OPENCODE_CONFIG_VERSION=1|2` forces a schema explicitly
 * (useful for testing without a v2 binary installed).
 *
 * Any probe failure falls back to 'v1' to preserve current behavior.
 */
export async function resolveOpenCodeConfigVersion(): Promise<OpenCodeConfigVersion> {
  const override = process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
  if (override === '2') {
    return 'v2';
  }
  if (override === '1') {
    return 'v1';
  }
  if (cachedConfigVersion && isConfigVersionCacheEntryFresh(cachedConfigVersion)) {
    return cachedConfigVersion.version;
  }
  try {
    const bin = OpenCodePluginMetadata.cliCommand || 'opencode';
    // Resolve the full path first: on Windows the global npm shim is a
    // `.cmd` file, which spawn cannot execute without a shell. Path
    // resolution alone is not sufficient — `shell: true` is still required
    // on Windows (cf. BaseAgentAdapter launch path, npm helpers in
    // src/utils/processes.ts).
    const resolvedBin = (await getCommandPath(bin)) ?? bin;
    const isWindows = os.platform() === 'win32';
    // exec() quotes argv, not the executable. Match the launcher's quoting,
    // including the raw metadata path when PATH resolution returned nothing.
    const quotedBin = isWindows && /[ \t,;=()&|<>^%[\]{}]/.test(resolvedBin) && !resolvedBin.startsWith('"')
      ? `"${resolvedBin}"`
      : resolvedBin;
    const result = await exec(quotedBin, ['--version'], {
      timeout: 3000,
      shell: isWindows,
    });
    if (result.code !== 0) {
      throw new ToolExecutionError('opencode --version', `exited with code ${result.code}`);
    }
    // Require a complete version response, not a number embedded in an error
    // or warning. Keep v prefixes and prerelease/build identifiers valid.
    const match = /^(?:opencode(?:-ai)?[ \t]+)?v?(\d+)\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.exec(result.stdout.trim());
    if (!match) {
      throw new ToolExecutionError('opencode --version', 'did not report a valid version');
    }
    const version: OpenCodeConfigVersion = Number(match[1]) >= 2 ? 'v2' : 'v1';
    cachedConfigVersion = { version, cachedAt: Date.now(), fromSuccessfulProbe: true };
  } catch (error) {
    // A failed probe must never block agent startup: fall back to the v1
    // schema, but say so loudly — a silent fallback is what made the
    // Windows autodetect gap undetectable. The fallback is cached only for
    // the short failure TTL, so the next probe retries soon instead of
    // pinning v1 for the rest of the process.
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`[opencode] Version probe failed (${reason}), falling back to v1 config schema`);
    cachedConfigVersion = { version: 'v1', cachedAt: Date.now(), fromSuccessfulProbe: false };
  }
  logger.debug(`[opencode] Config schema version: ${cachedConfigVersion.version}`);
  return cachedConfigVersion.version;
}

/** Test seam — resets the cached probe result. */
export function resetOpenCodeConfigVersionCache(): void {
  cachedConfigVersion = undefined;
}

/**
 * Emit a v2-shaped config through the unified injection strategy: inline via
 * `OPENCODE_CONFIG_CONTENT` primary, temp-file `OPENCODE_CONFIG` fallback
 * above the env size limit. Both channels run through the same v2
 * parse + normalize pipeline (verified against v2 sources).
 */
function injectV2Config(
  env: NodeJS.ProcessEnv,
  v2Config: Record<string, unknown>,
  label: string,
): NodeJS.ProcessEnv {
  const v2ConfigJson = JSON.stringify(v2Config);
  if (v2ConfigJson.length > MAX_ENV_SIZE) {
    logger.warn(`Config size (${v2ConfigJson.length} bytes) exceeds env var limit (${MAX_ENV_SIZE}), using temp file fallback`, {
      agent: 'opencode'
    });

    const v2ConfigPath = writeConfigToTempFile(v2ConfigJson, label);
    logger.debug(`[opencode] Wrote v2 config to temp file: ${v2ConfigPath}`);

    env.OPENCODE_CONFIG = v2ConfigPath;
    return env;
  }

  env.OPENCODE_CONFIG_CONTENT = v2ConfigJson;
  return env;
}

/** Explain how to fix the model's actual source, not just override one run. */
function formatMissingV2ModelError(model: string, env: NodeJS.ProcessEnv, config: AgentConfig): string {
  const profileName = env.CODEMIE_PROFILE_NAME || config?.profileName;
  const profileSelection = profileName ? `select profile '${profileName}'` : 'select the affected profile';
  const updateDefaultHint = `To change the saved default: run "codemie setup", choose "Update an existing profile", ${profileSelection}, then select an available model and save.`;
  const oneRunHint = 'For one run only: codemie-opencode --profile <profile-name> --model <model-id>. This does not change the saved default.';
  const lines = [
    `[opencode] Model '${model}' is not in the catalogue emitted for OpenCode v2.`,
    'Launch aborted. Automatic model fallback is disabled, including for profile defaults.',
    ...(profileName ? [`CodeMie profile: '${profileName}'.`] : []),
  ];

  switch (env.CODEMIE_MODEL_SOURCE) {
    case 'cli':
      lines.push(
        'Model source: --model CLI override.',
        'Retry with --model <model-id>. Changing the saved profile default will not fix this override.'
      );
      break;
    case 'env':
      lines.push(
        'Model source: CODEMIE_MODEL environment variable.',
        'Update or unset CODEMIE_MODEL; it overrides the saved profile default.'
      );
      break;
    case 'default':
      lines.push(`Model source: ${profileName ? 'saved profile default' : 'configuration default'}.`, updateDefaultHint, oneRunHint);
      break;
    default:
      // Direct adapter callers may not provide AgentCLI's provenance marker.
      lines.push(
        'Model source: not provided.',
        `If this is a saved profile default: ${updateDefaultHint}`,
        'If CODEMIE_MODEL is set, update or unset it; if --model was supplied, correct that override.',
        oneRunHint
      );
  }

  lines.push(
    'Use the catalogue model ID as-is, without adding a provider prefix or #variant.',
    'List IDs with "codemie models list" (active profile only). If needed, select the matching profile with "codemie profile switch <profile-name>" first.'
  );
  return lines.join('\n');
}

/**
 * Hooks the CodeMie CLI always registers with OpenCode, on top of anything the
 * user's profile defines. They measure active session time:
 *   UserPromptSubmit → SessionStore.startActivityTracking
 *   Stop             → SessionStore.accumulateActiveDuration + incremental sync
 *
 * Stop is async (detached spawn) because the plugin executes synchronous hooks
 * with execSync, which would otherwise block OpenCode's event loop while the
 * child re-parses SQLite and rewrites JSONL.
 */
const DEFAULT_HOOKS: Record<string, unknown[]> = {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codemie hook', timeout: 5 }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'codemie hook', timeout: 10, async: true }] }],
};

/**
 * Merge the CodeMie telemetry hooks with any hooks the active profile defines.
 *
 * Entries are appended per event name rather than spread over the object: a
 * shallow spread lets a profile that defines its own Stop or UserPromptSubmit
 * REPLACE the telemetry hook, which silently zeroes active_duration_ms for
 * exactly the users who customise hooks.
 */
function buildMergedHooks(env: NodeJS.ProcessEnv): Record<string, unknown[]> {
  const mergedHooks: Record<string, unknown[]> = { ...DEFAULT_HOOKS };

  if (!env.CODEMIE_PROFILE_CONFIG) {
    return mergedHooks;
  }

  try {
    const profileConfig = JSON.parse(env.CODEMIE_PROFILE_CONFIG);
    if (profileConfig.hooks && typeof profileConfig.hooks === 'object') {
      for (const [eventName, entries] of Object.entries(profileConfig.hooks)) {
        if (!Array.isArray(entries)) {
          logger.warn(`[opencode] Ignoring non-array profile hook entry: ${eventName}`);
          continue;
        }
        mergedHooks[eventName] = [...(mergedHooks[eventName] ?? []), ...entries];
      }
      logger.debug('[opencode] Merged profile hooks with defaults');
    }
  } catch {
    // Non-critical — profile config parse failure doesn't block startup
  }

  return mergedHooks;
}

/**
 * Build a hook config object from environment variables.
 * Used by both onSessionStart and onSessionEnd lifecycle hooks.
 *
 * clientType reads env.CODEMIE_CLIENT_TYPE (set by BaseAgentAdapter from
 * metadata.ssoConfig.clientType for every agent) rather than the fixed
 * OPENCODE_CLIENT_TYPE constant, so that plugins extending OpenCodePlugin with
 * a different clientType (e.g. opencode-acp's 'codemie-opencode-acp') are
 * tagged correctly in telemetry. Falls back to OPENCODE_CLIENT_TYPE to
 * preserve behavior for plain OpenCode / any caller that doesn't set the env var.
 */
function buildHookConfig(env: NodeJS.ProcessEnv, sessionId: string): HookProcessingConfig {
  return {
    agentName: env.CODEMIE_AGENT || 'opencode',
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    env,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: env.CODEMIE_CLIENT_TYPE || OPENCODE_CLIENT_TYPE,
  };
}

/**
 * Resolve the requested effort to a v2 variant id: normalize + clamp +
 * mapLevel, mirroring applyReasoningEffort. Undefined when unset or
 * unrecognized (callers treat that as "no effort requested").
 */
function resolveV2EffortLevel(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.CODEMIE_REASONING_EFFORT;
  if (!raw) return undefined;
  const normalized = normalizeReasoningEffort(raw);
  if (!normalized) {
    logger.debug(`[opencode] reasoning-effort: unrecognized level '${raw}', skipping v2 variant`);
    return undefined;
  }
  const config = OpenCodePluginMetadata.reasoningEffort;
  const clamped = clampToSupported(normalized, config?.supportedLevels ?? V2_EFFORT_LEVELS);
  return config?.mapLevel ? (config.mapLevel(clamped) ?? clamped) : clamped;
}

/**
 * Per-model `variants` entries carrying the effort as request-body overlays.
 * v2 resolves `#variant` via withVariant (recursive deep merge): the
 * chat-completions branch takes the OpenAI-standard `reasoning_effort`, the
 * Responses branch takes `reasoning.effort`. Both openai-compatible packages
 * forward `body` into the request payload (http.body), so the proxy receives
 * standard params it already speaks.
 */
function buildV2EffortVariants(kind: 'chat' | 'responses'): Array<Record<string, unknown>> {
  return V2_EFFORT_LEVELS.map((level) => ({
    id: level,
    body: kind === 'chat' ? { reasoning_effort: level } : { reasoning: { effort: level } },
  }));
}

/**
 * Claude on Bedrock carries its reasoning controls in Converse's
 * `additionalModelRequestFields`, not in an OpenAI-style `reasoning_effort`.
 * The overlays below mirror OpenCode's own bedrockConverse variant protocol
 * (packages/core/src/variant.ts:421-453), so a variant emitted here produces the
 * same request body the binary resolves for a catalogue variant:
 *
 * - Claude 4.6+ (adaptive thinking): `output_config.effort` alongside adaptive
 *   thinking — the channel Anthropic models accept on Bedrock
 * - Claude 3.7 / 4.0-4.5 (manual budget): `settings.thinking.budgetTokens`, the
 *   only typed setting the amazon-bedrock package takes
 *   (packages/ai/src/providers/amazon-bedrock.ts:33); the Converse protocol fits
 *   the budget under `maxTokens` (protocols/bedrock-converse.ts:497-516)
 *
 * `minimal` is not an Anthropic effort value, so it travels as `low`.
 */
const BEDROCK_THINKING_BUDGETS: Record<CanonicalReasoningEffort, number> = {
  minimal: 1_024, // Bedrock rejects a thinking budget below 1024
  low: 4_096,
  medium: 8_192,
  high: 16_000,
  xhigh: 24_000,
  max: 32_000, // OpenCode's ANTHROPIC_OUTPUT_TOKEN_MAX
};
const BEDROCK_EFFORT_VALUES: Record<CanonicalReasoningEffort, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * Resolve the Anthropic effort value Bedrock actually accepts for this Claude
 * generation. AWS's adaptive-thinking effort table (docs.aws.amazon.com/
 * bedrock/latest/userguide/claude-messages-adaptive-thinking.html) scopes
 * `xhigh` to Opus 4.6/5 and Haiku 5.5 — Sonnet 4.6 is not on that list and
 * returns an error for it, even though it accepts `max`. Every other 4.6+
 * generation mirrors OpenCode's own value domain unchanged (variant.ts has no
 * such restriction) pending the AWS probe confirming the remaining models.
 */
function resolveBedrockEffort(info: BedrockClaudeInfo, level: CanonicalReasoningEffort): string {
  const value = BEDROCK_EFFORT_VALUES[level];
  if (value === 'xhigh' && info.family === 'sonnet' && info.major === 4 && info.minor === 6) {
    logger.warn("[opencode] Bedrock Claude Sonnet 4.6 does not support effort 'xhigh' (AWS adaptive-thinking table); downgrading to 'high'");
    return 'high';
  }
  return value;
}

/** Claude family and version parsed out of a Bedrock model id. */
interface BedrockClaudeInfo {
  readonly family: string;
  readonly major: number;
  readonly minor: number;
}

/**
 * Claude family and version out of a Bedrock model id, matched with the same two
 * expressions OpenCode uses for its Claude capability probes (variant.ts:55-69,
 * protocols/utils/claude-model.ts:7-12): family-first
 * (`us.anthropic.claude-sonnet-4-6-…-v1:0`) and version-first
 * (`us.anthropic.claude-3-7-sonnet-…-v1:0`). The region prefix and the `:0`
 * suffix do not defeat either parse.
 */
function parseBedrockClaudeInfo(modelId: string): BedrockClaudeInfo | undefined {
  const familyFirst = /(?:^|[./])claude-([a-z]+)-(\d+)(?:[.-](\d{1,2}))?(?:$|[-:@])/.exec(modelId.toLowerCase());
  const versionFirst = /claude-(\d+)(?:[.-](\d{1,2}))?-([a-z]+)/.exec(modelId.toLowerCase());
  const parsed = familyFirst
    ? { family: familyFirst[1], major: familyFirst[2], minor: familyFirst[3] }
    : versionFirst
      ? { family: versionFirst[3], major: versionFirst[1], minor: versionFirst[2] }
      : undefined;
  if (!parsed) return undefined;
  return { family: parsed.family, major: Number(parsed.major), minor: Number(parsed.minor ?? 0) };
}

/**
 * Extended thinking arrived with Claude 3.7, so 3.7 and every 4.x/5.x generation
 * takes it — including the original Claude Sonnet 4 (launched May 23, 2025,
 * `anthropic.claude-sonnet-4-20250514-v1:0`), which the AWS extended-thinking
 * guide lists as supported and OpenCode's own manual-thinking gate
 * (`major===4 && minor<6`, variant.ts:66) includes without a family exception.
 */
function supportsBedrockClaudeThinking(info: BedrockClaudeInfo): boolean {
  if (info.major === 3) return info.minor >= 7;
  return info.major >= 4;
}

/**
 * OpenCode's manual-thinking gate (variant.ts:55-69): 3.7 and 4.0-4.5 take a
 * budget, 4.6+ takes effort — matching Anthropic's own note that extended
 * thinking is deprecated on Opus 4.6 / Sonnet 4.6 and rejected on later models.
 */
function isBedrockManualThinkingModel(info: BedrockClaudeInfo): boolean {
  return (info.major === 3 && info.minor === 7) || (info.major === 4 && info.minor < 6);
}

/**
 * Context window and max output per Claude generation, as published on the
 * Amazon Bedrock model cards (docs.aws.amazon.com/bedrock/latest/userguide/
 * model-card-anthropic-claude-*.html) — the platform this code actually
 * targets, not the Claude API cards, which disagree for two generations:
 *
 * - Opus 4.1 is the one 200k-context model with a 32k output cap (every other
 *   3.7–4.5 generation — Sonnet 4, Sonnet 4.5, Opus 4.5, Haiku 4.5 — caps at
 *   64k)
 * - Sonnet 4.6 is the one 1M-context model with a 64k output cap; every other
 *   4.6+ generation (Opus 4.6/4.7/4.8, Sonnet/Opus 5.x) caps at 128k
 *
 * `output` becomes `maxTokens` directly, and the thinking budget is capped at
 * half of it (fitThinkingBudget) — over-declaring it sends a `max_tokens`
 * value AWS rejects; under-declaring it clamps a requested budget to a
 * fraction of what the model actually accepts. CodeMie's own catalogue has no
 * Bedrock rows, so without a per-generation declaration the model falls back
 * to the generic { context: 128000, output: 4096 } from `getModelConfig()` —
 * or, with nothing emitted at all, to OpenCode's { context: 200000,
 * output: 32000 } default.
 */
function resolveBedrockClaudeLimits(info: BedrockClaudeInfo): { context: number; output: number } {
  if (info.family === 'opus' && info.major === 4 && info.minor === 1) {
    return { context: 200_000, output: 32_000 };
  }
  const isLongContext = info.major > 4 || (info.major === 4 && info.minor >= 6);
  if (!isLongContext) {
    return { context: 200_000, output: 64_000 };
  }
  if (info.family === 'sonnet' && info.major === 4 && info.minor === 6) {
    return { context: 1_000_000, output: 64_000 };
  }
  return { context: 1_000_000, output: 128_000 };
}

/**
 * Per-model `variants` carrying reasoning effort on Bedrock. The ids are the
 * canonical levels, so the `#level` suffix always resolves; each overlay is what
 * the Converse protocol turns into a request field (variant `body` becomes
 * `http.body` and deep-merges over the payload, route/transport/http.ts:41-48).
 */
function buildV2BedrockEffortVariants(info: BedrockClaudeInfo): Array<Record<string, unknown>> {
  const manual = isBedrockManualThinkingModel(info);
  return V2_EFFORT_LEVELS.map((level) =>
    manual
      ? {
          id: level,
          settings: { thinking: { type: 'enabled', budgetTokens: BEDROCK_THINKING_BUDGETS[level] } },
        }
      : {
          id: level,
          body: {
            additionalModelRequestFields: {
              thinking: { type: 'adaptive', display: 'summarized' },
              output_config: { effort: resolveBedrockEffort(info, level) },
            },
          },
        }
  );
}

/** Distinguish existing directory arguments from unrecognized command tokens. */
function isDirectoryArgument(argument: string): boolean {
  try {
    return statSync(argument, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    // Let OpenCode report inaccessible/invalid paths without guessing a mode.
    return false;
  }
}

export const OpenCodePluginMetadata: AgentMetadata = {
  name: 'opencode',
  displayName: 'OpenCode CLI',
  description: 'OpenCode - open-source AI coding assistant',
  npmPackage: 'opencode-ai',  // Official npm package (npm i -g opencode-ai)
  cliCommand: process.env.CODEMIE_OPENCODE_BIN || 'opencode',

  sessionAnalyticsReport: true,
  dataPaths: {
    home: '.opencode'
    // NOTE: Session storage is NOT in home - it's in XDG_DATA_HOME/opencode/storage/
    // This is handled by getSessionStoragePath() in opencode.paths.ts
  },
  ownedSubcommands: OPENCODE_SUBCOMMANDS,
  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: []
  },
  supportedProviders: ['litellm', 'ai-run-sso', 'ollama', 'bedrock', 'bearer-auth'],
  ssoConfig: { enabled: true, clientType: OPENCODE_CLIENT_TYPE },

  // Tool names are lower-cased before they reach the aggregator, and
  // filterErrorTools does an exact match — the global default
  // ['Bash','Execute','Shell'] would silently never match here.
  metricsConfig: {
    excludeErrorsFromTools: ['bash'],
  },

  // V2 nests servers under mcp.servers; V1 uses mcp directly. Detect the document
  // shape, not the binary version, since V2 also accepts legacy configs.
  // OpenCode accepts both the
  // .json and .jsonc filenames, so each scope lists candidates in priority order.
  mcpConfig: {
    project: {
      path: ['opencode.json', 'opencode.jsonc'],
      jsonPath: ['mcp.servers', 'mcp'],
    },
    local: {
      path: ['.opencode/opencode.json', '.opencode/opencode.jsonc'],
      jsonPath: ['mcp.servers', 'mcp'],
    },
    user: {
      path: [
        join(getOpenCodeConfigDir(), 'opencode.json'),
        join(getOpenCodeConfigDir(), 'opencode.jsonc'),
        '~/.opencode/opencode.json',
      ],
      jsonPath: ['mcp.servers', 'mcp'],
    },
  },

  // OpenCode accepts singular and plural directory names for every category.
  // Two deliberate mappings:
  //   hooks → plugin/ + plugins/  (OpenCode has no hooks/ directory; plugins are
  //                                the closest equivalent extension point)
  //   rules → []                  (OpenCode has no rules/ concept, so the
  //                                rules_* metric fields stay at zero)
  extensionsConfig: {
    project: '.opencode',
    global: getOpenCodeConfigDir(),
    extraGlobalDirs: ['~/.opencode'],
    skillsEntryFile: 'SKILL.md',
    dirNames: {
      agents: ['agent', 'agents'],
      commands: ['command', 'commands'],
      skills: ['skill', 'skills'],
      hooks: ['plugin', 'plugins'],
      rules: [],
    },
  },

  flagMappings: {
    '--resume': {
      type: 'flag',
      target: '-s',
    },
  },

  reasoningEffort: {
    strategy: 'cli-flag',
    flag: '--variant',
    placement: 'append',
    supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    userOverrideFlags: ['--variant'],
    // OpenCode v2 removed `--variant` from `run` (effort travels via the
    // `#variant` suffix in `--model` instead), so injecting the flag would
    // fail the whole launch with "Unrecognized flag" (exit 1). Skip the
    // injection on v2 loudly — a silent drop would hide that the requested
    // effort is not applied. When beforeRun already honored the effort
    // through config variants (V2_EFFORT_APPLIED_ENV), skip quietly.
    shouldApply: async (args: string[], env: NodeJS.ProcessEnv): Promise<boolean> => {
      if ((await resolveOpenCodeConfigVersion()) !== 'v2') {
        return true;
      }
      if (args.some((arg) => arg === '--variant' || arg.startsWith('--variant='))) {
        logger.warn('[opencode] --variant is not accepted by OpenCode v2 `run`; the binary will reject it — remove the flag or use --model provider/model#variant');
        console.error(chalk.yellow('⚠  --variant is not supported by OpenCode v2 (opencode run has no such flag); continuing, but the run is likely to fail — remove --variant or use --model provider/model#variant.'));
      } else if (env[V2_EFFORT_APPLIED_ENV] === '1' && env[V2_MODEL_REF_ENV]) {
        // Explicit model flags win over the configured default. Inspect final
        // argv instead of equating emitted config with successful delivery.
        let effectiveModel: string | undefined;
        for (let index = 0; index < args.length; index++) {
          const arg = args[index];
          if (arg === '--') break;
          if (arg === '-m' || arg === '--model') {
            effectiveModel = args[++index];
          } else if (arg.startsWith('--model=')) {
            effectiveModel = arg.slice('--model='.length);
          }
        }
        if (args[0] === 'run' && effectiveModel === env[V2_MODEL_REF_ENV]) {
          logger.debug('[opencode] reasoning-effort delivered through the final v2 model reference; skipping --variant injection');
          return false;
        }
        logger.warn('[opencode] Requested reasoning effort was configured but not delivered through the final run model reference');
        console.error(chalk.yellow(args[0] === 'run'
          ? '⚠  --reasoning-effort did not override your explicit --model. Select provider/model#variant to apply effort.'
          : '⚠  Startup --reasoning-effort is not applied on this OpenCode v2 command. In the TUI, select a variant with /effort or Ctrl+T; for automation, use run --model provider/model#variant.'));
      } else {
        // Single user-facing warning for every not-honored case (non-reasoning
        // model, ollama, a Bedrock model without extended thinking, no proxy
        // config): beforeRun logs specifics to the file log but stays quiet on
        // console, so this stays the only one.
        logger.warn('[opencode] --reasoning-effort is set but could not be applied on v2 (unsupported model/provider, ollama, Bedrock model without extended thinking, or no proxy config); ignoring effort and continuing without it');
        console.error(chalk.yellow('⚠  --reasoning-effort could not be applied for this OpenCode v2 run; ignoring.'));
      }
      return false;
    },
  },

  lifecycle: {
    /**
     * Emit the `started` codemie_cli_session_total row and scan MCP/extensions.
     *
     * Runs in-process rather than via a hook: OpenCode's session.created event
     * does not correspond to CLI startup, and this must happen before
     * ensureSessionFile in beforeRun — otherwise the placeholder record with
     * agentSessionId 'unknown' and a fabricated startTime wins, and every
     * downstream metric inherits it.
     *
     * session_id is the CodeMie session UUID: OpenCode's own ses_* id does not
     * exist yet, and using it only at SessionEnd would leave the started and
     * completed rows uncorrelatable.
     *
     * SIDE EFFECT (user-visible, accepted): routing SessionStart through
     * processEvent means handleSessionStart's syncSkillsToClaude step now runs
     * for codemie-opencode too, so running this agent creates
     * `{cwd}/.claude/skills/` in the user's project and copies CodeMie-managed
     * skills into it — the same behaviour codemie-claude has always had.
     * OpenCode does read those skills, so this is intentional rather than
     * incidental, but it means a project where the user only ever ran opencode
     * will now gain a .claude/ directory. Call this out in the release notes
     * for any version that ships this change.
     */
    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionStart',
            session_id: sessionId,
            transcript_path: '',
            permission_mode: 'default',
            cwd: process.cwd(),
            source: 'startup',
          },
          buildHookConfig(env, sessionId)
        );
        logger.info(`[opencode] SessionStart hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[opencode] SessionStart hook failed (non-blocking): ${msg}`);
      }

      // Failsafe path for metrics and conversations: everything it reads is
      // already durable in opencode.db, so deltas keep flowing even if the
      // injected plugin never loads.
      startOpenCodeIncrementalSync({
        sessionId,
        startedAt: Date.now(),
        cwd: process.cwd(),
        metadata: OpenCodePluginMetadata,
        buildContext: () => ({
          sessionId,
          apiBaseUrl: env.CODEMIE_SYNC_API_URL || env.CODEMIE_BASE_URL || '',
          cookies: '',
          clientType: env.CODEMIE_CLIENT_TYPE || OPENCODE_CLIENT_TYPE,
          version: env.CODEMIE_CLI_VERSION || '0.0.0',
          dryRun: false,
          gitBranch: env.CODEMIE_GIT_BRANCH,
        }),
        ssoUrl: env.CODEMIE_URL,
        env,
        syncApiUrl: env.CODEMIE_SYNC_API_URL || env.CODEMIE_BASE_URL,
        cliVersion: env.CODEMIE_CLI_VERSION,
      });
    },

    // NOTE: beforeRun signature is (env, config) per AgentLifecycle interface
    // Claude plugin only uses (env), but interface supports both
    async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig) {
      // Object.assign in BaseAgentAdapter must also clear a previous launch's
      // handoff, including when this launch exits early without provider config.
      env[V2_EFFORT_APPLIED_ENV] = '';
      env[V2_MODEL_REF_ENV] = '';

      // Safety net only — onSessionStart normally created the record already,
      // and ensureSessionFile early-returns when it exists.
      const sessionId = env.CODEMIE_SESSION_ID;
      if (sessionId) {
        try {
          await ensureSessionFile(sessionId, env, 'opencode');
        } catch (error) {
          logger.error('[opencode] Failed to create session file in beforeRun', { error });
          // Don't throw - let OpenCode run even if session file creation fails
        }
      }

      // Resolve before provider-config early returns: V2 server isolation is
      // needed independently of whether this launch emits a provider block.
      // Set it before DB resolution as well, so a failed path probe can use the
      // appropriate v1/v2 fallback without changing the child's XDG environment.
      const configVersion = await resolveOpenCodeConfigVersion();
      env[RESOLVED_CONFIG_VERSION_ENV] = configVersion;

      // Point the injected plugin at the transcript codemie hook must re-parse.
      // performIncrementalSync skips any event without a transcript_path.
      // Resolve even before the database exists, and honor the binary's channel
      // and OPENCODE_DB selection. A guessed default could send hooks to another
      // database or leave first-run transcript_path empty.
      const dbPath = await resolveOpenCodeDbPath(undefined, {
        command: OpenCodePluginMetadata.cliCommand,
        env,
      });
      env.CODEMIE_OPENCODE_TRANSCRIPT = dbPath === ':memory:' ? '' : dbPath;

      // Register the telemetry hook *environment* BEFORE the base-URL early returns
      // below: OPENCODE_HOOKS is the channel the injected payload reads, so
      // leaving it downstream meant any run without CODEMIE_BASE_URL had no turn
      // boundaries at all and active_duration_ms stayed 0. Only the payload
      // itself is injected after that check — it is part of the proxy config.
      env.OPENCODE_HOOKS = JSON.stringify({ hooks: buildMergedHooks(env) });

      const provider = env.CODEMIE_PROVIDER;
      const baseUrl = env.CODEMIE_BASE_URL;

      if (!baseUrl) {
        return env;
      }

      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        logger.warn(`Invalid CODEMIE_BASE_URL format: ${baseUrl}`, { agent: 'opencode' });
        return env;
      }

      // Model selection priority: env var > config > default
      const selectedModel = env.CODEMIE_MODEL || config?.model || 'gpt-5-2-2025-12-11';

      // Fetch live model catalogue from the CodeMie API.
      // Falls back to the static OPENCODE_MODEL_CONFIGS on any error.
      const allModels = await fetchDynamicModelConfigs(baseUrl, env, selectedModel);

      // Use dynamic catalogue first, then fall back to static getModelConfig for unknown IDs.
      const modelConfig = allModels[selectedModel] ?? getModelConfig(selectedModel);

      const { providerOptions } = modelConfig;

      // Split models by API routing type
      const chatModels = getChatCompletionsModelConfigs(allModels);
      const responsesApiModels = getResponsesApiModelConfigs(allModels);

      // Determine URLs based on provider type
      const isBedrock = provider === 'bedrock';
      const proxyBaseUrl = provider !== 'ollama' && !isBedrock ? baseUrl : undefined;
      const ollamaBaseUrl = provider === 'ollama'
        ? (baseUrl.endsWith('/v1') || baseUrl.includes('/v1/') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/v1`)
        : 'http://localhost:11434/v1';

      // Determine default model provider
      // - ollama: uses ollama provider directly
      // - bedrock: uses OpenCode's built-in amazon-bedrock provider (AWS env vars set by provider hook)
      // - all others: route through codemie-proxy (SSO/proxy)
      const activeProvider = provider === 'ollama' ? 'ollama' : (isBedrock ? 'amazon-bedrock' : 'codemie-proxy');
      const timeout = providerOptions?.timeout ?? parseInt(env.CODEMIE_TIMEOUT || '600') * 1000;

      // v2 dropped the v1 plugin surface (directory-only scanner, no
      // OPENCODE_HOOKS consumption, new Plugin.define API), so each schema
      // registers its own packaging: each v2 branch below materialises the
      // directory payload it registers, and the v1 single-file payload is
      // created by the v1 block that consumes it. Neither is written on a run
      // that cannot use it — v2 rejects single-file targets outright, so a v1
      // file written on a v2 run could never load, and vice versa.

      // OpenCode 2.x speaks a different config schema (`providers` + `package`
      // + `settings`). Probe result is cached; v1 path below is unchanged.
      if (proxyBaseUrl && configVersion === 'v2') {
        // Effort on v2 travels via `#variant`, not `--variant` (removed from
        // `run`): declare body-overlay variants on reasoning-capable models
        // and suffix the selected model reference when effort is requested.
        // Available variants are independent of the initial selection: the TUI
        // needs them even without startup effort. Large catalogues use the
        // existing temp-file fallback rather than dropping model metadata.
        const effortLevel = resolveV2EffortLevel(env);
        const v2Models: Record<string, unknown> = {};
        for (const [id, mc] of Object.entries(chatModels)) {
          v2Models[id] = {
            name: mc.name ?? id,
            capabilities: {
              tools: mc.tool_call,
              input: mc.modalities.input,
              output: mc.modalities.output,
            },
            ...(mc.limit && { limit: mc.limit }),
            ...(mc.cost && {
              cost: {
                input: mc.cost.input,
                output: mc.cost.output,
                ...(mc.cost.cache_read !== undefined && { cache: { read: mc.cost.cache_read } }),
              },
            }),
            ...(mc.reasoning && { variants: buildV2EffortVariants('chat') }),
          };
        }
        for (const [id, mc] of Object.entries(responsesApiModels)) {
          v2Models[id] = {
            name: mc.name ?? id,
            capabilities: {
              tools: mc.tool_call,
              input: mc.modalities.input,
              output: mc.modalities.output,
            },
            ...(mc.limit && { limit: mc.limit }),
            ...(mc.cost && {
              cost: {
                input: mc.cost.input,
                output: mc.cost.output,
                ...(mc.cost.cache_read !== undefined && { cache: { read: mc.cost.cache_read } }),
              },
            }),
            ...(mc.reasoning && { variants: buildV2EffortVariants('responses') }),
            package: V2_RESPONSES_PACKAGE,
          };
        }
        // A missing config default falls back to another model in the same
        // provider on v2; the provider allowlist cannot prevent that. Reject
        // missing CLI/env selections AND profile defaults before spawning the
        // agent, without inventing a catalogue entry from getModelConfig().
        if (!Object.hasOwn(v2Models, selectedModel)) {
          // SessionStart already started this timer. Do not run transcript
          // discovery on rejection: this launch has no OpenCode session yet.
          if (sessionId) stopOpenCodeIncrementalSync(sessionId);
          throw new ConfigurationError(formatMissingV2ModelError(selectedModel, env, config));
        }

        let v2ModelRef = `codemie-proxy/${modelConfig.id}`;
        if (effortLevel) {
          if (modelConfig.reasoning) {
            v2ModelRef += `#${effortLevel}`;
            env[V2_EFFORT_APPLIED_ENV] = '1';
            // enrichArgs (below) picks this up to pass `-m <ref>` on the argv —
            // the channel `run` actually resolves the variant through.
            env[V2_MODEL_REF_ENV] = v2ModelRef;
          } else {
            // Console warning intentionally omitted here: the shouldApply gate
            // below delivers the single user-facing warning for every
            // not-honored case. This log line keeps the specific reason.
            logger.warn(`[opencode] --reasoning-effort '${effortLevel}' is set but model '${modelConfig.id}' is not reasoning-capable; continuing without effort`);
          }
        }
        return injectV2Config(env, {
          $schema: 'https://opencode.ai/config.json',
          share: 'disabled',
          // Keep unrelated providers out of the picker. Same-provider fallback
          // for a missing selected model is prevented by the guard above.
          enabled_providers: ['codemie-proxy'],
          model: v2ModelRef,
          providers: {
            'codemie-proxy': {
              name: 'CodeMie SSO',
              package: V2_CHAT_PACKAGE,
              settings: {
                baseURL: `${proxyBaseUrl}/`,
                apiKey: 'proxy-handled',
                timeout,
              },
              ...(providerOptions?.headers && { headers: providerOptions.headers }),
              models: v2Models,
            },
          },
          plugins: [getHooksV2PluginDirUrl()],
        }, 'opencode-v2');
      }

      // Ollama is a direct (non-proxy) provider with the same endpoint shape as
      // the proxy — address + openai-compatible runtime — so it gets a native v2
      // block too.
      //
      // No models map, and not because "the endpoint serves its own inventory":
      // v2 ships no `ollama` provider in packages/ai/src/providers/, and the
      // openai-compatible package exposes only configure / model / routes — it
      // cannot list anything. Inventory comes from the bundled discovery plugin
      // (packages/core/src/plugin/provider/ollama.ts): it reads the baseURL
      // declared below, strips a /v1 or /api suffix, enumerates /api/tags,
      // enriches each entry via /api/show, and keeps only models whose
      // capabilities include "completion" (1s timeout per request). Its provider
      // transform is a no-op at zero models (local.ts:61-62), so an unreachable
      // endpoint leaves the provider model-less — which is exactly why the
      // allowlist below matters here: it turns that into an explicit "no model
      // is available" error rather than a silent switch to another provider.
      if (provider === 'ollama' && configVersion === 'v2') {
        return injectV2Config(env, {
          $schema: 'https://opencode.ai/config.json',
          share: 'disabled',
          enabled_providers: ['ollama'],
          model: `ollama/${modelConfig.id}`,
          providers: {
            ollama: {
              name: 'Ollama',
              package: V2_CHAT_PACKAGE,
              settings: {
                baseURL: `${ollamaBaseUrl}/`,
                apiKey: 'ollama',
                timeout,
              },
            },
          },
          plugins: [getHooksV2PluginDirUrl()],
        }, 'opencode-v2-ollama');
      }

      // Bedrock is the remaining non-proxy provider, and unlike Ollama it has a
      // real v2 provider package: `amazon-bedrock` is registered in the built-in
      // registry (packages/core/src/provider.ts) and its settings accept region,
      // credentials, profile and apiKey
      // (packages/ai/src/providers/amazon-bedrock.ts:8-35).
      //
      // Only the region is declared: it resolves through the AWS environment when
      // omitted, and credentials fall back to the AWS default chain, so the
      // environment the Bedrock provider plugin already sets keeps working. The
      // selected model is emitted explicitly so `model:` resolves without
      // depending on a bundled catalogue.
      if (provider === 'bedrock' && configVersion === 'v2') {
        const bedrockRegion = env.AWS_REGION || env.CODEMIE_AWS_REGION;
        const bedrockModelId = toBedrockModelId(modelConfig.id, bedrockRegion);

        // Effort travels exactly as on the proxy branch: body-overlay variants on
        // the model plus a `#level` suffix on the reference, because `run` resolves
        // the variant only from the CLI `--model` reference (enrichArgs passes `-m`).
        //
        // The gate is Claude detection, not `modelConfig.reasoning`: CodeMie's
        // catalogue carries no Bedrock rows, so `getModelConfig()` misses the
        // `claude` family prefix (a Bedrock id starts with `us.anthropic.`) and
        // reports reasoning: false for every Bedrock model.
        const effortLevel = resolveV2EffortLevel(env);
        const claudeInfo = parseBedrockClaudeInfo(bedrockModelId);
        const bedrockEffort = effortLevel && claudeInfo && supportsBedrockClaudeThinking(claudeInfo)
          ? effortLevel
          : undefined;
        if (bedrockEffort) {
          env[V2_EFFORT_APPLIED_ENV] = '1';
          env[V2_MODEL_REF_ENV] = `amazon-bedrock/${bedrockModelId}#${bedrockEffort}`;
        } else if (effortLevel) {
          // Console warning intentionally omitted: the shouldApply gate below
          // delivers the single user-facing warning for every not-honored case.
          logger.warn(`[opencode] --reasoning-effort '${effortLevel}' is set but Bedrock model '${bedrockModelId}' is not a Claude generation with extended thinking; continuing without effort`);
        }
        const bedrockModelRef = bedrockEffort
          ? `amazon-bedrock/${bedrockModelId}#${bedrockEffort}`
          : `amazon-bedrock/${bedrockModelId}`;

        // CodeMie's catalogue has no Bedrock rows, so `getModelConfig()` falls back
        // to the generic { context: 128000, output: 4096 }. Claude's real limits are
        // resolved per generation instead (see resolveBedrockClaudeLimits) — which
        // is also what keeps the thinking budget above fitThinkingBudget's
        // half-of-maxTokens clamp.
        const bedrockLimit = claudeInfo
          ? resolveBedrockClaudeLimits(claudeInfo)
          : modelConfig.limit;

        return injectV2Config(env, {
          $schema: 'https://opencode.ai/config.json',
          share: 'disabled',
          enabled_providers: ['amazon-bedrock'],
          model: bedrockModelRef,
          providers: {
            'amazon-bedrock': {
              name: 'Amazon Bedrock',
              package: '@opencode/ai/providers/amazon-bedrock',
              settings: {
                ...(bedrockRegion && { region: bedrockRegion }),
                timeout,
              },
              models: {
                [bedrockModelId]: {
                  name: modelConfig.name ?? bedrockModelId,
                  ...(bedrockLimit && { limit: bedrockLimit }),
                  ...(bedrockEffort && claudeInfo && { variants: buildV2BedrockEffortVariants(claudeInfo) }),
                },
              },
            },
          },
          plugins: [getHooksV2PluginDirUrl()],
        }, 'opencode-v2-bedrock');
      }

      // Always enable openai CUSTOM_LOADER when Responses API models exist.
      // This fixes model-switching: if user starts with Claude and switches to GPT,
      // the CUSTOM_LOADER must already be registered.
      if (proxyBaseUrl && Object.keys(responsesApiModels).length > 0) {
        env.OPENAI_API_KEY = 'proxy-handled';
        logger.debug('[opencode] Enabling openai CUSTOM_LOADER for Responses API models');
      }

      const hasResponsesApiModels = Object.keys(responsesApiModels).length > 0;
      const openCodeConfig: Record<string, unknown> = {
        enabled_providers: ['codemie-proxy', 'openai', 'ollama', 'amazon-bedrock'],
        share: 'disabled',
        provider: {
          ...(proxyBaseUrl && {
            'codemie-proxy': {
              npm: '@ai-sdk/openai-compatible',
              name: 'CodeMie SSO',
              options: {
                baseURL: `${proxyBaseUrl}/`,
                apiKey: 'proxy-handled',
                timeout,
                ...(providerOptions?.headers && { headers: providerOptions.headers })
              },
              models: chatModels
            }
          }),
          // Built-in openai CUSTOM_LOADER: routes Responses API models via sdk.responses()
          ...(proxyBaseUrl && hasResponsesApiModels && {
            openai: {
              // OpenCode orders provider groups by name; a distinct, longer name keeps this group below
              // the 'CodeMie SSO' group that holds the routers (equal names left the order arbitrary).
              name: 'CodeMie SSO (Responses API)',
              // whitelist: suppress the built-in openai model list (GPT-4, GPT-4o, etc.)
              // OpenCode merges user models with models.dev — whitelist restricts to ours only
              whitelist: Object.keys(responsesApiModels),
              options: {
                baseURL: `${proxyBaseUrl}/`,
                apiKey: 'proxy-handled',
                timeout,
                ...(providerOptions?.headers && { headers: providerOptions.headers })
              },
              models: responsesApiModels
            }
          }),
          ollama: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Ollama',
            options: {
              baseURL: `${ollamaBaseUrl}/`,
              apiKey: 'ollama',
              timeout,
            }
          }
        },
        model: `${activeProvider}/${isBedrock ? toBedrockModelId(modelConfig.id, env.AWS_REGION || env.CODEMIE_AWS_REGION) : modelConfig.id}`
      };

      openCodeConfig.plugin = (openCodeConfig.plugin as string[] | undefined) || [];
      const pluginUrl = getHooksPluginFileUrl();
      (openCodeConfig.plugin as string[]).push(pluginUrl);
      logger.debug(`[opencode] Injected hooks plugin: ${pluginUrl}`);

      env.OPENCODE_DISABLE_SHARE = 'true';
      const configJson = JSON.stringify(openCodeConfig);

      // Config injection strategy:
      // 1. Primary: OPENCODE_CONFIG_CONTENT env var (inline JSON)
      // 2. Fallback: OPENCODE_CONFIG env var pointing to temp file
      // See tech spec ADR-002 and "Fallback Strategy" section
      if (configJson.length > MAX_ENV_SIZE) {
        logger.warn(`Config size (${configJson.length} bytes) exceeds env var limit (${MAX_ENV_SIZE}), using temp file fallback`, {
          agent: 'opencode'
        });

        const configPath = writeConfigToTempFile(configJson, 'opencode');
        logger.debug(`[opencode] Wrote config to temp file: ${configPath}`);

        // OPENCODE_CONFIG is verified in OpenCode source: src/flag/flag.ts
        env.OPENCODE_CONFIG = configPath;
        return env;
      }

      // Primary path: inject config inline via OPENCODE_CONFIG_CONTENT
      // Verified in OpenCode source: src/config/config.ts:93-96
      env.OPENCODE_CONFIG_CONTENT = configJson;
      return env;
    },

    enrichArgs: (args: string[], _config: AgentConfig) => {
      /**
       * Force an isolated server for this run.
       *
       * CodeMie delivers its provider configuration through
       * `OPENCODE_CONFIG_CONTENT`, which OpenCode 2.x reads only when it starts
       * the server itself (`packages/cli/src/server-process.ts`, the `config.content`
       * field). Without this flag the CLI attaches to the shared managed service,
       * and a server left running by a plain `opencode` launch keeps its own
       * provider catalogue — the run then silently serves models that no profile
       * ever configured while every CodeMie check reports green.
       *
       * `--standalone` spawns a per-run server with the inherited environment
       * (`Standalone.start()` passes `extendEnv: true`), so the injection
       * applies without terminating anyone's session; the server is torn down
       * with the client through its stdin ownership lease.
       *
       * Two cases are left alone: an explicit `--standalone` (never duplicated)
       * and an explicit `--server <url>` — v2 rejects that combination outright
       * ("--server and --standalone cannot be combined",
       * `services/server-connection.ts`), so adding it there would break the run.
       */
      const withStandaloneServer = (mapped: string[]): string[] => {
        // beforeRun's environment is merged into process.env by BaseAgentAdapter.
        // V1 (including version-probe fallback) has no --standalone flag.
        if (process.env[RESOLVED_CONFIG_VERSION_ENV] !== 'v2') return mapped;

        const separatorIndex = mapped.indexOf('--');
        const cliArgs = separatorIndex === -1 ? mapped : mapped.slice(0, separatorIndex);
        const targetsExplicitServer = cliArgs.some(
          (arg) => arg === '--server' || arg.startsWith('--server='),
        );
        if (cliArgs.some((arg) => arg === '--standalone' || arg.startsWith('--standalone=')) || targetsExplicitServer) return mapped;

        let commandIndex = 0;
        while (commandIndex < cliArgs.length) {
          const argument = cliArgs[commandIndex];
          if (V2_ROOT_VALUE_FLAGS.has(argument)) {
            commandIndex += 2;
            continue;
          }
          if (!argument.startsWith('-')) break;
          commandIndex++;
        }

        const isCommand = commandIndex < cliArgs.length;
        // After --, a directory named like a subcommand is still a root argument.
        const argument = isCommand ? cliArgs[commandIndex] : separatorIndex === -1 ? undefined : mapped[separatorIndex + 1];
        const nestedCommands = argument !== undefined ? V2_STANDALONE_GROUPS.get(argument) : undefined;
        const nestedCommand = nestedCommands ? cliArgs.slice(commandIndex + 1).find((arg) => !arg.startsWith('-')) : undefined;
        const supportsStandalone = isCommand && argument !== undefined && V2_STANDALONE_SUBCOMMANDS.has(argument) &&
          (nestedCommands === undefined || (nestedCommand !== undefined && nestedCommands.has(nestedCommand)));
        if (supportsStandalone && argument === 'run') {
          return [...mapped.slice(0, commandIndex + 1), '--standalone', ...mapped.slice(commandIndex + 1)];
        }
        if (!supportsStandalone) {
          if (isCommand && argument !== undefined &&
            (V2_PASSTHROUGH_SUBCOMMANDS.has(argument) || V2_STANDALONE_SUBCOMMANDS.has(argument))) return mapped;
          if (argument !== undefined && !isDirectoryArgument(argument)) return mapped;
        }
        // Insert before -- so the flag cannot become prompt or directory data.
        return separatorIndex === -1
          ? [...mapped, '--standalone']
          : [...mapped.slice(0, separatorIndex), '--standalone', ...mapped.slice(separatorIndex)];
      };

      const withEffortModel = (mapped: string[]): string[] => {
        // beforeRun stashes the honored `provider/model#variant` reference in
        // the environment (merged into process.env before enrichArgs runs, see
        // BaseAgentAdapter). `run` resolves the variant — and therefore the body
        // overlays — only from the CLI reference, so pass it as `-m`, but solely
        // on the `run` path: other subcommands (and the bare TUI invocation)
        // accept no such flag, and an explicit user `-m`/`--model` always wins.
        const ref = process.env[V2_MODEL_REF_ENV];
        if (
          !ref || mapped[0] !== 'run' ||
          mapped.some((arg) => arg === '-m' || arg === '--model' || arg.startsWith('--model='))
        ) {
          return mapped;
        }
        return [...mapped, '-m', ref];
      };

      if (args.length > 0 && OPENCODE_SUBCOMMANDS.includes(args[0])) {
        return withEffortModel(withStandaloneServer(args));
      }

      const taskIndex = args.indexOf('--task');
      if (taskIndex !== -1 && taskIndex < args.length - 1) {
        const taskValue = args[taskIndex + 1];
        const otherArgs = args.filter((arg, i, arr) => {
          if (i === taskIndex || i === taskIndex + 1) return false;
          if (arg === '-m' || arg === '--message') return false;
          if (i > 0 && (arr[i - 1] === '-m' || arr[i - 1] === '--message')) return false;
          return true;
        });
        // Message is a positional arg: `opencode run <message>`
        // Note: -m in upstream opencode-ai means --model, NOT --message.
        return withEffortModel(withStandaloneServer(['run', taskValue, ...otherArgs]));
      }
      // Bare TUI invocation: no subcommand, so the flag goes at the end.
      return withStandaloneServer(args);
    },

    /**
     * Close out the session: flush remaining deltas and conversations, upload
     * them, emit the `completed` codemie_cli_session_total row, and archive the
     * spool files.
     *
     * Routed through processEvent rather than calling the adapter directly, so
     * the full SessionEnd pipeline runs in the right order:
     *   accumulateActiveDuration → incremental sync → SessionSyncer upload →
     *   session-end metrics → status update → rename to completed_*
     *
     * The previous implementation only wrote JSONL, with an empty cookie jar
     * and no SessionSyncer call, and relied on the proxy's shutdown timer to
     * upload whatever happened to be on disk.
     */
    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;

      if (!sessionId) {
        logger.debug('[opencode] No CODEMIE_SESSION_ID in environment, skipping session end');
        return;
      }

      stopOpenCodeIncrementalSync(sessionId);

      try {
        // Discover the transcript to re-parse. Constrained to this working
        // directory: the CLI reads the user's shared opencode.db, which holds
        // sessions from every project they have open.
        let transcriptPath = '';
        let sourceSessionId: string | undefined;
        try {
          const adapter = new OpenCodeSessionAdapter(OpenCodePluginMetadata, { env });
          const sessions = await adapter.discoverSessions({
            maxAgeDays: 1,
            limit: 1,
            cwd: process.cwd(),
          });
          if (sessions.length > 0) {
            transcriptPath = sessions[0].filePath;
            sourceSessionId = sessions[0].sessionId;
            logger.debug(`[opencode] Discovered OpenCode session: ${sessions[0].sessionId}`);
          } else {
            logger.debug('[opencode] No recent OpenCode sessions found for this directory');
          }
        } catch (discoverError) {
          const msg = discoverError instanceof Error ? discoverError.message : String(discoverError);
          logger.debug(`[opencode] Session discovery failed (non-blocking): ${msg}`);
        }

        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionEnd',
            session_id: sessionId,
            transcript_path: transcriptPath,
            permission_mode: 'default',
            cwd: process.cwd(),
            reason: exitCode === 0 ? 'exit' : `exit(${exitCode})`,
          },
          { ...buildHookConfig(env, sessionId), sourceSessionId }
        );
        logger.info(`[opencode] SessionEnd hook completed for session ${sessionId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[opencode] SessionEnd hook failed (non-blocking): ${errorMessage}`);
        // Don't throw - metrics failure shouldn't block exit
      } finally {
        // Both payloads may have been written: the v2 directory on every run,
        // the v1 single file only when the v1 shape was emitted.
        cleanupHooksPlugin();
        cleanupHooksV2Plugin();
      }
    }
  }
};

/**
 * OpenCode agent plugin
 * Phase 1: Core plugin with CLI wrapping and SSO proxy support
 * Phase 2: Session analytics integration
 */
export class OpenCodePlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(OpenCodePluginMetadata);
    // Initialize session adapter with metadata for unified session sync
    this.sessionAdapter = new OpenCodeSessionAdapter(OpenCodePluginMetadata);
  }

  /**
   * Check if OpenCode is installed
   * Overridden to provide custom install instructions (AC-1.2)
   *
   * NOTE (GPT-5.5 review): This method should be SIDE-EFFECT FREE.
   * Install instructions are displayed via logger (file-only in non-debug mode)
   * so they appear in logs but don't pollute stdout during programmatic checks
   * like `codemie doctor`. The CLI layer (AgentCLI) handles user-facing output.
   */
  async isInstalled(): Promise<boolean> {
    // Use metadata.cliCommand which respects CODEMIE_OPENCODE_BIN
    const cliCommand = this.metadata.cliCommand;
    if (!cliCommand) return false;

    const installed = await commandExists(cliCommand);

    if (!installed) {
      // Log install guidance to debug log (file-only unless CODEMIE_DEBUG=true)
      // Actual user-facing message is handled by AgentCLI layer
      logger.debug('[opencode-plugin] OpenCode not installed. Install with:');
      logger.debug('[opencode-plugin]   codemie install opencode');
      logger.debug('[opencode-plugin]   Or directly: npm i -g opencode-ai');
    }

    return installed;
  }

  /**
   * Return session adapter for analytics
   * Phase 2: Returns OpenCodeSessionAdapter instance
   */
  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  /**
   * No extension installer - OpenCode installed manually
   * Returns undefined (interface allows optional return)
   */
  getExtensionInstaller(): BaseExtensionInstaller | undefined {
    return undefined;
  }
}
