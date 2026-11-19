/**
 * The step tree of one session, for `codemie analytics view --session <id>`.
 *
 * A port of `traceEntries` in `report/client/app.js` (the report's Timeline): the same order,
 * levels, parents and `#n` numbering, checked by `report/__tests__/view-parity.test.ts`. The
 * label leaves out the report's "kind · " prefix; `kind` is its own field.
 */

import type { DispatchEvent } from '../cost/types.js';
import type { ReportSessionRecord } from '../report/types.js';
import type { TraceEntry } from './types.js';

interface Step {
  d: DispatchEvent;
  key: string;
  label: string;
  parent: Step | null;
  children: Step[];
  level: number;
  issue: string;
}

export function buildTrace(s: ReportSessionRecord): TraceEntry[] {
  const byId = new Map<string, Step>();
  const byAgent = new Map<string, Step>();
  const duplicateIds = new Set<string>();
  const duplicateAgents = new Set<string>();
  const counts = new Map<string, number>();
  const occurrences = new Map<string, number>();

  const steps = (s.dispatches ?? [])
    .map((d, i): Step => {
      const step: Step = { d, key: d.id != null ? String(d.id) : `legacy:${i}`, label: '', parent: null, children: [], level: 0, issue: '' };
      if (d.id != null) {
        if (byId.has(String(d.id))) {
          duplicateIds.add(String(d.id));
          step.key += `:duplicate:${i}`;
        } else {
          byId.set(String(d.id), step);
        }
      }
      if (d.kind === 'agent' && d.agentId) {
        if (byAgent.has(d.agentId)) duplicateAgents.add(d.agentId);
        else byAgent.set(d.agentId, step);
      }
      const nameKey = `${d.kind}:${d.name}`;
      counts.set(nameKey, (counts.get(nameKey) ?? 0) + 1);
      return step;
    })
    .sort((a, b) => (a.d.start || 0) - (b.d.start || 0));

  for (const step of steps) {
    const d = step.d;
    const nameKey = `${d.kind}:${d.name}`;
    occurrences.set(nameKey, (occurrences.get(nameKey) ?? 0) + 1);
    step.label = d.name + ((counts.get(nameKey) ?? 0) > 1 ? ` #${occurrences.get(nameKey)}` : '');
    if (duplicateIds.has(String(d.id))) step.issue = 'Repeated invocation ID';
    else if (d.relationshipStatus === 'cycle') step.issue = 'Ancestry cycle';
    else if (d.relationshipStatus === 'conflict') step.issue = 'Conflicting parent evidence';
    else if (d.relationshipStatus === 'missing') step.issue = 'Parent not resolved';
    if (step.issue) continue;
    if (d.parentId != null) {
      step.parent = (!duplicateIds.has(String(d.parentId)) && byId.get(String(d.parentId))) || null;
      if (!step.parent) step.issue = 'Parent not found';
    } else if (d.ownerAgentId && d.ownerAgentId !== s.sessionId && d.ownerAgentId !== 'root') {
      step.parent = (!duplicateAgents.has(d.ownerAgentId) && byAgent.get(d.ownerAgentId)) || null;
      if (!step.parent) step.issue = 'Owner not found';
    } else if ((d.depth ?? 0) > 1) {
      step.issue = 'Parent not recorded';
    }
  }

  // A parent chain that loops back on itself: every step in the loop becomes a root.
  for (const step of steps) {
    const path: Step[] = [];
    const positions = new Map<Step, number>();
    let current: Step | null = step;
    while (current) {
      const seenAt = positions.get(current);
      if (seenAt !== undefined) {
        for (const cyclic of path.slice(seenAt)) {
          cyclic.issue = 'Ancestry cycle';
          cyclic.parent = null;
        }
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = current.parent;
    }
  }
  for (const step of steps) {
    if (step.parent) step.parent.children.push(step);
  }

  const ordered: Step[] = [];
  const visited = new Set<Step>();
  const appendTree = (root: Step): void => {
    const pending = [{ step: root, level: 0 }];
    while (pending.length) {
      const { step, level } = pending.pop()!;
      if (visited.has(step)) continue;
      visited.add(step);
      step.level = level;
      ordered.push(step);
      for (let i = step.children.length - 1; i >= 0; i--) pending.push({ step: step.children[i], level: level + 1 });
    }
  };
  steps.filter((step) => !step.parent && !step.issue).forEach(appendTree);
  steps.filter((step) => !step.parent && step.issue).forEach(appendTree);
  steps.forEach((step) => {
    if (!visited.has(step)) appendTree(step);
  });

  return ordered.map((step) => ({
    key: step.key,
    kind: step.d.kind,
    name: step.d.name,
    label: step.label,
    level: step.level,
    parentKey: step.parent?.key ?? null,
    childKeys: step.children.map((child) => child.key),
    issue: step.issue || null,
  }));
}
