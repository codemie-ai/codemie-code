/**
 * Bridges from a resolved SSOAuth to the shapes existing consumers take. The type branching for
 * credential material lives here and in the strategies, nowhere else.
 */

import { droppedCookieKeys } from './selection.js';
import type { SSOAuth, SSOAuthType } from './types.js';

function unreachable(value: never): never {
  throw new Error(`Unhandled SSO auth type: ${JSON.stringify(value)}`);
}

/** Argument of the `fetchCodeMie*` helpers and `buildAuthHeaders`: the cookie map, or the bare token. */
export function authMaterial(auth: SSOAuth): Record<string, string> | string {
  switch (auth.type) {
    case 'cookie':
      return auth.cookies;
    case 'jwt':
      return auth.token;
    default:
      return unreachable(auth);
  }
}

/** The `cookies` / `jwtToken` pair of the processing context. */
export function toProcessingAuthFields(auth: SSOAuth): { cookies: string; jwtToken?: string } {
  switch (auth.type) {
    case 'cookie':
      return { cookies: auth.authValue };
    case 'jwt':
      return { cookies: '', jwtToken: auth.token };
    default:
      return unreachable(auth);
  }
}

/** Auth options of the CodeMie SDK client. */
export function toSdkAuthOptions(auth: SSOAuth): { cookies: Record<string, string> } | { jwt_token: string } {
  switch (auth.type) {
    case 'cookie':
      return { cookies: auth.cookies };
    case 'jwt':
      return { jwt_token: auth.token };
    default:
      return unreachable(auth);
  }
}

/** The credential material analytics/session sync sends: the Cookie header, or the bare bearer token. */
export type AnalyticsAuthMaterial = { kind: 'cookies'; cookies: string } | { kind: 'bearer'; jwtToken: string };

/** Maps a resolved credential to the kind-specific field analytics auth carries. */
export function toAnalyticsAuthMaterial(auth: SSOAuth): AnalyticsAuthMaterial {
  switch (auth.type) {
    case 'cookie':
      return { kind: 'cookies', cookies: auth.authValue };
    case 'jwt':
      return { kind: 'bearer', jwtToken: auth.token };
    default:
      return unreachable(auth);
  }
}

/**
 * What a log line may say about a credential: its type and, for cookies, entry names and counts.
 * Never values or token text.
 */
export interface AuthLogDescription {
  type: SSOAuthType;
  cookieCount?: number;
  cookieNames?: string[];
  /** Names of cookie entries the Cookie header leaves out as invalid. */
  droppedCookieNames?: string[];
}

export function describeAuthForLog(auth: SSOAuth): AuthLogDescription {
  switch (auth.type) {
    case 'cookie':
      return {
        type: auth.type,
        cookieCount: Object.keys(auth.cookies).length,
        cookieNames: Object.keys(auth.cookies),
        droppedCookieNames: droppedCookieKeys(auth.cookies),
      };
    case 'jwt':
      return { type: auth.type };
    default:
      return unreachable(auth);
  }
}
