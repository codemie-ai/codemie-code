/**
 * Gathers ticket evidence for every session in one analytics run.
 *
 * Tool calls and native prompts come from the cost pass's parsed logs via {@link observe}, which
 * the enricher calls in start-time order with each session's `windowEnd`. That is the order the
 * cost pass uses to give a replayed API response to the EARLIEST session (`takeUnseenRecords` +
 * `withinWindow` in usage-readers.ts), and the same rule applies here: a run-wide `seen` set of
 * call ids and native row keys, and nothing after the session's own end. A resumed session's
 * replay of an earlier session's Jira call, prompt or branch is therefore attributed once, to the
 * session that comes first in that order (start time, ties in input order, as for cost).
 *
 * CodeMie-tracked prompts and branches come from the session deltas via {@link addDeltas}.
 *
 * Tool evidence is gathered whenever any source is on, even if `tool` is not requested: branch and
 * prompt ids are only kept when a tool-call id confirms their project key (merge.ts).
 */

import type { RawSessionData } from '../data-loader.js';
import type { ParsedSessionView } from '../cost/cost-enricher.js';
import { buildTicketReport, type SessionEvidence, type TicketReport, type TicketSource } from './merge.js';
import { normalizePromptText, readNativeSignals } from './native-signals.js';
import { readToolCalls } from './tool-calls.js';
import { compileToolMatcher, ticketsFromToolInput } from './tool-tickets.js';

/**
 * native-loader.ts synthesizes a native session's deltas with record ids `<sessionId>-native` and
 * `<sessionId>-native-<n>`, carrying the opening prompt and modal branch read from the same log the
 * native pass reads row by row (with replay detection), so those deltas are skipped here.
 */
function isSynthesizedNativeDelta(sessionId: string, recordId: string | undefined): boolean {
  return typeof recordId === 'string' && recordId.startsWith(`${sessionId}-native`);
}

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
  private readonly seenRows = new Set<string>();
  /** Per session: prompts already counted, keyed the way CodeMie records them (first text block). */
  private readonly countedPrompts = new Map<string, Set<string>>();
  private readonly matchesTool: (name: string) => boolean;
  private readonly collectTool: boolean;
  private readonly collectBranch: boolean;
  private readonly collectPrompt: boolean;

  constructor(private readonly options: TicketCollectorOptions) {
    this.matchesTool = compileToolMatcher(options.toolGlobs);
    this.collectPrompt = options.sources.has('prompt');
    this.collectBranch = options.sources.has('branch');
    this.collectTool = options.sources.size > 0;
  }

  private session(sessionId: string): SessionEvidence {
    let e = this.evidence.get(sessionId);
    if (!e) {
      e = { tool: new Map(), branches: new Set(), prompts: new Set() };
      this.evidence.set(sessionId, e);
    }
    return e;
  }

  /** Adds a prompt once per session, however many of the two records (native log, deltas) carry it. */
  private addPrompt(sessionId: string, e: SessionEvidence, text: string, key: string): void {
    let counted = this.countedPrompts.get(sessionId);
    if (!counted) this.countedPrompts.set(sessionId, (counted = new Set()));
    if (counted.has(key)) return;
    counted.add(key);
    e.prompts.add(text);
  }

  /** A {@link ParsedSessionObserver} for `enrichCosts`; bound so it can be passed directly. */
  readonly observe = (view: ParsedSessionView): void => {
    if (!view.parsed) return;
    const e = this.session(view.sessionId);

    if (this.collectTool) {
      for (const call of readToolCalls(view.agentName, view.parsed)) {
        if (!call.matchNames.some(this.matchesTool) || !inWindow(call.ts, view.windowEnd)) continue;
        // A call without an id is recognised by what a replay copies verbatim: name, time and input.
        const callKey = call.id ?? (call.ts !== null ? `${call.name}|${call.ts}|${JSON.stringify(call.input) ?? ''}` : null);
        if (callKey !== null) {
          if (this.seenCalls.has(callKey)) continue;
          this.seenCalls.add(callKey);
        }
        for (const id of ticketsFromToolInput(call.input)) e.tool.set(id, (e.tool.get(id) ?? 0) + 1);
      }
    }

    if (this.collectBranch || this.collectPrompt) {
      const signals = readNativeSignals(view.agentName, view.parsed);
      if (this.collectBranch) for (const branch of signals.metadataBranches) e.branches.add(branch);
      for (const row of signals.rows) {
        if (!inWindow(row.ts, view.windowEnd)) continue;
        if (row.key !== null) {
          if (this.seenRows.has(row.key)) continue;
          this.seenRows.add(row.key);
        }
        if (this.collectBranch && row.branch) e.branches.add(row.branch);
        if (this.collectPrompt && row.prompt) this.addPrompt(view.sessionId, e, row.prompt, row.promptKey ?? row.prompt);
      }
    }
  };

  /** Prompts and branches CodeMie recorded per turn; the same text seen in the native log counts once. */
  addDeltas(sessions: readonly RawSessionData[]): void {
    if (!this.collectBranch && !this.collectPrompt) return;
    for (const raw of sessions) {
      const e = this.session(raw.sessionId);
      for (const delta of raw.deltas ?? []) {
        if (isSynthesizedNativeDelta(raw.sessionId, delta.recordId)) continue;
        if (this.collectBranch && delta.gitBranch) e.branches.add(delta.gitBranch);
        if (this.collectPrompt) {
          for (const prompt of delta.userPrompts ?? []) {
            const text = prompt?.text ? normalizePromptText(prompt.text) : '';
            if (text) this.addPrompt(raw.sessionId, e, text, text);
          }
        }
      }
    }
  }

  /** Per-session tickets, plus the sessions whose ticket list hit the per-session cap. */
  buildReport(): TicketReport {
    return buildTicketReport(this.evidence, this.options.sources);
  }
}
