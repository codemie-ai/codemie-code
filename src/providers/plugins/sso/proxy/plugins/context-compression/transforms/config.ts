export interface CompressConfig {
  protectRecent: number;
  targetRatio: number | null;
  compressUserMessages: boolean;
  protectAnalysisContext: boolean;
  minTokensToCompress: number;
  compressSystemMessages: boolean;
}

export const DEFAULT_COMPRESS_CONFIG: CompressConfig = {
  protectRecent: 4,
  targetRatio: null,
  compressUserMessages: false,
  protectAnalysisContext: true,
  minTokensToCompress: 250,
  compressSystemMessages: true,
};

export function buildCompressConfig(features: Record<string, unknown> | undefined): CompressConfig {
  if (!features) return { ...DEFAULT_COMPRESS_CONFIG };

  const config = { ...DEFAULT_COMPRESS_CONFIG };

  if (typeof features['protectRecent'] === 'number') {
    config.protectRecent = features['protectRecent'];
  }

  if (typeof features['targetRatio'] === 'number') {
    config.targetRatio = features['targetRatio'];
  } else if (features['targetRatio'] === null) {
    config.targetRatio = null;
  }

  if (typeof features['compressUserMessages'] === 'boolean') {
    config.compressUserMessages = features['compressUserMessages'];
  }

  if (typeof features['protectAnalysisContext'] === 'boolean') {
    config.protectAnalysisContext = features['protectAnalysisContext'];
  }

  if (typeof features['minTokensToCompress'] === 'number') {
    config.minTokensToCompress = features['minTokensToCompress'];
  }

  if (typeof features['compressSystemMessages'] === 'boolean') {
    config.compressSystemMessages = features['compressSystemMessages'];
  }

  return config;
}
