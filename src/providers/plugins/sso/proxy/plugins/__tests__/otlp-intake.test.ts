import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'http';
import type { ProxyContext } from '../../proxy-types.js';
import { createOtlpIntake } from '../otlp-intake.js';
import { logger } from '@/utils/logger.js';

const SESSION = '0b7c2e7a-1f4e-4c55-9a8e-2f6a5d7c9e10';

function fakeResponse(): ServerResponse & { statusCode: number } {
  const res = { statusCode: 0, setHeader: () => undefined, end: () => undefined };
  return res as unknown as ServerResponse & { statusCode: number };
}

describe('createOtlpIntake — hooks batch', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'otlp-intake-'));
    vi.stubEnv('CODEMIE_HOME', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await logger.close();
    await rm(home, { recursive: true, force: true });
  });

  it('names the written events to projectNamesOf and the whole batch to afterHooksWrite', async () => {
    const written = { session_id: SESSION, type: 'agent.tool.end', project: 'alpha' };
    const noSession = { type: 'agent.tool.end', project: 'beta' };
    const projectNamesOf = vi.fn((events: Record<string, unknown>[]) => events.map((e) => String(e['project'])));
    const afterHooksWrite = vi.fn();
    const intake = createOtlpIntake({ projectNamesOf, afterHooksWrite, recordStampLoss: vi.fn(async () => undefined) });
    const res = fakeResponse();

    await intake.handleHooks({
      method: 'POST',
      url: '/v1/analytics/hooks',
      headers: {},
      requestBody: Buffer.from(JSON.stringify({ agentName: 'claude-code-otlp', hookEvents: [written, noSession] })),
      metadata: { gatewayKeyValidated: true },
    } as unknown as ProxyContext, res);

    expect(res.statusCode).toBe(202);
    expect(projectNamesOf).toHaveBeenCalledWith([written]);
    expect(afterHooksWrite).toHaveBeenCalledWith(SESSION, 'claude-code-otlp', [written, noSession]);
    const spooled = await readFile(join(home, 'proxy', 'otlp-spool', `${SESSION}.hooks.ndjson`), 'utf-8');
    expect(spooled.trim().split('\n')).toHaveLength(1);
  });
});
