import { describe, it, expect } from 'vitest';
import { setupModelSummaryLine } from '../setup-ui.js';

describe('setupModelSummaryLine', () => {
  it('states per-session choice for the subscription provider (no stored model name)', () => {
    const line = setupModelSummaryLine('anthropic-subscription', '');
    expect(line).toMatch(/per session/i);
    expect(line).toMatch(/Claude Code/i);
  });

  it('shows the model for other providers', () => {
    expect(setupModelSummaryLine('litellm', 'gpt-5.5')).toContain('gpt-5.5');
  });
});
