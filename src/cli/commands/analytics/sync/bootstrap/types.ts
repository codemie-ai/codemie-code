/**
 * Shared types for `codemie analytics sync bootstrap`: its `--webhook` non-interactive mode
 * (`./run-bootstrap.ts`) and its guided 8-step wizard (`./guided.ts`, Task 7).
 *
 * Kept in their own module, separate from `run-bootstrap.ts`, so `guided.ts` can import them
 * without creating an import cycle with the runner that dispatches to it (`run-bootstrap.ts`
 * imports `guided.ts`; `guided.ts` must therefore never import back from `run-bootstrap.ts`).
 */

import type { SyncReport } from '../types.js';

/** Raw flags accepted by `codemie analytics sync bootstrap`. */
export interface BootstrapOptions {
  webhook?: string;
  /** `--webhook-b64`: the trigger URL as base64url, for shells that mangle a raw URL. */
  webhookB64?: string;
  lookbackDays?: string;
  includeExternal?: string;
}

/** A prompter abstraction over inquirer, used by the guided wizard (Task 7) so its steps run
 * against a scriptable fake in tests. `createRealBootstrapDeps()` in `run-bootstrap.ts` wires
 * a real inquirer-backed implementation. */
export interface BootstrapPrompter {
  input(message: string, def?: string): Promise<string>;
  confirm(message: string, def: boolean): Promise<boolean>;
  select<T extends string>(message: string, choices: { value: T; name: string }[], def?: T): Promise<T>;
}

/** Every side effect `runBootstrap` (and the guided wizard it hands off to) needs, injected so
 * tests run without a real terminal, network call or filesystem. `createRealBootstrapDeps()`
 * in `run-bootstrap.ts` wires the real ones. */
export interface BootstrapDeps {
  isTTY: boolean;
  cwd: string;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
  send: (url: string, report: SyncReport, timeoutMs?: number) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  prompt: BootstrapPrompter;
  statePath: string;
  /** The running CLI's version, named in the update hint as the minimum developers need;
   * `null` when it cannot be read. */
  cliVersion: () => Promise<string | null>;
}
