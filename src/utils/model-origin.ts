/**
 * Where a launch's `CODEMIE_MODEL` came from, and the shared model text for
 * banner and `codemie profile status`.
 *
 * Dependency-free on purpose, like `project-binding.ts`: `bin/codemie-copilot.js`
 * and the banner import it without pulling in ConfigLoader.
 *
 * - `shell`  any non-empty `CODEMIE_MODEL` nothing below recorded, including one
 *            inherited from a parent CodeMie session
 * - `dotenv` the value dotenv added from `<cwd>/.env`
 * - `saved`  the value `codemie-copilot` copied from its saved `--model` pick
 */
import { sanitizeDisplayText } from './project-binding.js';

export type ModelEnvOrigin = 'shell' | 'dotenv' | 'saved';

/** Output-only env var the launcher exports next to CODEMIE_MODEL_SOURCE. Never an input to config loading. */
export const MODEL_ENV_ORIGIN_ENV = 'CODEMIE_MODEL_ENV_ORIGIN';

/** Output-only env var carrying the profile model an env override replaced. */
export const PROFILE_MODEL_ENV = 'CODEMIE_PROFILE_MODEL';

const ORIGINS: readonly ModelEnvOrigin[] = ['shell', 'dotenv', 'saved'];

// In-process records only: a child process must never inherit them.
const dotenvValues = new Map<string, string>();
let savedModelPick: string | undefined;

/** Parse an origin value; unknown or missing values yield `undefined`. */
export function parseModelEnvOrigin(value: unknown): ModelEnvOrigin | undefined {
  return typeof value === 'string' && (ORIGINS as readonly string[]).includes(value)
    ? (value as ModelEnvOrigin)
    : undefined;
}

/** An env variable name as the platform compares it: Windows names are case-insensitive. */
export function envKeyId(key: string): string {
  return process.platform === 'win32' ? key.toUpperCase() : key;
}

/** Record the keys dotenv added to `process.env`, with the values it set. */
export function recordDotenvValues(applied: Record<string, string>): void {
  for (const [key, value] of Object.entries(applied)) {
    dotenvValues.set(envKeyId(key), value);
  }
}

/** True only while `env[key]` still holds the value dotenv set. */
export function isFromDotenv(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const recorded = dotenvValues.get(envKeyId(key));
  return recorded !== undefined && env[key] === recorded;
}

/** Record the model `codemie-copilot` copied from its saved pick into `CODEMIE_MODEL`. */
export function recordSavedModelPick(model: string): void {
  savedModelPick = model;
}

/** Origin of the current `CODEMIE_MODEL`; `undefined` when it is missing or empty. */
export function resolveModelEnvOrigin(env: NodeJS.ProcessEnv = process.env): ModelEnvOrigin | undefined {
  const model = env.CODEMIE_MODEL;
  if (!model) return undefined;
  if (isFromDotenv('CODEMIE_MODEL', env)) return 'dotenv';
  if (savedModelPick !== undefined && model === savedModelPick) return 'saved';
  return 'shell';
}

/** Clear the in-process `.env` and saved-pick records; for tests. */
export function resetModelOriginRecords(): void {
  dotenvValues.clear();
  savedModelPick = undefined;
}

function overrideCause(origin: ModelEnvOrigin): string {
  switch (origin) {
    case 'shell':
      return 'CODEMIE_MODEL from shell env overrides';
    case 'dotenv':
      return 'CODEMIE_MODEL from .env overrides';
    case 'saved':
      return 'your saved codemie-copilot --model pick, overrides';
  }
}

/**
 * Model text for banner and `codemie profile status`. Marks an override only when
 * an origin is given and the model differs from the profile model it replaced.
 */
export function describeModel(model: string, origin: ModelEnvOrigin | undefined, profileModel: string | undefined): string {
  const shown = sanitizeDisplayText(model);
  if (!origin || model === profileModel) return shown;
  const replaced = profileModel ? sanitizeDisplayText(profileModel) : 'N/A';
  return `${shown} (${overrideCause(origin)} profile: ${replaced})`;
}
