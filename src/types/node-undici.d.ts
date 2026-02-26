/**
 * Minimal ambient type declarations for node:undici.
 *
 * node:undici is bundled with Node.js 18+ and used by the native fetch() API,
 * but @types/node@20 does not ship undici type declarations.
 * These stubs satisfy TypeScript's module resolution without external packages.
 */
declare module 'node:undici' {
  export function setGlobalDispatcher(dispatcher: unknown): void;
  export class Agent {
    constructor(options?: { connect?: { ca?: string | string[] } });
  }
}
