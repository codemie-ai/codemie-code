// Auto-retry request with sanitizer for Azure DIAL/Azure OpenAI endpoint

import { sanitizeAzureDialPayload } from './azure-dial-sanitizer-source.js';

/**
 * Performs a request to DIAL/Azure endpoint, automatically sanitizing the payload in case of "Extra inputs are not permitted" error
 * @param send     Async function making the request (SDK or http fetch)
 * @param payload  Original request payload
 * @returns        Successful response/result or exception if the error is not fixable
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
      const cleaned = sanitizeAzureDialPayload(payload);
      try {
        // Second attempt — sanitized payload
        return await send(cleaned);
      } catch (err2: any) {
        throw new Error(`[DIAL Retry] Request failed after sanitize retry: ${err2?.message || err2}`);
      }
    }
    throw err;
  }
}

