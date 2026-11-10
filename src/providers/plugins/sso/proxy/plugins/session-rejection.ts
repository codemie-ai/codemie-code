/**
 * Session-shaped 401 classifier.
 *
 * The one place that decides whether a 401 from the CodeMie gateway is treated as a rejected SSO
 * session. It sits in its own module so the metrics and OTLP classifiers can call it later and a
 * unification only moves callers.
 *
 * ASSUMPTION: the predicate is status-only (`statusCode === 401`). No real gateway captures of an
 * expired-cookie 401 or of a non-session 401 (denied model, relayed upstream failure) were
 * available when this was written, so no body or header difference could be observed. It is
 * unverified whether the gateway returns 401 for causes other than a dead SSO session, and
 * whether a session 401 differs by body or header (spec Risks, EPMCDME-17014). Until that is known
 * this function may match every 401; the caller's identical-credential loop guard, plus the
 * detached sign-in's lock and cooldown, is what bounds a non-session 401. When captures exist,
 * narrow the predicate to the observed difference and update the fixtures in
 * `__tests__/session-rejection.test.ts`.
 *
 * A 403 is deliberately not a session rejection: it means "authenticated but not allowed", and
 * signing in again cannot fix it.
 */

export interface UpstreamResponseShape {
  statusCode?: number;
  headers?: Record<string, unknown>;
}

/** Whether `response` is a 401 that should be handled as a rejected SSO session. */
export function isSessionRejection401(response: UpstreamResponseShape): boolean {
  return response.statusCode === 401;
}
