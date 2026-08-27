/**
 * PromptHookExecutor tests.
 *
 * Pins the LLM-backed hook executor's contract WITHOUT any real LLM call:
 * `@langchain/openai`'s ChatOpenAI is mocked so its `invoke` returns canned
 * output, and the logger is mocked so error logging never touches the real
 * ~/.codemie log files. Covers prompt template resolution, JSON/plain-text
 * response parsing, invalid-decision fallback, and fail-open error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HookInput } from '../types.js';

// ---- Mock the LLM layer: no real network / LLM call ever happens. --------
// invokeMock is what the fake ChatOpenAI.invoke delegates to; ctorMock lets us
// assert the options the executor passes when constructing the model.
const invokeMock = vi.hoisted(() => vi.fn());
const ctorMock = vi.hoisted(() => vi.fn());

vi.mock('@langchain/openai', () => {
  class ChatOpenAI {
    constructor(opts: unknown) {
      ctorMock(opts);
    }
    invoke(...args: unknown[]): unknown {
      return invokeMock(...args);
    }
  }
  return { ChatOpenAI };
});

// Keep HumanMessage real-ish but harmless — we only need to know the content
// reaches invoke. Spread the real module so other exports remain intact.
const humanMessageMock = vi.hoisted(() => vi.fn());
vi.mock('@langchain/core/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/core/messages')>();
  return {
    ...actual,
    HumanMessage: class HumanMessage {
      content: string;
      constructor(content: string) {
        this.content = content;
        humanMessageMock(content);
      }
    },
  };
});

// Mock the logger so error()/warn()/debug() do not write real log files.
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

import { PromptHookExecutor } from '../prompt-executor.js';

/** Minimal HookInput factory covering the fields resolvePrompt touches. */
function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'sess-123',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/repo/work',
    permission_mode: 'auto',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
    prompt: 'do the thing',
    ...overrides,
  };
}

/** Make invoke resolve with an object shaped like a LangChain AIMessage. */
function respondWith(content: string): void {
  invokeMock.mockResolvedValueOnce({ content });
}

