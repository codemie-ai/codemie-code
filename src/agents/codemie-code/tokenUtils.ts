/**
 * Token Usage and Cost Calculation Utilities
 *
 * Provides utilities for extracting token usage from LLM responses
 * and calculating costs for different providers and models.
 */

import type { TokenUsage } from './types.js';

/**
 * Provider pricing information (per 1M tokens)
 * Updated as of November 2024 - check provider websites for latest pricing
 */
export const MODEL_PRICING = {
  // OpenAI GPT Models
  'gpt-4.1': { input: 2.50, output: 10.00 },
  'gpt-4.1-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },

  // Claude Models (via LiteLLM/Bedrock)
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20240620': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022': { input: 0.25, output: 1.25 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-sonnet-20240229': { input: 3.00, output: 15.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },

  // Generic fallbacks for unknown models
  'gpt-4-*': { input: 10.00, output: 30.00 },
  'gpt-3.5-*': { input: 0.50, output: 1.50 },
  'claude-3-*': { input: 3.00, output: 15.00 },
} as const;

/**
 * Extract token usage from LangChain AIMessage or response
 * Based on LangChain v1.0+ usage_metadata format
 */
export function extractTokenUsage(
  response: any,
  model: string,
  _provider: string
): TokenUsage | null {
  try {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let usage: any = null;

    // Extract from AIMessage usage_metadata (LangChain v1.0+ format)
    if (response?.usage_metadata) {
      usage = response.usage_metadata;
      inputTokens = usage.input_tokens || 0;
      outputTokens = usage.output_tokens || 0;

      // Handle cache information from input_token_details
      if (usage.input_token_details?.cache_read) {
        cachedTokens = usage.input_token_details.cache_read;
      }
    }

    // Extract from response_metadata.usage (for direct LLM calls)
    else if (response?.response_metadata?.usage) {
      usage = response.response_metadata.usage;
      inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
      outputTokens = usage.output_tokens || usage.completion_tokens || 0;

      // Handle different cache formats
      if (usage.input_token_details?.cache_read) {
        cachedTokens = usage.input_token_details.cache_read;
      } else if (usage.cache_read_input_tokens) {
        cachedTokens = usage.cache_read_input_tokens;
      }
    }

    // Legacy format support (older LangChain versions)
    else if (response?.usage) {
      usage = response.usage;
      inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
      outputTokens = usage.output_tokens || usage.completion_tokens || 0;
      cachedTokens = usage.cache_read_input_tokens || 0;
    }

    // Try to extract from response generations (older LangChain format)
    else if (response?.generations?.[0]?.generationInfo?.usage) {
      usage = response.generations[0].generationInfo.usage;
      inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
      outputTokens = usage.completion_tokens || usage.output_tokens || 0;
      cachedTokens = usage.cache_read_input_tokens || 0;
    }

    // If no tokens found, return null
    if (inputTokens === 0 && outputTokens === 0) {
      return null;
    }

    const totalTokens = inputTokens + outputTokens;
    const estimatedCost = calculateCost(model, inputTokens, outputTokens);

    return {
      inputTokens,
      outputTokens,
      cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
      totalTokens,
      estimatedCost: estimatedCost > 0 ? estimatedCost : undefined
    };
  } catch (error) {
    console.warn('[TokenUtils] Failed to extract token usage:', error);
    return null;
  }
}

/**
 * Calculate estimated cost for a model and token usage
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;

  // Convert from per-million to per-token rates
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * Get pricing information for a model
 */
export function getModelPricing(model: string): { input: number; output: number } | null {
  // Direct model match
  if (MODEL_PRICING[model as keyof typeof MODEL_PRICING]) {
    return MODEL_PRICING[model as keyof typeof MODEL_PRICING];
  }

  // Pattern matching for model families
  if (model.startsWith('gpt-4')) {
    return MODEL_PRICING['gpt-4-*'];
  }
  if (model.startsWith('gpt-3.5')) {
    return MODEL_PRICING['gpt-3.5-*'];
  }
  if (model.startsWith('claude-3')) {
    return MODEL_PRICING['claude-3-*'];
  }

  return null;
}

/**
 * Format cost as a human-readable string
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.001) return '<$0.001';
  if (cost < 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Format token count as a human-readable string
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/**
 * Create a formatted summary of token usage
 */
export function formatTokenUsageSummary(usage: TokenUsage): string {
  const parts: string[] = [];

  parts.push(`${formatTokens(usage.inputTokens)} in, ${formatTokens(usage.outputTokens)} out`);

  if (usage.cachedTokens && usage.cachedTokens > 0) {
    parts.push(`${formatTokens(usage.cachedTokens)} cached`);
  }

  if (usage.estimatedCost && usage.estimatedCost > 0) {
    parts.push(`(${formatCost(usage.estimatedCost)})`);
  }

  return parts.join(', ');
}

/**
 * Extract token usage from LangGraph stream chunk
 * Based on LangChain documentation about "messages" stream mode
 */
export function extractTokenUsageFromStreamChunk(
  chunk: any,
  model: string,
  provider: string
): TokenUsage | null {
  try {
    // For LangGraph "updates" stream mode, check agent messages
    if (chunk.agent?.messages) {
      for (const message of chunk.agent.messages) {
        // Check for usage_metadata in AIMessage (LangChain v1.0+ format)
        if (message.usage_metadata) {
          return extractTokenUsage(message, model, provider);
        }

        // Check for response_metadata.usage
        if (message.response_metadata?.usage) {
          return extractTokenUsage(message, model, provider);
        }
      }
    }

    // For "messages" stream mode, the chunk might be the message directly
    if (chunk.usage_metadata) {
      return extractTokenUsage(chunk, model, provider);
    }

    // Check chunk metadata for usage information
    if (chunk.metadata?.usage) {
      return extractTokenUsage({ usage: chunk.metadata.usage }, model, provider);
    }

    return null;
  } catch (error) {
    console.warn('[TokenUtils] Failed to extract tokens from stream chunk:', error);
    return null;
  }
}

/**
 * Extract token usage from final state after LangGraph completion
 * This captures any usage information that wasn't caught during streaming
 */
export function extractTokenUsageFromFinalState(
  finalState: any,
  model: string,
  provider: string
): TokenUsage | null {
  try {
    if (finalState?.messages) {
      // Look through messages in reverse order to find the most recent one with usage
      for (let i = finalState.messages.length - 1; i >= 0; i--) {
        const message = finalState.messages[i];

        if (message.usage_metadata || message.response_metadata?.usage) {
          return extractTokenUsage(message, model, provider);
        }
      }
    }

    return null;
  } catch (error) {
    console.warn('[TokenUtils] Failed to extract tokens from final state:', error);
    return null;
  }
}