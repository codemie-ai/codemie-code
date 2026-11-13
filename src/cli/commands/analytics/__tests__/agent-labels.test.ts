import { describe, it, expect } from 'vitest';
import { agentLabel } from '../agent-labels.js';
import { AgentRegistry } from '@/agents/registry.js';

describe('agentLabel', () => {
  it('labels oh-my-pi separately from Pi', () => {
    expect(agentLabel('omp')).toBe('Oh My Pi');
    expect(agentLabel('pi')).toBe('Pi');
  });

  it('gives every registered agent a product name rather than its raw key', () => {
    const unlabeled = AgentRegistry.getAgentNames().filter((name) => agentLabel(name) === name);
    expect(unlabeled).toEqual([]);
  });

  it('returns the key unchanged for unknown agents', () => {
    expect(agentLabel('unknown-agent')).toBe('unknown-agent');
  });
});
