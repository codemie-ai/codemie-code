/**
 * The hook adapters run under `LocalPolicy`: the base flow, then Claude Code, Copilot CLI and Copilot Chat with their
 * real gates over preferences and scope files in a home of this file's own.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const isolated = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-policy-adapters-')));
  const saved = {
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
    CODEMIE_HOME: process.env['CODEMIE_HOME'],
    COPILOT_HOME: process.env['COPILOT_HOME'],
    CODEMIE_SESSION_ID: process.env['CODEMIE_SESSION_ID'],
  };
  process.env['HOME'] = dir;
  process.env['USERPROFILE'] = dir;
  process.env['CODEMIE_HOME'] = path.join(dir, '.codemie');
  process.env['COPILOT_HOME'] = path.join(dir, '.copilot');
  delete process.env['CODEMIE_SESSION_ID'];
  return { dir, saved };
});

const ssoCalls: string[] = [];
vi.mock('@/providers/plugins/sso/sso.auth-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/plugins/sso/sso.auth-gate.js')>()),
  ensureCodeMieSsoAuth: vi.fn(async () => {
    ssoCalls.push('ensureCodeMieSsoAuth');
    return { ok: false, reason: 'not signed in' };
  }),
  ensureCodeMieSsoAuthOrWait: vi.fn(async () => {
    ssoCalls.push('ensureCodeMieSsoAuthOrWait');
    return { ok: false, reason: 'not signed in' };
  }),
}));
// Runs `claude --version`: no client binary is run by a test.
vi.mock('@/agents/plugins/claude-code-otlp/client-version-cache.js', () => ({
  resolveClientVersion: vi.fn(async () => '2.1.0'),
}));
const stampCalls: unknown[] = [];
vi.mock('@/agents/core/evidence/stamp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/core/evidence/stamp.js')>();
  return {
    ...actual,
    stampEvidence: vi.fn((...args: Parameters<typeof actual.stampEvidence>) => {
      stampCalls.push(args);
      return actual.stampEvidence(...args);
    }),
  };
});

const { OtlpAgentAdapter } = await import('@/agents/core/OtlpAgentAdapter.js');
const { ClaudeCodeOtlpPlugin } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.js');
const { CopilotCliOtlpPlugin } = await import('@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.js');
const { CopilotChatOtlpPlugin } = await import('@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.plugin.js');
const { LocalPolicy } = await import('../local-policy.js');
type Decision = import('@/agents/core/OtlpAgentAdapter.js').ForwardDecision;
type Context = import('@/agents/core/OtlpAgentAdapter.js').OtlpHookContext;

const codemieHome = join(isolated.dir, '.codemie');
const tracked = join(isolated.dir, 'work', 'tracked');
const excluded = join(isolated.dir, 'work', 'excluded');

afterAll(async () => {
  await (await import('@/utils/logger.js')).logger.close();
  for (const [key, value] of Object.entries(isolated.saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(isolated.dir, { recursive: true, force: true });
});

/** The developer's filters: `excluded` left out for each client, both Copilot connectors on for the user. */
function writeFilters(): void {
  mkdirSync(codemieHome, { recursive: true });
  writeFileSync(join(codemieHome, 'claude-analytics.json'), JSON.stringify({ excludedProjects: [excluded] }));
  writeFileSync(
    join(codemieHome, 'copilot-analytics.json'),
    JSON.stringify({
      version: 1,
      connectors: {
        'copilot-cli-otlp': { excludedProjects: [excluded] },
        'copilot-chat-otlp': { excludedProjects: [excluded] },
      },
    })
  );
  writeFileSync(
    join(codemieHome, 'copilot-connectors.json'),
    JSON.stringify({
      version: 1,
      connectors: {
        'copilot-cli-otlp': { enabled: true, scope: 'user' },
        'copilot-chat-otlp': { enabled: true, scope: 'user' },
      },
    })
  );
}

const marks = (): string[] => {
  try {
    return readdirSync(join(codemieHome, 'analytics', 'excluded'));
  } catch {
    return [];
  }
};

