import { ORG_ENCODED_HEADER } from './org-encoding.js';

/** The one negotiated publication contract: used by the capability check, the sender and echo verification. */
export const PUBLICATION_CONTRACT = '1';

export const CONTRACT_HEADER = 'X-CodeMie-Publication-Contract';
export const FUNDING_HEADER = 'X-CodeMie-Funding-Route';
export const CONSENT_HEADER = 'X-CodeMie-Work-Consent';
export const CONSENT_VALUE = 'explicit-folder';
export const DESTINATION_HEADER = 'X-CodeMie-Destination';
export const BOUND_PROJECT_HEADER = 'X-CodeMie-Bound-Project';

/**
 * Headers only the analytics forwarder may build (from the frozen record). A model request must never carry
 * them, whatever its case. `X-CodeMie-Project`, `Session-ID` and the model attribution headers are not listed.
 */
const ANALYTICS_ONLY_HEADERS: ReadonlySet<string> = new Set(
  [
    CONTRACT_HEADER, FUNDING_HEADER, CONSENT_HEADER, DESTINATION_HEADER, BOUND_PROJECT_HEADER,
    'X-CodeMie-Subscription-Type', 'X-CodeMie-Routed-Via-CodeMie', 'X-CodeMie-Organization', ORG_ENCODED_HEADER,
    'X-CodeMie-Policy-Version', 'X-CodeMie-Repo-Remote', 'X-CodeMie-Project-Source',
  ].map((h) => h.toLowerCase())
);

/** Deletes analytics-only headers (case-insensitively) in place; unrelated headers are kept. */
export function stripAnalyticsOnlyHeaders(headers: Record<string, unknown>): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(headers)) {
    if (ANALYTICS_ONLY_HEADERS.has(name.toLowerCase())) {
      delete headers[name];
      removed.push(name);
    }
  }
  return removed;
}
