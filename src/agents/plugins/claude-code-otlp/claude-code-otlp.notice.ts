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
  work_consent_required: 'To publish future work sessions, run codemie proxy analytics connect-folder --project "<project-name>" from this folder and start a new session.',
  resume_unknown: 'this resumed or forked session has no recorded scope, so none of it is published.',
  generation_changed: 'analytics collection was turned off and on again during this session.',
  scope_excluded: 'this folder is excluded from analytics.',
  response_unverified: 'the analytics backend answer could not be verified.',
  contract_unsupported: 'the analytics backend does not accept this client version.',
  hold_expired: 'the analytics backend stayed unavailable for too long.',
  hold_contract_unavailable: 'the analytics backend is not ready for this client yet; data is held and will be retried.',
  hold_state_unknown: 'the analytics backend could not be reached to confirm it is ready; data is held and will be retried.',
  hold_personal_unsupported: 'the analytics backend cannot store personal analytics for this account yet; data is held and will be retried.',
  hold_project_unavailable: 'the connected project is not available for analytics on the backend right now; data is held and will be retried.',
  hold_destination_unsupported: 'the connected project name cannot be used as an analytics destination by the backend; data is held and will be retried.',
  consent_invalid: 'the analytics backend rejected the folder consent.',
  consent_project_unsupported: 'the connected project name cannot be sent to the analytics backend (only Latin-1 text is supported); reconnect the folder with a supported project.',
  scope_unproven: 'this session began before analytics recorded its collection scope, so its folder and consent cannot be proven and none of it is published.',
  requires_session: 'the analytics backend rejected the request.',
  unspecified: 'publishing stopped.',
};

/** Notices of a hold that can still recover: Claude keeps working and nothing says to restart. */
const HOLD_ONLY: ReadonlySet<StopReason> = new Set<StopReason>(['hold_contract_unavailable', 'hold_state_unknown', 'hold_personal_unsupported', 'hold_project_unavailable', 'hold_destination_unsupported']);

export function stopNoticeText(reason: StopReason): string {
  if (reason === 'work_consent_required') {
    return `CodeMie analytics was not sent for this session. ${TEXT[reason]} Claude keeps working.`;
  }
  return `CodeMie analytics paused for this session: ${TEXT[reason]} ${HOLD_ONLY.has(reason) ? 'Claude keeps working.' : GUIDE}`;
}
