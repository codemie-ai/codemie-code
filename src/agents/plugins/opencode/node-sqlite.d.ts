/**
 * Minimal type declarations for node:sqlite (Node.js 22.5+, experimental)
 *
 * node:sqlite lacks @types declarations in @types/node@20.x.
 * These ambient declarations provide compile-time safety for the sqlite reader.
 * At runtime, Node.js 22.5+ provides the module natively.
 */
declare module 'node:sqlite' {
  interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
  }

  interface DatabaseSyncOptions {
    open?: boolean;
  }

  class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export { DatabaseSync };
}
