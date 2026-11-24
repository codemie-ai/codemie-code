import { describe, expect, it } from 'vitest';
import { buildLlmModelsUrl } from '../sso.http-client.js';

describe('buildLlmModelsUrl', () => {
  const api = 'https://codemie.example.com/code-assistant-api';

  it('returns the full catalog URL without a project', () => {
    expect(buildLlmModelsUrl(api)).toBe(`${api}/v1/llm_models?include_all=true`);
  });

  it('adds the project as an encoded project_id', () => {
    const url = new URL(buildLlmModelsUrl(api, 'demo project&x=1'));
    expect(url.pathname).toBe('/code-assistant-api/v1/llm_models');
    expect(url.searchParams.get('include_all')).toBe('true');
    expect(url.searchParams.get('project_id')).toBe('demo project&x=1');
  });
});
