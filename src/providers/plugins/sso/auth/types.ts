/**
 * Types of the SSO auth resolver: the resolved credential a request is sent with, and the
 * per-type storage strategy the resolver picks between.
 */

import type { JWTCredentials, SSOAuthResult, SSOCredentials } from '@/providers/core/types.js';

export type SSOAuthType = 'cookie' | 'jwt';

/** `store` credentials come from the credential store and may be re-read; `explicit` ones never are. */
export type SSOAuthSource = 'store' | 'explicit';

interface SSOAuthBase {
  type: SSOAuthType;
  apiUrl: string;
  /** The URL the credential was looked up for (the profile's base URL). */
  url: string;
  expiresAt?: number;
  headers: Readonly<Record<string, string>>;
  /** Value a request is sent with: the Cookie header, or the bare token. Used by supersede checks. */
  authValue: string;
  /** Stable, non-secret hash of the login. */
  fingerprint: string;
  identityToken?: string;
  email?: string;
  source: SSOAuthSource;
}

export interface CookieSSOAuth extends SSOAuthBase {
  type: 'cookie';
  cookies: Record<string, string>;
}

export interface JwtSSOAuth extends SSOAuthBase {
  type: 'jwt';
  token: string;
}

export type SSOAuth = CookieSSOAuth | JwtSSOAuth;

/** A browser login result; `auth` is the credential the resolver stored, present on success. */
export type SSOLoginResult = SSOAuthResult & { auth?: SSOAuth };

export type StoredRecordOf<T extends SSOAuthType> = T extends 'cookie' ? SSOCredentials : JWTCredentials;

export interface SSOAuthStrategy<T extends SSOAuthType = SSOAuthType> {
  readonly type: T;
  /** Includes expired records, so the resolver can clear them. */
  load(url: string): Promise<StoredRecordOf<T> | null>;
  loadGlobal(): Promise<StoredRecordOf<T> | null>;
  /** This type's record from a callback result; null when the payload has no usable material for it. */
  fromCallback(result: SSOAuthResult, storedAt: number): StoredRecordOf<T> | null;
  /**
   * Whether the server accepts this callback record. Asked at login only when a later strategy
   * also has a record from the same callback; a strategy without it is always accepted.
   */
  isAccepted?(record: StoredRecordOf<T>): Promise<boolean>;
  save(record: StoredRecordOf<T>, url: string): Promise<void>;
  /** Clears current key, legacy key, and the global slot when its apiUrl origin matches url's origin. */
  clear(url?: string): Promise<void>;
}
