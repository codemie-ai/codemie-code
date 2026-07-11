// Auto-retry request with sanitizer for Azure DIAL/Azure OpenAI endpoint

import { sanitizeAzureOpenAIPayload } from './azure-openai-sanitizer-source.js';
import { ToolExecutionError } from '../../../utils/errors.js';

/**
 * Performs a request to an Azure OpenAI / EPAM DIAL endpoint, automatically
 * sanitizing the payload and retrying once if the endpoint returns a
 * "Extra inputs are not permitted" HTTP 400 validation error.
 *
 * The `send` and `payload` parameters use `any` because this function is a
 * generic transport-level wrapper that must be compatible with any SDK or raw
 * fetch shape (LiteLLM, OpenAI SDK, raw fetch). Callers are responsible for
 * typing their own send function and payload before passing them in.
 *
 * @param send     Async function that performs the actual request (SDK or raw fetch)
 * @param payload  Original request payload (OpenAI Chat Completions shape)
 * @returns        The response from the first or sanitized-retry attempt
 * @throws         {ToolExecutionError} if the sanitized retry also fails (toolName='[DIAL Retry]')
 */
export async function requestWithSanitizerRetry(send: (payload: any) => Promise<any>, payload: any): Promise<any> {
  // First attempt — original payload
  try {
    return await send(payload);
  } catch (err: any) {
    // Analysis: only if error is 400 and "Extra inputs are not permitted"
    if (err &&
        (err.status === 400 || err.code === 400 || (err.response && err.response.status === 400)) &&
        (typeof err.message === 'string' && err.message.includes('Extra inputs are not permitted') ||
         (err.response && typeof err.response.data === 'string' && err.response.data.includes('Extra inputs are not permitted')) ||
         (err.data && typeof err.data === 'string' && err.data.includes('Extra inputs are not permitted')))) {
      // Applying sanitizer
      const cleaned = sanitizeAzureOpenAIPayload(payload);
      try {
        // Second attempt — sanitized payload
        return await send(cleaned);
      } catch (err2: any) {
        throw new ToolExecutionError('[DIAL Retry]', `Request failed after sanitize retry: ${err2?.message || err2}`);
      }
    }
    throw err;
  }
}

