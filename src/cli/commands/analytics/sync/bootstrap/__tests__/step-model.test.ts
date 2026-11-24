import { describe, it, expect } from 'vitest';
import {
  TargetKind,
  TargetSelection,
  ALL_STEPS,
  stepsFor,
  stepHeading,
} from '../step-model.js';

describe('step-model', () => {
  describe('TargetKind and TargetSelection types', () => {
    it('should export TargetKind as webhook | git', () => {
      const webhook: TargetKind = 'webhook';
      const git: TargetKind = 'git';
      expect(webhook).toBe('webhook');
      expect(git).toBe('git');
    });

    it('should export TargetSelection with webhook and git booleans', () => {
      const selection: TargetSelection = { webhook: true, git: false };
      expect(selection.webhook).toBe(true);
      expect(selection.git).toBe(false);
    });
  });

  describe('ALL_STEPS', () => {
    it('should contain 10 step descriptors', () => {
      expect(ALL_STEPS).toHaveLength(10);
    });

    it('should have correct ids in order', () => {
      const ids = ALL_STEPS.map((s) => s.id);
      expect(ids).toEqual([
        'target',
        'channel',
        'folder',
        'timezone',
        'flow',
        'trigger-url',
        'git-repo',
        'external',
        'lookback',
        'developers',
      ]);
    });

    it('should have titles for all steps', () => {
      ALL_STEPS.forEach((step) => {
        expect(step.title).toBeTruthy();
        expect(typeof step.title).toBe('string');
      });
    });

    it('should tag target step with both webhook and git', () => {
      const target = ALL_STEPS.find((s) => s.id === 'target');
      expect(target?.targets).toEqual(['webhook', 'git']);
    });

    it('should tag channel, folder, timezone, flow, trigger-url as webhook-only', () => {
      const webhookIds = ['channel', 'folder', 'timezone', 'flow', 'trigger-url'];
      webhookIds.forEach((id) => {
        const step = ALL_STEPS.find((s) => s.id === id);
        expect(step?.targets).toEqual(['webhook']);
      });
    });

    it('should tag git-repo step as git-only', () => {
      const gitRepo = ALL_STEPS.find((s) => s.id === 'git-repo');
      expect(gitRepo?.targets).toEqual(['git']);
    });

    it('should tag external, lookback, developers as always', () => {
      const alwaysIds = ['external', 'lookback', 'developers'];
      alwaysIds.forEach((id) => {
        const step = ALL_STEPS.find((s) => s.id === id);
        expect(step?.targets).toBe('always');
      });
    });
  });

  describe('stepsFor', () => {
    it('should return 9 steps for webhook-only selection', () => {
      const result = stepsFor({ webhook: true, git: false });
      expect(result).toHaveLength(9);

      const ids = result.map((s) => s.id);
      expect(ids).toEqual([
        'target',
        'channel',
        'folder',
        'timezone',
        'flow',
        'trigger-url',
        'external',
        'lookback',
        'developers',
      ]);
    });

    it('should return 5 steps for git-only selection', () => {
      const result = stepsFor({ webhook: false, git: true });
      expect(result).toHaveLength(5);

      const ids = result.map((s) => s.id);
      expect(ids).toEqual([
        'target',
        'git-repo',
        'external',
        'lookback',
        'developers',
      ]);
    });

    it('should return all 10 steps for both webhook and git selection', () => {
      const result = stepsFor({ webhook: true, git: true });
      expect(result).toHaveLength(10);

      const ids = result.map((s) => s.id);
      expect(ids).toEqual([
        'target',
        'channel',
        'folder',
        'timezone',
        'flow',
        'trigger-url',
        'git-repo',
        'external',
        'lookback',
        'developers',
      ]);
    });

    it('should preserve step order from ALL_STEPS', () => {
      const webhookOnly = stepsFor({ webhook: true, git: false });
      const both = stepsFor({ webhook: true, git: true });

      // Verify webhook-only steps appear in the same order in both
      let webhookIdx = 0;
      for (const step of both) {
        if (webhookOnly[webhookIdx]?.id === step.id) {
          webhookIdx++;
        }
      }
      expect(webhookIdx).toBe(webhookOnly.length);
    });
  });

  describe('stepHeading', () => {
    it('should produce "Step N of M · <title>" format for webhook-only', () => {
      const webhookSteps = stepsFor({ webhook: true, git: false });
      const heading = stepHeading(webhookSteps, 'target');
      expect(heading).toBe('Step 1 of 9 · Delivery target');
    });

    it('should produce "Step 1 of 5 · Delivery target" for git-only list', () => {
      const gitSteps = stepsFor({ webhook: false, git: true });
      const heading = stepHeading(gitSteps, 'target');
      expect(heading).toBe('Step 1 of 5 · Delivery target');
    });

    it('should correctly number middle steps', () => {
      const webhookSteps = stepsFor({ webhook: true, git: false });
      const heading = stepHeading(webhookSteps, 'trigger-url');
      expect(heading).toBe('Step 6 of 9 · Trigger URL');
    });

    it('should correctly number last step', () => {
      const allSteps = stepsFor({ webhook: true, git: true });
      const heading = stepHeading(allSteps, 'developers');
      expect(heading).toBe('Step 10 of 10 · Developers');
    });

    it('should raise error if id not found in steps', () => {
      const webhookSteps = stepsFor({ webhook: true, git: false });
      expect(() => stepHeading(webhookSteps, 'git-repo')).toThrow();
    });
  });
});
