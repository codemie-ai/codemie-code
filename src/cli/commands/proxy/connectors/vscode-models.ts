export type VsCodeApiType = 'chat-completions' | 'responses' | 'messages';

export type VsCodeReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface VsCodeModelDefinition {
  id: string;
  apiType: VsCodeApiType;
  vision: boolean;
  thinking: boolean;
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

export const VS_CODE_SUPPORTED_MODELS: readonly VsCodeModelDefinition[] = [
  {
    id: 'claude-sonnet-4-5-20250929',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    modelOptions: { top_p: null },
    maxInputTokens: 136000,
    maxOutputTokens: 64000,
  },
  {
    id: 'gpt-4.1',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    maxInputTokens: 1014808,
    maxOutputTokens: 32768,
  },
  {
    id: 'gpt-4.1-mini',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    maxInputTokens: 1014808,
    maxOutputTokens: 32768,
  },
  {
    id: 'gpt-5-2025-08-07',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GPT_5_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    id: 'gpt-5-mini-2025-08-07',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GPT_5_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    id: 'gpt-5-nano-2025-08-07',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GPT_5_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    id: 'gpt-5-2-2025-12-11',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GPT_5_2_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    id: 'gpt-5.4-2026-03-05',
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
    id: 'gpt-5.5-2026-04-24',
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
    id: 'gpt-5.6-luna-2026-07-09',
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
    id: 'gpt-5.6-sol-2026-07-09',
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
    id: 'gpt-5.6-terra-2026-07-09',
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
    id: 'gemini-3-flash',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GEMINI_FLASH_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 983040,
    maxOutputTokens: 65536,
  },
  {
    id: 'gemini-3.1-pro',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GEMINI_PRO_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 983040,
    maxOutputTokens: 65536,
  },
  {
    id: 'gemini-3.5-flash',
    apiType: 'chat-completions',
    vision: true,
    thinking: true,
    supportsReasoningEffort: GEMINI_FLASH_EFFORTS,
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 983040,
    maxOutputTokens: 65536,
  },
  {
    id: 'claude-4-5-sonnet',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    modelOptions: { top_p: null },
    maxInputTokens: 136000,
    maxOutputTokens: 64000,
  },
  {
    id: 'claude-sonnet-4-6',
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
    id: 'claude-sonnet-5',
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
    id: 'claude-opus-4-5-20251101',
    apiType: 'messages',
    vision: true,
    thinking: false,
    requestHeaders: MESSAGE_AUTH_HEADERS,
    supportsReasoningEffort: CLAUDE_EFFORTS,
    maxInputTokens: 136000,
    maxOutputTokens: 64000,
  },
  {
    id: 'claude-opus-4-6-20260205',
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
    id: 'claude-opus-4-7',
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
    id: 'claude-opus-4-8',
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
    id: 'claude-opus-5',
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
    id: 'claude-haiku-4-5-20251001',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    modelOptions: { top_p: null },
    maxInputTokens: 136000,
    maxOutputTokens: 64000,
  },
  {
    id: 'qwen.qwen3-coder-30b-a3b-v1',
    apiType: 'chat-completions',
    vision: false,
    thinking: false,
    maxInputTokens: 245760,
    maxOutputTokens: 16384,
  },
  {
    id: 'qwen.qwen3-coder-480b-a35b-v1',
    apiType: 'chat-completions',
    vision: false,
    thinking: false,
    maxInputTokens: 114688,
    maxOutputTokens: 16384,
  },
  {
    id: 'moonshotai.kimi-k2.5',
    apiType: 'chat-completions',
    vision: true,
    thinking: false,
    maxInputTokens: 245760,
    maxOutputTokens: 16384,
  },
];
