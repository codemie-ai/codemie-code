import type { StopReason } from '@/agents/core/evidence/stop-marker.js';

/**
 * One-line user notice for a publication stop or first hold. It is shown through the hook's `systemMessage`
 * (the user sees it; the model context does not) and never carries a project name, path or account.
 */
const GUIDE = 'Claude keeps working. Start a new session (/clear or a new terminal) to resume analytics.';

const TEXT: Record<StopReason, string> = {
  collection_disabled: 'analytics was turned off for this session.',
  folder_changed: 'the working folder moved to another project or an unconnected folder.',
  consent_revoked: 'the folder is no longer connected for work analytics.',
  consent_missing: 'the folder is not connected for work analytics.',
  resume_unknown: 'this resumed or forked session has no recorded scope, so none of it is published.',
  generation_changed: 'analytics collection was turned off and on again during this session.',
  scope_excluded: 'this folder is excluded from analytics.',
  response_unverified: 'the analytics backend answer could not be verified.',
  contract_unsupported: 'the analytics backend does not accept this client version.',
  hold_expired: 'the analytics backend stayed unavailable for too long.',
  hold_contract_unavailable: 'the analytics backend is not ready for this client yet; data is held and will be retried.',
  consent_invalid: 'the analytics backend rejected the folder consent.',
  requires_session: 'the analytics backend rejected the request.',
  unspecified: 'publishing stopped.',
};

export function stopNoticeText(reason: StopReason): string {
  return `CodeMie analytics paused for this session: ${TEXT[reason]} ${reason === 'hold_contract_unavailable' ? 'Claude keeps working.' : GUIDE}`;
}