/** Every file name under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf-8' });
}

const launcher = vi.fn(async (_agent: string, _event?: string) => undefined);
const forward = vi.fn(async (_events: Record<string, unknown>[], _agent: string) => true);
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rmSync(codemieHome, { recursive: true, force: true });
  mkdirSync(tracked, { recursive: true });
  mkdirSync(excluded, { recursive: true });
  writeFilters();
  launcher.mockClear();
  forward.mockReset().mockResolvedValue(true);
  ssoCalls.length = 0;
  stampCalls.length = 0;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  vi.unstubAllEnvs();
});

const deps = (includeExternalNow = true) => ({
  policy: new LocalPolicy(includeExternalNow),
  ensureOtlpProxy: launcher,
  forwardOtlpEventsToSpool: forward,
});

/** Session ids of the events of every forward call. */
const forwardedSessions = (): string[] =>
  forward.mock.calls.flatMap(([events]) => events.map((event) => String(event['session_id'])));

interface FakeInput {
  cwd: string;
  sessionId: string;
  enforced?: boolean;
}

class FakeAdapter extends OtlpAgentAdapter<FakeInput> {
  readonly name = 'fake';
  hookErrors: unknown[] = [];

  protected parseHookInput(raw: string): FakeInput | null {
    return JSON.parse(raw) as FakeInput;
  }
  protected async extractHookContext(input: FakeInput): Promise<Context> {
    const evidenceInputs = await this.policy.evidenceInputs(async () => ({
      routing: { routed: false, routing_proof: 'proven' as const },
      funding_route: 'subscription' as const,
      collection_generation: 0,
    }));
    return { cwd: input.cwd, sessionId: input.sessionId, ...(evidenceInputs && { evidenceInputs }) };
  }
  protected async isTracked(): Promise<boolean> {
    return true;
  }
  protected override sessionIdOf(input: FakeInput): string {
    return input.sessionId;
  }
  protected override requiresSpoolAcceptance(input: FakeInput): boolean {
    return input.enforced === true;
  }
  protected override async onHookError(err: unknown): Promise<void> {
    this.hookErrors.push(err);
  }
  protected async evaluate(input: FakeInput): Promise<Decision> {
    return { decision: 'forward', payload: [{ type: 'fake.event', session_id: input.sessionId }] };
  }
  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return {};
  }
  protected resolveEventType(event: Record<string, unknown>): string {
    return String(event['type']);
  }
  protected buildEventId(event: Record<string, unknown>): string {
    return `fake:${String(event['session_id'])}`;
  }
}