describe('PromptHookExecutor', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    ctorMock.mockReset();
    humanMessageMock.mockReset();
    loggerMock.debug.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('builds the LLM with defaults (fast model, temp 0, 30s timeout)', () => {
      new PromptHookExecutor({ apiKey: 'key-abc' });
      expect(ctorMock).toHaveBeenCalledTimes(1);
      const opts = ctorMock.mock.calls[0][0] as Record<string, unknown>;
      expect(opts.apiKey).toBe('key-abc');
      expect(opts.modelName).toBe('gpt-3.5-turbo');
      expect(opts.temperature).toBe(0);
      expect(opts.timeout).toBe(30000);
      // No baseUrl → configuration has no baseURL key.
      expect((opts.configuration as Record<string, unknown>).baseURL).toBeUndefined();
    });

    it('honours model, timeout, and baseUrl overrides', () => {
      new PromptHookExecutor({
        apiKey: 'k',
        model: 'gpt-4o-mini',
        timeout: 5000,
        baseUrl: 'https://proxy.local/v1',
      });
      const opts = ctorMock.mock.calls[0][0] as Record<string, unknown>;
      expect(opts.modelName).toBe('gpt-4o-mini');
      expect(opts.timeout).toBe(5000);
      expect((opts.configuration as Record<string, unknown>).baseURL).toBe('https://proxy.local/v1');
    });

    it('logs an init message only when debug is enabled', () => {
      new PromptHookExecutor({ apiKey: 'k' });
      expect(loggerMock.debug).not.toHaveBeenCalled();
      new PromptHookExecutor({ apiKey: 'k', debug: true });
      expect(loggerMock.debug).toHaveBeenCalledWith('Prompt hook executor initialized');
    });
  });

  describe('execute — happy path & response parsing', () => {
    it('returns a parsed JSON decision from the model output', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      respondWith(JSON.stringify({ decision: 'deny', reason: 'dangerous' }));
      const result = await exec.execute('Evaluate: $TOOL_NAME', makeInput());
      expect(result).toEqual({ decision: 'deny', reason: 'dangerous' });
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    it('defaults decision to allow when JSON omits it', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      respondWith(JSON.stringify({ reason: 'no opinion' }));
      const result = await exec.execute('check', makeInput());
      expect(result.decision).toBe('allow');
      expect(result.reason).toBe('no opinion');
    });

    it('coerces an invalid decision back to allow and warns', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      respondWith(JSON.stringify({ decision: 'nuke', reason: 'weird' }));
      const result = await exec.execute('check', makeInput());
      expect(result.decision).toBe('allow');
      expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid decision'));
    });

    it('accepts each of the four valid decision values as-is', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      for (const decision of ['allow', 'deny', 'block', 'approve'] as const) {
        respondWith(JSON.stringify({ decision }));
        const result = await exec.execute('check', makeInput());
        expect(result.decision).toBe(decision);
      }
    });

    it('trims and parses JSON surrounded by whitespace', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      respondWith(`  \n  ${JSON.stringify({ decision: 'block' })}  \n `);
      const result = await exec.execute('check', makeInput());
      expect(result.decision).toBe('block');
    });
  });

  describe('execute — plain-text (non-JSON) responses', () => {
    it('treats neutral plain text as allow, using the text as the reason', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      respondWith('Looks fine to me');
      const result = await exec.execute('check', makeInput());
      expect(result).toEqual({ decision: 'allow', reason: 'Looks fine to me' });
    });

    it('detects a blocking keyword in plain text and denies', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      respondWith('You should BLOCK this command');
      const result = await exec.execute('check', makeInput());
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('You should BLOCK this command');
    });

    it('recognises other blocking keywords (deny/reject/prevent)', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      for (const word of ['deny', 'reject', 'prevent']) {
        respondWith(`We must ${word} it`);
        const result = await exec.execute('check', makeInput());
        expect(result.decision).toBe('deny');
      }
    });
  });

  describe('execute — prompt template resolution', () => {
    it('substitutes every supported placeholder before calling the LLM', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      respondWith('ok');
      const template =
        'tool=$TOOL_NAME sess=$SESSION_ID cwd=$CWD prompt=$PROMPT input=$TOOL_INPUT args=$ARGUMENTS';
      await exec.execute(template, makeInput());
      const resolved = humanMessageMock.mock.calls[0][0] as string;
      expect(resolved).toContain('tool=Bash');
      expect(resolved).toContain('sess=sess-123');
      expect(resolved).toContain('cwd=/repo/work');
      expect(resolved).toContain('prompt=do the thing');
      // $TOOL_INPUT is JSON-stringified tool_input.
      expect(resolved).toContain('"command": "ls -la"');
      // $ARGUMENTS is the full input JSON.
      expect(resolved).toContain('"hook_event_name": "PreToolUse"');
      // No unresolved placeholder tokens remain.
      expect(resolved).not.toContain('$TOOL_NAME');
      expect(resolved).not.toContain('$ARGUMENTS');
    });

    it('replaces missing optional fields with empty strings / empty objects', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      respondWith('ok');
      const input = makeInput({ tool_name: undefined, tool_input: undefined, prompt: undefined });
      await exec.execute('name=[$TOOL_NAME] prompt=[$PROMPT] input=$TOOL_INPUT', input);
      const resolved = humanMessageMock.mock.calls[0][0] as string;
      expect(resolved).toContain('name=[]');
      expect(resolved).toContain('prompt=[]');
      expect(resolved).toContain('input={}');
    });

    it('leaves a template with no placeholders untouched', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      respondWith('ok');
      await exec.execute('Just a plain instruction.', makeInput());
      expect(humanMessageMock.mock.calls[0][0]).toBe('Just a plain instruction.');
    });
  });

  describe('execute — error handling (fail open)', () => {
    it('returns allow and logs the error when the LLM invoke rejects', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      invokeMock.mockRejectedValueOnce(new Error('timeout after 30000ms'));
      const result = await exec.execute('check', makeInput());
      expect(result.decision).toBe('allow');
      expect(result.reason).toContain('Prompt hook failed');
      expect(result.reason).toContain('timeout after 30000ms');
      expect(loggerMock.error).toHaveBeenCalled();
    });

    it('fails open with the stringified value for a non-Error rejection', async () => {
      const exec = new PromptHookExecutor({ apiKey: 'k' });
      invokeMock.mockRejectedValueOnce('boom');
      const result = await exec.execute('check', makeInput());
      expect(result.decision).toBe('allow');
      expect(result.reason).toContain('boom');
    });
  });
});
