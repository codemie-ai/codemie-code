export {
  resolveSSOAuth,
  resolveSSOAuthFromEnv,
  resolveAnalyticsSSOAuth,
  resolveSSOAuthForUrl,
  storeSSOAuth,
  clearSSOAuth,
  explicitJwtAuth,
} from './resolver.js';
export {
  authMaterial,
  toProcessingAuthFields,
  toSdkAuthOptions,
  toAnalyticsAuthMaterial,
  describeAuthForLog,
} from './material.js';
export type { AnalyticsAuthMaterial, AuthLogDescription } from './material.js';
export type { SSOAuth, CookieSSOAuth, JwtSSOAuth, SSOAuthType, SSOLoginResult } from './types.js';
export { buildCookieHeader, hasUsableCookies, droppedCookieKeys } from './selection.js';
