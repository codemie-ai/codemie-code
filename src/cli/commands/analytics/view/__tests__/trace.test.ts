/**
 * `analytics view --session`: the step tree of one session, as the report's Timeline builds it.
 */

import { describe, it, expect } from 'vitest';
import { buildTrace } from '../trace.js';
import { dispatch, record } from './record-fixture.js';

const tree = (s: ReturnType<typeof record>) =>
  buildTrace(s).map(({ key, label, level, parentKey, childKeys, issue }) => ({ key, label, level, parentKey, childKeys, issue }));

describe('buildTrace', () => {
  it('nests children under their parent by parentId, then by owner agentId', () => {
    const s = record({
      sessionId: 'root-session',
      dispatches: [
        dispatch({ kind: 'agent', name: 'code-reviewer', id: 'tool-1', agentId: 'agent-1', ownerAgentId: 'root-session', start: 100, depth: 1, relationshipStatus: 'resolved' }),
        dispatch({ kind: 'agent', name: 'review-lens', id: 'tool-2', agentId: 'agent-2', parentId: 'tool-1', ownerAgentId: 'agent-1', start: 200, depth: 2, relationshipStatus: 'resolved' }),
        dispatch({ kind: 'skill', name: 'brainstorming', id: 'tool-3', ownerAgentId: 'agent-1', start: 150, relationshipStatus: 'resolved' }),
        dispatch({ kind: 'skill', name: 'writing-plans', id: 'tool-4', ownerAgentId: 'agent-2', start: 250, relationshipStatus: 'resolved' }),
        dispatch({ kind: 'command', name: 'compact', id: 'cmd-1', ownerAgentId: 'root-session', start: 50, relationshipStatus: 'root' }),
      ],
    });

    expect(tree(s)).toEqual([
      { key: 'cmd-1', label: 'compact', level: 0, parentKey: null, childKeys: [], issue: null },
      { key: 'tool-1', label: 'code-reviewer', level: 0, parentKey: null, childKeys: ['tool-3', 'tool-2'], issue: null },
      { key: 'tool-3', label: 'brainstorming', level: 1, parentKey: 'tool-1', childKeys: [], issue: null },
      { key: 'tool-2', label: 'review-lens', level: 1, parentKey: 'tool-1', childKeys: ['tool-4'], issue: null },
      { key: 'tool-4', label: 'writing-plans', level: 2, parentKey: 'tool-2', childKeys: [], issue: null },
    ]);
    expect(buildTrace(s).map((e) => [e.kind, e.name])).toEqual([
      ['command', 'compact'], ['agent', 'code-reviewer'], ['skill', 'brainstorming'], ['agent', 'review-lens'], ['skill', 'writing-plans'],
    ]);
  });

  it('numbers repeated names in start order: "teams-transcript #1", "#2"', () => {
    const s = record({
      dispatches: [
        dispatch({ kind: 'command', name: 'teams-transcript', id: 'later', start: 300 }),
        dispatch({ kind: 'command', name: 'review', id: 'once', start: 200 }),
        dispatch({ kind: 'command', name: 'teams-transcript', id: 'earlier', start: 100 }),
        dispatch({ kind: 'skill', name: 'teams-transcript', id: 'other-kind', start: 400 }),
      ],
    });

    expect(buildTrace(s).map((e) => [e.key, e.label])).toEqual([
      ['earlier', 'teams-transcript #1'],
      ['once', 'review'],
      ['later', 'teams-transcript #2'],
      ['other-kind', 'teams-transcript'], // a skill of the same name is its own series
    ]);
  });

  it('keeps a step whose parent is missing at level 0 with issue "Parent not found"', () => {
    const s = record({
      dispatches: [
        dispatch({ kind: 'agent', name: 'orphan', id: 'tool-9', parentId: 'gone', start: 10, depth: 2 }),
        dispatch({ kind: 'agent', name: 'general-purpose', id: 'tool-1', start: 20 }),
        dispatch({ kind: 'skill', name: 'legacy-step', start: 30 }),
      ],
    });

    expect(tree(s)).toEqual([
      { key: 'tool-1', label: 'general-purpose', level: 0, parentKey: null, childKeys: [], issue: null },
      { key: 'legacy:2', label: 'legacy-step', level: 0, parentKey: null, childKeys: [], issue: null },
      { key: 'tool-9', label: 'orphan', level: 0, parentKey: null, childKeys: [], issue: 'Parent not found' },
    ]);
  });

  it('returns no steps for a session without dispatches', () => {
    expect(buildTrace(record({ dispatches: undefined }))).toEqual([]);
  });
});
