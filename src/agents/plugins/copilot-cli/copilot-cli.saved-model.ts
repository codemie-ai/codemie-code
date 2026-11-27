import { recordSavedModelPick } from '@/utils/model-origin.js';

/** The `codemie-copilot` launch options that decide whether its saved model applies. */
export interface CopilotModelOptions {
  model?: string | boolean;
}

/**
 * Copy the saved `--model` pick into `CODEMIE_MODEL` when neither `--model` nor an existing
 * `CODEMIE_MODEL` chose the model, and record it so the banner names the saved pick.
 */
export function applySavedCopilotModel(
  options: CopilotModelOptions,
  savedModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (typeof options.model === 'string' || options.model === true || env.CODEMIE_MODEL || !savedModel) {
    return;
  }

  env.CODEMIE_MODEL = savedModel;
  recordSavedModelPick(savedModel);
}
