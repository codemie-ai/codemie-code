/**
 * Session-shaped 401 classifier.
 *
 * The one place that decides whether a 401 from the CodeMie gateway is treated as a rejected SSO
 * session. It sits in its own module so the metrics and OTLP classifiers can call it later and a
 * unification only moves callers.
 *
 * The backend answers a request without a valid session with 401 and the body
 * `{"error": {"message": "Authentication failed", "details": ..., "help": ...}}` (an
 * `ExtendedHTTPException`, handled in `codemie/rest_api/main.py`; raised in
 * `codemie/enterprise/idp/dependencies.py`). Other 401s reach the client with a different body: the
 * LLM proxy returns LiteLLM's error status unchanged (`proxy_router.py`, `_handle_error_response`),
 * so a LiteLLM 401 can arrive while the SSO session is valid. Only a 401 whose body carries that
 * message is a rejected session; the caller must therefore read the body and pass it here.
 *
 * REMAINING UNVERIFIED: no real capture of an expired-cookie 401 was available. If the gateway in
 * front of the backend (oauth2-proxy) answers an expired cookie with its own 401 body instead of the
 * redirect, that body is not matched; add its shape here with a fixture when it is captured. A
 * missed session 401 is passed through unchanged, as before this fix. The caller's loop guard, lock
 * and cooldown still bound the sign-ins.
 *
 * A 403 is deliberately not a session rejection: it means "authenticated but not allowed", and
 * signing in again cannot fix it.
 */

export interface UpstreamResponseShape {
  statusCode?: number;
  headers?: Record<string, unknown>;
}

const SESSION_REJECTION_MESSAGE = 'authentication failed';

/** Whether `response` with `body` is a 401 that should be handled as a rejected SSO session. */
export function isSessionRejection401(response: UpstreamResponseShape, body: Buffer | string): boolean {
  if (response.statusCode !== 401) return false;
  try {
    const parsed: unknown = JSON.parse(typeof body === 'string' ? body : body.toString('utf-8'));
    const message = (parsed as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof message === 'string' && message.trim().toLowerCase() === SESSION_REJECTION_MESSAGE;
  } catch {
    return false; // not JSON: not the backend's own session rejection
  }
}
