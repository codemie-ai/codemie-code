/**
 * Kimi env-model alias resolution.
 *
 * When kimi-code is launched with the model supplied through the environment
 * (KIMI_MODEL_NAME — how CodeMie launches it), it records the placeholder alias
 * `__kimi_env_model__` in `wire.jsonl` (config.update.modelAlias and every
 * usage.record.model) instead of the real model id. The real id is only written to
 * the per-session log, `<session>/logs/kimi-code.log`, on each `llm config` line:
 *
 *   ... llm config  turnStep=0.1 provider=openai model=moonshotai.kimi-k2.5 modelAlias=__kimi_env_model__ ...
 *
 * These helpers recover that id so metrics and cost see a priceable model name.
 */

import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { logger } from '../../../utils/logger.js';

/** Placeholder alias kimi-code records for an environment-supplied model. */
export const KIMI_ENV_MODEL_ALIAS = '__kimi_env_model__';

const ENV_MODEL_LINE_PATTERN = /\bmodel=(\S+)\s+modelAlias=__kimi_env_model__(?:\s|$)/m;

/** The real model id from a kimi-code.log body, or null when no env-alias `llm config` line exists. */
export function extractKimiEnvModelFromLog(logText: string): string | null {
  const match = logText.match(ENV_MODEL_LINE_PATTERN);
  const model = match?.[1];
  return model && model !== KIMI_ENV_MODEL_ALIAS ? model : null;
}

/** `<session>/agents/main/wire.jsonl` → `<session>/logs/kimi-code.log`. */
export function kimiLogPathForWire(wireFilePath: string): string {
  const sessionDir = dirname(dirname(dirname(wireFilePath)));
  return join(sessionDir, 'logs', 'kimi-code.log');
}

/** Reads the env-supplied model for the session that owns `wireFilePath`; null when unavailable. */
export async function readKimiEnvModel(wireFilePath: string): Promise<string | null> {
  try {
    const logText = await readFile(kimiLogPathForWire(wireFilePath), 'utf-8');
    return extractKimiEnvModelFromLog(logText);
  } catch (error) {
    logger.debug(`[kimi-env-model] No session log for ${wireFilePath}:`, error);
    return null;
  }
}

/**
 * The model id to report for a recorded Kimi model: the env model when `model` is the
 * env alias and a real id is known, otherwise `model` unchanged.
 */
export function resolveKimiModelId(model: string, envModel: string | null | undefined): string {
  if (model === KIMI_ENV_MODEL_ALIAS && envModel && envModel !== KIMI_ENV_MODEL_ALIAS) {
    return envModel;
  }
  return model;
}
