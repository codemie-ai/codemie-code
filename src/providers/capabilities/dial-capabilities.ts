// Capabilities detection for DIAL models: foundation only

export interface ModelCapabilities {
  openaiCompatible: boolean;
  tools: boolean;
  reasoning: boolean;
  thinking: boolean;
  vision: boolean;
}

export function detectCapabilitiesFromModelName(modelId: string): ModelCapabilities {
  // Simple heuristic for demo/foundation
  if (/claude/i.test(modelId)) {
    return {
      openaiCompatible: true,
      tools: true,
      reasoning: false,
      thinking: false,
      vision: false,
    };
  }
  if (/gemini/i.test(modelId)) {
    return {
      openaiCompatible: true,
      tools: true,
      reasoning: false,
      thinking: false,
      vision: true,
    };
  }
  if (/grok/i.test(modelId)) {
    return {
      openaiCompatible: true,
      tools: true,
      reasoning: false,
      thinking: false,
      vision: false,
    };
  }
  if (/gpt|openai/i.test(modelId)) {
    return {
      openaiCompatible: true,
      tools: true,
      reasoning: true,
      thinking: false,
      vision: false
    };
  }
  // Fallback: openai compatible only
  return {
    openaiCompatible: true,
    tools: false,
    reasoning: false,
    thinking: false,
    vision: false,
  };
}