describe('the base adapter with LocalPolicy', () => {
  it('a session not admitted starts no daemon and forwards nothing', async () => {
    const adapter = new FakeAdapter();

    await adapter.processOtlpEvent(JSON.stringify({ cwd: tracked, sessionId: 'base-1' }), deps(false));

    expect(launcher).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('an admitted session is forwarded with no evidence stamp', async () => {
    const adapter = new FakeAdapter();

    await adapter.processOtlpEvent(JSON.stringify({ cwd: tracked, sessionId: 'base-2' }), deps(true));

    expect(launcher).toHaveBeenCalled();
    expect(forwardedSessions()).toEqual(['base-2']);
    expect(forward.mock.calls[0]).toHaveLength(2);
    expect(stampCalls).toEqual([]);
  });

  it('a spool refusal on an enforced event reaches onHookError', async () => {
    const adapter = new FakeAdapter();
    forward.mockResolvedValue(false);

    await adapter.processOtlpEvent(JSON.stringify({ cwd: tracked, sessionId: 'base-3', enforced: true }), deps(true));

    expect(adapter.hookErrors).toEqual([expect.objectContaining({ message: 'Local analytics spool did not accept the hook event batch' })]);
  });
});

describe('Claude Code with LocalPolicy', () => {
  const claudeHook = (over: Record<string, unknown>) =>
    JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cc-1', transcript_path: '', cwd: tracked, prompt: 'hi', ...over });

  it('a resume hook with no identity is written and no stop marker appears', async () => {
    await new ClaudeCodeOtlpPlugin().processOtlpEvent(
      claudeHook({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'cc-resume' }),
      deps(true)
    );

    expect(forwardedSessions()).toContain('cc-resume');
    expect(filesUnder(codemieHome).filter((name) => name.endsWith('.stop.json'))).toEqual([]);
  });

  it('the prompt calls no SSO function and is forwarded', async () => {
    await new ClaudeCodeOtlpPlugin().processOtlpEvent(claudeHook({}), deps(true));

    expect(ssoCalls).toEqual([]);
    expect(forwardedSessions()).toEqual(['cc-1']);
  });

  it('unreadable preferences leave no mark', async () => {
    writeFileSync(join(codemieHome, 'claude-analytics.json'), '{not json');

    await new ClaudeCodeOtlpPlugin().processOtlpEvent(claudeHook({ session_id: 'cc-corrupt' }), deps(true));

    expect(marks()).toEqual([]);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('Copilot with LocalPolicy', () => {
  const cliHook = (over: Record<string, unknown>) =>
    JSON.stringify({ sessionId: 'cli-1', cwd: tracked, timestamp: 1_764_000_000_000, codemieEventName: 'userPromptTransformed', prompt: 'hi', ...over });
  const chatHook = (over: Record<string, unknown>) =>
    JSON.stringify({ hook_event_name: 'UserPromptSubmit', timestamp: '2026-11-25T10:00:00.000Z', session_id: 'chat-1', cwd: tracked, prompt: 'hi', ...over });

  it.each([
    ['Copilot CLI userPromptTransformed', () => new CopilotCliOtlpPlugin(), cliHook({}), 'cli-1'],
    ['Copilot CLI preToolUse', () => new CopilotCliOtlpPlugin(), cliHook({ codemieEventName: 'preToolUse', toolName: 'bash', toolArgs: '{}' }), 'cli-1'],
    ['Copilot Chat UserPromptSubmit', () => new CopilotChatOtlpPlugin(), chatHook({}), 'chat-1'],
    ['Copilot Chat PreToolUse', () => new CopilotChatOtlpPlugin(), chatHook({ hook_event_name: 'PreToolUse', tool_name: 'read' }), 'chat-1'],
  ])('%s calls no SSO function and is forwarded', async (_case, make, raw, sessionId) => {
    await make().processOtlpEvent(raw, deps(true));

    expect(ssoCalls).toEqual([]);
    expect(forwardedSessions()).toContain(sessionId);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('an unreadable Copilot scope record leaves no mark', async () => {
    writeFileSync(join(codemieHome, 'copilot-connectors.json'), '{not json');

    await new CopilotCliOtlpPlugin().processOtlpEvent(cliHook({ codemieEventName: 'agentStop' }), deps(true));

    expect(marks()).toEqual([]);
    expect(forward).not.toHaveBeenCalled();
  });

  it('a Copilot Chat hook with no cwd leaves no mark', async () => {
    await new CopilotChatOtlpPlugin().processOtlpEvent(chatHook({ hook_event_name: 'Stop', cwd: undefined }), deps(true));

    expect(marks()).toEqual([]);
    expect(forward).not.toHaveBeenCalled();
  });

  it('edge: a hook with no session id in an excluded folder leaves no mark and writes nothing', async () => {
    await new CopilotChatOtlpPlugin().processOtlpEvent(chatHook({ hook_event_name: 'Stop', session_id: undefined, cwd: excluded }), deps(true));

    expect(marks()).toEqual([]);
    expect(launcher).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('a session that fired a hook in an excluded folder', () => {
  const cases = [
    {
      client: 'Claude Code',
      make: () => new ClaudeCodeOtlpPlugin(),
      hook: (sessionId: string, cwd: string) =>
        JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, transcript_path: '', cwd, prompt: 'hi' }),
    },
    {
      client: 'Copilot CLI',
      make: () => new CopilotCliOtlpPlugin(),
      hook: (sessionId: string, cwd: string) =>
        JSON.stringify({ sessionId, cwd, timestamp: 1_764_000_000_000, codemieEventName: 'userPromptTransformed', prompt: 'hi' }),
    },
    {
      client: 'Copilot Chat',
      make: () => new CopilotChatOtlpPlugin(),
      hook: (sessionId: string, cwd: string) =>
        JSON.stringify({ hook_event_name: 'UserPromptSubmit', timestamp: '2026-11-25T10:00:00.000Z', session_id: sessionId, cwd, prompt: 'hi' }),
    },
  ];

  it.each(cases)('$client: is not forwarded back in a tracked folder; another session is', async ({ make, hook }) => {
    const adapter = make();

    await adapter.processOtlpEvent(hook('ex-1', excluded), deps(true));
    expect(marks()).toEqual(['ex-1']);

    await adapter.processOtlpEvent(hook('ex-1', tracked), deps(true));
    expect(launcher).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();

    await adapter.processOtlpEvent(hook('ex-2', tracked), deps(true));
    expect(forwardedSessions()).toEqual(['ex-2']);
  });
});
