import { resolveTenantModelId } from './model-name-resolver.js';
import type { TenantModelDescriptor } from './tenant-catalog.js';

export type VsCodeApiType = 'chat-completions' | 'responses' | 'messages';

export type VsCodeReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface VsCodeCapabilityEntry {
  family: string;
  apiType: VsCodeApiType;
  vision: boolean;
  thinking: boolean;
  /** Absent means the model supports tool calling. */
  toolCalling?: boolean;
  zeroDataRetentionEnabled?: boolean;
  adaptiveThinking?: true;
  modelOptions?: Readonly<{
    temperature?: number | null;
    top_p?: number | null;
  }>;
  requestHeaders?: Readonly<Record<string, string>>;
  supportsReasoningEffort?: readonly VsCodeReasoningEffort[];
  reasoningEffortFormat?: 'chat-completions' | 'responses';
  maxInputTokens: number;
  maxOutputTokens: number;
}

const GPT_5_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
const GPT_5_2_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
const GPT_5_XHIGH_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
const GPT_5_6_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const GEMINI_FLASH_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
const GEMINI_PRO_EFFORTS = ['low', 'medium', 'high'] as const;
const CLAUDE_EFFORTS = ['low', 'medium', 'high'] as const;
const CLAUDE_MAX_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
const CLAUDE_XHIGH_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const MESSAGE_AUTH_HEADERS = {
  Authorization: 'Bearer ${apiKey}',
} as const;

export const VS_CODE_CAPABILITY_TABLE: readonly VsCodeCapabilityEntry[] = [
  {
    family: 'claude-sonnet-4-5',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    modelOptions: { top_p: null },
    maxInputTokens: 136000,
    maxOutputTokens: 64000,
  },
  {
    family: 'gpt-4.1',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    maxInputTokens: 1014808,
    maxOutputTokens: 32768,
  },
  {
    family: 'gpt-4.1-mini',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    maxInputTokens: 1014808,
    maxOutputTokens: 32768,
  },
  {
    family: 'gpt-5',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GPT_5_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    family: 'gpt-5-mini',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GPT_5_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    family: 'gpt-5-nano',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GPT_5_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    family: 'gpt-5-2',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GPT_5_2_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    family: 'gpt-5.4',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GPT_5_XHIGH_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 922000,
    maxOutputTokens: 128000,
  },
  // VS Code's zero-data-retention Responses mode replays the complete local
  // conversation with store=false and without previous_response_id. The proxy
  // strips deployment-bound encrypted reasoning state while preserving the
  // selected effort and visible/tool history for load-balanced continuations.
  {
    family: 'gpt-5.5',
    apiType: 'responses',
    vision: true,
    thinking: true,
    zeroDataRetentionEnabled: true,
    supportsReasoningEffort: GPT_5_XHIGH_EFFORTS,
    reasoningEffortFormat: 'responses',
    maxInputTokens: 922000,
    maxOutputTokens: 128000,
  },
  {
    family: 'gpt-5.6-luna',
    apiType: 'responses',
    vision: true,
    thinking: true,
    zeroDataRetentionEnabled: true,
    supportsReasoningEffort: GPT_5_6_EFFORTS,
    reasoningEffortFormat: 'responses',
    maxInputTokens: 922000,
    maxOutputTokens: 128000,
  },
  {
    family: 'gpt-5.6-sol',
    apiType: 'responses',
    vision: true,
    thinking: true,
    zeroDataRetentionEnabled: true,
    supportsReasoningEffort: GPT_5_6_EFFORTS,
    reasoningEffortFormat: 'responses',
    maxInputTokens: 922000,
    maxOutputTokens: 128000,
  },
  {
    family: 'gpt-5.6-terra',
    apiType: 'responses',
    vision: true,
    thinking: true,
    zeroDataRetentionEnabled: true,
    supportsReasoningEffort: GPT_5_6_EFFORTS,
    reasoningEffortFormat: 'responses',
    maxInputTokens: 922000,
    maxOutputTokens: 128000,
  },
  {
    family: 'gemini-3-flash',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GEMINI_FLASH_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 983040,
    maxOutputTokens: 65536,
  },
  {
    family: 'gemini-3.1-pro',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GEMINI_PRO_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 983040,
    maxOutputTokens: 65536,
  },
  {
    family: 'gemini-3.5-flash',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GEMINI_FLASH_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 983040,
    maxOutputTokens: 65536,
  },
  {
    family: 'claude-4-5-sonnet',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    modelOptions: { top_p: null },
    maxInputTokens: 136000,
    maxOutputTokens: 64000,
  },
  {
    family: 'claude-sonnet-4-6',
    apiType: 'messages',
    vision: true,
    thinking: true,
    adaptiveThinking: true,
    requestHeaders: MESSAGE_AUTH_HEADERS,
    supportsReasoningEffort: CLAUDE_MAX_EFFORTS,
    maxInputTokens: 936000,
    maxOutputTokens: 64000,
  },
  {
    family: 'claude-sonnet-5',
    apiType: 'messages',
    vision: true,
    thinking: true,
    adaptiveThinking: true,
    requestHeaders: MESSAGE_AUTH_HEADERS,
    supportsReasoningEffort: CLAUDE_XHIGH_EFFORTS,
    maxInputTokens: 872000,
    maxOutputTokens: 128000,
  },
  {
    family: 'claude-opus-4-5',
    apiType: 'messages',
    vision: true,
    thinking: false,
    requestHeaders: MESSAGE_AUTH_HEADERS,
    supportsReasoningEffort: CLAUDE_EFFORTS,
    maxInputTokens: 136000,
    maxOutputTokens: 64000,
  },
  {
    family: 'claude-opus-4-6',
    apiType: 'messages',
    vision: true,
    thinking: true,
    adaptiveThinking: true,
    requestHeaders: MESSAGE_AUTH_HEADERS,
    supportsReasoningEffort: CLAUDE_MAX_EFFORTS,
    maxInputTokens: 872000,
    maxOutputTokens: 128000,
  },
  {
    family: 'claude-opus-4-7',
    apiType: 'messages',
    vision: true,
    thinking: true,
    adaptiveThinking: true,
    requestHeaders: MESSAGE_AUTH_HEADERS,
    supportsReasoningEffort: CLAUDE_XHIGH_EFFORTS,
    maxInputTokens: 872000,
    maxOutputTokens: 128000,
  },
  {
    family: 'claude-opus-4-8',
    apiType: 'messages',
    vision: true,
    thinking: true,
    adaptiveThinking: true,
    requestHeaders: MESSAGE_AUTH_HEADERS,
    supportsReasoningEffort: CLAUDE_XHIGH_EFFORTS,
    maxInputTokens: 872000,
    maxOutputTokens: 128000,
  },
  {
    family: 'claude-opus-5',
    apiType: 'messages',
    vision: true,
    thinking: true,
    adaptiveThinking: true,
    requestHeaders: MESSAGE_AUTH_HEADERS,
    supportsReasoningEffort: CLAUDE_XHIGH_EFFORTS,
    maxInputTokens: 872000,
    maxOutputTokens: 128000,
  },
  {
    family: 'claude-haiku-4-5',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    modelOptions: { top_p: null },
    maxInputTokens: 136000,
    maxOutputTokens: 64000,
  },
  {
    family: 'qwen.qwen3-coder-30b-a3b-v1',
    apiType: 'chat-completions',
    vision: false,
    thinking: false,
    maxInputTokens: 245760,
    maxOutputTokens: 16384,
  },
  {
    family: 'qwen.qwen3-coder-480b-a35b-v1',
    apiType: 'chat-completions',
    vision: false,
    thinking: false,
    maxInputTokens: 114688,
    maxOutputTokens: 16384,
  },
  {
    family: 'moonshotai.kimi-k2.5',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    maxInputTokens: 245760,
    maxOutputTokens: 16384,
  },
];

