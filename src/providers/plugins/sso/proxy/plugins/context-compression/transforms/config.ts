import type { ProfileFeatures } from '../../../../../../../env/types.js';

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

export function buildCompressConfig(features: ProfileFeatures | undefined): CompressConfig {
  const cc = features?.contextCompression;
  if (!cc) return { ...DEFAULT_COMPRESS_CONFIG };

  const config = { ...DEFAULT_COMPRESS_CONFIG };

  if (typeof cc.protectRecent === 'number')           config.protectRecent           = cc.protectRecent;
  if (typeof cc.targetRatio === 'number')             config.targetRatio             = cc.targetRatio;
  else if (cc.targetRatio === null)                   config.targetRatio             = null;
  if (typeof cc.compressUserMessages === 'boolean')   config.compressUserMessages    = cc.compressUserMessages;
  if (typeof cc.protectAnalysisContext === 'boolean') config.protectAnalysisContext  = cc.protectAnalysisContext;
  if (typeof cc.minTokensToCompress === 'number')     config.minTokensToCompress     = cc.minTokensToCompress;
  if (typeof cc.compressSystemMessages === 'boolean') config.compressSystemMessages  = cc.compressSystemMessages;

  return config;
}
