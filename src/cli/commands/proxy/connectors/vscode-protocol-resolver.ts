import type {
  VsCodeModelDescriptor,
  VsCodeProtocolMetadata,
  VsCodeProtocolType,
  VsCodeReasoningEffort,
} from './vscode-model-catalog.js';

export type { VsCodeProtocolType } from './vscode-model-catalog.js';

export interface VsCodeProtocolDefaults {
  apiPath: '/v1/chat/completions' | '/v1/responses' | '/v1/messages';
  zeroDataRetentionEnabled?: boolean;
  thinking?: boolean;
  adaptiveThinking?: true;
  modelOptions?: Readonly<{
    temperature?: null;
    top_p?: null;
  }>;
  requestHeaders?: Readonly<Record<string, string>>;
  supportsReasoningEffort?: readonly VsCodeReasoningEffort[];
  reasoningEffortFormat?: 'chat-completions' | 'responses';
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ProtocolResolution {
  type: VsCodeProtocolType;
  source: 'backend' | 'compatibility-rule' | 'provider-default';
  defaults: VsCodeProtocolDefaults;
}

export interface UnclassifiedProtocolResolution {
  type: 'unclassified';
  reason: string;
}

export interface ResolvedVsCodeModel {
  descriptor: VsCodeModelDescriptor;
  protocol: ProtocolResolution;
}

export interface UnclassifiedVsCodeModel {
  descriptor: VsCodeModelDescriptor;
  protocol: UnclassifiedProtocolResolution;
}

export interface ResolvedVsCodeCatalog {
  models: ResolvedVsCodeModel[];
  unclassified: UnclassifiedVsCodeModel[];
}

const MESSAGE_AUTH_HEADERS = {
  Authorization: 'Bearer ${apiKey}',
} as const;
const GPT_5_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
const GPT_5_2_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
const GPT_5_XHIGH_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
const GPT_5_6_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const GEMINI_FLASH_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
const GEMINI_PRO_EFFORTS = ['low', 'medium', 'high'] as const;
const CLAUDE_EFFORTS = ['low', 'medium', 'high'] as const;
const CLAUDE_MAX_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
const CLAUDE_XHIGH_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface ClaudeVersion {
  family: 'sonnet' | 'opus' | 'haiku';
  major: number;
  minor: number;
}

function buildDefaults(
  type: VsCodeProtocolType,
  model: VsCodeModelDescriptor,
  metadata?: VsCodeProtocolMetadata
): VsCodeProtocolDefaults {
  const compatibility = getCompatibilityCapabilities(model, type);
  const reasoningEfforts = metadata?.reasoning_efforts ??
    compatibility.supportsReasoningEffort;
  const reasoningEffortFormat = metadata?.reasoning_effort_format ??
    compatibility.reasoningEffortFormat;
  const adaptiveThinking = metadata?.adaptive_thinking ??
    compatibility.adaptiveThinking;
  const thinking = compatibility.thinking ?? (
    adaptiveThinking === true || Boolean(reasoningEfforts?.length)
  );
  const modelOptions = getClaudeVersion(modelSearchText(model))
    ? { modelOptions: { top_p: null } as const }
    : {};
  const capabilities = {
    ...modelOptions,
    thinking,
    ...(compatibility.maxInputTokens !== undefined && {
      maxInputTokens: compatibility.maxInputTokens,
    }),
    ...(compatibility.maxOutputTokens !== undefined && {
      maxOutputTokens: compatibility.maxOutputTokens,
    }),
    ...(adaptiveThinking === true && { adaptiveThinking: true as const }),
    ...(reasoningEfforts && reasoningEfforts.length > 0 && {
      supportsReasoningEffort: reasoningEfforts,
    }),
    ...(reasoningEffortFormat && {
      reasoningEffortFormat,
    }),
  };

  if (type === 'responses') {
    return {
      apiPath: '/v1/responses',
      zeroDataRetentionEnabled: metadata?.zero_data_retention ?? true,
      ...capabilities,
    };
  }
  if (type === 'messages') {
    return {
      apiPath: '/v1/messages',
      requestHeaders: MESSAGE_AUTH_HEADERS,
      ...capabilities,
    };
  }
  return { apiPath: '/v1/chat/completions', ...capabilities };
}

function modelSearchText(model: VsCodeModelDescriptor): string {
  return [model.requestId, model.deploymentName, model.baseName]
    .join(' ')
    .toLowerCase();
}

function getGptFiveMinorVersion(text: string): number | undefined {
  const match = text.match(/(?:^|\s)gpt[-.]?5[.-](\d{1,2})(?=[.-]|\s|$)/i);
  return match ? Number(match[1]) : undefined;
}

function getClaudeVersion(text: string): ClaudeVersion | undefined {
  const familyFirst = text.match(
    /(?:^|\s)claude-(sonnet|opus|haiku)[.-](\d+)(?:[.-](\d+))?/i
  );
  if (familyFirst) {
    return {
      family: familyFirst[1].toLowerCase() as ClaudeVersion['family'],
      major: Number(familyFirst[2]),
      minor: Number(familyFirst[3] ?? 0),
    };
  }

  const versionFirst = text.match(
    /(?:^|\s)claude-(\d+)[.-](\d+)[.-](sonnet|opus|haiku)/i
  );
  if (!versionFirst) return undefined;
  return {
    family: versionFirst[3].toLowerCase() as ClaudeVersion['family'],
    major: Number(versionFirst[1]),
    minor: Number(versionFirst[2]),
  };
}

function isAtLeast(version: ClaudeVersion, major: number, minor: number): boolean {
  return version.major > major || (version.major === major && version.minor >= minor);
}

function getCompatibilityCapabilities(
  model: VsCodeModelDescriptor,
  type: VsCodeProtocolType
): Pick<
  VsCodeProtocolDefaults,
  | 'thinking'
  | 'adaptiveThinking'
  | 'supportsReasoningEffort'
  | 'reasoningEffortFormat'
  | 'maxInputTokens'
  | 'maxOutputTokens'
> {
  const text = modelSearchText(model);
  if (/(?:^|\s)gpt[-.]?5(?:[.-][^\s]+)*[.-]codex(?:[.-]|\s|$)/i.test(text)) {
    return {};
  }

  const gptFiveMinor = getGptFiveMinorVersion(text);
  if (/(?:^|\s)gpt[-.]?5(?:[.-]|\s|$)/i.test(text)) {
    const supportsReasoningEffort = gptFiveMinor === 2
      ? GPT_5_2_EFFORTS
      : gptFiveMinor === 4 || gptFiveMinor === 5
        ? GPT_5_XHIGH_EFFORTS
        : gptFiveMinor === 6
          ? GPT_5_6_EFFORTS
          : GPT_5_EFFORTS;
    return {
      thinking: true,
      supportsReasoningEffort,
      reasoningEffortFormat: type === 'responses' ? 'responses' : 'chat-completions',
      maxInputTokens: gptFiveMinor !== undefined && gptFiveMinor >= 4 ? 922000 : 272000,
      maxOutputTokens: 128000,
    };
  }

  if (/(?:^|\s)gpt-4\.1(?:[.-]|\s|$)/i.test(text)) {
    return { maxInputTokens: 1014808, maxOutputTokens: 32768 };
  }

  if (/(?:^|\s)gemini-3(?:\.5)?-flash(?:[.-]|\s|$)/i.test(text)) {
    return {
      thinking: true,
      supportsReasoningEffort: GEMINI_FLASH_EFFORTS,
      reasoningEffortFormat: 'chat-completions',
      maxInputTokens: 983040,
      maxOutputTokens: 65536,
    };
  }
  if (/(?:^|\s)gemini-3\.1-pro(?:[.-]|\s|$)/i.test(text)) {
    return {
      thinking: true,
      supportsReasoningEffort: GEMINI_PRO_EFFORTS,
      reasoningEffortFormat: 'chat-completions',
      maxInputTokens: 983040,
      maxOutputTokens: 65536,
    };
  }

  const claudeVersion = getClaudeVersion(text);
  if (!claudeVersion) {
    if (/(?:^|\s)qwen\.qwen3-coder-30b-/i.test(text)) {
      return { maxInputTokens: 245760, maxOutputTokens: 16384 };
    }
    if (/(?:^|\s)qwen\.qwen3-coder-480b-/i.test(text)) {
      return { maxInputTokens: 114688, maxOutputTokens: 16384 };
    }
    if (/(?:^|\s)moonshotai\.kimi-k2\.5(?:\s|$)/i.test(text)) {
      return { maxInputTokens: 245760, maxOutputTokens: 16384 };
    }
    return {};
  }
  if (type !== 'messages') {
    return { maxInputTokens: 136000, maxOutputTokens: 64000 };
  }
  if (claudeVersion.family === 'sonnet') {
    return {
      thinking: true,
      adaptiveThinking: true,
      supportsReasoningEffort: isAtLeast(claudeVersion, 5, 0)
        ? CLAUDE_XHIGH_EFFORTS
        : CLAUDE_MAX_EFFORTS,
      maxInputTokens: isAtLeast(claudeVersion, 5, 0) ? 872000 : 936000,
      maxOutputTokens: isAtLeast(claudeVersion, 5, 0) ? 128000 : 64000,
    };
  }
  if (claudeVersion.family === 'opus') {
    if (!isAtLeast(claudeVersion, 4, 6)) {
      return {
        thinking: false,
        supportsReasoningEffort: CLAUDE_EFFORTS,
        maxInputTokens: 136000,
        maxOutputTokens: 64000,
      };
    }
    return {
      thinking: true,
      adaptiveThinking: true,
      supportsReasoningEffort: isAtLeast(claudeVersion, 4, 7)
        ? CLAUDE_XHIGH_EFFORTS
        : CLAUDE_MAX_EFFORTS,
      maxInputTokens: 872000,
      maxOutputTokens: 128000,
    };
  }
  return { maxInputTokens: 136000, maxOutputTokens: 64000 };
}

function resolveCompatibilityRule(model: VsCodeModelDescriptor): VsCodeProtocolType | undefined {
  const text = modelSearchText(model);
  const gptFiveMinor = getGptFiveMinorVersion(text);
  if (/(?:^|\s)gpt[-.]?5(?:[.-][^\s]+)*[.-]codex(?:[.-]|\s|$)/i.test(text)) {
    return 'responses';
  }
  if (gptFiveMinor !== undefined && gptFiveMinor >= 5) return 'responses';

  const claudeVersion = getClaudeVersion(text);
  if (claudeVersion?.family === 'opus' && isAtLeast(claudeVersion, 4, 5)) return 'messages';
  if (claudeVersion?.family === 'sonnet' && isAtLeast(claudeVersion, 4, 6)) return 'messages';

  if (/(?:^|\s)gpt[-.]?4(?:[.-]|\s|$)/i.test(text)) return 'chat-completions';
  if (/(?:^|\s)gpt[-.]?5(?:[.-]|\s|$)/i.test(text) &&
      (gptFiveMinor === undefined || gptFiveMinor <= 4)) {
    return 'chat-completions';
  }
  if (/(?:^|\s)(?:gemini|qwen|moonshotai|kimi)[.-]/i.test(text)) {
    return 'chat-completions';
  }
  if (/(?:^|\s)o(?:1|3|4)(?:[.-]|\s|$)/i.test(text)) {
    return 'chat-completions';
  }
  if (claudeVersion?.family === 'haiku' && !isAtLeast(claudeVersion, 4, 6)) {
    return 'chat-completions';
  }
  if (claudeVersion?.family === 'sonnet' && !isAtLeast(claudeVersion, 4, 6)) {
    return 'chat-completions';
  }
  if (claudeVersion?.family === 'opus' && !isAtLeast(claudeVersion, 4, 5)) {
    return 'chat-completions';
  }
  return undefined;
}

/** Resolve a model route without using a global unknown-model fallback. */
export function resolveVsCodeProtocol(
  model: VsCodeModelDescriptor
): ProtocolResolution | UnclassifiedProtocolResolution {
  if (model.protocol) {
    return {
      type: model.protocol.type,
      source: 'backend',
      defaults: buildDefaults(model.protocol.type, model, model.protocol),
    };
  }

  if (model.protocolMetadataPresent) {
    return {
      type: 'unclassified',
      reason: 'backend protocol metadata is invalid or unsupported',
    };
  }

  const type = resolveCompatibilityRule(model);
  if (!type) {
    return {
      type: 'unclassified',
      reason: 'no backend protocol metadata or compatible model-family rule',
    };
  }

  return {
    type,
    source: 'compatibility-rule',
    defaults: buildDefaults(type, model),
  };
}

/** Split an enabled backend catalog into safe VS Code entries and omissions. */
export function resolveVsCodeModelCatalog(
  models: readonly VsCodeModelDescriptor[]
): ResolvedVsCodeCatalog {
  const resolved: ResolvedVsCodeModel[] = [];
  const unclassified: UnclassifiedVsCodeModel[] = [];

  for (const descriptor of models) {
    const protocol = resolveVsCodeProtocol(descriptor);
    if (protocol.type === 'unclassified') {
      unclassified.push({ descriptor, protocol });
    } else {
      resolved.push({ descriptor, protocol });
    }
  }

  return { models: resolved, unclassified };
}