/**
 * The capability-table entry that describes `tenantId`, or `undefined` when no
 * family matches. An exact family match wins; otherwise the first entry whose
 * family the shared resolver maps onto `tenantId` (dated / vendor-prefixed /
 * reordered tenant naming).
 */
export function findVsCodeCapabilityEntry(tenantId: string): VsCodeCapabilityEntry | undefined {
  return VS_CODE_CAPABILITY_TABLE.find((entry) => entry.family === tenantId)
    ?? VS_CODE_CAPABILITY_TABLE.find((entry) => resolveTenantModelId(entry.family, [tenantId]) === tenantId);
}

const DEFAULT_MAX_INPUT_TOKENS = 128000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MIN_RESPONSES_GPT_5_MINOR = 5;
/** Leading vendor prefix such as `openai.`, `azure.` or `azure_openai/`. */
const VENDOR_PREFIX = /^[a-z_]+[./]/;
/**
 * `gpt-<major>` with an optional 1–2 digit minor after `.` or `-`. The
 * lookahead keeps a date suffix (`gpt-5-2025-08-07`) from reading as a minor.
 */
const GPT_VERSION = /^gpt-(\d+)(?:[.-](\d{1,2})(?!\d))?/;

/**
 * Responses-only for an untabled id: any codex variant, GPT-6 and newer, and
 * GPT-5.5 and newer (dot- or dash-separated minor). Everything else uses
 * chat-completions. Mirrors the Responses families opencode-dynamic-models.ts
 * records; kept local because src/cli must not import from an agent plugin.
 */
function isResponsesOnlyGpt(id: string): boolean {
  const name = id.trim().toLowerCase().replace(VENDOR_PREFIX, '');
  if (name.includes('codex')) return true;
  const match = name.match(GPT_VERSION);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major > 5 || (major === 5 && minor >= MIN_RESPONSES_GPT_5_MINOR);
}

/**
 * Conservative capability entry for a tenant model with no capability-table
 * family. No reasoning effort, no custom headers, modest token limits. A
 * Responses model is always stateless (zero data retention) so the proxy's
 * Responses invariants still hold. Never `messages`: that needs per-family
 * auth headers the table owns.
 */
export function buildDefaultVsCodeCapability(descriptor: TenantModelDescriptor): VsCodeCapabilityEntry {
  const responses = isResponsesOnlyGpt(descriptor.id);
  return {
    family: descriptor.id,
    apiType: responses ? 'responses' : 'chat-completions',
    vision: descriptor.multimodal === true,
    thinking: false,
    toolCalling: descriptor.toolCalling !== false,
    ...(responses ? { zeroDataRetentionEnabled: true } : {}),
    maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };
}
