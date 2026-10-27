/**
 * Gathers ticket evidence for every session in one analytics run.
 *
 * Tool calls and native prompts come from the cost pass's parsed logs via {@link observe}, which
 * the enricher calls in start-time order with each session's `windowEnd`. That is the order the
 * cost pass uses to give a replayed API response to the EARLIEST session (`takeUnseenRecords` +
 * `withinWindow` in usage-readers.ts), and the same rule applies here: a run-wide `seen` set of
 * call ids (and prompt row ids), and nothing after the session's own end. A resumed session's
 * replay of an earlier session's Jira call is therefore attributed once, to the earlier session.
 *
 * CodeMie-tracked prompts and branches come from the session deltas via {@link addDeltas}.
 */

import type { RawSessionData } from '../data-loader.js';
import type { ParsedSessionView } from '../cost/cost-enricher.js';
import type { SessionTicket } from '../report/types.js';
import { buildSessionTickets, type SessionEvidence, type TicketSource } from './merge.js';
import { readNativeSignals } from './native-signals.js';
import { readToolCalls } from './tool-calls.js';
import { compileToolMatcher, ticketsFromToolInput } from './tool-tickets.js';

export interface TicketCollectorOptions {
  sources: ReadonlySet<TicketSource>;
  toolGlobs: readonly string[];
}

function inWindow(ts: number | null, windowEnd: number | undefined): boolean {
  return windowEnd === undefined || ts === null || ts <= windowEnd;
}

export class TicketCollector {
  private readonly evidence = new Map<string, SessionEvidence>();
  private readonly seenCalls = new Set<string>();
  private readonly seenPrompts = new Set<string>();
  private readonly matchesTool: (name: string) => boolean;

  constructor(private readonly options: TicketCollectorOptions) {
    this.matchesTool = compileToolMatcher(options.toolGlobs);
  }

  private session(sessionId: string): SessionEvidence {
    let e = this.evidence.get(sessionId);
    if (!e) {
      e = { tool: new Map(), branches: new Set(), prompts: new Set() };
      this.evidence.set(sessionId, e);
    }
    return e;
  }

  /** A {@link ParsedSessionObserver} for `enrichCosts`; bound so it can be passed directly. */
  readonly observe = (view: ParsedSessionView): void => {
    if (!view.parsed) return;
    const { sources } = this.options;
    const e = this.session(view.sessionId);

    if (sources.has('tool')) {
      for (const call of readToolCalls(view.agentName, view.parsed)) {
        if (!this.matchesTool(call.name) || !inWindow(call.ts, view.windowEnd)) continue;
        if (call.id !== null) {
          if (this.seenCalls.has(call.id)) continue;
          this.seenCalls.add(call.id);
        }
        for (const id of ticketsFromToolInput(call.input)) e.tool.set(id, (e.tool.get(id) ?? 0) + 1);
      }
    }

    if (sources.has('branch') || sources.has('prompt')) {
      const signals = readNativeSignals(view.agentName, view.parsed);
      if (sources.has('branch')) for (const branch of signals.branches) e.branches.add(branch);
      if (sources.has('prompt')) {
        for (const prompt of signals.prompts) {
          if (!inWindow(prompt.ts, view.windowEnd)) continue;
          if (prompt.key !== null) {
            if (this.seenPrompts.has(prompt.key)) continue;
            this.seenPrompts.add(prompt.key);
          }
          e.prompts.add(prompt.text);
        }
      }
    }
  };

  /** Prompts and branches CodeMie recorded per turn; the same text seen in the native log counts once. */
  addDeltas(sessions: readonly RawSessionData[]): void {
    const { sources } = this.options;
    if (!sources.has('branch') && !sources.has('prompt')) return;
    for (const raw of sessions) {
      const e = this.session(raw.sessionId);
      for (const delta of raw.deltas ?? []) {
        if (sources.has('branch') && delta.gitBranch) e.branches.add(delta.gitBranch);
        if (sources.has('prompt')) {
          for (const prompt of delta.userPrompts ?? []) {
            if (prompt?.text?.trim()) e.prompts.add(prompt.text);
          }
        }
      }
    }
  }

  build(): Map<string, SessionTicket[]> {
    return buildSessionTickets(this.evidence, this.options.sources);
  }
}
