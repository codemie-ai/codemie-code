import { describe, it, expect } from 'vitest';
import { detectSessionSource, SESSION_SOURCE_DETECTORS } from '../session-source-detector.js';
import type { NamedInvocationStats } from '../../types.js';

function names(list: string[]): NamedInvocationStats[] {
  return list.map((name) => ({ name, totalCalls: 1, successCount: 1, failureCount: 0 }));
}

function session(over: { skill?: string[]; agent?: string[]; command?: string[] }) {
  return {
    skillInvocations: names(over.skill ?? []),
    agentInvocations: names(over.agent ?? []),
    commandInvocations: names(over.command ?? []),
  };
}

describe('detectSessionSource', () => {
  it('labels a session with a namespaced sdlc-factory agent invocation as CodeMie AI Factory', () => {
    expect(detectSessionSource(session({ agent: ['sdlc-factory:tech-analyst'] }))).toBe('CodeMie AI Factory');
  });

  it('labels a session with an unnamespaced sdlc-light/-task/-autonomous slash command as CodeMie AI Factory', () => {
    expect(detectSessionSource(session({ command: ['sdlc-light'] }))).toBe('CodeMie AI Factory');
    expect(detectSessionSource(session({ command: ['sdlc-task'] }))).toBe('CodeMie AI Factory');
    expect(detectSessionSource(session({ command: ['sdlc-autonomous'] }))).toBe('CodeMie AI Factory');
  });

  it('labels a session with a superpowers skill as Superpowers when no sdlc-factory signal is present', () => {
    expect(detectSessionSource(session({ skill: ['superpowers:test-driven-development'] }))).toBe('Superpowers');
  });

  it('prioritizes CodeMie AI Factory over Superpowers when both are present in one session', () => {
    expect(detectSessionSource(session({ skill: ['superpowers:brainstorming'], command: ['sdlc-light'] }))).toBe('CodeMie AI Factory');
  });

  it('labels a session with an openspec-named invocation as OpenSpec', () => {
    expect(detectSessionSource(session({ skill: ['openspec:apply'] }))).toBe('OpenSpec');
    expect(detectSessionSource(session({ command: ['open-spec-init'] }))).toBe('OpenSpec');
  });

  it('labels a session with a speckit-named invocation as SpecKit', () => {
    expect(detectSessionSource(session({ agent: ['speckit-planner'] }))).toBe('SpecKit');
  });

  it('labels a session with a bmad-named invocation as BMAD', () => {
    expect(detectSessionSource(session({ skill: ['bmad:architect'] }))).toBe('BMAD');
  });

  it('falls back to Pure chat when no known signal is found', () => {
    expect(detectSessionSource(session({ skill: ['some-other-skill'], command: ['analytics'] }))).toBe('Pure chat');
    expect(detectSessionSource(session({}))).toBe('Pure chat');
  });

  it('matches case-insensitively', () => {
    expect(detectSessionSource(session({ agent: ['SDLC-Factory:Foo'] }))).toBe('CodeMie AI Factory');
  });

  it('exposes the ordered detector list for callers that need custom ordering/extension', () => {
    expect(SESSION_SOURCE_DETECTORS.map((d) => d.name)).toEqual(['sdlc-factory', 'superpowers', 'openspec', 'speckit', 'bmad']);
  });
});
