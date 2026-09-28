import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  KIMI_ENV_MODEL_ALIAS,
  extractKimiEnvModelFromLog,
  kimiLogPathForWire,
  readKimiEnvModel,
  resolveKimiModelId,
} from '../kimi.env-model.js';

const ENV_LOG_LINE =
  '2026-09-01T10:24:55.508Z INFO  llm config  turnStep=0.1 provider=openai model=moonshotai.kimi-k2.5 ' +
  'modelAlias=__kimi_env_model__ thinkingEffort=on systemPromptChars=30822 toolCount=27';

describe('extractKimiEnvModelFromLog', () => {
  it('returns the real model id from the llm config line for the env alias', () => {
    expect(extractKimiEnvModelFromLog(`noise\n${ENV_LOG_LINE}\nmore noise`)).toBe('moonshotai.kimi-k2.5');
  });

  it('ignores llm config lines for other aliases', () => {
    const log = '2026-07-20T13:09:32.179Z INFO  llm config  turnStep=0.1 provider=kimi model=k3 modelAlias=kimi-code/k3';
    expect(extractKimiEnvModelFromLog(log)).toBeNull();
  });

  it('returns null for an empty log', () => {
    expect(extractKimiEnvModelFromLog('')).toBeNull();
  });
});

describe('kimiLogPathForWire', () => {
  it('maps <session>/agents/main/wire.jsonl to <session>/logs/kimi-code.log', () => {
    expect(kimiLogPathForWire('/h/sessions/wd_x/session_1/agents/main/wire.jsonl'))
      .toBe(join('/h/sessions/wd_x/session_1', 'logs', 'kimi-code.log'));
  });
});

describe('resolveKimiModelId', () => {
  it('substitutes the env model for the env alias', () => {
    expect(resolveKimiModelId(KIMI_ENV_MODEL_ALIAS, 'moonshotai.kimi-k2.5')).toBe('moonshotai.kimi-k2.5');
  });

  it('keeps the alias when no env model is known', () => {
    expect(resolveKimiModelId(KIMI_ENV_MODEL_ALIAS, undefined)).toBe(KIMI_ENV_MODEL_ALIAS);
  });

  it('never rewrites a non-alias model id', () => {
    expect(resolveKimiModelId('k3', 'moonshotai.kimi-k2.5')).toBe('k3');
  });

  it('does not substitute the alias with itself', () => {
    expect(resolveKimiModelId(KIMI_ENV_MODEL_ALIAS, KIMI_ENV_MODEL_ALIAS)).toBe(KIMI_ENV_MODEL_ALIAS);
  });
});

describe('readKimiEnvModel', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-env-model-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the env model from the sibling session log', async () => {
    await mkdir(join(root, 'agents', 'main'), { recursive: true });
    await mkdir(join(root, 'logs'), { recursive: true });
    await writeFile(join(root, 'logs', 'kimi-code.log'), `${ENV_LOG_LINE}\n`);

    expect(await readKimiEnvModel(join(root, 'agents', 'main', 'wire.jsonl'))).toBe('moonshotai.kimi-k2.5');
  });

  it('returns null when the session log is missing', async () => {
    expect(await readKimiEnvModel(join(root, 'agents', 'main', 'wire.jsonl'))).toBeNull();
  });
});
