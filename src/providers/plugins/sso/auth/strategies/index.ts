import type { SSOAuthStrategy } from '../types.js';
import { cookieStrategy } from './cookie.strategy.js';
import { jwtStrategy } from './jwt.strategy.js';

/** Every credential type the resolver can pick from. */
export const STRATEGIES: readonly SSOAuthStrategy[] = [cookieStrategy, jwtStrategy];
